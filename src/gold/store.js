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

const MIN_KEY_LENGTH = 16;

/** The hash key (GOLD_HASH_KEY, else AUDIT_HASH_KEY); throws when neither is set or it is too short. */
function hashKey(env = process.env) {
    for (const name of ['GOLD_HASH_KEY', 'AUDIT_HASH_KEY']) {
        const v = env[name];
        if (typeof v === 'string' && v.length >= MIN_KEY_LENGTH) return v;
    }
    throw new Error(`gold tools need GOLD_HASH_KEY (or AUDIT_HASH_KEY), at least ${MIN_KEY_LENGTH} characters, to fingerprint post text`);
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
             LEFT JOIN relevance_results rr ON rr.raw_post_id = rp.id
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
 *   human:       items this labeller has not labelled yet (any method).
 *   adjudicated: items where the latest human labels of two or more
 *                labellers disagree (label or flags) and no adjudicated
 *                label is newer than the newest of those human labels (a
 *                later human correction re-opens an adjudicated item).
 */
async function pendingItems({ sampleId, labeller, method = 'human', codebookVersion = null }) {
    if (method === 'human') {
        return dbAll(
            `SELECT ${ITEM_COLS} FROM relevance_gold_items i
             WHERE i.sample_id = $1
               AND i.erased_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM relevance_gold_labels l WHERE l.item_id = i.id AND l.labeller = $2)
             ORDER BY i.draw_rank`,
            [sampleId, labeller],
        );
    }
    const human = await labelRows({ sampleId, codebookVersion, methods: ['human'] });
    const adjudicatedSeq = new Map();
    for (const r of await labelRows({ sampleId, codebookVersion, methods: ['adjudicated'] })) {
        const s = BigInt(String(r.seq));
        if (!adjudicatedSeq.has(r.item_id) || adjudicatedSeq.get(r.item_id) < s) adjudicatedSeq.set(r.item_id, s);
    }
    const perItem = new Map();
    const newestHuman = new Map();
    for (const [, m] of latestPerLabeller(human)) {
        for (const [itemId, r] of m) {
            if (!perItem.has(itemId)) perItem.set(itemId, new Set());
            perItem.get(itemId).add(`${r.label}+${[...r.flags].sort().join('+')}`);
            const s = BigInt(String(r.seq));
            if (!newestHuman.has(itemId) || newestHuman.get(itemId) < s) newestHuman.set(itemId, s);
        }
    }
    const open = (id) => !adjudicatedSeq.has(id) || adjudicatedSeq.get(id) < newestHuman.get(id);
    const disputed = [...perItem].filter(([id, set]) => set.size > 1 && open(id)).map(([id]) => id);
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

async function labelsFor(itemId) {
    return dbAll(
        `SELECT labeller, method, label, flags, note, created_at FROM relevance_gold_labels
         WHERE item_id = $1 ORDER BY seq`,
        [itemId],
    );
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
             LEFT JOIN relevance_results rr ON rr.raw_post_id = rp.id
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
    recordLabel, recordLabels, erasePost, eraseRemoved,
};
