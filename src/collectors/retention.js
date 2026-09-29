// src/collectors/retention.js
// Platform-terms retention, by BLANKING (ADR 0001 ruling 9).
//
// Sources whose terms limit how long their content may be kept carry a
// `retention` block in the registry (src/config/source-registry.js). Today
// that is Reddit (#52). Jennifer's decision of 2026-09-29, verbatim:
// "Blank text, keep audit rows" — the option read "Remove the post text but
// keep the scores and audit-trail rows forever. The audit trail stays
// intact, but Reddit's terms count retaining deleted content in any form as a
// violation, so this risks losing API access." So NOTHING is deleted:
//
//   WHEN  - a post was collected maxAgeHours (48) ago (collection is always
//           after Reddit's created_utc, so this is the later of the two), or
//         - the 6-hourly re-check sees it deleted or removed upstream
//           (src/collectors/reddit/recheck.js; ambiguous states count as
//           removed).
//   WHAT  raw_posts.content (NOT NULL) becomes REMOVAL_NOTICE; inside
//         raw_payload the text and title become the notice and the url is cut
//         to the slug-less permalink https://www.reddit.com/r/<sub>/comments/
//         <id36>/ (the stored permalink's slug is made from the title).
//         text_removed_at / text_removed_reason record when and why
//         (migration 025).
//   KEEP  the row, the username-free permalink, the t3_ external id, the
//         provenance fingerprint, the content hash, and EVERY score and
//         decision_audit_log row — which include derived cue-word fragments
//         (sentiment positive_words / negative_words) and the scores. That is
//         the accepted risk of ruling 9.
//   LOG   one data_retention_log row per batch: action
//         'blanked_platform_terms', the legal basis citing the Reddit Data API
//         Terms deletion clause, and a note that the audit and score rows are
//         retained by owner decision; the reason lists the batch's post UUIDs
//         (ours, never Reddit's ids) and why.
//
// SCOPE: every UPDATE re-applies, in SQL, the registry slug of a source that
// HAS a retention block and never a demo feed, so no other source's row can
// be blanked whatever ids reach it.

'use strict';

const { dbAll, dbGet, dbTransaction } = require('../db/connection');
const { SOURCES, getSource } = require('../config/source-registry');
const { DEMO_SOURCE_TYPE } = require('../config/data-mode');

const BLANK_ACTION = 'blanked_platform_terms';
const REMOVAL_NOTICE = '[removed: Reddit Data API Terms retention]';
const RETAINED_NOTE = 'Audit and score rows (decision_audit_log, sentiment/relevance/discourse results, embeddings) '
    + 'are retained by owner decision: ADR 0001 ruling 9, Jennifer 2026-09-29, "Blank text, keep audit rows".';
const DEFAULT_BATCH = 500;
const MAX_BATCH = 5000;

/** Registry sources with a platform-terms retention window. */
function retentionSources() {
    return SOURCES.filter(s => s.retention && s.retention.maxAgeHours > 0);
}

/** The source's retention notice (for receipts), or null. */
function retentionNotice(slug) {
    const src = getSource(slug);
    return src && src.retention ? src.retention.notice : null;
}

/**
 * Blank the given posts of one retention source. Only rows of that source
 * whose text is not yet removed are touched. Must run in a transaction.
 * @param {import('pg').PoolClient} client
 * @param {string} slug
 * @param {string[]} postIds
 * @param {{ reason: string, performedBy: string, rule: string }} o
 * @returns {Promise<string[]>} ids blanked
 */
async function blankPlatformPosts(client, slug, postIds, { reason, rule, performedBy }) {
    const src = getSource(slug);
    if (!src || !src.retention) throw new Error(`${slug} has no platform-terms retention`);
    if (!postIds.length) return [];
    const res = await client.query(
        `UPDATE raw_posts rp
         SET content = $4,
             raw_payload = COALESCE(rp.raw_payload, '{}'::jsonb)
                 || jsonb_build_object('text', $4::text, 'title', $4::text)
                 || CASE WHEN rp.raw_payload->>'url' ~ '^https://www\\.reddit\\.com/r/[A-Za-z0-9_]+/comments/[a-z0-9]+/'
                         THEN jsonb_build_object('url', substring(rp.raw_payload->>'url'
                                  FROM '^https://www\\.reddit\\.com/r/[A-Za-z0-9_]+/comments/[a-z0-9]+/'))
                         ELSE jsonb_build_object('url', NULL) END,
             text_removed_at = NOW(),
             text_removed_reason = $5
         FROM data_sources ds
         WHERE ds.id = rp.source_id
           AND ds.name = $1
           AND ds.source_type <> $2
           AND rp.id = ANY($3::uuid[])
           AND rp.text_removed_at IS NULL
         RETURNING rp.id`,
        [slug, DEMO_SOURCE_TYPE, postIds, REMOVAL_NOTICE, reason],
    );
    const ids = res.rows.map(r => r.id);
    if (ids.length) {
        await client.query(
            `INSERT INTO data_retention_log (raw_post_id, action, reason, legal_basis, performed_by)
             VALUES (NULL, $1, $2, $3, $4)`,
            [BLANK_ACTION, JSON.stringify({
                summary: `Text of ${ids.length} ${src.name} post(s) replaced by the removal notice.`,
                source: slug, rule, reason, post_ids: ids, retained: RETAINED_NOTE,
            }), `${src.retention.legalBasis} ${RETAINED_NOTE}`, performedBy],
        );
    }
    return ids;
}

/** Blank specific posts now (the deletion re-check). @returns {Promise<string[]>} */
async function blankPosts(slug, postIds, { reason, performedBy = 'src/collectors/reddit/recheck.js' } = {}) {
    if (!postIds.length) return [];
    return dbTransaction(client => blankPlatformPosts(client, slug, postIds, {
        reason, rule: 'removed upstream (deletion re-check)', performedBy,
    }));
}

/**
 * The 48-hour window: blank every retention source's posts collected more
 * than maxAgeHours ago whose text is still stored, in bounded batches.
 * @returns {Promise<Record<string, number>>} posts blanked per slug
 */
async function blankExpired({ batchSize = DEFAULT_BATCH, log = () => {} } = {}) {
    const size = Math.min(Math.max(Number.isInteger(batchSize) ? batchSize : DEFAULT_BATCH, 1), MAX_BATCH);
    const totals = {};
    for (const src of retentionSources()) {
        totals[src.slug] = 0;
        const hours = src.retention.maxAgeHours;
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
                     FOR UPDATE OF rp`,
                    [src.slug, DEMO_SOURCE_TYPE, hours, size],
                )).rows;
                return blankPlatformPosts(client, src.slug, rows.map(r => r.id), {
                    reason: `${hours}-hour retention window ended`, rule: `${hours}-hour retention`,
                    performedBy: 'src/collectors/retention.js',
                });
            });
            totals[src.slug] += ids.length;
            if (ids.length) log(`[retention] ${src.slug}: text of ${ids.length} post(s) past ${hours} h removed`);
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

/** The receipt's retention block for a post of a retention source, or null. */
function retentionStatus(slug, { collectedAt, textRemovedAt, textRemovedReason }) {
    const src = getSource(slug);
    if (!src || !src.retention) return null;
    if (textRemovedAt) {
        return {
            status: 'text_removed',
            removed_at: textRemovedAt,
            reason: textRemovedReason || null,
            notice: `Text removed per the Reddit Data API Terms (${textRemovedReason || 'retention'}): after `
                + `${src.retention.maxAgeHours} hours or on deletion upstream. Scores and audit rows retained by owner decision.`,
        };
    }
    const removesAt = collectedAt ? new Date(new Date(collectedAt).getTime() + src.retention.maxAgeHours * 3600000) : null;
    return { status: 'live', removes_at: removesAt ? removesAt.toISOString() : null, notice: src.retention.notice };
}

/** Last blanking record for the status surface. */
async function lastBlanking() {
    return dbGet(`SELECT performed_at, reason FROM data_retention_log WHERE action = $1 ORDER BY performed_at DESC LIMIT 1`, [BLANK_ACTION]);
}

module.exports = {
    BLANK_ACTION, REMOVAL_NOTICE, RETAINED_NOTE, retentionSources, retentionNotice, blankPlatformPosts, blankPosts,
    blankExpired, postsWithText, retentionStatus, lastBlanking,
};
