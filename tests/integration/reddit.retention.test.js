// tests/integration/reddit.retention.test.js
// Reddit (#52) against the real test database: the 48-hour text removal and
// the 6-hourly upstream-deletion re-check by BLANKING (ADR 0001 ruling 9,
// Jennifer: "Blank text, keep audit rows"), the receipt and replay for a
// blanked post, the shared request budget, the maintenance jobs, the
// subreddit-selection snapshot served by /api/sources, and the bias stage
// (no user traits). Reddit API answers are HAND-WRITTEN FROM DOCS,
// UNVERIFIED AGAINST THE LIVE API; Reddit is never contacted.

'use strict';

const request = require('supertest');
const app = require('../../src/server');
const db = require('../../src/db/connection');
const { seedSources } = require('../../scripts/seed');
const { main: replayMain } = require('../../scripts/replay');
const retention = require('../../src/collectors/retention');
const { recheckDeletions } = require('../../src/collectors/reddit/recheck');
const { DbBudget, BudgetExhaustedError } = require('../../src/collectors/reddit/budget');
const selection = require('../../src/collectors/reddit/selection');
const maintenance = require('../../src/collectors/reddit/maintenance');
const { runBiasChecks } = require('../../src/pipeline/bias');
const { insertJob, insertMethodologyVersions, insertBiasMethodology, insertPostWithFullPipeline } = require('./helpers');

const HOUR = 3600000;
const OPEN_ENV = {
    COLLECTOR_CONTACT_URL: 'https://example.org/contact',
    REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'secret',
    REDDIT_USER_AGENT: 'server:pulse-of-ai:v1.0.0 (by /u/example_user)', REDDIT_API_APPROVAL_REF: 'RBP-1',
    GATE_APPROVED_BY: 'Test Operator 2026-09-29',   // PR #22 decision G5
};

let ids;
let mv;
let jobId;

beforeEach(async () => {
    await seedSources();
    const rows = await db.dbAll("SELECT id, name FROM data_sources WHERE name IN ('reddit', 'hacker_news')");
    ids = Object.fromEntries(rows.map(r => [r.name, r.id]));
    mv = await insertMethodologyVersions();
    jobId = await insertJob();
});

/** A scored Reddit post (every score + audit row) with a Reddit payload. */
async function redditPost(t3, hoursAgo, { slug = 'reddit' } = {}) {
    const id = await insertPostWithFullPipeline(ids[slug], jobId, mv, {
        externalId: `data-api:${t3}`, collectedAt: new Date(Date.now() - hoursAgo * HOUR), location: '',
    });
    await db.dbRun(
        `UPDATE raw_posts SET raw_payload = $2::jsonb WHERE id = $1`,
        [id, JSON.stringify({
            id: `data-api:${t3}`, title: 'AI safety thread', text: 'AI safety thread\n\nLong self text about LLMs',
            url: `https://www.reddit.com/r/OpenAI/comments/${t3.slice(3)}/ai_safety_thread/`, source_slug: slug, route: 'data-api',
        })],
    );
    await db.dbRun(`UPDATE sentiment_results SET positive_words = '{safety}' WHERE raw_post_id = $1`, [id]);
    return id;
}

const snapshotRows = async (id) => ({
    post: await db.dbGet('SELECT content, content_hash, external_id, provenance_fingerprint, raw_payload, text_removed_at, text_removed_reason FROM raw_posts WHERE id = $1', [id]),
    audit: (await db.dbAll('SELECT id, output, input_hash FROM decision_audit_log WHERE raw_post_id = $1 ORDER BY id', [id])),
    sentiment: await db.dbGet('SELECT score, indicator, positive_words FROM sentiment_results WHERE raw_post_id = $1', [id]),
    relevance: await db.dbGet('SELECT score FROM relevance_results WHERE raw_post_id = $1', [id]),
    discourse: await db.dbGet('SELECT dqi_total FROM discourse_results WHERE raw_post_id = $1', [id]),
});

describe('48-hour retention: text blanked, scores and audit rows kept (ruling 9)', () => {
    it('blanks only Reddit posts past 48 h; keeps permalink, t3 id, hash, provenance, scores and audit rows', async () => {
        const old = await redditPost('t3_old01', 49);
        const fresh = await redditPost('t3_new01', 1);
        const hn = await insertPostWithFullPipeline(ids.hacker_news, jobId, mv, { externalId: 'hn:1', collectedAt: new Date(Date.now() - 100 * HOUR) });
        const before = { old: await snapshotRows(old), fresh: await snapshotRows(fresh), hn: await snapshotRows(hn) };

        const totals = await retention.blankExpired();
        // Every real source is visited (P10-2); only the Reddit post changed.
        expect(totals.reddit).toBe(1);
        expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(1);

        const after = await snapshotRows(old);
        expect(after.post.content).toBe('[removed: Reddit Data API Terms retention]');
        expect(after.post.raw_payload).toEqual(expect.objectContaining({
            text: retention.REMOVAL_NOTICE, title: retention.REMOVAL_NOTICE,
            url: 'https://www.reddit.com/r/OpenAI/comments/old01/',   // slug (title words) cut
        }));
        expect(JSON.stringify(after.post.raw_payload)).not.toMatch(/safety thread|LLMs/i);
        expect(after.post.text_removed_at).not.toBeNull();
        expect(after.post.text_removed_reason).toBe('48-hour retention window ended');
        for (const k of ['content_hash', 'external_id', 'provenance_fingerprint']) expect(after.post[k]).toEqual(before.old.post[k]);
        for (const k of ['audit', 'sentiment', 'relevance', 'discourse']) expect([k, after[k]]).toEqual([k, before.old[k]]);
        expect(after.sentiment.positive_words).toEqual(['safety']);   // derived cue words retained (ruling 9)
        expect(await snapshotRows(fresh)).toEqual(before.fresh);
        expect(await snapshotRows(hn)).toEqual(before.hn);

        const log = await db.dbAll('SELECT raw_post_id, action, reason, legal_basis, performed_by FROM data_retention_log');
        expect(log).toHaveLength(1);
        expect(log[0]).toEqual(expect.objectContaining({ raw_post_id: null, action: 'blanked_platform_terms', performed_by: 'src/collectors/retention.js' }));
        expect(log[0].legal_basis).toMatch(/Reddit Data API Terms.*48 hours.*retained by owner decision/s);
        expect(JSON.parse(log[0].reason)).toEqual(expect.objectContaining({ source: 'reddit', post_ids: [old], rule: '48-hour retention' }));

        // Idempotent: nothing left to blank, no new log row.
        expect(Object.values(await retention.blankExpired()).reduce((a, b) => a + b, 0)).toBe(0);
        expect(await db.dbAll('SELECT id FROM data_retention_log')).toHaveLength(1);
    });

    it('guard: blanking only ever touches Reddit rows, whatever ids reach it', async () => {
        const hn = await insertPostWithFullPipeline(ids.hacker_news, jobId, mv, { externalId: 'hn:2' });
        const r = await redditPost('t3_g01', 1);
        const hnBefore = await snapshotRows(hn);
        const blanked = await retention.blankPosts('reddit', [hn, r], { reason: 'test' });
        expect(blanked).toEqual([r]);
        expect(await snapshotRows(hn)).toEqual(hnBefore);
        await expect(retention.blankPosts('hacker_news', [hn], { reason: 'x' })).rejects.toThrow(/no platform-terms retention/);
        // P10-2: YouTube and TikTok (30 days) have platform windows too; the
        // Guardian's was withdrawn ("Use normal retention", 2026-09-29).
        expect(retention.retentionSources().map(s => s.slug).sort()).toEqual(['reddit', 'tiktok', 'youtube']);
    });
});

// PR #22 decision G3 (Jennifer, 2026-09-29): the embedding is derived from
// the text, so platform-terms blanking deletes it in the same transaction;
// scores and audit rows stay (ruling 9). The §19 detail window leaves
// embeddings to monthly compaction.
describe('G3: platform-terms blanking deletes the post embedding, keeps scores and audit rows', () => {
    const embeddings = async (id) => (await db.dbGet('SELECT COUNT(*)::int AS n FROM post_embeddings WHERE raw_post_id = $1', [id])).n;
    const embed = (id) => db.dbRun('INSERT INTO post_embeddings (raw_post_id) VALUES ($1)', [id]);

    it('48 h window: the blanked post loses its embedding, the fresh one and other sources keep theirs', async () => {
        const old = await redditPost('t3_emb01', 49);
        const fresh = await redditPost('t3_emb02', 1);
        const hn = await insertPostWithFullPipeline(ids.hacker_news, jobId, mv, { externalId: 'hn:emb', collectedAt: new Date(Date.now() - 100 * HOUR) });
        for (const id of [old, fresh, hn]) await embed(id);
        const before = await snapshotRows(old);

        await retention.blankExpired();
        expect(await embeddings(old)).toBe(0);
        expect(await embeddings(fresh)).toBe(1);
        expect(await embeddings(hn)).toBe(1);
        const after = await snapshotRows(old);
        for (const k of ['audit', 'sentiment', 'relevance', 'discourse']) expect([k, after[k]]).toEqual([k, before[k]]);
        const log = JSON.parse((await db.dbGet(`SELECT reason FROM data_retention_log WHERE action = 'blanked_platform_terms'`)).reason);
        expect(log).toMatchObject({ post_ids: [old], embeddings_deleted: 1, retained: expect.stringMatching(/embedding.*deleted.*G3/) });
    });

    it('upstream deletion (blankPosts) deletes the embedding in the same transaction; a failed blank keeps it', async () => {
        const r = await redditPost('t3_emb03', 1);
        await embed(r);
        // The whole batch rolls back when the log insert fails: text AND embedding stay.
        await expect(db.dbTransaction(async (client) => {
            await retention.blankPlatformPosts(client, 'reddit', [r], { reason: 'x', rule: 'x', performedBy: 'test' });
            throw new Error('abort');
        })).rejects.toThrow('abort');
        expect(await embeddings(r)).toBe(1);
        expect((await db.dbGet('SELECT text_removed_at FROM raw_posts WHERE id = $1', [r])).text_removed_at).toBeNull();

        expect(await retention.blankPosts('reddit', [r], { reason: 'deleted upstream' })).toEqual([r]);
        expect(await embeddings(r)).toBe(0);
    });

    it('the detail window (§19) blanks text but leaves the embedding to compaction', async () => {
        const hn = await insertPostWithFullPipeline(ids.hacker_news, jobId, mv, { externalId: 'hn:old', collectedAt: new Date(Date.now() - 91 * 24 * HOUR) });
        await embed(hn);
        expect((await retention.blankExpired()).hacker_news).toBe(1);
        expect(await embeddings(hn)).toBe(1);
        const log = JSON.parse((await db.dbGet(`SELECT reason FROM data_retention_log WHERE action = 'text_removed_detail_window'`)).reason);
        expect(log).not.toHaveProperty('embeddings_deleted');
    });
});

describe('6-hourly deletion re-check (/api/info, fixtures)', () => {
    const thing = (name, extra = {}) => ({ kind: 't3', data: { name, subreddit: 'OpenAI', subreddit_type: 'public', title: 'AI', selftext: 'x', ...extra } });

    it('blanks posts deleted, removed or missing upstream at once; keeps live ones; batches of 100', async () => {
        const live = await redditPost('t3_live1', 2);
        const deleted = await redditPost('t3_del1', 2);
        const removed = await redditPost('t3_rem1', 2);
        const missing = await redditPost('t3_mis1', 2);
        const priv = await redditPost('t3_prv1', 2);
        const calls = [];
        const api = {
            async info(names) {
                calls.push(names);
                return [thing('t3_live1'), thing('t3_del1', { selftext: '[deleted]' }),
                    thing('t3_rem1', { removed_by_category: 'moderator' }), thing('t3_prv1', { subreddit_type: 'private' })]
                    .filter(t => names.includes(t.data.name));
            },
        };
        const r = await recheckDeletions({ api });
        expect(calls).toHaveLength(1);
        expect(calls[0].sort()).toEqual(['t3_del1', 't3_live1', 't3_mis1', 't3_prv1', 't3_rem1']);
        expect(r).toEqual(expect.objectContaining({ checked: 5, blanked: 4, failedBatches: 0, complete: true }));
        const reasons = Object.fromEntries(await Promise.all([deleted, removed, missing, priv].map(async id =>
            [id, (await db.dbGet('SELECT text_removed_reason FROM raw_posts WHERE id = $1', [id])).text_removed_reason])));
        expect(reasons).toEqual({
            [deleted]: 'selftext is [deleted]', [removed]: 'removed_by_category is set',
            [missing]: 'missing from /api/info (deleted or inaccessible)', [priv]: "subreddit_type is 'private'",
        });
        expect((await db.dbGet('SELECT content FROM raw_posts WHERE id = $1', [live])).content).not.toMatch(/removed/);
        expect(await db.dbAll("SELECT id FROM data_retention_log WHERE action = 'blanked_platform_terms'")).toHaveLength(4);
        // Already-blanked posts are not re-checked.
        calls.length = 0;
        await recheckDeletions({ api });
        expect(calls).toEqual([['t3_live1']]);
    });

    it('a failed batch blanks nothing (the 48 h window still bounds it) and reports incomplete; 150 posts = 2 batches', async () => {
        for (let i = 0; i < 150; i++) {
            await db.dbRun(
                `INSERT INTO raw_posts (source_id, external_id, content, content_hash) VALUES ($1, $2, 'AI text', md5($2))`,
                [ids.reddit, `data-api:t3_b${i}`],
            );
        }
        let n = 0;
        const api = { async info(names) {
            n++;
            if (n === 1) throw Object.assign(new Error('HTTP 503'), { status: 503 });
            return names.map(name => thing(name));
        } };
        const r = await recheckDeletions({ api });
        expect(r).toEqual(expect.objectContaining({ checked: 50, blanked: 0, failedBatches: 1, complete: false }));
        const budgetOut = { async info() { throw new BudgetExhaustedError(); } };
        expect((await recheckDeletions({ api: budgetOut })).complete).toBe(false);
        const refused = { async info() { throw Object.assign(new Error('no'), { status: 403 }); } };
        await expect(recheckDeletions({ api: refused })).rejects.toThrow('no');
    });
});

describe('receipts and replay of a blanked Reddit post', () => {
    it('the receipt shows the removal notice and why; a live post says when its text goes', async () => {
        const old = await redditPost('t3_rcp1', 49);
        const fresh = await redditPost('t3_rcp2', 1);
        await retention.blankExpired();
        const res = await request(app).get(`/api/audit/${old}`);
        expect(res.status).toBe(200);
        expect(res.body.post.content_snippet).toBe(retention.REMOVAL_NOTICE);
        expect(res.body.provenance.permalink).toBe('https://www.reddit.com/r/OpenAI/comments/rcp1/');
        expect(res.body.provenance.retention).toEqual(expect.objectContaining({
            status: 'text_removed', reason: '48-hour retention window ended',
            notice: expect.stringMatching(/Text removed per the Reddit Data API Terms.*after 48 hours or on deletion upstream.*Scores and audit rows retained by owner decision/),
        }));
        expect(res.body.decisions).toHaveLength(3);
        const live = await request(app).get(`/api/audit/${fresh}`);
        expect(live.body.provenance.retention).toEqual(expect.objectContaining({ status: 'live', removes_at: expect.any(String) }));
        expect(live.body.post.content_snippet).not.toBe(retention.REMOVAL_NOTICE);
        // Other sources carry no retention block.
        const hn = await insertPostWithFullPipeline(ids.hacker_news, jobId, mv, { externalId: 'hn:3' });
        expect((await request(app).get(`/api/audit/${hn}`)).body.provenance.retention).toBeUndefined();
    });

    it('npm run replay reports NOT RE-RUNNABLE with the platform-terms reason (exit 3, never DIVERGENCE)', async () => {
        const old = await redditPost('t3_rpl1', 49);
        await retention.blankExpired();
        const out = [];
        const code = await replayMain(['--post', old], { db, out: l => out.push(l), err: l => out.push(l) });
        const text = out.join('\n');
        expect(code).toBe(3);
        expect(text).toContain('[NOT RE-RUNNABLE] sentiment');
        expect(text).toMatch(/post text removed under the retention rules \(48-hour retention window ended\).*content hash no longer matches.*retained by owner decision/);
        expect(text).not.toContain('[DIVERGENCE]');
    });
});

describe('the shared request budget (DbBudget)', () => {
    it('caps a window, keeps a reserve, rolls the window, and honours X-Ratelimit headers', async () => {
        const b = new DbBudget({ cap: 3, windowMs: 1000 });
        expect(await b.take({ reserve: 3 })).toBe(false);
        expect([await b.take(), await b.take(), await b.take(), await b.take()]).toEqual([true, true, true, false]);
        await new Promise(r => setTimeout(r, 1100));
        expect(await b.take()).toBe(true);
        await b.observe({ 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '60' });
        expect(await b.take()).toBe(false);
        const row = await db.dbGet('SELECT upstream_remaining, blocked_until > NOW() AS blocked FROM reddit_api_budget WHERE id = 1');
        expect(row).toEqual({ upstream_remaining: 3, blocked: true });
        // One budget for every process: a second instance sees the block.
        expect(await new DbBudget().take()).toBe(false);
    });
});

describe('maintenance: retention always, API jobs only behind the open gate', () => {
    it('with the gate closed it makes no API call; the 48 h text retention runs in the maintenance job whatever the gate', async () => {
        const id = await redditPost('t3_m01', 60);
        const r = await maintenance.runRedditMaintenance({ env: {} , api: { info: () => { throw new Error('must not call'); } } });
        expect(r.blanked).toBeUndefined();
        expect(r.api).toMatch(/^skipped: /);
        // P10-2: the worker's repeatable maintenance job owns retention.
        const { processMaintenanceJob } = require('../../src/workers/maintenance.worker');
        const out = await processMaintenanceJob({}, { steps: [['retention', () => retention.blankExpired()]] });
        expect(out.retention.ok).toBe(true);
        expect(out.retention.result.reddit).toBe(1);
        expect((await db.dbGet('SELECT text_removed_at FROM raw_posts WHERE id = $1', [id])).text_removed_at).not.toBeNull();
    });

    it('with the gate open: re-check and discovery run once when due, the snapshot replaces the provisional list', async () => {
        expect((await selection.loadSelection()).basis).toBe('provisional');
        const [q1] = require('../../src/collectors/reddit/discovery').buildQueries();
        const posts = Array.from({ length: 25 }, (_, i) => ({ kind: 't3', data: { name: `t3_s${i}`, subreddit: 'Futurology', title: 'AI jobs', selftext: '', created_utc: Math.floor(Date.now() / 1000) - 3600 } }));
        const api = {
            info: async names => names.map(name => ({ kind: 't3', data: { name, subreddit_type: 'public', title: 'AI', selftext: 'x' } })),
            listing: async (path, params) => (params.q === q1 && !params.after ? { children: posts, after: null } : { children: [], after: null }),
            about: async () => ({ display_name: 'Futurology', subscribers: 21000000, subreddit_type: 'public', over18: false }),
        };
        await redditPost('t3_m02', 2);
        const r = await maintenance.runRedditMaintenance({ env: OPEN_ENV, api });
        expect(r.recheck).toEqual(expect.objectContaining({ complete: true }));
        expect(r.discovery).toEqual(expect.objectContaining({ complete: true }));
        const sel = await selection.loadSelection();
        expect(sel).toEqual(expect.objectContaining({ basis: 'ranking', subreddits: ['Futurology'], min_ai_posts_7d: 20 }));
        expect(sel.ranking).toEqual([{ subreddit: 'Futurology', ai_posts_7d: 25, subscribers: 21000000, rank: 1, selected: true }]);
        // Not due again within its interval.
        const again = await maintenance.runRedditMaintenance({ env: OPEN_ENV, api });
        expect(again.recheck).toBeUndefined();
        expect(again.discovery).toBeUndefined();
        // The database kill switch closes the API jobs too.
        await db.dbRun("UPDATE data_sources SET collection_disabled_at = NOW() WHERE name = 'reddit'");
        expect((await maintenance.runRedditMaintenance({ env: OPEN_ENV, api })).api).toMatch(/kill switch/);
    });

    it('an incomplete or failed job releases its claim and is retried on the next tick', async () => {
        expect(await maintenance.claimJob('recheck', 6)).toBe(true);
        expect(await maintenance.claimJob('recheck', 6)).toBe(false);   // held
        await maintenance.finishJob('recheck', { complete: false });
        expect(await maintenance.claimJob('recheck', 6)).toBe(true);
        await maintenance.finishJob('recheck', { complete: true, stats: { checked: 0 } });
        expect(await maintenance.claimJob('recheck', 6)).toBe(false);   // done, not due
    });

    it('a snapshot that selects nothing is stored but keeps the previous selection', async () => {
        await selection.saveSnapshot({ windowStart: new Date(), windowEnd: new Date(), minPosts: 20, selected: [], ranking: [],
            exclusions: [{ subreddit: 'x', ai_posts_7d: 30, reason: 'no subscriber count returned' }], stats: {} });
        expect((await selection.loadSelection()).basis).toBe('provisional');
        expect((await selection.selectionStatus()).latest_snapshot).toEqual(expect.objectContaining({ applied: false }));
    });
});

describe('GET /api/sources: Reddit gate, terms citation, retention and selection', () => {
    it('serves the Reddit row awaiting approval with its selection (provisional) and retention', async () => {
        const res = await request(app).get('/api/sources');
        const reddit = res.body.find(s => s.slug === 'reddit');
        expect(reddit).toEqual(expect.objectContaining({
            rank: 52, category: 'forums', auth_kind: 'approval', terms_url: 'https://redditinc.com/policies/data-api-terms',
            retention: expect.objectContaining({ max_age_hours: 48, recheck_hours: 6 }),
        }));
        expect(reddit.status).toMatch(/^(awaiting_approval|disabled)$/);
        expect(reddit.selection).toEqual(expect.objectContaining({ basis: 'provisional', deny_list: ['antiai'], latest_snapshot: null }));
        expect(reddit.selection.subreddits).toHaveLength(7);
        expect(reddit.selection.rule).toMatch(/most subscribers among those with at least the minimum number of AI-mentioning posts/);
        expect(res.body.find(s => s.slug === 'hacker_news').selection).toBeUndefined();
        expect(res.body.find(s => s.slug === 'hacker_news').retention).toBeNull();
    });
});

describe('bias stage: no user-trait inference on Reddit posts', () => {
    it('only the three aggregate checks run; no row labels a user or a political trait', async () => {
        const biasMvId = await insertBiasMethodology();
        for (let i = 0; i < 4; i++) await redditPost(`t3_bias${i}`, 1);
        const r = await runBiasChecks(jobId, biasMvId);
        expect(r.checksRun).toBe(3);
        const rows = await db.dbAll('SELECT assessment_type, group_field, group_value, metric_name FROM bias_assessments WHERE job_id = $1', [jobId]);
        expect(new Set(rows.map(x => x.assessment_type))).toEqual(new Set(['location_concentration', 'platform_sentiment_parity', 'negative_dominance']));
        const text = JSON.stringify(rows);
        expect(text).not.toMatch(/author|user|political|affiliation|ideolog|partisan|gender|religio|ethnic|orientation/i);
        // Group fields are locations and platform categories only — never a person.
        for (const x of rows) expect([null, 'global', 'location', 'category', 'source_category', 'platform']).toContain(x.group_field);
    });
});

describe('one real collection run through the pipeline (fixtures)', () => {
    it('stores only allowlisted fields — never an author — with the t3 id, permalink and redacted text', async () => {
        const { runCollection } = require('../../src/collectors/runner');
        const { fixtureTransport } = require('../helpers/fixtureTransport');
        const { clearTokenCache, TOKEN_URL } = require('../../src/collectors/reddit/api');
        await require('../../scripts/seed').seedMethodology();
        clearTokenCache();
        const subs = (await selection.loadSelection()).subreddits;
        const transport = fixtureTransport([
            [TOKEN_URL, 'reddit/token.json'],
            ['https://oauth.reddit.com/r/OpenAI/new?limit=100&raw_json=1', 'reddit/new-openai.json'],
            ...subs.filter(s => s !== 'OpenAI').map(s => [`https://oauth.reddit.com/r/${s}/new?limit=100&raw_json=1`, 'reddit/new-empty.json']),
        ]);
        const summary = await runCollection({
            slugs: ['reddit'], env: OPEN_ENV, transport, now: () => Date.parse('2026-09-29T12:00:00Z'),
            queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
        });
        expect(summary.sources[0]).toEqual(expect.objectContaining({ slug: 'reddit', outcome: 'ok', new: 2 }));
        const rows = await db.dbAll(
            `SELECT rp.external_id, rp.content, rp.raw_payload, rp.location FROM raw_posts rp WHERE rp.source_id = $1 ORDER BY rp.external_id`,
            [ids.reddit],
        );
        expect(rows.map(r => r.external_id)).toEqual(['data-api:t3_1aaa01', 'data-api:t3_1aaa02']);
        const json = JSON.stringify(rows);
        expect(json).not.toMatch(/author|Fixture(Author|Mod|Moderator|Crosspost|Video|Flair|Award)|fixture_mod|Another_User|t2_fixture|someone@example/i);
        expect(rows[0].content).toContain('u/[user]');
        expect(rows[0].raw_payload.url).toBe('https://www.reddit.com/r/OpenAI/comments/1aaa01/new_gpt_model_evaluation_thread/');
        expect(rows[0].location).toBe('');
        // Every call used the shared budget.
        expect((await db.dbGet('SELECT used FROM reddit_api_budget')).used).toBe(transport.calls.length);
        expect(transport.calls.every(c => /^https:\/\/(www|oauth)\.reddit\.com\//.test(c.url))).toBe(true);
    });
});
