// src/pipeline/correlation.js
// Cross-platform user correlation with privacy-preserving pseudonymous identifiers.
//
// Privacy model:
//   - No usernames, handles, or platform IDs are ever stored
//   - Behavioral signals (writing style + topic affinity + temporal pattern) are
//     hashed with a deployment-specific salt — not reversible
//   - Pseudonymous IDs use a verb-noun format ('running-tiger') — human-readable
//     but unlinked to any real identity
//   - Correlation requires >= CORRELATION_MIN_CONFIDENCE (0.85) to create a profile
//
// Entry points:
//   generatePseudoId(seed)                    — deterministic verb-noun from seed
//   computeSignalHash(signals, salt)          — SHA-256 of behavioral signals
//   correlateUser({ sourceId, signalHash,     — find/create pseudonymous user
//                   topicAffinity, confidence})
//
// See: src/db/migrations/006_correlation_tables.sql

'use strict';

const crypto = require('crypto');
const { dbGet, dbRun } = require('../db/connection');

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * Minimum confidence before a pseudonymous profile is created.
 * Below this value, correlateUser() returns null.
 * Threshold is 0.85 per the technical specification §20.
 */
const CORRELATION_MIN_CONFIDENCE = 0.85;

// Verb and noun word pools for pseudo ID generation.
// 20 verbs × 20 nouns = 400 possible combinations (sufficient for MVP scale).
// Chosen to be neutral, non-offensive, and easy to read.
const VERBS = [
    'running',  'jumping',  'swimming', 'flying',   'climbing',
    'dancing',  'singing',  'reading',  'writing',  'building',
    'creating', 'exploring','thinking', 'growing',  'learning',
    'moving',   'resting',  'watching', 'listening','teaching',
];

const NOUNS = [
    'tiger',  'eagle',   'dolphin', 'wolf',   'panther',
    'falcon', 'otter',   'bear',    'fox',    'raven',
    'lion',   'crane',   'lynx',    'hawk',   'deer',
    'seal',   'owl',     'elk',     'mink',   'swan',
];

// ─── generatePseudoId ─────────────────────────────────────────────────────────

/**
 * Generate a deterministic verb-noun pseudonymous ID from a seed string.
 * The same seed always produces the same ID.  Not reversible — the seed is never stored.
 *
 * Algorithm: SHA-256(seed) → bytes 0-3 → verb index, bytes 4-7 → noun index.
 *
 * @param {string} seed  Arbitrary string (typically signalHash + deploymentSalt)
 * @returns {string}     Verb-noun ID, e.g. 'running-tiger'
 */
function generatePseudoId(seed) {
    const hash    = crypto.createHash('sha256').update(seed).digest();
    const verbIdx = hash.readUInt32BE(0) % VERBS.length;
    const nounIdx = hash.readUInt32BE(4) % NOUNS.length;
    return `${VERBS[verbIdx]}-${NOUNS[nounIdx]}`;
}

// ─── computeSignalHash ────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hash of correlation signals combined with a salt.
 * The hash is stored in user_platform_sightings as the verifiable but
 * non-reversible identity signal.
 *
 * @param {object} signals  Behavioral signals (style cluster, topic affinity, etc.)
 * @param {string} salt     Deployment-specific secret salt (from env)
 * @returns {string}        64-character hex SHA-256 hash
 */
function computeSignalHash(signals, salt) {
    const content = JSON.stringify({ signals, salt });
    return crypto.createHash('sha256').update(content).digest('hex');
}

// ─── correlateUser ────────────────────────────────────────────────────────────

/**
 * Find or create a pseudonymous user profile for the given correlation signals.
 * Returns null if confidence is below the minimum threshold.
 *
 * On first sighting:  creates pseudonymous_users + user_platform_sightings rows.
 * On repeat sighting: updates platform_count + last_sighted_at, adds sighting row.
 *
 * @param {{
 *   sourceId:       string,   UUID of data_sources row
 *   signalHash:     string,   SHA-256 of behavioral signals (from computeSignalHash)
 *   topicAffinity:  string[], Top topic categories (stored for audit)
 *   confidence:     number,   0.0–1.0 correlation confidence score
 * }} params
 * @returns {Promise<{
 *   pseudoUserId: string,
 *   pseudoId:     string,
 *   isNew:        boolean
 * } | null>}
 */
async function correlateUser({ sourceId, signalHash, topicAffinity = [], confidence }) {
    // Reject low-confidence correlations before any DB write
    if (confidence < CORRELATION_MIN_CONFIDENCE) {
        return null;
    }

    // Derive pseudo_id deterministically from signal hash + deployment salt
    const salt    = process.env.CORRELATION_SALT || 'pulse-of-ai-default-salt';
    const pseudoId = generatePseudoId(signalHash + salt);

    // Check if this pseudo_id already exists (same behavioral fingerprint)
    const existing = await dbGet(
        'SELECT id FROM pseudonymous_users WHERE pseudo_id = $1',
        [pseudoId],
    );

    if (existing) {
        // Existing profile — update stats and add sighting record
        await dbRun(
            `UPDATE pseudonymous_users
             SET last_sighted_at        = NOW(),
                 platform_count         = platform_count + 1,
                 correlation_confidence = GREATEST(correlation_confidence, $1)
             WHERE id = $2`,
            [confidence, existing.id],
        );

        await dbRun(
            `INSERT INTO user_platform_sightings
                (pseudo_user_id, source_id, signal_hash, confidence)
             VALUES ($1, $2, $3, $4)`,
            [existing.id, sourceId, signalHash, confidence],
        );

        return { pseudoUserId: existing.id, pseudoId, isNew: false };
    }

    // New profile — create pseudonymous user and first sighting
    const newUser = await dbRun(
        `INSERT INTO pseudonymous_users
            (pseudo_id, topic_affinity, platform_count, correlation_confidence)
         VALUES ($1, $2, 1, $3)
         RETURNING id`,
        [pseudoId, topicAffinity, confidence],
    );

    await dbRun(
        `INSERT INTO user_platform_sightings
            (pseudo_user_id, source_id, signal_hash, confidence)
         VALUES ($1, $2, $3, $4)`,
        [newUser.id, sourceId, signalHash, confidence],
    );

    return { pseudoUserId: newUser.id, pseudoId, isNew: true };
}

module.exports = {
    generatePseudoId,
    computeSignalHash,
    correlateUser,
    CORRELATION_MIN_CONFIDENCE,
};
