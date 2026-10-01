// tests/integration/migration.070.test.js
// Relevance-accuracy Stage 0 (P3), against the real test DB: the gold-set
// tables relevance_gold_items and relevance_gold_labels — their constraints,
// the label input-hash check, and append-only enforcement (UPDATE / DELETE
// raise, like migration 036's governance tables).

'use strict';

const fs = require('fs');
const path = require('path');
const { dbAll, dbGet, dbRun, dbTransaction } = require('../../src/db/connection');

const SQL_070 = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/070_relevance_gold_set.sql'), 'utf8');
const H = (c) => c.repeat(64);
const POST = '11111111-1111-4111-8111-111111111111';

async function insertItem(over = {}) {
    const v = {
        sample_id: 'gold-test-a', raw_post_id: POST, input_hash: H('a'), category: 'news', scope: 'filter',
        decision: 'relevant', script: 'latin', stratum_population: 10, stratum_sample_size: 2,
        stratum_weight: 1, design_weight: 5, draw_rank: H('b'), sampler_version: '1.0.0', seed: 's', ...over,
    };
    v.stratum = over.stratum || `${v.category}|${v.scope}|${v.decision}|${v.script}`;
    return (await dbRun(
        `INSERT INTO relevance_gold_items (sample_id, raw_post_id, input_hash, category, scope, decision, script, stratum,
             stratum_population, stratum_sample_size, stratum_weight, design_weight, draw_rank, sampler_version, seed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [v.sample_id, v.raw_post_id, v.input_hash, v.category, v.scope, v.decision, v.script, v.stratum,
            v.stratum_population, v.stratum_sample_size, v.stratum_weight, v.design_weight, v.draw_rank, v.sampler_version, v.seed],
    )).id;
}

async function insertLabel(itemId, over = {}) {
    const v = { label: 'AI_CENTRAL', flags: [], labeller: 'ann', method: 'human', model_id: null,
        codebook_version: '1.0.0', input_hash: H('a'), note: null, ...over };
    return (await dbRun(
        `INSERT INTO relevance_gold_labels (item_id, label, flags, labeller, method, model_id, codebook_version, input_hash, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [itemId, v.label, v.flags, v.labeller, v.method, v.model_id, v.codebook_version, v.input_hash, v.note],
    )).id;
}

describe('migration 070: relevance gold set', () => {
    it('is idempotent (re-running it is a no-op)', async () => {
        await dbTransaction(c => c.query(SQL_070));
        await dbTransaction(c => c.query(SQL_070));
        const t = await dbAll(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'relevance_gold_%' AND NOT tgisinternal ORDER BY 1`);
        expect(t.map(r => r.tgname)).toEqual([
            'relevance_gold_items_append_only', 'relevance_gold_labels_append_only', 'relevance_gold_labels_check',
        ]);
    });

    it('creates no methodology version and changes no registered row', () => {
        expect(SQL_070).not.toMatch(/INSERT\s+INTO\s+methodology_versions/i);
        expect(SQL_070).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    });

    it('has no foreign key to raw_posts (the demo purge deletes posts; gold rows are append-only)', async () => {
        const fk = await dbAll(`SELECT conrelid::regclass::text AS t FROM pg_constraint
                                WHERE contype = 'f' AND confrelid = 'raw_posts'::regclass
                                  AND conrelid::regclass::text LIKE 'relevance_gold_%'`);
        expect(fk).toEqual([]);
    });

    it('stores an item and a label with the codebook values', async () => {
        const item = await insertItem();
        await insertLabel(item, { label: 'NOT_AI', flags: ['SPAM', 'LANG'] });
        await insertLabel(item, { label: 'AI_INCIDENTAL', labeller: 'llm-1', method: 'llm_proposed', model_id: 'model-x' });
        await insertLabel(item, { label: 'AI_CENTRAL', labeller: 'jen', method: 'adjudicated', note: 'ruled' });
        const rows = await dbAll('SELECT label, flags, method FROM relevance_gold_labels ORDER BY created_at, id');
        expect(rows).toHaveLength(3);
        expect(rows.find(r => r.method === 'human').flags).toEqual(['SPAM', 'LANG']);
    });

    it.each([
        ['scope', { scope: 'everywhere' }],
        ['decision', { decision: 'maybe' }],
        ['script', { script: 'klingon' }],
        ['input_hash', { input_hash: 'abc' }],
        ['draw_rank', { draw_rank: 'xyz' }],
        ['stratum form', { stratum: 'news|ai|relevant|latin' }],
        ['sample size above population', { stratum_population: 2, stratum_sample_size: 3 }],
        ['design weight below 1', { design_weight: 0.5 }],
        ['sample id form', { sample_id: 'Bad Sample!' }],
    ])('items reject a bad %s', async (_, over) => {
        await expect(insertItem(over)).rejects.toThrow(/violates check constraint/);
    });

    it('a post appears once per sample', async () => {
        await insertItem();
        await expect(insertItem()).rejects.toThrow(/duplicate key/);
        await expect(insertItem({ sample_id: 'gold-test-b' })).resolves.toBeDefined();
    });

    it.each([
        ['label', { label: 'MAYBE' }, /check constraint/],
        ['flag', { flags: ['FUN'] }, /check constraint/],
        ['method', { method: 'guess' }, /check constraint/],
        ['blank labeller', { labeller: '   ' }, /check constraint/],
        ['codebook version', { codebook_version: 'v1' }, /check constraint/],
        ['llm label without a model id', { method: 'llm_proposed', model_id: null }, /check constraint/],
        ['human label with a model id', { model_id: 'model-x' }, /check constraint/],
        ['duplicate flags', { flags: ['SPAM', 'SPAM'] }, /duplicate flags/],
        ['hash of different text', { input_hash: H('c') }, /input_hash does not match/],
    ])('labels reject a bad %s', async (_, over, err) => {
        const item = await insertItem();
        await expect(insertLabel(item, over)).rejects.toThrow(err);
    });

    it('a label must point at an existing item', async () => {
        await expect(insertLabel('22222222-2222-4222-8222-222222222222')).rejects.toThrow(/gold item .* does not exist|foreign key/);
    });

    it.each([['relevance_gold_items'], ['relevance_gold_labels']])('%s is append-only: UPDATE and DELETE raise', async (table) => {
        const item = await insertItem();
        const label = await insertLabel(item);
        const id = table === 'relevance_gold_items' ? item : label;
        await expect(dbRun(`UPDATE ${table} SET created_at = NOW() WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
        await expect(dbRun(`DELETE FROM ${table} WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
        expect((await dbGet(`SELECT COUNT(*)::int AS n FROM ${table}`)).n).toBe(1);
    });
});
