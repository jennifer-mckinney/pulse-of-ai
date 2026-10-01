// src/routes/audit.js
// GET /api/audit/:post_id
//
// Returns the full decision trail for a single raw post.
// This is the explainability endpoint — every inference is traceable to:
//   - The exact model and version used
//   - The input fingerprint (keyed — see below; never raw content)
//   - The full scored output
//   - The plain-English justification from methodology_versions
//   - FOUR audience representations per step (public / plain / config /
//     researcher), rendered at read time by the versioned templates in
//     src/config/audit-narration.js — no per-post prose is stored or invented
//   - The bias fairness layers for the post's processing job (value, τ,
//     citation, pass/fail/n-a) from bias_assessments + the versioned 'bias'
//     methodology config
//
// input_hash exposure: decision_audit_log.input_hash stores an UNSALTED
// SHA-256 of post content — the internal, immutable input fingerprint (the
// replay, src/audit/replay.js, re-hashes the stored content against it); it is
// never joined on and never modified.
// The API exposes HMAC-SHA256(AUDIT_HASH_KEY, storedHash) instead; when the
// key is unset the field is OMITTED entirely (never raw).
//
// Returns:
//   200 { provenance: { source, published_at, permalink, external_id,
//                       fingerprint, verifiable,              (decision D2)
//                       retention? },   platform-terms sources (Reddit):
//                                       { status: 'live', removes_at, notice }
//                                       or { status: 'text_removed',
//                                       removed_at, reason, notice } (ADR
//                                       0001 ruling 9)
//         post: {...}, narration: {...}, ingest: {...}|null,
//         decisions: [...],
//         bias: { job_id, assessed_at, model_name, version,
//                 lineage, lineage_fallback, layers } }
//   400 if post_id is not a valid UUID
//   404 if the post does not exist
//   500 on DB error (no stack trace returned to client)

'use strict';

const { logRouteError } = require('../middleware/log-error');

const crypto           = require('crypto');
const { Router }       = require('express');
const { dbGet, dbAll } = require('../db/connection');
const {
    NARRATION_COMPONENT,
    NARRATION_VERSION,
    renderAudiences,
    deriveScore,
    deriveStatus,
    renderIngestStep,
    VERIFY_PROVENANCE_COMMAND,
    PROVENANCE_VERIFIABLE,
} = require('../config/audit-narration');
const { buildLayers } = require('../config/bias-vocabulary');
const { DEMO_SOURCE_TYPE } = require('../config/data-mode');
const { attributionFor } = require('../config/source-registry');
const { retentionStatus } = require('../collectors/retention');
const {
    resolveBiasLineage,
    currentBiasVersion,
    loadBiasVersions,
} = require('../config/bias-lineage');

const router = Router();

// Route-init warning (once): without a key the endpoint silently drops the
// input fingerprint, which operators should know about before wondering why
// external consumers can't see it.
/* istanbul ignore start -- AUDIT_HASH_KEY is always set in test environment */
if (!process.env.AUDIT_HASH_KEY) {
    console.warn(
        '[audit] AUDIT_HASH_KEY is not set — input_hash will be omitted from '
        + '/api/audit responses. Generate one with: openssl rand -hex 32',
    );
}
/* istanbul ignore end */

// UUID v4 regex — used to validate path params before hitting the DB
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/audit/:post_id', async (req, res) => {
    try {
        const { post_id } = req.params;

        if (!UUID_REGEX.test(post_id)) {
            return res.status(400).json({ error: 'Invalid post ID: must be a UUID' });
        }

        // Fetch the raw post with source info
        const post = await dbGet(
            `SELECT
                rp.id,
                rp.content,
                rp.location,
                rp.collected_at,
                rp.external_id,
                rp.provenance_fingerprint,
                rp.ingest_mv_id,
                rp.admission_mv_id,
                rp.text_removed_at,
                rp.text_removed_reason,
                rp.raw_payload->>'url'          AS permalink,
                rp.raw_payload->>'published_at' AS published_at,
                ds.category    AS source_category,
                ds.name        AS source_name,
                ds.source_type AS source_type
             FROM raw_posts rp
             JOIN data_sources ds ON ds.id = rp.source_id
             WHERE rp.id = $1`,
            [post_id],
        );

        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        // Fetch all decision audit records for this post, joined with methodology metadata
        const decisions = await dbAll(
            `SELECT
                dal.decision_type,
                dal.model_name,
                dal.job_id,
                mv.version   AS methodology_version,
                mv.config,
                mv.justification,
                dal.input_hash,
                dal.output,
                dal.confidence,
                dal.created_at
             FROM decision_audit_log dal
             JOIN methodology_versions mv ON mv.id = dal.methodology_version_id
             WHERE dal.raw_post_id = $1
             ORDER BY dal.created_at ASC`,
            [post_id],
        );

        // input_hash is keyed to prevent offline hash-confirmation of post
        // content (security review L1, 2026-07-06): the stored value is an
        // unsalted SHA-256 of the content, so returning it raw would let
        // anyone confirm a guessed post text offline. External log consumers
        // verify content in their own systems; the DB value stays untouched
        // as the internal immutable input fingerprint (replay verification,
        // src/audit/replay.js). Key read per-request so tests
        // (and rotations) see the current environment.
        const auditKey = process.env.AUDIT_HASH_KEY;
        const exposed = decisions.map((d) => {
            const { input_hash, job_id, ...rest } = d;
            // Four audience representations + headline score/status, rendered
            // read-time from the STORED output/config (versioned templates —
            // see src/config/audit-narration.js). job_id stays internal (used
            // for the bias layers below, not part of the decision payload).
            const enriched = {
                ...rest,
                status:    deriveStatus(d),
                score:     deriveScore(d),
                audiences: renderAudiences(d, post.id),
            };
            if (!auditKey) return enriched;  // no key → omit, NEVER fall back to raw
            return {
                ...enriched,
                input_hash: crypto
                    .createHmac('sha256', auditKey)
                    .update(input_hash)
                    .digest('hex'),
            };
        });

        // ── Bias fairness layers for this post's processing job (gap G18) ────
        // The job that produced the post's decisions also ran the bias checks;
        // surface those job-level assessments as per-step fairness layers.
        // Citations / display names / planned layers come from the versioned
        // 'bias' methodology config — layers degrade gracefully when either
        // the assessments or the config are absent.
        const latestJobId = decisions.length > 0
            ? decisions[decisions.length - 1].job_id
            : null;

        // Methodology lineage (PR #8 review): the receipt names the bias
        // version that PRODUCED these assessments, not the newest one.
        // Rows record it in methodology_version_id (migration 010); older
        // rows with a NULL column are resolved at read time from
        // effective_from and labeled lineage 'inferred'
        // (src/config/bias-lineage.js). model_name + version ride along so
        // the drawer's bias step shows the same model@version pill as every
        // other pipeline step.
        let biasAssessments = [];
        if (latestJobId) {
            biasAssessments = await dbAll(
                `SELECT assessment_type, group_field, group_value, metric_name,
                        metric_value, threshold, is_violation, severity, created_at,
                        methodology_version_id
                 FROM bias_assessments
                 WHERE job_id = $1
                 ORDER BY created_at ASC`,
                [latestJobId],
            );
        }
        const biasVersions = await loadBiasVersions(dbAll);
        const latestBias = biasAssessments[biasAssessments.length - 1] || null;
        // One job = one pipeline run = one biasMvId, so the latest row's
        // lineage speaks for the job. With no assessments, nothing produced
        // anything: the CURRENT version supplies the planned-layer coverage,
        // and lineage 'current' says exactly that.
        const resolved = latestBias
            ? resolveBiasLineage(latestBias, biasVersions)
            : (() => {
                const current = currentBiasVersion(biasVersions);
                return { mv: current, lineage: current ? 'current' : null, fallback: false };
            })();
        const biasMv = resolved.mv;
        const biasConfig = biasMv ? biasMv.config : null;

        const biasBlock = {
            job_id:      latestJobId,
            assessed_at: latestBias ? latestBias.created_at : null,
            // Versioned bias-monitor identity (e.g. pulse-bias-monitor-v1 @
            // 1.1.0); null when no 'bias' methodology is registered — the
            // frontend omits the pill rather than inventing one.
            model_name:  biasMv ? biasMv.model_name : null,
            version:     biasMv ? biasMv.version    : null,
            // 'recorded' | 'inferred' | 'current' | null; lineage_fallback
            // is true only when an inferred row predates every version.
            lineage:          resolved.lineage,
            lineage_fallback: resolved.fallback,
            layers:      buildLayers(biasAssessments, biasConfig),
        };

        // ── Synthetic ingestion step (versioned 'ingest' methodology) ─────────
        // Ingestion is not an inference so it has no decision_audit_log rows;
        // its regulator-relevant facts (PII fields stripped, city granularity,
        // legal basis) live in the registered methodology config.
        // G10-11: the version the post was STORED under (raw_posts.
        // ingest_mv_id, lineage 'recorded'); for rows stored before
        // migration 022, the ingest version effective at collected_at
        // (lineage 'inferred'; the earliest one when the post predates
        // every registered version).
        let ingestMv = null;
        let ingestLineage = null;
        if (post.ingest_mv_id) {
            ingestMv = await dbGet(
                `SELECT model_name, version, config FROM methodology_versions WHERE id = $1 AND component = 'ingest'`,
                [post.ingest_mv_id],
            );
            if (ingestMv) ingestLineage = 'recorded';
        }
        if (!ingestMv) {
            ingestMv = await dbGet(
                `SELECT model_name, version, config FROM methodology_versions
                 WHERE component = 'ingest'
                 ORDER BY (effective_from <= $1) DESC,
                          CASE WHEN effective_from <= $1 THEN effective_from END DESC NULLS LAST,
                          effective_from ASC
                 LIMIT 1`,
                [post.collected_at],
            );
            if (ingestMv) ingestLineage = 'inferred';
        }

        // ── Provenance (decision D2) ───────────────────────────────────────
        // Traceability back to the source without storing identity: the
        // permalink when it is not an identity link, the stored (identity-
        // free) external id, and the keyed provenance fingerprint that
        // `npm run verify-provenance` reproduces from the original.
        const demo = post.source_type === DEMO_SOURCE_TYPE;
        const provenance = {
            source:       post.source_name,
            published_at: post.published_at || null,
            permalink:    /^https?:\/\//.test(post.permalink || '') ? post.permalink : null,
            external_id:  post.external_id,
            fingerprint:  post.provenance_fingerprint || null,
            verifiable:   post.provenance_fingerprint
                ? `${PROVENANCE_VERIFIABLE}: ${VERIFY_PROVENANCE_COMMAND.replace('{post_id}', post.id)}`
                : (demo
                    ? 'not applicable: fictional demo content, never collected from a source'
                    : 'no provenance fingerprint was recorded for this post (collected before ingest@1.3.0, or no provenance key was configured)'),
        };
        // ADR 0001 ruling 9: platform-terms retention (Reddit). A live post
        // says when its text will be removed; a blanked one shows the removal
        // notice as its text and says why, and that its scores and audit rows
        // were retained by owner decision.
        const retention = retentionStatus(post.source_name, {
            collectedAt: post.collected_at,
            textRemovedAt: post.text_removed_at,
            textRemovedReason: post.text_removed_reason,
        });
        if (retention) provenance.retention = retention;
        // PR #22 G6: the admission-filter version the post was stored under.
        const admissionMv = post.admission_mv_id ? await dbGet(
            `SELECT version FROM methodology_versions WHERE id = $1 AND component = 'admission_filter'`, [post.admission_mv_id]) : null;
        provenance.admission = admissionMv
            ? { component: 'admission_filter', version: admissionMv.version, lineage: 'recorded' }
            : { component: 'admission_filter', version: null,
                lineage: demo ? 'not applicable: fictional demo content' : 'not recorded: stored before the admission filter was versioned (migration 042)' };

        return res.json({
            provenance,
            post: {
                id:              post.id,
                content_snippet: post.content.slice(0, 120),
                location:        post.location,
                source_category: post.source_category,
                source_name:     post.source_name,
                // credit the source's terms require next to its content, or null
                attribution:     attributionFor(post.source_name),
                // 'demo' for fictional demo-feed posts, else 'live'
                data_origin:     post.source_type === DEMO_SOURCE_TYPE ? 'demo' : 'live',
                collected_at:    post.collected_at,
            },
            narration: { component: NARRATION_COMPONENT, version: NARRATION_VERSION },
            // Demo-feed posts get the fictional-content ingestion wording
            // (audit_narration 1.2.0 — src/config/data-mode.js defines demo).
            ingest:    ingestMv
                ? { ...renderIngestStep(ingestMv, { demo, provenance, postId: post.id }), lineage: ingestLineage }
                : null,
            decisions: exposed,
            bias:      biasBlock,
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        logRouteError('audit', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
