// tests/unit/correlation.test.js
// TDD tests for src/pipeline/correlation.js
//
// Covers: pseudo ID generation, signal hashing, and correlateUser's refusal
// (not implemented: signal design pending DPIA, PR #22 grumpy M7).

'use strict';

// A real (non-placeholder) per-deployment salt for these tests; the CI's
// placeholder (64 zeros) is refused by design (spec §20, fail closed).
process.env.CORRELATION_SALT = 'unit-test-deployment-salt-7f3a9c';

const { dbGet, dbRun } = require('../../src/db/connection');
const {
    generatePseudoId,
    computeSignalHash,
    correlateUser,
    CorrelationNotImplementedError,
} = require('../../src/pipeline/correlation');

// ─── Test helpers ──────────────────────────────────────────────────────────────

async function insertSource(name = 'corr-test-src', category = 'social') {
    const row = await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category)
         VALUES ($1, $1, 'reddit', $2)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name, category],
    );
    return row.id;
}

// ─── generatePseudoId() ───────────────────────────────────────────────────────

describe('generatePseudoId()', () => {
    it('is deterministic: same seed always produces the same pseudo_id', () => {
        const a = generatePseudoId('test-seed-abc');
        const b = generatePseudoId('test-seed-abc');
        expect(a).toBe(b);
    });

    it('produces different IDs for different seeds', () => {
        const a = generatePseudoId('seed-one');
        const b = generatePseudoId('seed-two');
        expect(a).not.toBe(b);
    });

    it('returns a string in adjective-animal format (word-word)', () => {
        const id = generatePseudoId('any-seed');
        // Must match two lowercase words joined by a hyphen
        expect(id).toMatch(/^[a-z]+-[a-z]+$/);
    });

    it('uses different word pools for adjective and animal, high variety', () => {
        // Generate 100 IDs and confirm both halves have variety.
        // unique-names-generator has 1,202 adjectives × 355 animals = 426,710 combinations;
        // 100 samples should show strong diversity across both halves.
        const adjParts = new Set();
        const animalParts = new Set();
        for (let i = 0; i < 100; i++) {
            const parts = generatePseudoId(`seed-${i}`).split('-');
            adjParts.add(parts[0]);
            animalParts.add(parts[1]);
        }
        expect(adjParts.size).toBeGreaterThan(10);
        animalParts.size > 0 && expect(animalParts.size).toBeGreaterThan(3);
    });
});

// ─── computeSignalHash() ─────────────────────────────────────────────────────

describe('computeSignalHash()', () => {
    it('returns a 64-character hex string (SHA-256)', () => {
        const hash = computeSignalHash({ style: 'analytical', topics: ['ai'] }, 'salt-deployment-0001');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic: same signals + salt always produces the same hash', () => {
        const signals = { style: 'formal', topicAffinity: ['ml', 'ethics'] };
        const a = computeSignalHash(signals, 'test-salt-deployment-01');
        const b = computeSignalHash(signals, 'test-salt-deployment-01');
        expect(a).toBe(b);
    });

    it('produces a different hash when the salt changes', () => {
        const signals = { style: 'formal' };
        const a = computeSignalHash(signals, 'salt-a-deployment-000');
        const b = computeSignalHash(signals, 'salt-b-deployment-000');
        expect(a).not.toBe(b);
    });

    it('produces a different hash when signals change', () => {
        const a = computeSignalHash({ style: 'formal' }, 'salt-deployment-0001');
        const b = computeSignalHash({ style: 'casual' }, 'salt-deployment-0001');
        expect(a).not.toBe(b);
    });
});

// ─── correlateUser() ─────────────────────────────────────────────────────────
// PR #22 grumpy M7: not implemented — no identity signal exists, so no
// profile may be created from ANY input, including a confidence at or above
// the spec's threshold. Real module, real test DB: nothing is written.

describe('correlateUser() — not implemented: signal design pending DPIA (M7)', () => {
    const count = async (t) => (await dbGet(`SELECT COUNT(*)::int AS n FROM ${t}`)).n;

    it.each([0, 0.5, 0.85, 0.99, 1])('refuses confidence %p and writes nothing', async (confidence) => {
        const srcId = await insertSource('corr-src-refused');
        const signalHash = computeSignalHash({ topics: ['llm'], hour: 9 }, 'salt-refused-deployment-01');
        const err = await correlateUser({ sourceId: srcId, signalHash, topicAffinity: ['llm'], confidence }).catch(e => e);
        expect(err).toBeInstanceOf(CorrelationNotImplementedError);
        expect(err.message).toMatch(/^not implemented: signal design pending DPIA/);
        expect(await count('pseudonymous_users')).toBe(0);
        expect(await count('user_platform_sightings')).toBe(0);
    });

    it('exports no confidence threshold or profile writer to call around the refusal', () => {
        const mod = require('../../src/pipeline/correlation');
        expect(Object.keys(mod).sort()).toEqual(['CorrelationNotImplementedError', 'computeSignalHash', 'correlateUser', 'generatePseudoId']);
    });
});

describe('fail closed without a per-deployment salt (spec §20)', () => {
    const { isUsableSalt, correlationStatus } = require('../../src/pipeline/correlation-gate');
    const OPEN = { CORRELATION_DPIA_REF: 'DPIA-1', CORRELATION_ENABLED: 'true' };

    it('unset or placeholder salts are not salts: correlation is misconfigured (off) and no pseudonym is computed', async () => {
        for (const salt of [undefined, '', '0'.repeat(64), 'changeme', 'pulse-of-ai-default-salt', 'short', '<your-salt>', '${CORRELATION_SALT}']) {
            expect([salt, isUsableSalt(salt)]).toEqual([salt, false]);
            expect(correlationStatus({ ...OPEN, CORRELATION_SALT: salt }).status).toBe('misconfigured');
            expect(() => computeSignalHash({ a: 1 }, salt)).toThrow(/per-deployment salt/);
        }
    });

    it('a set salt gives deployment-specific signals: the same signals differ across deployments', () => {
        const s1 = 'deployment-one-salt-a1b2c3d4';
        const s2 = 'deployment-two-salt-e5f6a7b8';
        expect(isUsableSalt(s1)).toBe(true);
        expect(computeSignalHash({ topics: ['llm'] }, s1)).not.toBe(computeSignalHash({ topics: ['llm'] }, s2));
        // M7: a good salt is necessary, not sufficient — no identity signal exists.
        expect(correlationStatus({ ...OPEN, CORRELATION_SALT: s1 })).toMatchObject({ enabled: false, status: 'not_implemented' });
    });
});

