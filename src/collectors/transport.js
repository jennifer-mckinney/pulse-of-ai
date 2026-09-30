// src/collectors/transport.js
// The collectors' network transport: (url, { method, headers, body, signal,
// maxBytes }) → { status, headers, body }, one HTTP exchange, no redirects
// followed (src/collectors/http.js follows them hop by hop).
//
//   - https only, over node:https with a guarded `lookup`
//     (src/collectors/netguard.js): every resolved address must be public and
//     the socket connects to the address that was checked (F10-2);
//   - TLS 1.2 minimum, certificates verified;
//   - the body is read as a STREAM and capped at `maxBytes` DECODED bytes
//     (gzip / deflate / br are inflated here, and the cap applies after
//     inflation), so a decompression bomb or an endless body is cut off
//     early instead of filling memory; a Content-Length over the cap is
//     refused before any body is read (F10-4). ResponseTooLargeError.
//   - a response that has no content (1xx, 204, 304, a HEAD response, or
//     Content-Length: 0) is NEVER run through a decoder: a 304 may repeat
//     the 200's Content-Encoding (RFC 9110 §15.4.5) with no body, and gunzip
//     over zero bytes throws "unexpected end of file" (diagnosis 2026-09-30:
//     the Internet Archive blog feed failed 91% of runs on it). A body that
//     is present but cannot be decoded is a ResponseDecodeError (kind
//     'parse'): deterministic, so http.js never retries it.
//
// createNetworkTransport({ request, lookup }) takes injectable node:https
// request / lookup functions for tests; readBody() is exported for the same
// reason.

'use strict';

const https = require('https');
const zlib = require('zlib');
const { CollectorError } = require('./errors');
const { createGuardedLookup, HostRefusedError } = require('./netguard');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;         // 5 MB per response
const ROBOTS_MAX_BYTES = 500 * 1024;               // RFC 9309 §2.5: at least 500 KiB parsed

class ResponseTooLargeError extends CollectorError {
    constructor(message, details = {}) {
        super(message, { kind: 'too_large', ...details });
    }
}

/** A body that is present but cannot be decoded (corrupt / truncated gzip, deflate, br). Never retried. */
class ResponseDecodeError extends CollectorError {
    constructor(message, details = {}) {
        super(message, { kind: 'parse', decode: true, ...details });
    }
}

/**
 * Whether a response carries no content, whatever its headers say
 * (RFC 9110 §6.4.1: 1xx, 204 and 304 responses and responses to HEAD have
 * none; Content-Length: 0 declares none).
 */
function hasNoContent(status, method, headers) {
    if (String(method || '').toUpperCase() === 'HEAD') return true;
    if (status === 204 || status === 304 || (status >= 100 && status < 200)) return true;
    return String((headers || {})['content-length'] || '').trim() === '0';
}

/**
 * Read a response stream, inflating by Content-Encoding, capped at maxBytes
 * decoded bytes.
 * @param {import('stream').Readable} res  with .headers (and .statusCode)
 * @param {{ maxBytes?: number, status?: number, method?: string }} opts
 *        status defaults to res.statusCode; method to 'GET'
 * @returns {Promise<string>}
 */
function readBody(res, { maxBytes = DEFAULT_MAX_BYTES, status = res.statusCode, method = 'GET' } = {}) {
    return new Promise((resolve, reject) => {
        // No content: never build a decoder. Drain the stream so the socket
        // is released, and resolve the empty body.
        if (hasNoContent(status, method, res.headers)) {
            res.resume();
            resolve('');
            return;
        }
        const declared = parseInt((res.headers || {})['content-length'], 10);
        if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy();
            reject(new ResponseTooLargeError(`response declares ${declared} bytes, over the ${maxBytes}-byte cap`));
            return;
        }
        const enc = String((res.headers || {})['content-encoding'] || '').trim().toLowerCase();
        let stream = res;
        let decoder = null;
        if (enc === 'gzip' || enc === 'x-gzip') decoder = zlib.createGunzip();
        else if (enc === 'deflate') decoder = zlib.createInflate();
        else if (enc === 'br') decoder = zlib.createBrotliDecompress();
        if (decoder) stream = res.pipe(decoder);

        const chunks = [];
        let total = 0;
        let rawBytes = 0;   // bytes received before decoding
        let done = false;
        const finish = (err, value) => {
            if (done) return;
            done = true;
            if (err) {
                if (decoder) decoder.destroy();
                res.destroy();
                reject(err);
            } else resolve(value);
        };
        stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                finish(new ResponseTooLargeError(`response exceeds the ${maxBytes}-byte cap (decoded)`));
                return;
            }
            chunks.push(chunk);
        });
        stream.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
        if (decoder) {
            res.on('data', (chunk) => { rawBytes += chunk.length; });
            res.on('error', err => finish(err));
            decoder.on('error', (err) => {
                // Defence in depth: an EMPTY body under a Content-Encoding
                // (no Content-Length, e.g. chunked) is an empty body, not a
                // corrupt one. A non-empty body that fails to decode is.
                if (rawBytes === 0 && total === 0 && err && err.code === 'Z_BUF_ERROR') {
                    finish(null, '');
                    return;
                }
                finish(new ResponseDecodeError(`response body could not be decoded (${enc}: ${(err && err.code) || 'error'})`,
                    { code: err && err.code }));
            });
        } else {
            stream.on('error', err => finish(err));
        }
    });
}

function flattenHeaders(raw) {
    const out = {};
    for (const [k, v] of Object.entries(raw || {})) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    return out;
}

/**
 * @param {{ request?: Function, lookup?: Function }} [deps]
 * @returns {(url: string, init: object) => Promise<{ status: number, headers: object, body: string }>}
 */
function createNetworkTransport({ request = https.request, lookup = createGuardedLookup() } = {}) {
    return function networkTransport(url, { method = 'GET', headers = {}, body, signal, maxBytes = DEFAULT_MAX_BYTES } = {}) {
        return new Promise((resolve, reject) => {
            let u;
            try {
                u = new URL(url);
            } catch {
                reject(new HostRefusedError('refused: not a URL'));
                return;
            }
            if (u.protocol !== 'https:') {
                reject(new HostRefusedError(`refused: ${u.protocol.replace(':', '')} is not https`));
                return;
            }
            const timedOut = () => signal && signal.aborted && signal.reason && signal.reason.name === 'TimeoutError';
            const req = request(u, {
                method,
                headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers },
                lookup,
                signal,
                minVersion: 'TLSv1.2',
                rejectUnauthorized: true,
            }, (res) => {
                readBody(res, { maxBytes, status: res.statusCode, method })
                    .then(text => resolve({ status: res.statusCode, headers: flattenHeaders(res.headers), body: text }))
                    .catch(err => reject(timedOut() ? Object.assign(new Error('request timed out'), { name: 'TimeoutError' }) : err));
            });
            req.on('error', err => reject(timedOut() ? Object.assign(new Error('request timed out'), { name: 'TimeoutError' }) : err));
            if (body !== undefined && body !== null) req.write(body);
            req.end();
        });
    };
}

module.exports = {
    createNetworkTransport, readBody, hasNoContent, ResponseTooLargeError, ResponseDecodeError, DEFAULT_MAX_BYTES, ROBOTS_MAX_BYTES,
};
