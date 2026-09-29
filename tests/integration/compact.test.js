// tests/integration/compact.test.js
// scripts/compact.js — Tier 1 → Tier 2 compaction, against the real test DB.
//
// P9-3: demo-feed posts (data_sources.source_type = 'demo', the standup's
// FICTIONAL population) are never folded into the monthly rollups — rollups
// describe real discourse only — and at the retention boundary they are
// deleted together with every row that references them (owner decision
// 2026-09-29: "Delete demo posts and their rows (Recommended)"). Real posts
// and their audit trails are never deleted; the guard tests below prove the
// source_type filter holds in SQL even for demo-looking real posts.

'use strict';

const { dbAll, dbGet, dbRun, dbTransaction } = require('../../src/db/connection');
const {
    compactMonth, purgeDemoPosts, deleteDemoPosts,
    DEMO_POST_DEPENDENTS, DEMO_PURGE_LEGAL_BASIS,
} = require('../../scripts/compact');
const {
    insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline,
} = require('./helpers');

async function insertDemoSource(name = 'demo_social') {
    return (await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category, active)
         VALUES ($1, 'Demo feed — Social (fictional)', 'demo', 'social', FALSE)
         RETURNING id`,
        [name],
    )).id;
}

// ─── Purge fixtures ───────────────────────────────────────────────────────────

const CUTOFF = new Date('2026-04-01T00:00:00Z');                       // the retention boundary
const OLD = (day) => new Date(Date.UTC(2026, 0, day, 12)).toISOString(); // January: past the boundary
const RECENT = '2026-06-15T12:00:00Z';                                 // inside the detail window
const quiet = () => {};

/** Full pipeline post + an embedding row, so every raw_posts dependent has a row. */
async function insertFullPost(sourceId, job, mv, opts) {
    const id = await insertPostWithFullPipeline(sourceId, job, mv, opts);
    await dbRun('INSERT INTO post_embeddings (raw_post_id) VALUES ($1)', [id]);
    return id;
}

async function insertProfile(pseudoId) {
    return (await dbRun(
        `INSERT INTO pseudonymous_users (pseudo_id, correlation_confidence)
         VALUES ($1, 0.9) RETURNING id`,
        [pseudoId],
    )).id;
}

async function insertSighting(profileId, sourceId, sightedAt) {
    return (await dbRun(
        `INSERT INTO user_platform_sightings (pseudo_user_id, source_id, signal_hash, confidence, sighted_at)
         VALUES ($1, $2, 'hash', 0.9, $3) RETURNING id`,
        [profileId, sourceId, sightedAt],
    )).id;
}

/** Full row images of these posts and every row referencing them. */
async function snapshot(postIds) {
    const out = {};
    for (const table of [...DEMO_POST_DEPENDENTS, 'raw_posts']) {
        const col = table === 'raw_posts' ? 'id' : 'raw_post_id';
        out[table] = await dbAll(
            `SELECT * FROM ${table} WHERE ${col} = ANY($1::uuid[]) ORDER BY id`, [postIds],
        );
    }
    return out;
}

/** Row counts per table from a snapshot. */
function counts(snap) {
    return Object.fromEntries(Object.entries(snap).map(([t, rows]) => [t, rows.length]));
}

async function purgeLog() {
    return dbAll(`SELECT raw_post_id, action, reason, legal_basis, performed_by
                  FROM data_retention_log WHERE action = 'purged_demo'
                  ORDER BY performed_at, id`);
}

describe('scripts/compact.js — demo sources stay out of the rollups (P9-3)', () => {
    it('rolls up real posts only: no demo source row, no demo counts', async () => {
        const at = '2025-01-15T12:00:00Z';
        const job = await insertJob();
        const mv = await insertMethodologyVersions();
        const liveSrc = await insertSource('real-social', 'social');
        const demoSrc = await insertDemoSource();
        for (let i = 0; i < 2; i++) {
            await insertPostWithFullPipeline(liveSrc, job, mv, { externalId: `live-${i}`, collectedAt: at });
            await insertPostWithFullPipeline(demoSrc, job, mv, { externalId: `demo-${i}`, collectedAt: at, indicator: 'negative' });
        }

        // raw_posts.content is NOT NULL in the schema, so compaction's
        // content-nulling step (after the rollups) cannot complete today —
        // tracked with the retention work (PR #10). The rollups are therefore
        // checked inside a transaction that relaxes that constraint and is
        // ALWAYS rolled back: nothing here persists or leaks into other suites.
        const ROLLBACK = new Error('rollback');
        let src;
        let topics;
        await dbTransaction(async (client) => {
            await client.query('ALTER TABLE raw_posts ALTER COLUMN content DROP NOT NULL');
            await compactMonth(client, '2025-01-01', { log: () => {} });
            src = (await client.query('SELECT source_id, post_count, negative_count FROM monthly_source_rollups')).rows;
            topics = (await client.query('SELECT SUM(post_count)::int AS n, SUM(negative_count)::int AS neg FROM monthly_topic_rollups')).rows[0];
            throw ROLLBACK;
        }).catch((err) => { if (err !== ROLLBACK) throw err; });

        expect(src).toEqual([{ source_id: liveSrc, post_count: 2, negative_count: 0 }]);
        expect(topics).toEqual({ n: 2, neg: 0 });
        // The constraint is back (the transaction rolled back).
        const col = await dbGet(`SELECT is_nullable FROM information_schema.columns
                                 WHERE table_name = 'raw_posts' AND column_name = 'content'`);
        expect(col.is_nullable).toBe('NO');
    });

    it('is importable without running the CLI (require.main guard)', () => {
        const mod = require('../../scripts/compact');
        expect(typeof mod.compactMonth).toBe('function');
        expect(typeof mod.getMonthsToCompact).toBe('function');
        expect(typeof mod.purgeDemoPosts).toBe('function');
    });
});

describe('scripts/compact.js — demo posts are deleted at retention (P9-3)', () => {
    let job;
    let mv;
    let liveSrc;
    let demoSrc;

    beforeEach(async () => {
        job = await insertJob();
        mv = await insertMethodologyVersions();
        liveSrc = await insertSource('real-social', 'social');
        demoSrc = await insertDemoSource();
    });

    it('covers every table with a foreign key to raw_posts (live catalog)', async () => {
        // A migration that adds a raw_posts FK must also extend the purge.
        const rows = await dbAll(`
            SELECT DISTINCT con.conrelid::regclass::text AS table_name
            FROM pg_constraint con
            WHERE con.contype = 'f' AND con.confrelid = 'raw_posts'::regclass
            ORDER BY 1`);
        expect(rows.map(r => r.table_name)).toEqual([...DEMO_POST_DEPENDENTS].sort());
    });

    it('deletes old demo posts and all their rows in bounded batches; live posts and recent demo posts are untouched', async () => {
        const oldDemo = [];
        for (let d = 1; d <= 3; d++) {
            oldDemo.push(await insertFullPost(demoSrc, job, mv, { externalId: `demo-old-${d}`, collectedAt: OLD(d) }));
        }
        const recentDemo = await insertFullPost(demoSrc, job, mv, { externalId: 'demo-recent', collectedAt: RECENT });
        const oldLive = await insertFullPost(liveSrc, job, mv, { externalId: 'live-old', collectedAt: OLD(2) });
        const recentLive = await insertFullPost(liveSrc, job, mv, { externalId: 'live-recent', collectedAt: RECENT });
        // An earlier retention-log row for a real post must survive as well.
        await dbRun(`INSERT INTO data_retention_log (raw_post_id, action, reason)
                     VALUES ($1, 'collected', 'fixture')`, [oldLive]);

        const kept = [recentDemo, oldLive, recentLive];
        const before = await snapshot(kept);
        expect(counts(await snapshot(oldDemo))).toEqual({
            sentiment_results: 3, relevance_results: 3, discourse_results: 3,
            post_embeddings: 3, decision_audit_log: 9, raw_posts: 3,
        });

        const result = await purgeDemoPosts({ cutoff: CUTOFF, batchSize: 2, log: quiet });

        // Two bounded batches (2 + 1 posts), then an empty pass ends the loop.
        expect(result.batches).toBe(2);
        expect(result.counts).toMatchObject({
            raw_posts: 3, sentiment_results: 3, relevance_results: 3,
            discourse_results: 3, post_embeddings: 3, decision_audit_log: 9,
        });
        // Every old demo row is gone, in every raw_posts-referencing table.
        expect(counts(await snapshot(oldDemo))).toEqual({
            sentiment_results: 0, relevance_results: 0, discourse_results: 0,
            post_embeddings: 0, decision_audit_log: 0, raw_posts: 0,
        });
        // Live posts (old and recent) and the recent demo post: byte-for-byte unchanged.
        expect(await snapshot(kept)).toEqual(before);
        expect((await dbGet(`SELECT COUNT(*)::int AS n FROM data_retention_log
                             WHERE raw_post_id = $1 AND action = 'collected'`, [oldLive])).n).toBe(1);

        // One retention-log row per batch, with counts, window and legal basis.
        const log = await purgeLog();
        expect(log).toHaveLength(2);
        const reasons = log.map(r => JSON.parse(r.reason));
        expect(reasons.map(r => r.counts.raw_posts)).toEqual([2, 1]);
        expect(reasons[0].counts).toMatchObject({ decision_audit_log: 6, sentiment_results: 2, post_embeddings: 2 });
        expect(reasons[0].window).toEqual({ from: OLD(1), to: OLD(2) });
        expect(reasons[1].window).toEqual({ from: OLD(3), to: OLD(3) });
        for (const row of log) {
            expect(row.raw_post_id).toBeNull();
            expect(row.legal_basis).toBe(DEMO_PURGE_LEGAL_BASIS);
            expect(row.legal_basis).toMatch(/fictional demo/i);
            expect(row.performed_by).toBe('scripts/compact.js');
            expect(JSON.parse(row.reason).cutoff).toBe(CUTOFF.toISOString());
        }

        // Idempotent: a second run finds nothing and writes nothing.
        const again = await purgeDemoPosts({ cutoff: CUTOFF, batchSize: 2, log: quiet });
        expect(again.batches).toBe(0);
        expect(await purgeLog()).toHaveLength(2);
    });

    it('purges demo-feed correlation sightings and profiles left with no evidence; real sightings and shared profiles stay', async () => {
        const demoOnly = await insertProfile('demo-only');
        const shared = await insertProfile('shared-profile');
        const liveOnly = await insertProfile('live-only');
        await insertSighting(demoOnly, demoSrc, OLD(5));
        await insertSighting(shared, demoSrc, OLD(5));
        const sharedLive = await insertSighting(shared, liveSrc, OLD(5));
        const liveSighting = await insertSighting(liveOnly, liveSrc, OLD(5));
        const recentDemoSighting = await insertSighting(liveOnly, demoSrc, RECENT);

        const result = await purgeDemoPosts({ cutoff: CUTOFF, log: quiet });

        expect(result.counts).toMatchObject({ user_platform_sightings: 2, pseudonymous_users: 1, raw_posts: 0 });
        const sightings = await dbAll('SELECT id FROM user_platform_sightings ORDER BY id');
        expect(sightings.map(s => s.id).sort()).toEqual([sharedLive, liveSighting, recentDemoSighting].sort());
        const profiles = await dbAll('SELECT pseudo_id FROM pseudonymous_users ORDER BY pseudo_id');
        expect(profiles.map(p => p.pseudo_id)).toEqual(['live-only', 'shared-profile']);

        const [row] = await purgeLog();
        expect(JSON.parse(row.reason).window).toEqual({ from: OLD(5), to: OLD(5) });
    });

    it('recomputes platform_count and the sighting window of surviving profiles in the same transaction', async () => {
        // Built the way correlateUser() builds a profile: one sighting per
        // correlation, platform_count kept equal to the sighting rows.
        const shared = await insertProfile('shared-recount');
        await insertSighting(shared, demoSrc, OLD(2));        // purged
        await insertSighting(shared, liveSrc, OLD(9));
        await insertSighting(shared, liveSrc, RECENT);
        await dbRun(`UPDATE pseudonymous_users SET platform_count = 3,
                         first_sighted_at = $2, last_sighted_at = $3 WHERE id = $1`,
        [shared, OLD(2), RECENT]);

        // Kept alive only by a real post: no sighting left after the purge.
        const postOnly = await insertProfile('post-only');
        await insertSighting(postOnly, demoSrc, OLD(4));      // purged
        const livePost = await insertFullPost(liveSrc, job, mv, { externalId: 'live-profiled', collectedAt: OLD(4) });
        await dbRun('UPDATE raw_posts SET pseudo_user_id = $1 WHERE id = $2', [postOnly, livePost]);
        await dbRun('UPDATE pseudonymous_users SET platform_count = 1 WHERE id = $1', [postOnly]);

        // Untouched by the purge: its count is left exactly as it was.
        const untouched = await insertProfile('untouched');
        await insertSighting(untouched, liveSrc, OLD(6));
        await dbRun('UPDATE pseudonymous_users SET platform_count = 7 WHERE id = $1', [untouched]);

        const result = await purgeDemoPosts({ cutoff: CUTOFF, log: quiet });
        expect(result.counts).toMatchObject({
            user_platform_sightings: 2, pseudonymous_users: 0, pseudonymous_users_recounted: 2,
        });

        const rows = Object.fromEntries((await dbAll(
            `SELECT pseudo_id, platform_count, first_sighted_at, last_sighted_at
             FROM pseudonymous_users`)).map(r => [r.pseudo_id, r]));
        expect(rows['shared-recount'].platform_count).toBe(2);
        expect(new Date(rows['shared-recount'].first_sighted_at).toISOString()).toBe(OLD(9));
        expect(new Date(rows['shared-recount'].last_sighted_at).toISOString()).toBe(new Date(RECENT).toISOString());
        expect(rows['post-only'].platform_count).toBe(0);
        expect(rows.untouched.platform_count).toBe(7);

        // Invariant for every profile the purge touched: count == sightings left.
        const drift = await dbAll(`
            SELECT pu.pseudo_id FROM pseudonymous_users pu
            WHERE pu.pseudo_id IN ('shared-recount', 'post-only')
              AND pu.platform_count <> (SELECT COUNT(*) FROM user_platform_sightings s
                                        WHERE s.pseudo_user_id = pu.id)`);
        expect(drift).toEqual([]);
    });

    it('a failed recount rolls the whole batch back: the sightings stay and the count is unchanged', async () => {
        const shared = await insertProfile('rollback-recount');
        await insertSighting(shared, demoSrc, OLD(3));
        await insertSighting(shared, liveSrc, OLD(8));
        await dbRun('UPDATE pseudonymous_users SET platform_count = 2 WHERE id = $1', [shared]);

        // Fail the recount UPDATE only; every earlier statement ran.
        const failing = (client) => new Proxy(client, {
            get(target, prop) {
                if (prop !== 'query') return Reflect.get(target, prop);
                return (sql, params) => (/SET platform_count/.test(sql)
                    ? Promise.reject(new Error('recount failed'))
                    : target.query(sql, params));
            },
        });
        const { purgeDemoBatch } = require('../../scripts/compact');
        await expect(dbTransaction(c => purgeDemoBatch(failing(c), { cutoff: CUTOFF, batchSize: 10 })))
            .rejects.toThrow('recount failed');

        expect(await dbAll('SELECT id FROM user_platform_sightings WHERE pseudo_user_id = $1', [shared]))
            .toHaveLength(2);
        expect((await dbGet('SELECT platform_count FROM pseudonymous_users WHERE id = $1', [shared])).platform_count)
            .toBe(2);
        expect(await purgeLog()).toHaveLength(0);
    });

    it('GUARD: never deletes a row from a non-demo source, even when the post looks like demo data', async () => {
        // A REAL source whose name, display name, post content and payload
        // all look like demo data. Only data_sources.source_type decides.
        const lookalikeSrc = (await dbRun(
            `INSERT INTO data_sources (name, display_name, source_type, category, active)
             VALUES ('demo_news', 'Demo feed — News (fictional)', 'rss', 'news', FALSE)
             RETURNING id`,
        )).id;
        const lookalike = await insertFullPost(lookalikeSrc, job, mv, { externalId: 'demo-lookalike', collectedAt: OLD(1) });
        await dbRun(
            `UPDATE raw_posts SET content = 'Demo feed — fictional demo post (not real discourse)',
                                  raw_payload = '{"demo": true, "fictional": true}'::jsonb
             WHERE id = $1`, [lookalike]);
        const oldLive = await insertFullPost(liveSrc, job, mv, { externalId: 'live-old', collectedAt: OLD(1) });
        const lookalikeProfile = await insertProfile('lookalike-profile');
        await insertSighting(lookalikeProfile, lookalikeSrc, OLD(1));
        await dbRun('UPDATE raw_posts SET pseudo_user_id = $1 WHERE id = $2', [lookalikeProfile, lookalike]);

        const realIds = [lookalike, oldLive];
        const before = await snapshot(realIds);

        // 1. Direct call with real post ids: the SQL filter matches nothing.
        const direct = await dbTransaction(client => deleteDemoPosts(client, realIds));
        expect(Object.values(direct).every(n => n === 0)).toBe(true);

        // 2. The full purge run: no demo data exists, so nothing is deleted or logged.
        const result = await purgeDemoPosts({ cutoff: CUTOFF, log: quiet });
        expect(result.batches).toBe(0);
        expect(await purgeLog()).toHaveLength(0);

        expect(await snapshot(realIds)).toEqual(before);
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM user_platform_sightings')).n).toBe(1);
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM pseudonymous_users')).n).toBe(1);
    });

    it('GUARD: a mixed id list deletes only the demo posts in it', async () => {
        const demo = await insertFullPost(demoSrc, job, mv, { externalId: 'demo-1', collectedAt: OLD(1) });
        const live = await insertFullPost(liveSrc, job, mv, { externalId: 'live-1', collectedAt: OLD(1) });
        const before = await snapshot([live]);

        const deleted = await dbTransaction(client => deleteDemoPosts(client, [demo, live]));

        expect(deleted).toEqual({
            sentiment_results: 1, relevance_results: 1, discourse_results: 1,
            post_embeddings: 1, decision_audit_log: 3, raw_posts: 1,
        });
        expect(await snapshot([live])).toEqual(before);
    });

    it('a failed batch rolls back whole: nothing deleted, nothing logged', async () => {
        const demo = await insertFullPost(demoSrc, job, mv, { externalId: 'demo-1', collectedAt: OLD(1) });
        const before = await snapshot([demo]);
        const BOOM = new Error('boom');
        await expect(dbTransaction(async (client) => {
            await deleteDemoPosts(client, [demo]);
            throw BOOM;
        })).rejects.toBe(BOOM);
        expect(await snapshot([demo])).toEqual(before);
        expect(await purgeLog()).toHaveLength(0);
    });

    it('clamps the batch size to at least 1', async () => {
        await insertFullPost(demoSrc, job, mv, { externalId: 'demo-1', collectedAt: OLD(1) });
        await insertFullPost(demoSrc, job, mv, { externalId: 'demo-2', collectedAt: OLD(2) });
        const result = await purgeDemoPosts({ cutoff: CUTOFF, batchSize: 0, log: quiet });
        expect(result.batches).toBe(2);
        expect(result.counts.raw_posts).toBe(2);
    });
});
