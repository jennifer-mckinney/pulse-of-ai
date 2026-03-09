// src/pipeline/discourse.js
// Deliberative Quality Index (DQI) scoring pipeline component.
//
// Reference: Steenbergen et al. (2003). "Measuring Political Deliberation:
//   A Discourse Quality Index." Comparative European Politics, 1(1), 21–48.
//
// This implementation adapts DQI with 4 NLP improvements:
//   1. Semantic deduplication of arguments (Phase D — embedding similarity)
//   2. Echo-chamber detection via source diversity signal (Phase D)
//   3. Source authority weighting (Phase D — citation credibility)
//   4. NLP claim-evidence linkage (heuristic here; ML in Phase D)
//
// Current (Phase B): heuristic scoring on 5 dimensions, each in [0,1].
//   total = mean of all 5 dimension scores.
//
// Dimensions:
//   participation    — post meets minimum substance threshold (word count)
//   justification    — contains reasoning connectors (because, therefore, since, etc.)
//   respectfulness   — absence of hostile/disrespectful language markers
//   constructiveness — contains solution-oriented language (should, could, propose, etc.)
//   evidence         — cites data, studies, or examples (according to, study, research, etc.)

'use strict';

const crypto = require('crypto');
const { dbGet, dbTransaction } = require('../db/connection');

const MODEL_NAME = 'dqi-heuristic-v1';

// ─── Dimension constants ──────────────────────────────────────────────────────

/** Exported for use in tests and methodology documentation. */
const DQI_DIMENSIONS = [
    'participation',
    'justification',
    'respectfulness',
    'constructiveness',
    'evidence',
];

// Minimum word count for a "participatory" post (below this → 0.0)
const MIN_WORDS_FULL = 50;
const MIN_WORDS_PARTIAL = 15;

// Reasoning connectors (justification dimension)
const JUSTIFICATION_MARKERS = [
    'because', 'therefore', 'since', 'thus', 'hence',
    'consequently', 'as a result', 'it follows that', 'given that',
    'for this reason', 'in order to', 'due to',
];

// Hostile language markers (respectfulness dimension — penalised)
const HOSTILE_MARKERS = [
    'stupid', 'idiot', 'garbage', 'worthless', 'moron', 'dumb',
    'pathetic', 'useless', 'hate', 'awful', 'terrible person',
    'shut up', 'go away',
];

// Constructive / solution language (constructiveness dimension)
const CONSTRUCTIVE_MARKERS = [
    'should', 'could', 'would', 'propose', 'suggest', 'recommend',
    'solution', 'approach', 'improve', 'address', 'invest', 'build',
    'implement', 'develop', 'constructive',
];

// Evidence / citation markers (evidence dimension)
const EVIDENCE_MARKERS = [
    'according to', 'research shows', 'studies show', 'study', 'research',
    'evidence', 'data', 'findings', 'survey', 'experiment', 'paper',
    'published', 'report', 'statistics', 'analysis indicates',
];

// ─── Dimension scoring helpers ────────────────────────────────────────────────

function scoreParticipation(lower, wordCount) {
    if (wordCount >= MIN_WORDS_FULL)    return 1.0;
    if (wordCount >= MIN_WORDS_PARTIAL) return 0.5;
    return 0.0;
}

function scoreJustification(lower) {
    const found = JUSTIFICATION_MARKERS.filter(m => lower.includes(m));
    // Full credit for 2+ markers; partial for 1; zero for none
    if (found.length >= 2) return 1.0;
    if (found.length === 1) return 0.5;
    return 0.0;
}

function scoreRespectfulness(lower) {
    // Starts at 1.0; each hostile marker deducts 0.25, floor at 0
    const hits = HOSTILE_MARKERS.filter(m => lower.includes(m)).length;
    return Math.max(0, 1.0 - hits * 0.25);
}

function scoreConstructiveness(lower) {
    const found = CONSTRUCTIVE_MARKERS.filter(m => lower.includes(m));
    if (found.length >= 3) return 1.0;
    if (found.length >= 1) return 0.5;
    return 0.0;
}

function scoreEvidence(lower) {
    const found = EVIDENCE_MARKERS.filter(m => lower.includes(m));
    if (found.length >= 2) return 1.0;
    if (found.length === 1) return 0.5;
    return 0.0;
}

// ─── Pure scoring ─────────────────────────────────────────────────────────────

/**
 * Compute DQI score for a piece of text.
 * Pure function — no database access, no side effects.
 *
 * @param {string} text  Raw post content to score
 * @returns {{
 *   total:      number,   // mean of all 5 dimension scores, in [0,1]
 *   dimensions: {
 *     participation:    number,
 *     justification:    number,
 *     respectfulness:   number,
 *     constructiveness: number,
 *     evidence:         number
 *   }
 * }}
 */
function computeDQI(text) {
    const safe      = (text || '').trim();
    const lower     = safe.toLowerCase();
    const wordCount = safe ? safe.split(/\s+/).length : 0;

    if (!safe) {
        const zero = Object.fromEntries(DQI_DIMENSIONS.map(d => [d, 0]));
        return { total: 0, dimensions: zero };
    }

    const dimensions = {
        participation:    scoreParticipation(lower, wordCount),
        justification:    scoreJustification(lower),
        respectfulness:   scoreRespectfulness(lower),
        constructiveness: scoreConstructiveness(lower),
        evidence:         scoreEvidence(lower),
    };

    const total = Object.values(dimensions).reduce((sum, v) => sum + v, 0) / DQI_DIMENSIONS.length;

    return { total, dimensions };
}

// ─── DB persistence ───────────────────────────────────────────────────────────

/**
 * Score a raw post with DQI and persist with full audit trail.
 * Idempotent: a second call for the same postId is a no-op.
 *
 * @param {string} postId  UUID of raw_posts row
 * @param {string} jobId   UUID of processing_jobs row
 * @param {string} mvId    UUID of methodology_versions row (component='discourse')
 * @returns {Promise<object>}  The saved discourse_results row
 */
async function saveDQI(postId, jobId, mvId) {
    const post = await dbGet('SELECT content FROM raw_posts WHERE id = $1', [postId]);
    if (!post || !post.content) {
        throw new Error(`saveDQI: post ${postId} not found or content already nulled`);
    }

    // Idempotency check
    const existing = await dbGet(
        'SELECT * FROM discourse_results WHERE raw_post_id = $1',
        [postId],
    );
    if (existing) return existing;

    const scored    = computeDQI(post.content);
    const inputHash = crypto.createHash('sha256').update(post.content).digest('hex');

    return dbTransaction(async (client) => {
        // 1. Write decision_audit_log row
        const auditResult = await client.query(
            `INSERT INTO decision_audit_log
                (raw_post_id, job_id, methodology_version_id,
                 decision_type, model_name, input_hash, output, confidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
                postId,
                jobId,
                mvId,
                'discourse',
                MODEL_NAME,
                inputHash,
                JSON.stringify({ total: scored.total, dimensions: scored.dimensions }),
                scored.total,   // use DQI total as confidence proxy
            ],
        );
        const auditId = auditResult.rows[0].id;

        // 2. Write discourse_results row
        const discResult = await client.query(
            `INSERT INTO discourse_results
                (raw_post_id, audit_id, dqi_total, dimensions)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [
                postId,
                auditId,
                scored.total,
                JSON.stringify(scored.dimensions),
            ],
        );

        return discResult.rows[0];
    });
}

module.exports = { computeDQI, saveDQI, DQI_DIMENSIONS };
