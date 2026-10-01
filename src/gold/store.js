// src/gold/store.js
// Relevance-accuracy Stage 0 (P3): database access for the gold-set tools
// (scripts/gold-sample.js, gold-label.js, gold-agreement.js). Every query is
// parameterised; table names are constants. The gold tables are
// append-only (migration 070): this module only SELECTs and INSERTs.
//
// Offline only: nothing in the production pipeline requires src/gold.

'use strict';

const crypto = require('crypto');
const { dbAll, dbGet, dbTransaction } = require('../db/connection');
const { DEMO_SOURCE_TYPE } = require('../config/data-mode');
const { latestPerLabeller } = require('./agreement');
const { scriptOf, scopeOf, decisionOf, SAMPLER_VERSION } = require('./sampler');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const DEFAULT_BATCH = 2000;

/**
 * Stream the sampling population: stored, non-demo posts whose text is
 * still present, classified into their stratum dimensions. Post text is
 * read to compute the script and hash, and is NOT returned.
 * Keyset pagination by post id, so memory stays bounded.
 *
 * @param {{ since?: string|null, batchSize?: number }} [opts]
 * @returns {AsyncGenerator<{rawPostId, category, scope, decision, script, inputHash, relevanceMvId}>}
 */
async function* streamCandidates({ since = null, batchSize = DEFAULT_BATCH } = {}) {
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
               AND rp.id > $3::uuid
             ORDER BY rp.id
             LIMIT $4`,
            [DEMO_SOURCE_TYPE, since, after, batchSize],
        );
        if (!rows.length) return;
        for (const r of rows) {
            yield {
                rawPostId: r.id,
                category: r.category,
                scope: scopeOf(r.slug, r.route),
                decision: decisionOf(r.is_relevant),
                script: scriptOf(r.content),
                inputHash: sha256(r.content),
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

/** All label rows of a sample (or every sample), optionally one codebook version. */
async function labelRows({ sampleId = null, codebookVersion = null, methods = null } = {}) {
    const rows = await dbAll(
        `SELECT l.id, l.item_id, l.label, l.flags, l.labeller, l.method, l.note, l.created_at
         FROM relevance_gold_labels l
         JOIN relevance_gold_items i ON i.id = l.item_id
         WHERE ($1::text IS NULL OR i.sample_id = $1)
           AND ($2::text IS NULL OR l.codebook_version = $2)
           AND ($3::text[] IS NULL OR l.method = ANY($3::text[]))
         ORDER BY l.created_at, l.id`,
        [sampleId, codebookVersion, methods],
    );
    return rows;
}

/**
 * Items still to label, in draw-rank order.
 *   human:       items this labeller has not labelled yet (any method).
 *   adjudicated: items where the latest human labels of two or more
 *                labellers disagree (label or flags) and no adjudicated
 *                label exists yet.
 */
async function pendingItems({ sampleId, labeller, method = 'human', codebookVersion = null }) {
    if (method === 'human') {
        return dbAll(
            `SELECT ${ITEM_COLS} FROM relevance_gold_items i
             WHERE i.sample_id = $1
               AND NOT EXISTS (SELECT 1 FROM relevance_gold_labels l WHERE l.item_id = i.id AND l.labeller = $2)
             ORDER BY i.draw_rank`,
            [sampleId, labeller],
        );
    }
    const human = await labelRows({ sampleId, codebookVersion, methods: ['human'] });
    const adjudicated = new Set((await labelRows({ sampleId, codebookVersion, methods: ['adjudicated'] })).map(r => r.item_id));
    const perItem = new Map();
    for (const [, m] of latestPerLabeller(human)) {
        for (const [itemId, r] of m) {
            if (!perItem.has(itemId)) perItem.set(itemId, new Set());
            perItem.get(itemId).add(`${r.label}+${[...r.flags].sort().join('+')}`);
        }
    }
    const disputed = [...perItem].filter(([id, set]) => set.size > 1 && !adjudicated.has(id)).map(([id]) => id);
    if (!disputed.length) return [];
    return dbAll(
        `SELECT ${ITEM_COLS} FROM relevance_gold_items i WHERE i.id = ANY($1::uuid[]) ORDER BY i.draw_rank`,
        [disputed],
    );
}

/**
 * The post text for an item, only when it is still the text that was sampled.
 * @returns {Promise<{status: 'ok', content: string, inputHash: string} | {status: 'removed'|'changed'}>}
 */
async function itemText(item) {
    const row = await dbGet('SELECT content, text_removed_at FROM raw_posts WHERE id = $1', [item.raw_post_id]);
    if (!row || row.text_removed_at || !row.content) return { status: 'removed' };
    const inputHash = sha256(row.content);
    if (inputHash !== item.input_hash) return { status: 'changed' };
    return { status: 'ok', content: row.content, inputHash };
}

async function labelsFor(itemId) {
    return dbAll(
        `SELECT labeller, method, label, flags, note, created_at FROM relevance_gold_labels
         WHERE item_id = $1 ORDER BY created_at, id`,
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

module.exports = {
    readOnly, streamEvalRows,
    streamCandidates, sampleExists, insertItems, labelRows, pendingItems, itemText, labelsFor, recordLabel, recordLabels, sha256,
};
