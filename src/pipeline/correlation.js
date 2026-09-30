// src/pipeline/correlation.js
// Cross-platform user correlation with privacy-preserving pseudonymous identifiers.
//
// Privacy model:
//   - No usernames, handles, or platform IDs are ever stored
//   - Behavioral signals (writing style + topic affinity + temporal pattern) are
//     hashed with a deployment-specific salt — not reversible
//   - Pseudonymous IDs use an adjective-animal format ('balanced-impala') drawn from
//     unique-names-generator (1,202 × 355 = 426,710 combinations) — human-readable
//     but unlinked to any real identity
//   - NOT IMPLEMENTED (PR #22 grumpy M7): no identity signal exists on
//     identity-free data, and its design needs the DPIA (spec §20). The
//     gate (src/pipeline/correlation-gate.js) reports 'not_implemented' and
//     correlateUser throws; no profile is ever created.
//
// Entry points:
//   generatePseudoId(seed)                    — deterministic adjective-animal from seed
//   computeSignalHash(signals, salt)          — keyed HMAC-SHA256 of signals
//   correlateUser()                           — throws CorrelationNotImplementedError
//
// See: src/db/migrations/006_correlation_tables.sql

'use strict';

const { isUsableSalt, NOT_IMPLEMENTED_REASON } = require('./correlation-gate');

const crypto = require('crypto');
const { adjectives, animals, uniqueNamesGenerator } = require('unique-names-generator');

// ─── Constants ─────────────────────────────────────────────────────────────────

// unique-names-generator provides curated, library-maintained word pools.
// adjectives (1,202 words) × animals (355 words) = 426,710 combinations.
// This replaces the previous 20×20 = 400 hardcoded list which had unacceptable
// collision probability at 10,000+ events per 2–3 minute cycle.
const NAME_CONFIG = {
    dictionaries: [adjectives, animals],
    separator: '-',
    style: 'lowerCase',
};

// ─── generatePseudoId ─────────────────────────────────────────────────────────

/**
 * Generate a deterministic adjective-animal pseudonymous ID from a seed string.
 * The same seed always produces the same ID.  Not reversible — the seed is never stored.
 *
 * Algorithm: SHA-256(seed) → UInt32 at bytes 0–3 → integer seed for
 * unique-names-generator, which applies its own LCG to select word indices.
 * The library's integer seed API guarantees determinism across calls.
 *
 * @param {string} seed  Arbitrary string (typically signalHash + deploymentSalt)
 * @returns {string}     Adjective-animal ID, e.g. 'balanced-impala'
 */
function generatePseudoId(seed) {
    // Derive a stable 32-bit integer from the seed — feeds uniqueNamesGenerator's
    // seeded PRNG so we get determinism without storing the raw seed.
    const hash      = crypto.createHash('sha256').update(seed).digest();
    const seedInt   = hash.readUInt32BE(0);
    return uniqueNamesGenerator({ ...NAME_CONFIG, seed: seedInt });
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
    // Keyed (HMAC-SHA256 with the deployment salt), so the stored signal
    // cannot be confirmed from a guessed signal without the salt.
    if (!isUsableSalt(salt)) throw new Error('computeSignalHash needs the per-deployment salt (unset or placeholder)');
    return crypto.createHmac('sha256', salt).update(JSON.stringify(signals)).digest('hex');
}

// ─── correlateUser ────────────────────────────────────────────────────────────

/** Thrown by correlateUser: no identity signal is designed or implemented. */
class CorrelationNotImplementedError extends Error {
    constructor() {
        super(NOT_IMPLEMENTED_REASON);
        this.name = 'CorrelationNotImplementedError';
        this.code = 'CORRELATION_NOT_IMPLEMENTED';
    }
}

/**
 * Cross-platform correlation is NOT IMPLEMENTED (PR #22 grumpy M7): the only
 * signal identity-free data offers (a post's topics plus its posting hour)
 * is not an identity signal, and designing one needs the DPIA (spec §20).
 * The former body created profiles from post-level signals with confidence
 * 0 — a no-op that pretended to be a pipeline stage, and a mis-linking
 * hazard if the threshold were ever lowered. It is removed: this always
 * throws, so no pseudonymous_users / user_platform_sightings row can be
 * written from a non-identity signal. A DPIA-approved design replaces it.
 * @returns {Promise<never>}
 */
async function correlateUser() {
    throw new CorrelationNotImplementedError();
}

module.exports = {
    generatePseudoId,
    computeSignalHash,
    correlateUser,
    CorrelationNotImplementedError,
};
