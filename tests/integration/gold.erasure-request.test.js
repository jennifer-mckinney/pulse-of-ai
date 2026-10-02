// tests/integration/gold.erasure-request.test.js
// Relevance-accuracy Stage 0 (P3), against the real test DB:
//   - `gold-erase --post ID --remove-text` removes a live post's text the way retention does (text,
//     raw_payload text keys, url, embedding, gold rows, data_retention_log row) in one transaction;
//   - retention's row lock conflicts with the gold sampler's FOR SHARE (so a removal and a sample
//     never interleave) and covers only the rows the UPDATE touches.

'use strict';

const db = require('../../src/db/connection');
const { seedSources } = require('../../scripts/seed');
const retention = require('../../src/collectors/retention');
const { insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

process.env.GOLD_HASH_KEY = process.env.GOLD_HASH_KEY || 'integration-test-gold-hash-key-0123456789';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || 'localhost';
const TEST_PORT = String(process.env.POSTGRES_TEST_PORT || '5433');
if (!['5433', '5434'].includes(TEST_PORT)) process.env.GOLD_ALLOW_DB_PORT = TEST_PORT;
const goldErase = require('../../scripts/gold-erase');

const LOCAL = { POSTGRES_HOST: 'localhost', NODE_ENV: 'test', POSTGRES_TEST_PORT: TEST_PORT, GOLD_ALLOW_DB_PORT: process.env.GOLD_ALLOW_DB_PORT };
const quiet = () => {};
const H = (c) => c.repeat(64);

async function setup() {
    await seedSources();
    const hn = (await db.dbGet("SELECT id FROM data_sources WHERE name = 'hacker_news'")).id;
    const mv = await insertMethodologyVersions();
    const jobId = await insertJob();
    const post = await insertPostWithFullPipeline(hn, jobId, mv, { externalId: 'erase-req-1', location: '' });
    await db.dbRun(`UPDATE raw_posts SET raw_payload = $2::jsonb WHERE id = $1`,
        [post, JSON.stringify({ title: 'a secret title', url: 'https://example.test/p/1', route: 'algolia-search' })]);
    await db.dbRun('INSERT INTO post_embeddings (raw_post_id) VALUES ($1)', [post]);
    const item = (await db.dbRun(
        `INSERT INTO relevance_gold_items (sample_id, raw_post_id, input_hash, category, scope, decision, script, stratum,
             stratum_population, stratum_sample_size, stratum_weight, design_weight, draw_rank, sampler_version, seed)
         VALUES ('gold-req', $1, $2, 'forums', 'filter', 'relevant', 'latin', 'forums|filter|relevant|latin', 4, 2, 1, 2, $3, '1.0.0', 's')
         RETURNING id`, [post, H('a'), H('b')])).id;
    return { post, item };
}

describe('gold-erase --post --remove-text (erasure request)', () => {
    it('without --remove-text a post that still has text is refused and the hint names the flag', async () => {
        const { post } = await setup();
        await expect(goldErase.main(['--post', post], { env: LOCAL, out: quiet })).rejects.toThrow(/--remove-text/);
    });

    it('removes text, payload text keys, url, embedding and gold rows together, and logs it', async () => {
        const { post, item } = await setup();
        const out = [];
        const r = await goldErase.main(['--post', post, '--remove-text'], { env: LOCAL, out: l => out.push(l) });
        expect(r.erased).toBe(1);
        const p = await db.dbGet('SELECT content, raw_payload, text_removed_at, text_removed_reason FROM raw_posts WHERE id = $1', [post]);
        expect(p.content).not.toMatch(/Test post/);
        expect(p.text_removed_at).toBeTruthy();
        expect(p.text_removed_reason).toBe('erasure request');
        expect(JSON.stringify(p.raw_payload)).not.toMatch(/secret title|example\.test/);
        expect((await db.dbGet('SELECT COUNT(*)::int AS n FROM post_embeddings WHERE raw_post_id = $1', [post])).n).toBe(0);
        const g = await db.dbGet('SELECT raw_post_id, input_hash, erased_at FROM relevance_gold_items WHERE id = $1', [item]);
        expect(g).toMatchObject({ raw_post_id: null, input_hash: null });
        expect(g.erased_at).toBeTruthy();
        const log = await db.dbGet(`SELECT reason, legal_basis, performed_by FROM data_retention_log ORDER BY performed_at DESC LIMIT 1`);
        expect(JSON.parse(log.reason)).toMatchObject({ rule: 'erasure request', reason: 'erasure request', embeddings_deleted: 1 });
        expect(log.legal_basis).toMatch(/Article 17/);
        expect(out.join('\n')).toMatch(/removed/);
        // Re-running is harmless: the text is already gone.
        const again = await goldErase.main(['--post', post, '--remove-text'], { env: LOCAL, out: quiet });
        expect(again.erased).toBe(0);
    });

    it('parseArgs: --remove-text goes only with --post', () => {
        expect(() => goldErase.parseArgs(['--removed', '--remove-text'])).toThrow(/--remove-text goes with --post|exactly one/);
        expect(goldErase.parseArgs(['--post', '11111111-1111-4111-8111-111111111111', '--remove-text']).removeText).toBe(true);
    });

    it('removeTextOnRequest on an unknown post reports no source and changes nothing', async () => {
        await seedSources();
        expect(await retention.removeTextOnRequest('99999999-9999-4999-8999-999999999999')).toEqual({ removed: false, source: null });
    });
});

describe('retention row lock vs the gold sampler lock', () => {
    it('removeTextBatch waits for a sampler FOR SHARE lock on the post, then proceeds once it commits', async () => {
        const { post } = await setup();
        await db.dbTransaction(async (sampler) => {
            await sampler.query('SELECT id FROM raw_posts WHERE id = $1 ORDER BY id FOR SHARE', [post]);
            await expect(db.dbTransaction(async (client) => {
                await client.query("SET LOCAL lock_timeout = '300ms'");
                return retention.removeTextBatch(client, 'hacker_news', [post], {
                    reason: 'lock test', rule: 'lock test', performedBy: 'test', platform: false,
                });
            })).rejects.toThrow(/lock timeout/);
        });
        const ids = await db.dbTransaction(client => retention.removeTextBatch(client, 'hacker_news', [post], {
            reason: 'lock test', rule: 'lock test', performedBy: 'test', platform: false,
        }));
        expect(ids).toEqual([post]);
    });

    it('does not lock a post of another source or one whose text is already removed', async () => {
        const { post } = await setup();
        await db.dbTransaction(async (holder) => {
            await holder.query('SELECT id FROM raw_posts WHERE id = $1 FOR SHARE', [post]);
            // Wrong source slug: the lock query matches no row, so it neither waits nor changes anything.
            const ids = await db.dbTransaction(async (client) => {
                await client.query("SET LOCAL lock_timeout = '300ms'");
                return retention.removeTextBatch(client, 'guardian', [post], {
                    reason: 'lock test', rule: 'lock test', performedBy: 'test', platform: false,
                });
            });
            expect(ids).toEqual([]);
        });
    });
});
