// src/audit/replay.js
// Deterministic replay of one post's stored decisions (P1-4). This is the
// engine behind `npm run replay -- --post <id>` (scripts/replay.js), the
// reproduce command that every researcher view of the audit receipt prints.
//
// What a replay does, per stored decision_audit_log row:
//   1. Verifies the stored post content still hashes to the row's input_hash
//      (SHA-256, exactly as the pipeline computed it at scoring time).
//   2. Re-runs the deterministic scorer from src/pipeline over that content.
//   3. Diffs the replayed output against the STORED output, field by field,
//      and returns PASS or DIVERGENCE for the stage.
//
// Honesty rules (never fake a pass):
//   - A stage with no deterministic scorer in src/pipeline, a post whose
//     content is no longer stored, or a stored output carrying none of the
//     reproducible fields is NOT RE-RUNNABLE, with the reason stated.
//   - Stored fields that are absent are listed as "not compared"; they are
//     never treated as agreeing.
//   - A replay runs the CURRENT code. When the row's model_name snapshot or
//     the registered methodology config disagrees with what the code
//     actually does, that is reported as a caveat / config drift instead of
//     being hidden behind a PASS.
//   - Receipt stages that are not per-post inferences (ingestion's PII strip,
//     the job-level bias checks) are reported as out of per-post replay
//     scope, never silently omitted.
//
// Pure module: no DB access. scripts/replay.js loads the rows and prints the
// report this module builds.

'use strict';

const crypto = require('crypto');
const sentiment = require('../pipeline/sentiment');
const relevance = require('../pipeline/relevance');
const discourse = require('../pipeline/discourse');

// Numeric outputs round-trip through JSONB exactly (JSON.stringify emits the
// shortest round-trip form), so this tolerance only absorbs representation
// noise; any real scoring change is orders of magnitude larger.
const NUM_TOLERANCE = 1e-12;

const STATUS = Object.freeze({
    PASS: 'PASS',
    DIVERGENCE: 'DIVERGENCE',
    NOT_RERUNNABLE: 'NOT RE-RUNNABLE',
});

// ─── Per-stage deterministic scorers ─────────────────────────────────────────
// fields: the stored-output keys the pipeline writes for the stage (the
// exact JSON the save* functions persist), compared field by field.
const STAGES = {
    sentiment: {
        model: sentiment.MODEL_NAME,
        fields: ['score', 'comparative', 'indicator', 'positiveWords', 'negativeWords'],
        run: (text) => sentiment.computeSentiment(text),
        configDrift(config) {
            const notes = [];
            if (!config) return notes;
            if (config.positive_threshold !== undefined
                && Number(config.positive_threshold) !== sentiment.POSITIVE_THRESHOLD) {
                notes.push(`registered positive_threshold ${config.positive_threshold} ≠ code ${sentiment.POSITIVE_THRESHOLD}`);
            }
            if (config.negative_threshold !== undefined
                && Number(config.negative_threshold) !== sentiment.NEGATIVE_THRESHOLD) {
                notes.push(`registered negative_threshold ${config.negative_threshold} ≠ code ${sentiment.NEGATIVE_THRESHOLD}`);
            }
            return notes;
        },
    },
    relevance: {
        model: relevance.MODEL_NAME,
        fields: ['score', 'matchedKeywords'],
        run: (text) => relevance.computeRelevance(text),
        configDrift(config) {
            const notes = [];
            if (!config || !Array.isArray(config.keywords)) return notes;
            const code = new Set(relevance.KEYWORD_LIST);
            const reg = new Set(config.keywords);
            const onlyReg = [...reg].filter(k => !code.has(k));
            const onlyCode = [...code].filter(k => !reg.has(k));
            if (onlyReg.length || onlyCode.length) {
                notes.push(`registered keyword list (${reg.size}) ≠ code lexicon (${code.size}): `
                    + `${onlyReg.length} registered-only, ${onlyCode.length} code-only`);
            }
            if (config.score_per_match !== undefined
                && Number(config.score_per_match) !== 1 / relevance.KEYWORD_LIST.length) {
                notes.push(`registered score_per_match ${config.score_per_match} ≠ code 1/${relevance.KEYWORD_LIST.length}`);
            }
            return notes;
        },
    },
    discourse: {
        model: discourse.MODEL_NAME,
        fields: ['total', 'dimensions'],
        run: (text) => discourse.computeDQI(text),
        configDrift(config) {
            const notes = [];
            if (!config || !config.dimensions || typeof config.dimensions !== 'object') return notes;
            const reg = Object.keys(config.dimensions).sort();
            const code = [...discourse.DQI_DIMENSIONS].sort();
            if (reg.join(',') !== code.join(',')) {
                notes.push(`registered DQI dimensions [${reg.join(', ')}] ≠ code dimensions [${code.join(', ')}]`);
            }
            return notes;
        },
    },
};

// Receipt stages that are NOT per-post inferences — stated, never omitted.
const OUT_OF_SCOPE = [
    {
        stage: 'ingestion',
        reason: 'PII stripping ran before storage and the pre-strip payload is not retained, '
            + 'so there is no input to re-run it on',
    },
    {
        stage: 'bias',
        reason: 'fairness checks are job-level aggregates over every post in the processing job, '
            + 'not a per-post inference; they cannot be re-derived from one post',
    },
];

// ─── Diff helpers ────────────────────────────────────────────────────────────

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/** Deep equality with numeric tolerance (arrays ordered, objects by key). */
function sameValue(a, b) {
    if (typeof a === 'number' && typeof b === 'number') {
        return Math.abs(a - b) <= NUM_TOLERANCE;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((v, i) => sameValue(v, b[i]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ka = Object.keys(a).sort();
        const kb = Object.keys(b).sort();
        if (ka.join('\u0000') !== kb.join('\u0000')) return false;
        return ka.every(k => sameValue(a[k], b[k]));
    }
    return a === b;
}

function show(value) {
    return JSON.stringify(value);
}

// ─── Replay ──────────────────────────────────────────────────────────────────

/**
 * Replay one stored decision against the stored post content.
 * @param {string|null} content  raw_posts.content (null/'' when no longer stored)
 * @param {object} d  { decision_type, model_name, input_hash, output,
 *                      component, version, registered_model, config }
 * @returns {{ stage, version, model, status, reason, diffs, notCompared, caveats }}
 */
function replayDecision(content, d, removal = null) {
    const result = {
        stage: d.decision_type,
        version: d.version || null,
        model: d.model_name || null,
        status: STATUS.NOT_RERUNNABLE,
        reason: null,
        diffs: [],
        notCompared: [],
        caveats: [],
    };
    const spec = STAGES[d.decision_type];

    if (!spec) {
        result.reason = `no deterministic scorer in src/pipeline for decision type '${d.decision_type}'`;
        return result;
    }
    if (typeof content !== 'string' || content === '') {
        result.reason = 'stored post content is no longer available (retention compaction or erasure)';
        return result;
    }
    // ADR 0001 ruling 9: a platform-terms post (Reddit) whose text was
    // replaced by the removal notice cannot be re-run — the content no
    // longer hashes to the input that was scored.
    if (removal && removal.removedAt) {
        result.reason = `post text removed under platform terms (${removal.reason || 'retention'}) at `
            + `${new Date(removal.removedAt).toISOString()}: the Reddit Data API Terms allow keeping it at most 48 hours or `
            + 'until it is deleted upstream, so the content hash no longer matches; scores and audit rows are retained by '
            + 'owner decision (ADR 0001 ruling 9)';
        return result;
    }

    const stored = d.output && typeof d.output === 'object' ? d.output : {};
    const present = spec.fields.filter(f => Object.prototype.hasOwnProperty.call(stored, f));
    result.notCompared = spec.fields.filter(f => !present.includes(f));
    if (present.length === 0) {
        result.reason = `stored output carries none of the reproducible fields (${spec.fields.join(', ')})`;
        return result;
    }

    // Code identity + registered-config caveats (a replay runs TODAY's code).
    if (d.model_name && d.model_name !== spec.model) {
        result.caveats.push(`stored model_name '${d.model_name}' ≠ code model '${spec.model}' — `
            + 'replayed with the current code, so agreement does not prove the same build scored it');
    }
    for (const drift of spec.configDrift(d.config)) {
        result.caveats.push(`config drift: ${drift}`);
    }

    // Input identity: the content must still be exactly what was scored.
    if (d.input_hash && sha256(content) !== d.input_hash) {
        result.status = STATUS.DIVERGENCE;
        result.diffs.push({
            field: 'input_hash',
            stored: d.input_hash,
            replayed: sha256(content),
        });
        result.reason = 'stored content no longer hashes to the input that was scored';
        return result;
    }
    if (!d.input_hash) {
        result.caveats.push('no stored input_hash — input identity could not be verified');
    }

    const replayed = spec.run(content);
    for (const field of present) {
        if (!sameValue(stored[field], replayed[field])) {
            result.diffs.push({ field, stored: stored[field], replayed: replayed[field] });
        }
    }
    result.status = result.diffs.length === 0 ? STATUS.PASS : STATUS.DIVERGENCE;
    return result;
}

/**
 * Replay every stored decision for one post.
 * @param {{ post: { id, content }, decisions: Array<object> }} input
 * @returns {{ postId, stages, outOfScope, result, exitCode }}
 *   result: 'PASS' (every decision stage re-ran and matched),
 *           'DIVERGENCE' (any stage diverged — exit 1),
 *           'PARTIAL' (no divergence, but some/all stages could not be
 *           re-run, or the post has no decisions — exit 3; never a pass).
 */
function replayPost({ post, decisions }) {
    const removal = post.text_removed_at ? { removedAt: post.text_removed_at, reason: post.text_removed_reason } : null;
    const stages = (decisions || []).map(d => replayDecision(post.content, d, removal));
    const diverged = stages.some(s => s.status === STATUS.DIVERGENCE);
    const unrun = stages.some(s => s.status === STATUS.NOT_RERUNNABLE);
    let result;
    if (diverged) result = 'DIVERGENCE';
    else if (unrun || stages.length === 0) result = 'PARTIAL';
    else result = 'PASS';
    return {
        postId: post.id,
        stages,
        outOfScope: OUT_OF_SCOPE,
        result,
        exitCode: result === 'PASS' ? 0 : result === 'DIVERGENCE' ? 1 : 3,
    };
}

/** Human-readable report lines for a replayPost() result. */
function formatReport(report) {
    const lines = [`Replay — post ${report.postId}`];
    if (report.stages.length === 0) {
        lines.push('  (no stored decisions for this post — nothing to re-run)');
    }
    for (const s of report.stages) {
        const ident = [s.model, s.version ? `methodology ${s.version}` : null]
            .filter(Boolean).join(' @ ');
        lines.push(`  [${s.status}] ${s.stage}${ident ? ` (${ident})` : ''}`);
        if (s.reason) lines.push(`      reason: ${s.reason}`);
        for (const diff of s.diffs) {
            lines.push(`      ${diff.field}: stored ${show(diff.stored)} ≠ replayed ${show(diff.replayed)}`);
        }
        if (s.notCompared.length && s.status !== STATUS.NOT_RERUNNABLE) {
            lines.push(`      not compared (absent from stored output): ${s.notCompared.join(', ')}`);
        }
        for (const c of s.caveats) lines.push(`      caveat: ${c}`);
    }
    for (const o of report.outOfScope) {
        lines.push(`  [${STATUS.NOT_RERUNNABLE}] ${o.stage} — out of per-post replay scope: ${o.reason}`);
    }
    lines.push(`RESULT: ${report.result}`);
    return lines;
}

module.exports = {
    STATUS,
    STAGES,
    OUT_OF_SCOPE,
    NUM_TOLERANCE,
    sameValue,
    replayDecision,
    replayPost,
    formatReport,
};
