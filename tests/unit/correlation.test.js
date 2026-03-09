// tests/unit/correlation.test.js
// TDD tests for src/pipeline/correlation.js
//
// Covers: pseudo ID generation, signal hashing, user creation, sighting tracking,
// confidence threshold enforcement, and idempotency.

'use strict';

const { dbGet, dbRun, dbAll } = require('../../src/db/connection');
const {
    generatePseudoId,
    computeSignalHash,
    correlateUser,
    CORRELATION_MIN_CONFIDENCE,
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

    it('returns a string in verb-noun format (word-word)', () => {
        const id = generatePseudoId('any-seed');
        // Must match two lowercase words joined by a hyphen
        expect(id).toMatch(/^[a-z]+-[a-z]+$/);
    });

    it('uses different word pools for verb and noun', () => {
        // Generate 100 IDs and confirm both halves have variety
        const verbs = new Set();
        const nouns = new Set();
        for (let i = 0; i < 100; i++) {
            const parts = generatePseudoId(`seed-${i}`).split('-');
            verbs.add(parts[0]);
            nouns.add(parts[1]);
        }
        // With 20 verbs and 20 nouns in the word lists, 100 samples should hit many
        expect(verbs.size).toBeGreaterThan(3);
        expect(nouns.size).toBeGreaterThan(3);
    });
});

// ─── computeSignalHash() ─────────────────────────────────────────────────────

describe('computeSignalHash()', () => {
    it('returns a 64-character hex string (SHA-256)', () => {
        const hash = computeSignalHash({ style: 'analytical', topics: ['ai'] }, 'salt');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic: same signals + salt always produces the same hash', () => {
        const signals = { style: 'formal', topicAffinity: ['ml', 'ethics'] };
        const a = computeSignalHash(signals, 'test-salt');
        const b = computeSignalHash(signals, 'test-salt');
        expect(a).toBe(b);
    });

    it('produces a different hash when the salt changes', () => {
        const signals = { style: 'formal' };
        const a = computeSignalHash(signals, 'salt-a');
        const b = computeSignalHash(signals, 'salt-b');
        expect(a).not.toBe(b);
    });

    it('produces a different hash when signals change', () => {
        const a = computeSignalHash({ style: 'formal' }, 'salt');
        const b = computeSignalHash({ style: 'casual' }, 'salt');
        expect(a).not.toBe(b);
    });
});

// ─── correlateUser() ─────────────────────────────────────────────────────────

describe('correlateUser()', () => {
    it('returns null when confidence is below the minimum threshold', async () => {
        const srcId = await insertSource('corr-src-low');
        const result = await correlateUser({
            sourceId:      srcId,
            signalHash:    'abc123',
            topicAffinity: [],
            confidence:    CORRELATION_MIN_CONFIDENCE - 0.01,
        });
        expect(result).toBeNull();
    });

    it('creates a pseudonymous_users row when a new user is correlated', async () => {
        const srcId = await insertSource('corr-src-new');
        const hash  = computeSignalHash({ style: 'analytical' }, 'salt-a');

        const result = await correlateUser({
            sourceId:      srcId,
            signalHash:    hash,
            topicAffinity: ['ai', 'ethics'],
            confidence:    0.90,
        });

        expect(result).not.toBeNull();
        const user = await dbGet(
            'SELECT * FROM pseudonymous_users WHERE id = $1',
            [result.pseudoUserId],
        );
        expect(user).toBeDefined();
        expect(user.correlation_confidence).toBeCloseTo(0.90, 2);
    });

    it('returns isNew=true for a genuinely new correlation', async () => {
        const srcId = await insertSource('corr-src-isnew');
        const hash  = computeSignalHash({ style: 'academic' }, 'salt-b');

        const result = await correlateUser({
            sourceId:      srcId,
            signalHash:    hash,
            topicAffinity: [],
            confidence:    CORRELATION_MIN_CONFIDENCE,
        });

        expect(result.isNew).toBe(true);
    });

    it('creates a user_platform_sightings row for each correlation', async () => {
        const srcId = await insertSource('corr-src-sight');
        const hash  = computeSignalHash({ style: 'casual' }, 'salt-c');

        const result = await correlateUser({
            sourceId:      srcId,
            signalHash:    hash,
            topicAffinity: [],
            confidence:    0.92,
        });

        const sighting = await dbGet(
            'SELECT * FROM user_platform_sightings WHERE pseudo_user_id = $1',
            [result.pseudoUserId],
        );
        expect(sighting).toBeDefined();
        expect(sighting.source_id).toBe(srcId);
        expect(sighting.confidence).toBeCloseTo(0.92, 2);
    });

    it('stores the pseudo_id in verb-noun format', async () => {
        const srcId = await insertSource('corr-src-format');
        const hash  = computeSignalHash({ style: 'technical' }, 'salt-d');

        const result = await correlateUser({
            sourceId:      srcId,
            signalHash:    hash,
            topicAffinity: [],
            confidence:    0.88,
        });

        expect(result.pseudoId).toMatch(/^[a-z]+-[a-z]+$/);
    });

    it('increments platform_count on a repeat sighting', async () => {
        const srcId  = await insertSource('corr-src-repeat');
        const src2Id = await insertSource('corr-src-repeat-2', 'news');
        const hash   = computeSignalHash({ style: 'verbose' }, 'salt-e');

        // First sighting
        const first = await correlateUser({
            sourceId:      srcId,
            signalHash:    hash,
            topicAffinity: [],
            confidence:    CORRELATION_MIN_CONFIDENCE,
        });

        // Second sighting — same signal from a different source
        const second = await correlateUser({
            sourceId:      src2Id,
            signalHash:    hash,
            topicAffinity: [],
            confidence:    0.91,
        });

        expect(second.isNew).toBe(false);
        expect(second.pseudoUserId).toBe(first.pseudoUserId);

        const user = await dbGet(
            'SELECT platform_count FROM pseudonymous_users WHERE id = $1',
            [first.pseudoUserId],
        );
        expect(user.platform_count).toBe(2);
    });

    it('accumulates multiple sightings for the same user', async () => {
        const srcId = await insertSource('corr-src-multi');
        const hash  = computeSignalHash({ style: 'concise' }, 'salt-f');

        const first = await correlateUser({
            sourceId:      srcId,
            signalHash:    hash,
            topicAffinity: [],
            confidence:    CORRELATION_MIN_CONFIDENCE,
        });

        await correlateUser({
            sourceId:      srcId,
            signalHash:    hash,
            topicAffinity: [],
            confidence:    CORRELATION_MIN_CONFIDENCE,
        });

        const sightings = await dbAll(
            'SELECT * FROM user_platform_sightings WHERE pseudo_user_id = $1',
            [first.pseudoUserId],
        );
        expect(sightings.length).toBeGreaterThanOrEqual(2);
    });

    it('accepts exactly the minimum confidence threshold', async () => {
        const srcId = await insertSource('corr-src-exact');
        const hash  = computeSignalHash({ style: 'neutral' }, 'salt-g');

        const result = await correlateUser({
            sourceId:      srcId,
            signalHash:    hash,
            topicAffinity: [],
            confidence:    CORRELATION_MIN_CONFIDENCE, // exactly at threshold
        });

        expect(result).not.toBeNull();
    });
});
