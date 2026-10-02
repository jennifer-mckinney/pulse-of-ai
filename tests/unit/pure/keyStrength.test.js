// tests/unit/pure/keyStrength.test.js — the HMAC-key strength rule shared by the gold tools and the erasure request.
'use strict';

const crypto = require('crypto');
const { isStrongKey, entropyBits, MIN_KEY_ENTROPY_BITS } = require('../../../src/config/key-strength');

describe('isStrongKey', () => {
    it('accepts a random 64-hex key and a long mixed passphrase', () => {
        expect(isStrongKey(crypto.randomBytes(32).toString('hex'))).toBe(true);
        expect(isStrongKey('audit-key-0123456789-abcdefghijklmnop')).toBe(true);
    });

    it('refuses non-strings, short keys, template values and low-entropy keys', () => {
        expect(isStrongKey(undefined)).toBe(false);
        expect(isStrongKey('short')).toBe(false);
        expect(isStrongKey('replace_with_random_64_hex_chars')).toBe(false);
        expect(isStrongKey('a'.repeat(64))).toBe(false);
        expect(isStrongKey('abcdefgh'.repeat(4))).toBe(false);   // 32 characters, 96 bits
        expect(isStrongKey('ab12'.repeat(12))).toBe(false);      // 48 characters but only 4 symbols (96 bits)
    });

    it('estimates entropy as length times the Shannon entropy of the characters', () => {
        expect(entropyBits('aaaa')).toBe(0);
        expect(entropyBits('abab')).toBeCloseTo(4, 5);
        expect(entropyBits('abcdefgh'.repeat(4))).toBeCloseTo(96, 5);
        expect(MIN_KEY_ENTROPY_BITS).toBe(128);
    });
});
