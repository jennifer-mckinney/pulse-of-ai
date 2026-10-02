// src/config/key-strength.js
// A MINIMUM-VARIETY check on a configured secret before it is used as an HMAC key: long enough, not a template value
// and with enough character variety. It is a sanity filter against careless keys, NOT a proof of entropy: generate
// keys with `openssl rand -hex 32` (64 hex characters). Used by the offline gold tools
// (GOLD_HASH_KEY; AUDIT_HASH_KEY only as a dev/test fallback).

'use strict';

const MIN_KEY_LENGTH = 32;
// Estimated Shannon entropy of the whole key, in bits. `openssl rand -hex 32` (64 hex characters) is about 240;
// a repeated short alphabet ("abcdefgh" x 4) is 96 and is refused.
const MIN_KEY_ENTROPY_BITS = 128;
// Template values shipped in .env.example are public: never a key.
const PLACEHOLDER_KEY_RE = /^(?:replace|changeme|change[-_]me|example|your[-_]|xxx|todo)/i;

/** Estimated entropy of a string in bits: length x the Shannon entropy of its character frequencies. */
function entropyBits(s) {
    const counts = new Map();
    for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
    const n = [...s].length;
    let h = 0;
    for (const c of counts.values()) h -= (c / n) * Math.log2(c / n);
    return h * n;
}

/** True when `v` is usable as a keyed-hash key. */
function isStrongKey(v) {
    return typeof v === 'string' && v.length >= MIN_KEY_LENGTH && !PLACEHOLDER_KEY_RE.test(v)
        && entropyBits(v) >= MIN_KEY_ENTROPY_BITS;
}

/** True when the environment is production (same case/space-insensitive test as the gold tools' local-only guard). */
function isProductionEnv(env = process.env) {
    return String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

module.exports = { MIN_KEY_LENGTH, MIN_KEY_ENTROPY_BITS, entropyBits, isStrongKey, isProductionEnv };
