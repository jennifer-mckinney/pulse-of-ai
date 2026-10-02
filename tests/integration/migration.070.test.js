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
            'relevance_gold_items_append_only', 'relevance_gold_items_no_truncate',
            'relevance_gold_labels_append_only', 'relevance_gold_labels_check', 'relevance_gold_labels_no_truncate',
        ]);
    });

    it('creates no methodology version and changes no registered row', () => {
        expect(SQL_070).not.toMatch(/INSERT\s+INTO\s+methodology_versions/i);
        // The only UPDATEs are the two inside gold_erase_post (the erasure path).
        const outsideErase = SQL_070.replace(/CREATE OR REPLACE FUNCTION gold_erase_post[\s\S]*$/, '');
        expect(outsideErase).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
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
        await insertLabel(item, { label: 'AI_INCIDENTAL', labeller: 'llm:model-x', method: 'llm_proposed', model_id: 'model-x' });
        await insertLabel(item, { label: 'AI_CENTRAL', labeller: 'jen', method: 'adjudicated', note: 'ruled' });
        const rows = await dbAll('SELECT label, flags, method FROM relevance_gold_labels ORDER BY seq');
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
        ['llm label under a human-style name', { method: 'llm_proposed', model_id: 'm', labeller: 'ann' }, /check constraint/],
        ['human label in the llm: namespace', { labeller: 'llm:ann' }, /check constraint/],
        ['human label in the LLM: namespace (case-insensitive)', { labeller: 'LLM:ann' }, /check constraint/],
        ['llm label whose labeller is not llm:<model_id>', { method: 'llm_proposed', model_id: 'y', labeller: 'llm:x' }, /check constraint/],
        ['note over 200 characters', { note: 'x'.repeat(201) }, /check constraint/],
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

    it('seq is a strict order: the later row has the higher seq even in one transaction', async () => {
        const item = await insertItem();
        await dbTransaction(async (c) => {
            for (const label of ['NOT_AI', 'AI_CENTRAL']) {
                await c.query(`INSERT INTO relevance_gold_labels (item_id, label, labeller, method, codebook_version, input_hash)
                               VALUES ($1, $2, 'ann', 'human', '1.0.0', $3)`, [item, label, H('a')]);
            }
        });
        const rows = await dbAll('SELECT label, seq FROM relevance_gold_labels ORDER BY seq');
        expect(rows.map(r => r.label)).toEqual(['NOT_AI', 'AI_CENTRAL']);
        expect(BigInt(rows[1].seq) > BigInt(rows[0].seq)).toBe(true);
    });

    it('seq is GENERATED ALWAYS: an explicit seq is rejected', async () => {
        const item = await insertItem();
        await expect(dbRun(
            `INSERT INTO relevance_gold_labels (item_id, label, labeller, method, codebook_version, input_hash, seq)
             VALUES ($1, 'NOT_AI', 'ann', 'human', '1.0.0', $2, 5)`, [item, H('a')],
        )).rejects.toThrow(/generated always|cannot insert/i);
    });

    it.each([['relevance_gold_items'], ['relevance_gold_labels']])('%s refuses TRUNCATE unless the transaction opts in', async (table) => {
        const item = await insertItem();
        await insertLabel(item);
        await expect(dbRun(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/TRUNCATE is not allowed/);
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM relevance_gold_items')).n).toBe(1);
    });

    describe('gold_erase_post (the erasure path)', () => {
        it('blanks the post id, the hash and the notes, stamps erased_at, and keeps labels, flags and strata', async () => {
            const item = await insertItem();
            const other = await insertItem({ raw_post_id: '33333333-3333-4333-8333-333333333333', input_hash: H('d') });
            await insertLabel(item, { label: 'NOT_AI', flags: ['SPAM'], note: 'a short note' });
            await insertLabel(other, { input_hash: H('d') });
            expect((await dbGet('SELECT gold_erase_post($1::uuid) AS n', [POST])).n).toBe(1);
            const i = await dbGet('SELECT raw_post_id, input_hash, erased_at, stratum, design_weight::float AS dw FROM relevance_gold_items WHERE id = $1', [item]);
            expect(i).toMatchObject({ raw_post_id: null, input_hash: null, stratum: 'news|filter|relevant|latin', dw: 5 });
            expect(i.erased_at).toBeTruthy();
            const l = await dbGet('SELECT label, flags, input_hash, note, erased_at FROM relevance_gold_labels WHERE item_id = $1', [item]);
            expect(l).toMatchObject({ label: 'NOT_AI', flags: ['SPAM'], input_hash: null, note: null });
            expect(l.erased_at).toBeTruthy();
            // The other post is untouched, and a second erase is a no-op.
            expect((await dbGet('SELECT input_hash FROM relevance_gold_items WHERE id = $1', [other])).input_hash).toBe(H('d'));
            expect((await dbGet('SELECT gold_erase_post($1::uuid) AS n', [POST])).n).toBe(0);
        });

        it('an erased item can no longer be labelled, and the erasure leaves the append-only guard in force', async () => {
            const item = await insertItem();
            await dbGet('SELECT gold_erase_post($1::uuid) AS n', [POST]);
            await expect(insertLabel(item)).rejects.toThrow(/erased/);
            await expect(dbRun('UPDATE relevance_gold_items SET raw_post_id = $2 WHERE id = $1', [item, POST])).rejects.toThrow(/append-only/);
            await expect(dbRun('DELETE FROM relevance_gold_items WHERE id = $1', [item])).rejects.toThrow(/append-only/);
        });

        it('setting the erasure flag by hand cannot be used to rewrite anything but the erasable columns', async () => {
            const item = await insertItem();
            await expect(dbTransaction(async (c) => {
                await c.query("SET LOCAL pulse.gold_erasure = 'on'");
                await c.query("UPDATE relevance_gold_items SET category = 'forums', raw_post_id = NULL, input_hash = NULL, erased_at = NOW() WHERE id = $1", [item]);
            })).rejects.toThrow(/only erasure may change a row/);
            await expect(dbTransaction(async (c) => {
                await c.query("SET LOCAL pulse.gold_erasure = 'on'");
                await c.query('UPDATE relevance_gold_items SET created_at = NOW() WHERE id = $1', [item]);
            })).rejects.toThrow(/only erasure may change a row/);
            await expect(dbTransaction(async (c) => {
                await c.query("SET LOCAL pulse.gold_erasure = 'on'");
                await c.query('DELETE FROM relevance_gold_items WHERE id = $1', [item]);
            })).rejects.toThrow(/DELETE is not allowed/);
        });

        it('items are either live or fully erased (never half)', async () => {
            const item = await insertItem();
            await expect(dbTransaction(async (c) => {
                await c.query("SET LOCAL pulse.gold_erasure = 'on'");
                await c.query('UPDATE relevance_gold_items SET raw_post_id = NULL, erased_at = NOW() WHERE id = $1', [item]);
            })).rejects.toThrow(/erasure|only erasure/);
        });
    });

    describe('erasure review fixes', () => {
        it('draw_rank (sha256(seed:post id)) is replaced on erasure, so it cannot re-link the item to the post', async () => {
            const item = await insertItem();
            const before = (await dbGet('SELECT draw_rank FROM relevance_gold_items WHERE id = $1', [item])).draw_rank;
            await dbGet('SELECT gold_erase_post($1::uuid) AS n', [POST]);
            const after = (await dbGet('SELECT draw_rank FROM relevance_gold_items WHERE id = $1', [item])).draw_rank;
            expect(after).toMatch(/^[0-9a-f]{64}$/);
            expect(after).not.toBe(before);
        });

        it('an erased row cannot be changed again (the erased_at stamp cannot be falsified)', async () => {
            const item = await insertItem();
            await dbGet('SELECT gold_erase_post($1::uuid) AS n', [POST]);
            await expect(dbTransaction(async (c) => {
                await c.query("SET LOCAL pulse.gold_erasure = 'on'");
                await c.query('UPDATE relevance_gold_items SET erased_at = NOW() WHERE id = $1', [item]);
            })).rejects.toThrow(/cannot change again/);
        });
    });

    it('indexes items by post id alone (retention erases per post)', async () => {
        const idx = await dbAll(`SELECT indexname FROM pg_indexes WHERE tablename = 'relevance_gold_items' AND indexdef LIKE '%(raw_post_id)%'`);
        expect(idx.map(r => r.indexname)).toContain('idx_relevance_gold_items_post');
    });
});
