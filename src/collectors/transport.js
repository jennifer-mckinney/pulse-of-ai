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

/**
 * Read a response stream, inflating by Content-Encoding, capped at maxBytes
 * decoded bytes.
 * @param {import('stream').Readable} res  with .headers
 * @param {{ maxBytes: number }} opts
 * @returns {Promise<string>}
 */
function readBody(res, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    return new Promise((resolve, reject) => {
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
        stream.on('error', err => finish(err));
        if (decoder) res.on('error', err => finish(err));
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
                readBody(res, { maxBytes })
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
    createNetworkTransport, readBody, ResponseTooLargeError, DEFAULT_MAX_BYTES, ROBOTS_MAX_BYTES,
};
