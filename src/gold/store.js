// src/gold/store.js
// Relevance-accuracy Stage 0 (P3): database access for the gold-set tools
// (scripts/gold-sample.js, gold-label.js, gold-agreement.js). Every query is
// parameterised; table names are constants. The gold tables are
// append-only (migration 070): this module only SELECTs and INSERTs.
//
// Offline only: nothing in the production pipeline requires src/gold.
//
// input_hash is KEYED: HMAC-SHA256(GOLD_HASH_KEY, else AUDIT_HASH_KEY,
// "gold-input:v1\0" + text). An unkeyed sha256 of a post's text would let
// anyone with database access confirm that a person wrote a guessed text, and
// the gold rows are immutable. There is no fallback to an unkeyed hash. The
// key must stay the same between sampling and labelling: rotating it makes
// every item read as "changed" and unlabellable.

'use strict';

const crypto = require('crypto');
const { dbAll, dbGet, dbTransaction } = require('../db/connection');
const { DEMO_SOURCE_TYPE } = require('../config/data-mode');
const { latestPerLabeller } = require('./agreement');
const { scriptOf, scopeOf, decisionOf, SAMPLER_VERSION } = require('./sampler');

const MIN_KEY_LENGTH = 32;
// Template values shipped in .env.example are public: never a key.
const PLACEHOLDER_KEY_RE = /^(?:replace|changeme|change[-_]me|example|your[-_]|xxx|todo)/i;

/** The hash key (GOLD_HASH_KEY, else AUDIT_HASH_KEY); throws when neither is set or it is too short. */
function hashKey(env = process.env) {
    const valid = (v) => typeof v === 'string' && v.length >= MIN_KEY_LENGTH && !PLACEHOLDER_KEY_RE.test(v);
    // An explicitly configured GOLD_HASH_KEY is never silently replaced: a typo must fail, not
    // fingerprint a sample under the audit key (fixing the typo later would orphan every item).
    const gold = env.GOLD_HASH_KEY;
    if (typeof gold === 'string' && gold !== '') {
        if (valid(gold)) return gold;
        throw new Error(`GOLD_HASH_KEY is set but invalid: it needs at least ${MIN_KEY_LENGTH} characters and not a template value (unset it to use AUDIT_HASH_KEY)`);
    }
    if (valid(env.AUDIT_HASH_KEY)) return env.AUDIT_HASH_KEY;
    throw new Error(`gold tools need GOLD_HASH_KEY (or AUDIT_HASH_KEY), at least ${MIN_KEY_LENGTH} characters and not a template value, to fingerprint post text`);
}

/** Keyed fingerprint of a post's text (relevance_gold_*.input_hash). */
function inputHash(text, env = process.env) {
    return crypto.createHmac('sha256', hashKey(env)).update(`gold-input:v1\0${text}`).digest('hex');
}

const DEFAULT_BATCH = 2000;

/**
 * Stream the sampling population: stored, non-demo posts whose text is
 * still present, classified into their stratum dimensions. Post text is
 * read to compute the script and hash, and is NOT returned.
 * Keyset pagination by post id, so memory stays bounded.
 *
 * `until` is the snapshot bound both passes of the two-pass sampler use.
 * @param {{ since?: string|null, until?: string|null, batchSize?: number }} [opts]
 * @returns {AsyncGenerator<{rawPostId, category, scope, decision, script, inputHash, relevanceMvId}>}
 */
async function* streamCandidates({ since = null, until = null, batchSize = DEFAULT_BATCH } = {}) {
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
        const rows = await dbAll(
            `SELECT rp.id, rp.content, ds.name AS slug, ds.category, rp.raw_payload->>'route' AS route,
                    rr.is_relevant, dal.methodology_version_id AS relevance_mv_id
             FROM raw_posts rp
             JOIN data_sources ds ON ds.id = rp.source_id
             LEFT JOIN LATERAL (SELECT r.is_relevant, r.audit_id FROM relevance_results r WHERE r.raw_post_id = rp.id
                                ORDER BY r.created_at DESC NULLS LAST, r.id DESC LIMIT 1) rr ON TRUE
             LEFT JOIN decision_audit_log dal ON dal.id = rr.audit_id
             WHERE ds.source_type <> $1
               AND rp.text_removed_at IS NULL
               AND rp.content <> ''
               AND ($2::timestamptz IS NULL OR rp.collected_at >= $2::timestamptz)
               AND ($5::timestamptz IS NULL OR rp.collected_at <= $5::timestamptz)
               AND rp.id > $3::uuid
             ORDER BY rp.id
             LIMIT $4`,
            [DEMO_SOURCE_TYPE, since, after, batchSize, until],
        );
        if (!rows.length) return;
        for (const r of rows) {
            yield {
                rawPostId: r.id,
                category: r.category,
                scope: scopeOf(r.slug, r.route),
                decision: decisionOf(r.is_relevant),
                script: scriptOf(r.content),
                inputHash: inputHash(r.content),
                relevanceMvId: r.relevance_mv_id || null,
            };
        }
        after = rows[rows.length - 1].id;
        if (rows.length < batchSize) return;
    }
}

async function sampleExists(sampleId) {
    return Boolean(await dbGet('SELECT 1 FROM relevance_gold_items WHERE sample_id = $1 LIMIT 1', [sampleId]));
}

/**
 * Record a sample's items in one transaction. Refuses an existing sample id
 * (a sample is written once; the tables are append-only).
 */
async function insertItems(items, { sampleId, seed }) {
    return dbTransaction(async (client) => {
        // Serialise writers of the same sample id.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`relevance_gold_sample:${sampleId}`]);
        const exists = await client.query('SELECT 1 FROM relevance_gold_items WHERE sample_id = $1 LIMIT 1', [sampleId]);
        if (exists.rows.length) throw new Error(`sample "${sampleId}" already exists; choose a new --sample-id`);
        // Lock and re-check every selected post: retention's text removal needs the row lock, so
        // it either committed before this (the post is refused here) or waits until this commits
        // (and then erases the new item). Never store the id and fingerprint of removed text.
        const ids = items.map(it => it.rawPostId);
        const locked = await client.query(
            'SELECT id, content, text_removed_at FROM raw_posts WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE', [ids]);
        const byId = new Map(locked.rows.map(r => [r.id, r]));
        for (const it of items) {
            const row = byId.get(it.rawPostId);
            if (!row || row.text_removed_at || !row.content || inputHash(row.content) !== it.inputHash) {
                throw new Error('a sampled post lost or changed its text during sampling; nothing written, run again');
            }
        }
        for (const it of items) {
            await client.query(
                `INSERT INTO relevance_gold_items
                    (sample_id, raw_post_id, input_hash, category, scope, decision, script, stratum,
                     stratum_population, stratum_sample_size, stratum_weight, design_weight, draw_rank,
                     relevance_mv_id, sampler_version, seed)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
                [sampleId, it.rawPostId, it.inputHash, it.category, it.scope, it.decision, it.script, it.stratum,
                    it.stratumPopulation, it.stratumSampleSize, it.stratumWeight, it.designWeight, it.drawRank,
                    it.relevanceMvId, SAMPLER_VERSION, seed],
            );
        }
        return items.length;
    });
}

const ITEM_COLS = 'i.id, i.raw_post_id, i.input_hash, i.category, i.draw_rank';

/** One live (not erased) item of a sample, or null. */
async function getItem(sampleId, itemId) {
    return (await dbGet(
        `SELECT ${ITEM_COLS} FROM relevance_gold_items i WHERE i.sample_id = $1 AND i.id = $2 AND i.erased_at IS NULL`,
        [sampleId, itemId],
    )) || null;
}

/** All label rows of a sample (or every sample), optionally one codebook version. */
async function labelRows({ sampleId = null, codebookVersion = null, methods = null } = {}) {
    const rows = await dbAll(
        `SELECT l.id, l.seq, l.item_id, l.label, l.flags, l.labeller, l.method, l.note, l.created_at, i.design_weight
         FROM relevance_gold_labels l
         JOIN relevance_gold_items i ON i.id = l.item_id
         WHERE ($1::text IS NULL OR i.sample_id = $1)
           AND ($2::text IS NULL OR l.codebook_version = $2)
           AND ($3::text[] IS NULL OR l.method = ANY($3::text[]))
         ORDER BY l.seq`,
        [sampleId, codebookVersion, methods],
    );
    return rows;
}

/**
 * Items still to label, in draw-rank order.
 *   human:       items this labeller has not labelled yet under this codebook
 *                version (any method); a label from an older version does not
 *                block relabelling under the new one.
 *   adjudicated: items where the latest human labels of two or more
 *                labellers disagree (label or flags) and no adjudicated
 *                label is newer than the newest of those human labels; an
 *                already adjudicated item re-opens when any human label has
 *                changed since (a later human correction re-opens it).
 */
async function pendingItems({ sampleId, labeller, method = 'human', codebookVersion = null }) {
    if (method === 'human') {
        return dbAll(
            `SELECT ${ITEM_COLS} FROM relevance_gold_items i
             WHERE i.sample_id = $1
               AND i.erased_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM relevance_gold_labels l WHERE l.item_id = i.id AND l.labeller = $2
                               AND ($3::text IS NULL OR l.codebook_version = $3))
             ORDER BY i.draw_rank`,
            [sampleId, labeller, codebookVersion],
        );
    }
    const human = await labelRows({ sampleId, codebookVersion, methods: ['human'] });
    const adjudicatedSeq = new Map();
    for (const r of await labelRows({ sampleId, codebookVersion, methods: ['adjudicated'] })) {
        const s = BigInt(String(r.seq));
        if (!adjudicatedSeq.has(r.item_id) || adjudicatedSeq.get(r.item_id) < s) adjudicatedSeq.set(r.item_id, s);
    }
    // Per item: the human labels as they stand now (a set of "label+flags"), and
    // a signature of who said what, now and as it stood when the item was last
    // adjudicated. A later human row re-opens an adjudicated item only when it
    // CHANGED somebody's label (re-confirming a label changes nothing).
    const signature = (rows) => {
        const out = new Map();
        for (const [labeller, m] of latestPerLabeller(rows)) {
            for (const [itemId, r] of m) {
                if (!out.has(itemId)) out.set(itemId, []);
                out.get(itemId).push(`${labeller}=${r.label}+${[...r.flags].sort().join('+')}`);
            }
        }
        for (const v of out.values()) v.sort();
        return out;
    };
    const now = signature(human);
    const disputed = [];
    for (const [id, sigs] of now) {
        if (adjudicatedSeq.has(id)) {
            // Adjudicated: re-open on ANY change of a human signature since then (even when the
            // coders now agree, the adjudicated label was decided on facts that no longer hold).
            const at = signature(human.filter(r => r.item_id === id && BigInt(String(r.seq)) < adjudicatedSeq.get(id))).get(id) || [];
            if (at.join('|') !== sigs.join('|')) disputed.push(id);
            continue;
        }
        // Never adjudicated: only a disagreement between labellers queues it.
        const distinct = new Set(sigs.map(x => x.slice(x.indexOf('=') + 1)));
        if (distinct.size >= 2) disputed.push(id);
    }
    if (!disputed.length) return [];
    return dbAll(
        `SELECT ${ITEM_COLS} FROM relevance_gold_items i WHERE i.id = ANY($1::uuid[]) AND i.erased_at IS NULL ORDER BY i.draw_rank`,
        [disputed],
    );
}

/**
 * The post text for an item, only when it is still the text that was sampled.
 * @returns {Promise<{status: 'ok', content: string, inputHash: string} | {status: 'removed'|'changed'}>}
 */
async function itemText(item) {
    if (!item.raw_post_id || !item.input_hash) return { status: 'removed' };
    const row = await dbGet('SELECT content, text_removed_at FROM raw_posts WHERE id = $1', [item.raw_post_id]);
    if (!row || row.text_removed_at || !row.content) return { status: 'removed' };
    const hash = inputHash(row.content);
    if (hash !== item.input_hash) return { status: 'changed' };
    return { status: 'ok', content: row.content, inputHash: hash };
}

/**
 * The labels that currently count for an item: this codebook version only, and
 * each labeller's latest row (the table is append-only, so corrections are new
 * rows and the older ones are superseded). Ordered by seq.
 */
async function labelsFor(itemId, codebookVersion) {
    const rows = await dbAll(
        `SELECT id, seq, item_id, labeller, method, label, flags, note, created_at FROM relevance_gold_labels
         WHERE item_id = $1 AND codebook_version = $2 ORDER BY seq`,
        [itemId, codebookVersion],
    );
    const latest = latestPerLabeller(rows);
    const keep = new Set();
    for (const m of latest.values()) for (const r of m.values()) keep.add(r.id);
    return rows.filter(r => keep.has(r.id));
}

const INSERT_LABEL = `INSERT INTO relevance_gold_labels
    (item_id, label, flags, labeller, method, model_id, codebook_version, input_hash, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`;
const labelParams = (l) => [l.itemId, l.label, l.flags, l.labeller, l.method, l.modelId || null, l.codebookVersion, l.inputHash, l.note || null];

async function recordLabel(l) {
    return (await dbGet(INSERT_LABEL, labelParams(l))).id;
}

/** All-or-nothing insert of many labels (the LLM-proposal import). */
async function recordLabels(labels) {
    return dbTransaction(async (client) => {
        for (const l of labels) await client.query(INSERT_LABEL, labelParams(l));
        return labels.length;
    });
}

/**
 * Run fn(client) inside a READ ONLY transaction: any write in it fails
 * ("cannot execute ... in a read-only transaction"). Used by the offline
 * evaluation harness (scripts/relevance-eval.js).
 */
async function readOnly(fn) {
    return dbTransaction(async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        return fn(client);
    });
}

/**
 * Stream stored, non-demo posts with text for the evaluation harness, in
 * keyset pages, through a read-only client. Yields { category, storedRelevant, text }.
 */
async function* streamEvalRows(client, { since = null, category = null, limit = null, batchSize = DEFAULT_BATCH } = {}) {
    let after = '00000000-0000-0000-0000-000000000000';
    let seen = 0;
    for (;;) {
        const page = limit === null ? batchSize : Math.min(batchSize, limit - seen);
        if (page <= 0) return;
        const { rows } = await client.query(
            `SELECT rp.id, rp.content, ds.category, rr.is_relevant
             FROM raw_posts rp
             JOIN data_sources ds ON ds.id = rp.source_id
             LEFT JOIN LATERAL (SELECT r.is_relevant FROM relevance_results r WHERE r.raw_post_id = rp.id
                                ORDER BY r.created_at DESC NULLS LAST, r.id DESC LIMIT 1) rr ON TRUE
             WHERE ds.source_type <> $1
               AND rp.text_removed_at IS NULL
               AND rp.content <> ''
               AND ($2::timestamptz IS NULL OR rp.collected_at >= $2::timestamptz)
               AND ($3::text IS NULL OR ds.category = $3)
               AND rp.id > $4::uuid
             ORDER BY rp.id
             LIMIT $5`,
            [DEMO_SOURCE_TYPE, since, category, after, page],
        );
        for (const r of rows) {
            yield { category: r.category, storedRelevant: r.is_relevant === null ? null : r.is_relevant, text: r.content };
        }
        seen += rows.length;
        if (rows.length < page) return;
        after = rows[rows.length - 1].id;
    }
}

/** True when the post's text is gone (post deleted, text removed by retention, or empty). */
async function postTextGone(rawPostId) {
    const row = await dbGet('SELECT content, text_removed_at FROM raw_posts WHERE id = $1', [rawPostId]);
    return !row || Boolean(row.text_removed_at) || !row.content;
}

/** Erase one post's gold rows (migration 070's gold_erase_post); returns the number of items erased. */
async function erasePost(rawPostId) {
    return (await dbGet('SELECT gold_erase_post($1::uuid) AS n', [rawPostId])).n;
}

/**
 * Erase every live gold item whose post text is gone (post deleted, text
 * removed by retention, or emptied). Returns the number of items erased.
 */
async function eraseRemoved() {
    const rows = await dbAll(
        `SELECT DISTINCT i.raw_post_id
         FROM relevance_gold_items i
         LEFT JOIN raw_posts rp ON rp.id = i.raw_post_id
         WHERE i.erased_at IS NULL
           AND (rp.id IS NULL OR rp.text_removed_at IS NOT NULL OR rp.content = '')`,
    );
    let erased = 0;
    for (const r of rows) erased += await erasePost(r.raw_post_id);
    return erased;
}

module.exports = {
    readOnly, streamEvalRows, hashKey, inputHash,
    streamCandidates, sampleExists, insertItems, labelRows, pendingItems, getItem, itemText, labelsFor,
    recordLabel, recordLabels, erasePost, eraseRemoved, postTextGone,
};
