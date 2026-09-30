// tests/unit/pure/correlationGate.test.js
// PR #22 grumpy M8: the fail-closed salt check must reject the repo's own
// .env.example placeholder and every other known placeholder shape.

const fs = require('fs');
const path = require('path');
const { isUsableSalt, correlationStatus } = require('../../../src/pipeline/correlation-gate');

const exampleSalt = () => {
    const line = fs.readFileSync(path.join(__dirname, '../../../.env.example'), 'utf8')
        .split('\n').find(l => l.startsWith('CORRELATION_SALT='));
    return line.slice('CORRELATION_SALT='.length).trim();
};

describe('isUsableSalt — placeholders fail closed (M8)', () => {
    it('rejects the value shipped in .env.example', () => {
        const v = exampleSalt();
        expect(v).not.toBe('');
        expect(isUsableSalt(v)).toBe(false);
    });

    it.each([
        'replace_with_random_64_hex_chars',
        'REPLACE-ME-WITH-A-REAL-SALT-0001',
        'your_correlation_salt_goes_here',
        'change_me_to_something_random_1',
        'insert-random-salt-here-please',
        'placeholder-salt-value-0123456',
        'example_salt_value_0123456789ab',
        'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    ])('rejects %s', (v) => {
        expect(isUsableSalt(v)).toBe(false);
    });

    it('accepts a random 64-hex salt as standup generates', () => {
        expect(isUsableSalt('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).toBe(true);
    });

    it('a placeholder salt leaves correlation misconfigured, never enabled', () => {
        const st = correlationStatus({ CORRELATION_DPIA_REF: 'DPIA-1', CORRELATION_ENABLED: 'true', CORRELATION_SALT: exampleSalt() });
        expect(st.enabled).toBe(false);
        expect(st.status).toBe('misconfigured');
    });
});

// PR #22 grumpy M7: the only signal on identity-free data (topics plus
// hour) is not an identity signal — correlation cannot be enabled at all.
describe('correlationStatus — not implemented: signal design pending DPIA (M7)', () => {
    const GOOD = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
    it('with a DPIA, the switch on and a real salt, the status is not_implemented and it is off', () => {
        const st = correlationStatus({ CORRELATION_DPIA_REF: 'DPIA-7', CORRELATION_ENABLED: 'true', CORRELATION_SALT: GOOD });
        expect(st).toMatchObject({ enabled: false, status: 'not_implemented' });
        expect(st.reason).toMatch(/^not implemented: signal design pending DPIA\..*not an identity signal/);
    });
    it('no environment yields enabled', () => {
        const envs = [{}, { CORRELATION_ENABLED: 'true', CORRELATION_SALT: GOOD }, { CORRELATION_DPIA_REF: 'x', CORRELATION_ENABLED: 'on', CORRELATION_SALT: GOOD }];
        for (const env of envs) expect(correlationStatus(env).enabled).toBe(false);
    });
});
