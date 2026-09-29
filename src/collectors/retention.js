// src/collectors/retention.js
// Text retention for every collected post, by BLANKING (P10-2; ADR 0001
// ruling 9 and its generalisation).
//
// Every real (non-demo) source has a window after which a post's TEXT is
// removed (src/config/source-registry.js retentionHours):
//   - platform terms (`retention` block): Reddit 48 h (ruling 9, Jennifer:
//     "Blank text, keep audit rows"), the Guardian 24 h (its terms §5),
//     YouTube and TikTok 30 days. For the Guardian, YouTube and TikTok the
//     ruling-9 mechanism is applied BY ANALOGY, for consistency — recorded in
//     the ADR and flagged for Jennifer's confirmation;
//   - otherwise the spec §19 detail window, RETENTION_DETAIL_DAYS (90) days.
// Reddit posts are also blanked as soon as the 6-hourly re-check sees them
// deleted upstream (src/collectors/reddit/recheck.js → blankPosts).
//
//   WHAT  raw_posts.content (NOT NULL) becomes the source's removal notice;
//         raw_payload loses its text: the text and title keys (present on
//         rows stored before ingest@1.6.0, which stopped duplicating them)
//         become the notice, and the url is removed — except Reddit's, which
//         is cut to the slug-less permalink (the slug is made from the
//         title). text_removed_at / text_removed_reason record when and why
//         (migration 025).
//   KEEP  the row, the external id, the provenance fingerprint (anyone with
//         the original URL can still prove the match: npm run
//         verify-provenance), the content hash, and every score and
//         decision_audit_log row.
//   LOG   one data_retention_log row per batch that changed rows, listing
//         the post ids ACTUALLY changed (RETURNING), never a claim about rows
//         that were not touched: action 'blanked_platform_terms' (platform
//         window or upstream deletion) or 'text_removed_detail_window' (§19).
//
// SCOPE: every UPDATE re-applies, in SQL, the source's own name and
// source_type <> 'demo', so no other source's row — and never a demo row
// (demo posts are purged whole, scripts/compact.js) — can be touched.
//
// The job runs in the worker as the repeatable `maintenance` job
// (src/workers/maintenance.worker.js), every 5 minutes.

'use strict';

const { dbAll, dbGet, dbTransaction } = require('../db/connection');
const { getSource, retentionHours } = require('../config/source-registry');
const { DEMO_SOURCE_TYPE } = require('../config/data-mode');

const BLANK_ACTION = 'blanked_platform_terms';
const DETAIL_ACTION = 'text_removed_detail_window';
// Reddit's notice (ruling 9); every retention source carries its own.
const REMOVAL_NOTICE = '[removed: Reddit Data API Terms retention]';
const DETAIL_NOTICE = '[removed: detail retention window (spec §19)]';
const RETAINED_NOTE = 'Audit and score rows (decision_audit_log, sentiment/relevance/discourse results, embeddings) '
    + 'are retained by owner decision: ADR 0001 ruling 9, Jennifer 2026-09-29, "Blank text, keep audit rows".';
const DETAIL_LEGAL_BASIS = 'GDPR Article 5(1)(e) - Storage Limitation: post text is kept for the detail window '
    + '(TECHNICAL_SPEC §19) and then removed; scores, audit rows and monthly rollups remain.';
const DEFAULT_BATCH = 500;
const MAX_BATCH = 5000;

/** Registry sources with a platform-terms retention window. */
function retentionSources() {
    const { SOURCES } = require('../config/source-registry');
    return SOURCES.filter(s => s.retention && s.retention.maxAgeHours > 0);
}

/** The source's retention notice (for receipts), or null. */
function retentionNotice(slug) {
    const src = getSource(slug);
    return src && src.retention ? src.retention.notice : null;
}

/** What replaces a post's text for a source (platform notice or the §19 notice). */
function removalNoticeFor(slug) {
    const src = getSource(slug);
    return src && src.retention ? (src.retention.removalNotice || REMOVAL_NOTICE) : DETAIL_NOTICE;
}

/**
 * Remove the text of the given posts of ONE source. Only non-demo rows of
 * that source whose text is still stored are touched. Must run in a
 * transaction. Writes one data_retention_log row when anything changed.
 * @param {import('pg').PoolClient} client
 * @param {string} slug  data_sources.name
 * @param {string[]} postIds
 * @param {{ reason: string, rule: string, performedBy: string, platform: boolean }} o
 * @returns {Promise<string[]>} ids changed
 */
async function removeTextBatch(client, slug, postIds, { reason, rule, performedBy, platform }) {
    if (!postIds.length) return [];
    const src = getSource(slug);
    const notice = platform ? removalNoticeFor(slug) : DETAIL_NOTICE;
    const keepUrl = platform && src && src.retention && src.retention.keepUrlPrefix ? src.retention.keepUrlPrefix : null;
    const res = await client.query(
        `UPDATE raw_posts rp
         SET content = $4,
             raw_payload = (COALESCE(rp.raw_payload, '{}'::jsonb) - 'text' - 'title' - 'url')
                 || CASE WHEN rp.raw_payload ? 'text' THEN jsonb_build_object('text', $4::text) ELSE '{}'::jsonb END
                 || CASE WHEN rp.raw_payload ? 'title' THEN jsonb_build_object('title', $4::text) ELSE '{}'::jsonb END
                 || CASE WHEN $6::text IS NOT NULL AND rp.raw_payload->>'url' ~ $6::text
                         THEN jsonb_build_object('url', substring(rp.raw_payload->>'url' FROM $6::text))
                         WHEN rp.raw_payload ? 'url' THEN jsonb_build_object('url', NULL)
                         ELSE '{}'::jsonb END,
             text_removed_at = NOW(),
             text_removed_reason = $5
         FROM data_sources ds
         WHERE ds.id = rp.source_id
           AND ds.name = $1
           AND ds.source_type <> $2
           AND rp.id = ANY($3::uuid[])
           AND rp.text_removed_at IS NULL
         RETURNING rp.id`,
        [slug, DEMO_SOURCE_TYPE, postIds, notice, reason, keepUrl],
    );
    const ids = res.rows.map(r => r.id);
    if (ids.length) {
        const name = src ? src.name : slug;
        const legal = platform ? `${src.retention.legalBasis} ${RETAINED_NOTE}` : DETAIL_LEGAL_BASIS;
        await client.query(
            `INSERT INTO data_retention_log (raw_post_id, action, reason, legal_basis, performed_by)
             VALUES (NULL, $1, $2, $3, $4)`,
            [platform ? BLANK_ACTION : DETAIL_ACTION, JSON.stringify({
                summary: `Text of ${ids.length} ${name} post(s) replaced by the removal notice.`,
                source: slug, rule, reason, post_ids: ids,
                retained: platform ? RETAINED_NOTE : 'Scores, audit rows and monthly rollups are retained (spec §19).',
                ...(platform && src.retention.byAnalogy ? { applied_by_analogy: src.retention.byAnalogy } : {}),
            }), legal, performedBy],
        );
    }
    return ids;
}

/** Ruling-9 blanking of specific posts of a platform-terms source (kept name). */
async function blankPlatformPosts(client, slug, postIds, { reason, rule, performedBy }) {
    const src = getSource(slug);
    if (!src || !src.retention) throw new Error(`${slug} has no platform-terms retention`);
    return removeTextBatch(client, slug, postIds, { reason, rule, performedBy, platform: true });
}

/** Blank specific posts now (the deletion re-check). @returns {Promise<string[]>} */
async function blankPosts(slug, postIds, { reason, performedBy = 'src/collectors/reddit/recheck.js' } = {}) {
    if (!postIds.length) return [];
    return dbTransaction(client => blankPlatformPosts(client, slug, postIds, {
        reason, rule: 'removed upstream (deletion re-check)', performedBy,
    }));
}

/**
 * Remove the text of every real post past its source's window, in bounded
 * batches (one transaction and one log row per batch). Sources that are not
 * registry rows (the retired seed rows of migration 013) get the §19 window.
 * @param {{ batchSize?: number, log?: Function, env?: object }} [o]
 * @returns {Promise<Record<string, number>>} posts changed per source (every source visited)
 */
async function blankExpired({ batchSize = DEFAULT_BATCH, log = () => {}, env = process.env } = {}) {
    const size = Math.min(Math.max(Number.isInteger(batchSize) ? batchSize : DEFAULT_BATCH, 1), MAX_BATCH);
    const totals = {};
    const sources = await dbAll(
        'SELECT name FROM data_sources WHERE source_type <> $1 ORDER BY name', [DEMO_SOURCE_TYPE]);
    for (const { name } of sources) {
        const src = getSource(name);
        const platform = !!(src && src.retention);
        const hours = retentionHours(src, env);
        totals[name] = 0;
        for (;;) {
            const ids = await dbTransaction(async (client) => {
                const rows = (await client.query(
                    `SELECT rp.id
                     FROM raw_posts rp
                     JOIN data_sources ds ON ds.id = rp.source_id
                     WHERE ds.name = $1 AND ds.source_type <> $2
                       AND rp.text_removed_at IS NULL
                       AND rp.collected_at < NOW() - make_interval(hours => $3)
                     ORDER BY rp.collected_at, rp.id
                     LIMIT $4
                     FOR UPDATE OF rp SKIP LOCKED`,
                    [name, DEMO_SOURCE_TYPE, hours, size],
                )).rows;
                const rule = platform ? `${hours}-hour retention` : `${hours / 24}-day detail window (spec §19)`;
                return removeTextBatch(client, name, rows.map(r => r.id), {
                    reason: platform ? `${hours}-hour retention window ended` : `${hours / 24}-day detail window ended`,
                    rule, performedBy: 'src/collectors/retention.js', platform,
                });
            });
            totals[name] += ids.length;
            if (ids.length) log(`[retention] ${name}: text of ${ids.length} post(s) past ${hours} h removed`);
            if (ids.length < size) break;
        }
    }
    return totals;
}

/** Posts of a retention source whose text is still stored: [{ id, external_id, collected_at }]. */
async function postsWithText(slug) {
    return dbAll(
        `SELECT rp.id, rp.external_id, rp.collected_at
         FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id
         WHERE ds.name = $1 AND ds.source_type <> $2 AND rp.text_removed_at IS NULL
         ORDER BY rp.collected_at, rp.id`,
        [slug, DEMO_SOURCE_TYPE],
    );
}

/**
 * The receipt's retention block: every post whose text was removed, and
 * live posts of a platform-terms source (when their text will go); null
 * for a live post under the §19 window only.
 */
function retentionStatus(slug, { collectedAt, textRemovedAt, textRemovedReason }) {
    const src = getSource(slug);
    const platform = src && src.retention;
    if (textRemovedAt) {
        return {
            status: 'text_removed',
            removed_at: textRemovedAt,
            reason: textRemovedReason || null,
            notice: platform
                ? (slug === 'reddit'
                    ? `Text removed per the Reddit Data API Terms (${textRemovedReason || 'retention'}): after `
                        + `${src.retention.maxAgeHours} hours or on deletion upstream. Scores and audit rows retained by owner decision.`
                    : `Text removed per the source's terms (${textRemovedReason || 'retention'}): after ${src.retention.maxAgeHours} hours. `
                        + 'Scores and audit rows retained (ADR 0001 ruling 9, applied by analogy).')
                : `Text removed at the end of the detail retention window (${textRemovedReason || 'spec §19'}). `
                    + 'Scores, audit rows and monthly rollups are retained.',
        };
    }
    if (!platform) return null;
    const removesAt = collectedAt ? new Date(new Date(collectedAt).getTime() + src.retention.maxAgeHours * 3600000) : null;
    return { status: 'live', removes_at: removesAt ? removesAt.toISOString() : null, notice: src.retention.notice };
}

/** Last blanking record for the status surface. */
async function lastBlanking() {
    return dbGet(`SELECT performed_at, reason FROM data_retention_log WHERE action = $1 ORDER BY performed_at DESC LIMIT 1`, [BLANK_ACTION]);
}

module.exports = {
    BLANK_ACTION, DETAIL_ACTION, REMOVAL_NOTICE, DETAIL_NOTICE, RETAINED_NOTE, DETAIL_LEGAL_BASIS,
    retentionSources, retentionNotice, removalNoticeFor, removeTextBatch, blankPlatformPosts, blankPosts,
    blankExpired, postsWithText, retentionStatus, lastBlanking,
};
