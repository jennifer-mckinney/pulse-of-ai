// src/collectors/retention.js
// Text retention for every collected post, by BLANKING (P10-2; ADR 0001
// ruling 9 and its generalisation).
//
// Every real (non-demo) source has a window after which a post's TEXT is
// removed (src/config/source-registry.js retentionHours):
//   - platform terms (`retention` block): Reddit 48 h (ruling 9, Jennifer:
//     "Blank text, keep audit rows"), YouTube and TikTok 30 days. For
//     YouTube and TikTok the ruling-9 mechanism is applied BY ANALOGY, for
//     consistency — recorded in the ADR;
//   - otherwise the spec §19 detail window, RETENTION_DETAIL_DAYS (90) days.
//     The Guardian is here since Jennifer's ruling of 2026-09-29, verbatim
//     "Use normal retention" (its former 24 h blanking by analogy is gone;
//     the registry's `retentionRuling` keeps the ruling and the old window).
// Reddit posts are also blanked as soon as the 6-hourly re-check sees them
// deleted upstream (src/collectors/reddit/recheck.js → blankPosts).
//
//   WHAT  raw_posts.content (NOT NULL) becomes the source's removal notice;
//         raw_payload loses its text: every key ingest declares as text
//         (PAYLOAD_TEXT_KEYS: text, title, body, content, selftext — present
//         on rows stored before ingest@1.6.0, which stopped duplicating
//         them) becomes the notice, and the url is removed — except Reddit's, which
//         is cut to the slug-less permalink (the slug is made from the
//         title). text_removed_at / text_removed_reason record when and why
//         (migration 025).
//   KEEP  the row, the external id, the provenance fingerprint (anyone with
//         the original URL can still prove the match: npm run
//         verify-provenance), the content hash, and every score and
//         decision_audit_log row. This holds for an ERASURE REQUEST too (removeTextOnRequest): ADR 0001
//         ruling 9 ("Blank text, keep audit rows") is non-negotiable, so the content hash and the audit
//         rows are never rewritten.
//   DROP  for a platform-terms source, the post's post_embeddings row, in
//         the same transaction (PR #22 decision G3, Jennifer 2026-09-29:
//         the embedding is derived from the text). The §19 detail window
//         leaves embeddings to monthly compaction (scripts/compact.js).
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

const { dbAll, dbTransaction } = require('../db/connection');
const { getSource, retentionHours, retentionDetailDays } = require('../config/source-registry');
const { DEMO_SOURCE_TYPE } = require('../config/data-mode');
// P1-8: every payload key ingest declares as text (ingest@1.6.0
// payload_text_keys_not_stored), so a legacy row's body / content /
// selftext copy is removed too, not only text and title.
const { PAYLOAD_TEXT_KEYS } = require('../pipeline/ingest');

const BLANK_ACTION = 'blanked_platform_terms';
const DETAIL_ACTION = 'text_removed_detail_window';
// Reddit's notice (ruling 9); every retention source carries its own.
const REMOVAL_NOTICE = '[removed: Reddit Data API Terms retention]';
const DETAIL_NOTICE = '[removed: detail retention window (spec §19)]';
// PR #22 decision G3 (Jennifer, 2026-09-29): the post's embedding
// (post_embeddings) is derived from its text, so it is DELETED in the same
// transaction as platform-terms blanking; scores and audit rows stay.
const RETAINED_NOTE = 'Audit and score rows (decision_audit_log, sentiment/relevance/discourse results) '
    + 'are retained by owner decision: ADR 0001 ruling 9, Jennifer 2026-09-29, "Blank text, keep audit rows". '
    + 'The post embedding (derived from the text) is deleted with the text: PR #22 decision G3, Jennifer 2026-09-29.';
const DETAIL_LEGAL_BASIS = 'GDPR Article 5(1)(e) - Storage Limitation: post text is kept for the detail window '
    + '(TECHNICAL_SPEC §19) and then removed; scores, audit rows and monthly rollups remain.';
const DEFAULT_BATCH = 500;
const MAX_BATCH = 5000;

/**
 * Registry sources with a platform-terms retention window. A test-time
 * audit (tests/integration/reddit.retention.test.js lists them); nothing at
 * runtime needs the list (PR #22 grumpy NIT 18).
 */
function retentionSources() {
    const { SOURCES } = require('../config/source-registry');
    return SOURCES.filter(s => s.retention && s.retention.maxAgeHours > 0);
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
 * @param {{ reason: string, rule: string, performedBy: string, platform: boolean,
 *          deleteEmbeddings?: boolean, legalBasis?: string }} o   deleteEmbeddings defaults to `platform`; an erasure request sets it
 *          for any source
 * @returns {Promise<string[]>} ids changed
 */
async function removeTextBatch(client, slug, postIds, { reason, rule, performedBy, platform, deleteEmbeddings = platform, legalBasis = null, erasure = false }) {
    if (!postIds.length) return [];
    const src = getSource(slug);
    // An erasure request says so in the stored notice and keeps no url at all (a Reddit permalink still identifies the post).
    const notice = erasure ? ERASURE_NOTICE : (platform ? removalNoticeFor(slug) : DETAIL_NOTICE);
    const keepUrl = !erasure && platform && src && src.retention && src.retention.keepUrlPrefix ? src.retention.keepUrlPrefix : null;
    // Lock exactly the rows the UPDATE will touch, in id order first: the gold sampler locks posts in
    // the same order (FOR SHARE, which FOR NO KEY UPDATE still conflicts with), so the two can never
    // wait on each other in opposite orders. NO KEY UPDATE is enough (no key column changes) and
    // does not block foreign-key child inserts.
    await client.query(
        `SELECT rp.id FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id
         WHERE rp.id = ANY($1::uuid[]) AND ds.name = $2 AND ds.source_type <> $3 AND rp.text_removed_at IS NULL
         ORDER BY rp.id FOR NO KEY UPDATE OF rp`,
        [postIds, slug, DEMO_SOURCE_TYPE]);
    const res = await client.query(
        `UPDATE raw_posts rp
         SET content = $4,
             raw_payload = (COALESCE(rp.raw_payload, '{}'::jsonb) - $7::text[] - 'url')
                 || COALESCE((SELECT jsonb_object_agg(k, to_jsonb($4::text))
                              FROM unnest($7::text[]) AS k WHERE rp.raw_payload ? k), '{}'::jsonb)
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
        [slug, DEMO_SOURCE_TYPE, postIds, notice, reason, keepUrl, [...PAYLOAD_TEXT_KEYS]],
    );
    const ids = res.rows.map(r => r.id);
    // G3: a platform-terms source's embeddings go with the text, in this
    // transaction (the embed writer takes FOR SHARE on the post row, so an
    // embedding computed concurrently is either deleted here or never
    // written — src/pipeline/embeddings.js saveEmbeddingIfTextStored).
    let embeddingsDeleted = 0;
    if (ids.length && deleteEmbeddings) {
        embeddingsDeleted = (await client.query(
            'DELETE FROM post_embeddings WHERE raw_post_id = ANY($1::uuid[])', [ids])).rowCount;
    }
    if (ids.length) {
        // Gold-set rows (migration 070) are append-only and keep the post id, a fingerprint of the
        // text and labellers' notes: erase them in the SAME transaction as the text, so retention
        // never leaves a permanent link to removed text (gold_erase_post; labels and strata stay).
        await client.query('SELECT gold_erase_post(id) FROM unnest($1::uuid[]) AS id', [ids]);
        const name = src ? src.name : slug;
        const legal = legalBasis || (platform ? `${src.retention.legalBasis} ${RETAINED_NOTE}` : DETAIL_LEGAL_BASIS);
        await client.query(
            `INSERT INTO data_retention_log (raw_post_id, action, reason, legal_basis, performed_by)
             VALUES (NULL, $1, $2, $3, $4)`,
            [platform ? BLANK_ACTION : DETAIL_ACTION, JSON.stringify({
                summary: `Text of ${ids.length} ${name} post(s) replaced by the removal notice.`,
                source: slug, rule, reason, post_ids: ids,
                retained: erasure ? ERASURE_RETAINED_NOTE : (platform ? RETAINED_NOTE : 'Scores, audit rows and monthly rollups are retained (spec §19).'),
                ...(deleteEmbeddings ? { embeddings_deleted: embeddingsDeleted } : {}),
                ...(platform && src.retention.byAnalogy ? { applied_by_analogy: src.retention.byAnalogy } : {}),
            }), legal, performedBy],
        );
    }
    return ids;
}

const ERASURE_NOTICE = '[removed: erasure request]';
const ERASURE_LEGAL_BASIS = 'GDPR Article 17 - right to erasure: the post text was removed on request; '
    + 'scores and audit rows are retained (they hold no post text).';
const ERASURE_RETAINED_NOTE = 'Scores, audit rows, the content hash and the provenance fingerprint are retained by owner ruling '
    + '(ADR 0001 ruling 9, "Blank text, keep audit rows"; an erasure request is no exception). The post embedding and gold-set rows are deleted with the text. '
    + 'Residual risk, accepted by the owner: a guessed text can still be confirmed against the unkeyed content hash.';

/**
 * Remove ONE post's text on an erasure request (any real source, platform terms or not), in one
 * transaction: the same scrub as retention (text, raw_payload text keys, url - no Reddit permalink kept,
 * the stored notice says "erasure request"), the post's embedding deleted, its gold-set rows erased
 * (gold_erase_post), and a data_retention_log row written. Nothing else changes: ADR 0001 ruling 9
 * keeps the scores, every decision_audit_log row, the content hash and the provenance fingerprint, an
 * erasure request included (residual risk accepted by the owner: a guessed text can be confirmed against the hash).
 * A post whose text retention already removed still gets the rest (url and notice scrub, embedding, gold rows,
 * a log row when something changed): the request is never a silent no-op.
 * @param {string} postId
 * @param {{ performedBy?: string }} [o]
 * @returns {Promise<{ removed: boolean, source: string|null, goldErased: number, skipped?: 'demo' }>}
 *          removed=false when it had no text left; skipped='demo' for a demo post (purged whole by compaction, never
 *          touched here); goldErased counts the gold items erased by this call
 */
async function removeTextOnRequest(postId, { performedBy = 'scripts/gold-erase.js' } = {}) {
    return dbTransaction(async (client) => {
        const row = (await client.query(
            `SELECT ds.name, ds.source_type FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id WHERE rp.id = $1::uuid`, [postId])).rows[0];
        if (!row) return { removed: false, source: null, goldErased: 0 };
        if (row.source_type === DEMO_SOURCE_TYPE) return { removed: false, source: row.name, goldErased: 0, skipped: 'demo' };
        // Lock the post first (same mode and order as retention and the sampler), then count what is erased.
        await client.query('SELECT id FROM raw_posts WHERE id = $1::uuid FOR NO KEY UPDATE', [postId]);
        const goldErased = (await client.query(
            'SELECT COUNT(*)::int AS n FROM relevance_gold_items WHERE raw_post_id = $1::uuid AND erased_at IS NULL', [postId])).rows[0].n;
        const src = getSource(row.name);
        const ids = await removeTextBatch(client, row.name, [postId], {
            reason: 'erasure request', rule: 'erasure request', performedBy,
            platform: !!(src && src.retention), deleteEmbeddings: true, legalBasis: ERASURE_LEGAL_BASIS, erasure: true,
        });
        if (!ids.length) {
            // The text was already removed (retention, upstream deletion): finish what that left behind. A Reddit post keeps
            // its slug-less permalink and the platform notice after retention; an erasure request removes both.
            const scrubbed = (await client.query(
                `UPDATE raw_posts
                 SET content = $2,
                     raw_payload = COALESCE(raw_payload, '{}'::jsonb) - $3::text[] - 'url'
                 WHERE id = $1::uuid AND (content <> $2 OR raw_payload->>'url' IS NOT NULL)`,
                [postId, ERASURE_NOTICE, [...PAYLOAD_TEXT_KEYS]])).rowCount;
            const embeddingsDeleted = (await client.query('DELETE FROM post_embeddings WHERE raw_post_id = $1::uuid', [postId])).rowCount;
            await client.query('SELECT gold_erase_post($1::uuid)', [postId]);
            if (scrubbed + embeddingsDeleted + goldErased > 0) {
                await client.query(
                    `INSERT INTO data_retention_log (raw_post_id, action, reason, legal_basis, performed_by)
                     VALUES (NULL, $1, $2, $3, $4)`,
                    [DETAIL_ACTION, JSON.stringify({
                        summary: `Erasure request for a ${row.name} post whose text was already removed: remaining derived data erased.`,
                        source: row.name, rule: 'erasure request', reason: 'erasure request', post_ids: [postId],
                        retained: ERASURE_RETAINED_NOTE, embeddings_deleted: embeddingsDeleted, gold_items_erased: goldErased,
                        url_and_notice_scrubbed: scrubbed > 0,
                    }), ERASURE_LEGAL_BASIS, performedBy]);
            }
        }
        return { removed: ids.length === 1, source: row.name, goldErased };
    });
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
    // M1: validate the window BEFORE touching any source — a bad
    // RETENTION_DETAIL_DAYS fails the step and blanks nothing.
    retentionDetailDays(env);
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
    // A post blanked under a platform window that a later ruling removed
    // (the Guardian's 24 h, before "Use normal retention") says so, rather
    // than claiming the §19 window it never reached.
    const former = !platform && src && src.retentionRuling && src.retentionRuling.former;
    if (textRemovedAt && former && textRemovedReason === `${former.maxAgeHours}-hour retention window ended`) {
        const r = src.retentionRuling;
        return {
            status: 'text_removed',
            removed_at: textRemovedAt,
            reason: textRemovedReason,
            notice: `Text removed after ${former.maxAgeHours} hours under the window then in force (${former.basis}). `
                + `That window was withdrawn by ${r.by}'s ruling of ${r.date}, "${r.verbatim}"; later posts follow the `
                + 'detail retention window. Scores and audit rows are retained.',
        };
    }
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

module.exports = {
    BLANK_ACTION, DETAIL_ACTION, REMOVAL_NOTICE, DETAIL_NOTICE, RETAINED_NOTE, DETAIL_LEGAL_BASIS,
    retentionSources, removalNoticeFor, removeTextBatch, removeTextOnRequest, ERASURE_NOTICE, blankPlatformPosts, blankPosts,
    blankExpired, postsWithText, retentionStatus,
};
