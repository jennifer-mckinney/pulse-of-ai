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
// The post's content hash and its audit rows' input hashes: ADR 0001 ruling 9 keeps them through an erasure request.
const hashState = async (post) => db.dbAll(
    `SELECT 'post' AS k, content_hash AS h FROM raw_posts WHERE id = $1
     UNION ALL SELECT 'audit:' || id::text, input_hash FROM decision_audit_log WHERE raw_post_id = $1 ORDER BY 1`, [post]);

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
        const before = await hashState(post);
        expect(before.length).toBeGreaterThan(1);   // the post's own hash and its audit rows
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
        // ADR 0001 ruling 9 (non-negotiable): the content hash and every audit row are untouched by an erasure request.
        expect(await hashState(post)).toEqual(before);
        // Re-running is harmless: the text is already gone, nothing more is erased, and no new log row is written.
        const logsBefore = (await db.dbGet('SELECT COUNT(*)::int AS n FROM data_retention_log')).n;
        const again = await goldErase.main(['--post', post, '--remove-text'], { env: LOCAL, out: quiet });
        expect(again.erased).toBe(0);
        expect((await db.dbGet('SELECT COUNT(*)::int AS n FROM data_retention_log')).n).toBe(logsBefore);
        expect(await hashState(post)).toEqual(before);
    });

    it('a post whose text retention already removed still gets its embedding, url and notice erased, with one log row', async () => {
        const { post } = await setup();
        await db.dbTransaction(client => retention.removeTextBatch(client, 'hacker_news', [post], {
            reason: 'detail window ended', rule: 'detail window', performedBy: 'test', platform: false,
        }));
        const before = await hashState(post);
        const out = [];
        const r = await goldErase.main(['--post', post, '--remove-text'], { env: LOCAL, out: l => out.push(l) });
        expect(out.join('\n')).toMatch(/already gone/);
        expect(r.erased).toBe(0);   // retention already erased the gold rows with the text
        expect((await db.dbGet('SELECT COUNT(*)::int AS n FROM post_embeddings WHERE raw_post_id = $1', [post])).n).toBe(0);
        expect((await db.dbGet('SELECT content FROM raw_posts WHERE id = $1', [post])).content).toBe(retention.ERASURE_NOTICE);
        expect(await hashState(post)).toEqual(before);
        const log = await db.dbGet(`SELECT reason FROM data_retention_log ORDER BY performed_at DESC LIMIT 1`);
        expect(JSON.parse(log.reason)).toMatchObject({ rule: 'erasure request', embeddings_deleted: 1, url_and_notice_scrubbed: true });
        const logs = (await db.dbGet('SELECT COUNT(*)::int AS n FROM data_retention_log')).n;
        await goldErase.main(['--post', post, '--remove-text'], { env: LOCAL, out: quiet });
        expect((await db.dbGet('SELECT COUNT(*)::int AS n FROM data_retention_log')).n).toBe(logs);   // nothing left to do: no new row
    });

    it('a live gold item of a post whose text is already gone is erased and counted once', async () => {
        const { post, item } = await setup();
        // The text went by another route (a restored backup): the gold item is still live.
        await db.dbRun(`UPDATE raw_posts SET text_removed_at = NOW(), text_removed_reason = 'other' WHERE id = $1`, [post]);
        const r = await retention.removeTextOnRequest(post);
        expect(r).toMatchObject({ removed: false, source: 'hacker_news', goldErased: 1 });
        const g = await db.dbGet('SELECT raw_post_id, erased_at FROM relevance_gold_items WHERE id = $1', [item]);
        expect(g.raw_post_id).toBeNull();
        expect(g.erased_at).toBeTruthy();
        expect((await retention.removeTextOnRequest(post)).goldErased).toBe(0);   // not counted twice
    });

    it('a Reddit post already blanked by retention loses its permalink and platform notice on an erasure request', async () => {
        await seedSources();
        const reddit = (await db.dbGet("SELECT id FROM data_sources WHERE name = 'reddit'")).id;
        const mv = await insertMethodologyVersions();
        const jobId = await insertJob();
        const post = await insertPostWithFullPipeline(reddit, jobId, mv, { externalId: 'erase-reddit-1', location: '' });
        await db.dbRun('UPDATE raw_posts SET raw_payload = $2::jsonb WHERE id = $1',
            [post, JSON.stringify({ title: 'a secret title', url: 'https://www.reddit.com/r/test/comments/abc123/a_secret_title/' })]);
        await db.dbTransaction(client => retention.blankPlatformPosts(client, 'reddit', [post], {
            reason: 'removed upstream', rule: 'test', performedBy: 'test',
        }));
        const kept = await db.dbGet('SELECT raw_payload FROM raw_posts WHERE id = $1', [post]);
        expect(kept.raw_payload.url).toBe('https://www.reddit.com/r/test/comments/abc123/');   // retention keeps the permalink
        await retention.removeTextOnRequest(post);
        const p = await db.dbGet('SELECT content, raw_payload FROM raw_posts WHERE id = $1', [post]);
        expect(p.content).toBe(retention.ERASURE_NOTICE);
        expect(p.raw_payload).not.toHaveProperty('url');
    });

    it('a demo post is skipped: nothing changes and the tool says so', async () => {
        await seedSources();
        const demo = await db.dbGet(
            `INSERT INTO data_sources (name, display_name, source_type, category, active)
             VALUES ('erase_demo_feed', 'Erase demo feed', 'demo', 'forums', true)
             ON CONFLICT (name) DO UPDATE SET source_type = 'demo' RETURNING id, name`);
        const mv = await insertMethodologyVersions();
        const jobId = await insertJob();
        const post = await insertPostWithFullPipeline(demo.id, jobId, mv, { externalId: 'erase-demo-1', location: '' });
        const out = [];
        const r = await goldErase.main(['--post', post, '--remove-text'], { env: LOCAL, out: l => out.push(l) });
        expect(r.erased).toBe(0);
        expect(out.join('\n')).toMatch(/demo post .*not erasable here/);
        expect((await db.dbGet('SELECT text_removed_at FROM raw_posts WHERE id = $1', [post])).text_removed_at).toBeNull();
        expect(await retention.removeTextOnRequest(post)).toMatchObject({ removed: false, skipped: 'demo', goldErased: 0 });
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
