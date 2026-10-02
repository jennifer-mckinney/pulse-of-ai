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
// The erasure request keys the post's text digests with AUDIT_HASH_KEY (it fails closed without one).
process.env.AUDIT_HASH_KEY = 'integration-test-audit-hash-key-0123456789-abcdef';
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
        // The stored notice says it was an erasure request, not a retention expiry.
        expect(p.content).toBe(retention.ERASURE_NOTICE);
        expect(out.join('\n')).toMatch(/removed/);
        // The unkeyed SHA-256 of the text is gone from the post and its audit rows (keyed values, not confirmable by a guess).
        const hashes = await db.dbAll(
            `SELECT content_hash AS h FROM raw_posts WHERE id = $1 UNION ALL SELECT input_hash FROM decision_audit_log WHERE raw_post_id = $1`, [post]);
        expect(hashes.length).toBeGreaterThan(1);
        for (const { h } of hashes) expect(h).toMatch(/^erased:[0-9a-f]{64}$/);
        // Re-running is harmless: the text is already gone, nothing is re-keyed, nothing more is erased.
        const again = await goldErase.main(['--post', post, '--remove-text'], { env: LOCAL, out: quiet });
        expect(again.erased).toBe(0);
        expect((await db.dbAll(`SELECT content_hash AS h FROM raw_posts WHERE id = $1`, [post]))[0].h).toBe(hashes[0].h);
    });

    it('fails closed, changing nothing, when AUDIT_HASH_KEY is missing or weak', async () => {
        const { post } = await setup();
        await expect(retention.removeTextOnRequest(post, { env: {} })).rejects.toThrow(/AUDIT_HASH_KEY/);
        await expect(retention.removeTextOnRequest(post, { env: { AUDIT_HASH_KEY: 'abcdefgh'.repeat(4) } })).rejects.toThrow(/entropy/);
        const p = await db.dbGet('SELECT text_removed_at FROM raw_posts WHERE id = $1', [post]);
        expect(p.text_removed_at).toBeNull();
    });

    it('a post whose text retention already removed still gets its embedding, gold rows and digests erased, once, with a log row', async () => {
        const { post, item } = await setup();
        await db.dbTransaction(client => retention.removeTextBatch(client, 'hacker_news', [post], {
            reason: 'detail window ended', rule: 'detail window', performedBy: 'test', platform: false,
        }));
        // Retention (a detail-window post) left the embedding and the digests; its gold rows went with the text.
        const out = [];
        const r = await goldErase.main(['--post', post, '--remove-text'], { env: LOCAL, out: l => out.push(l) });
        expect(out.join('\n')).toMatch(/already gone/);
        expect((await db.dbGet('SELECT COUNT(*)::int AS n FROM post_embeddings WHERE raw_post_id = $1', [post])).n).toBe(0);
        expect((await db.dbGet('SELECT content_hash FROM raw_posts WHERE id = $1', [post])).content_hash).toMatch(/^erased:/);
        const log = await db.dbGet(`SELECT reason FROM data_retention_log ORDER BY performed_at DESC LIMIT 1`);
        expect(JSON.parse(log.reason)).toMatchObject({ rule: 'erasure request', embeddings_deleted: 1 });
        expect(r.erased).toBe(0);
    });

    it('the erased-item count is what the call erased: an already-erased item is not counted twice', async () => {
        const { post } = await setup();
        await db.dbTransaction(client => retention.removeTextBatch(client, 'hacker_news', [post], {
            reason: 'detail window ended', rule: 'detail window', performedBy: 'test', platform: false,
        }));
        const r = await retention.removeTextOnRequest(post);
        expect(r).toMatchObject({ removed: false, source: 'hacker_news', goldErased: 0 });
    });

    it('parseArgs: --remove-text goes only with --post', () => {
        expect(() => goldErase.parseArgs(['--removed', '--remove-text'])).toThrow(/--remove-text goes with --post|exactly one/);
        expect(goldErase.parseArgs(['--post', '11111111-1111-4111-8111-111111111111', '--remove-text']).removeText).toBe(true);
    });

    it('removeTextOnRequest on an unknown post reports no source and changes nothing', async () => {
        await seedSources();
        expect(await retention.removeTextOnRequest('99999999-9999-4999-8999-999999999999')).toEqual({ removed: false, source: null, goldErased: 0 });
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

    it('does not lock a post of another source (the source filter)', async () => {
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

    it('does not lock a post whose text is already removed (the text_removed_at filter)', async () => {
        const { post } = await setup();
        await db.dbRun('UPDATE raw_posts SET text_removed_at = NOW() WHERE id = $1', [post]);
        await db.dbTransaction(async (holder) => {
            await holder.query('SELECT id FROM raw_posts WHERE id = $1 FOR SHARE', [post]);
            const ids = await db.dbTransaction(async (client) => {
                await client.query("SET LOCAL lock_timeout = '300ms'");   // would throw if the lock query matched the row
                return retention.removeTextBatch(client, 'hacker_news', [post], {
                    reason: 'lock test', rule: 'lock test', performedBy: 'test', platform: false,
                });
            });
            expect(ids).toEqual([]);
        });
    });
});
