// src/collectors/terms-text.js
// Normalised visible text of a terms page (PR #22 principal P1-13, grumpy
// #15). Version 'terms-text@1' (stored with each snapshot, migration 041):
//   1. drop <script>, <style>, <noscript>, <template>, <svg> elements and
//      HTML comments, with their content;
//   2. turn block-level tags and <br> into line breaks, drop every other tag;
//   3. decode the common named entities and numeric entities;
//   4. collapse runs of spaces/tabs to one space, trim each line, drop empty
//      lines.
// A plain-text or non-HTML body goes through steps 3-4 only. The SHA-256 of
// the result is what a later reviewer can recompute from the stored text.

'use strict';

const crypto = require('crypto');

const VERSION = 'terms-text@1';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const NAMED = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
    hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', sect: '§' });

function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
        }
        const v = NAMED[e.toLowerCase()];
        return v === undefined ? m : v;
    });
}

/** @param {string} body  @param {string} [contentType] */
function normaliseTermsText(body, contentType = '') {
    let s = String(body || '');
    const html = /html|xml/i.test(contentType) || /<(html|body|div|p|head)\b/i.test(s);
    if (html) {
        s = s.replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/?(p|div|section|article|header|footer|main|nav|li|ul|ol|h[1-6]|tr|table|blockquote|pre|dt|dd|dl)\b[^>]*>/gi, '\n')
            .replace(/<[^>]*>/g, ' ');
    }
    s = decodeEntities(s).replace(/\r\n?/g, '\n');
    const lines = s.split('\n').map(l => l.replace(/[ \t\f\v ]+/g, ' ').trim()).filter(Boolean);
    let out = lines.join('\n');
    if (Buffer.byteLength(out) > MAX_TEXT_BYTES) out = Buffer.from(out).subarray(0, MAX_TEXT_BYTES).toString('utf8');
    return out;
}

const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');

module.exports = { normaliseTermsText, decodeEntities, sha256, VERSION, MAX_TEXT_BYTES };
