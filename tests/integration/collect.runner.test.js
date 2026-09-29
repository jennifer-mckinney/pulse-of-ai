// tests/integration/collect.runner.test.js
// One collection job through the REAL pipeline against the test database,
// on recorded fixtures (no network): gate → claim → fetch → store → score
// (audited, current methodology versions) → bias → embed gate → job counts,
// per-source state and run outcomes. A collected post replays to PASS.

'use strict';

const db = require('../../src/db/connection');
const { dbAll, dbGet, dbRun } = db;
const { runCollection } = require('../../src/collectors/runner');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { main: replayMain } = require('../../scripts/replay');
const { CURRENT_VERSIONS } = require('../../src/config/methodology-registry');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

const NOW = () => Date.parse(RECORDED_AT);
const ROUTES = [
    ['https://feeds.bbci.co.uk/robots.txt', 'recorded/bbc-robots.txt'],
    ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'recorded/bbc-technology.xml'],
    [/hn\.algolia\.com/, 'recorded/hn-algolia.json'],
    [/export\.arxiv\.org/, 'recorded/arxiv-api.xml'],
];

function queuesMock() {
    return { enqueueEmbeds: jest.fn().mockResolvedValue(), enqueueIngestRetry: jest.fn().mockResolvedValue() };
}

async function collect(slugs, extra = {}) {
    const queues = extra.queues || queuesMock();
    const transport = extra.transport || fixtureTransport(ROUTES);
    const summary = await runCollection({
        slugs, triggeredBy: 'test', env: extra.env || TEST_ENV, transport, queues, now: NOW,
        collectorCtx: { sleep: () => Promise.resolve() },
    });
    return { summary, queues, transport };
}

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

describe('runCollection', () => {
    it('collects, stores and scores posts from several categories with audit rows', async () => {
        const { summary, queues } = await collect(['bbc_news', 'hacker_news', 'arxiv']);
        expect(summary.postsProcessed).toBeGreaterThan(0);
        expect(Object.keys(summary.byCategory).sort()).toEqual(['academic', 'forums', 'news']);

        const job = await dbGet('SELECT status, posts_collected, posts_processed, sources_queried, triggered_by FROM processing_jobs WHERE id = $1', [summary.jobId]);
        expect(job).toEqual({ status: 'completed', posts_collected: summary.postsCollected,
            posts_processed: summary.postsProcessed, sources_queried: 3, triggered_by: 'test' });

        // Every new post has sentiment, relevance and discourse decisions under
        // the versions the code implements.
        const rows = await dbAll(
            `SELECT dal.decision_type, mv.version FROM decision_audit_log dal
             JOIN methodology_versions mv ON mv.id = dal.methodology_version_id
             WHERE dal.job_id = $1`, [summary.jobId]);
        expect(rows).toHaveLength(summary.postsProcessed * 3);
        for (const r of rows) expect(r.version).toBe(CURRENT_VERSIONS[r.decision_type]);

        // Job-level bias checks ran; embeds queued only for gated posts.
        expect(summary.bias.checksRun).toBe(3);
        const gated = await dbAll(`SELECT rr.raw_post_id FROM relevance_results rr
            JOIN decision_audit_log d ON d.raw_post_id = rr.raw_post_id AND d.job_id = $1 AND d.decision_type = 'relevance'
            WHERE rr.score >= $2`, [summary.jobId, require('../../src/pipeline/relevance').EMBED_GATE_MIN_SCORE - 1e-9]);
        expect(summary.embedQueued).toBe(gated.length);
        if (gated.length) expect(queues.enqueueEmbeds).toHaveBeenCalledWith(expect.arrayContaining(gated.map(g => g.raw_post_id)));
    });

    it('stores allowlisted payloads with city-level location and no identity fields', async () => {
        await collect(['bbc_news', 'hacker_news']);
        const posts = await dbAll(`SELECT rp.location, rp.raw_payload, ds.name FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id`);
        expect(posts.length).toBeGreaterThan(0);
        for (const p of posts) {
            expect(JSON.stringify(p.raw_payload)).not.toMatch(/"(author|username|user|owner)"/);
            if (p.name === 'bbc_news') expect(p).toMatchObject({ location: 'London', raw_payload: expect.objectContaining({ location_basis: 'publisher' }) });
            if (p.name === 'hacker_news') expect(p.location).toBe('');
        }
    });

    it('records per-source state and one run row per source', async () => {
        const { summary } = await collect(['bbc_news']);
        const st = await dbGet(`SELECT s.last_success_at, s.last_item_count, s.consecutive_failures, s.last_error
            FROM source_collection_state s JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = 'bbc_news'`);
        expect(st.last_success_at).toBeInstanceOf(Date);
        expect(st).toMatchObject({ last_item_count: summary.sources[0].kept, consecutive_failures: 0, last_error: null });
        const run = await dbGet(`SELECT outcome, gate_status, items_fetched, posts_new, requests FROM source_runs WHERE job_id = $1`, [summary.jobId]);
        expect(run).toMatchObject({ outcome: 'ok', gate_status: 'collecting', items_fetched: 4, requests: 2 });
    });

    it('honours the poll interval across runs (the cross-process claim)', async () => {
        await collect(['bbc_news']);
        const { summary, transport } = await collect(['bbc_news']);
        expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/poll interval/) });
        expect(transport.calls).toHaveLength(0);
        expect(summary.sourcesQueried).toBe(0);
    });

    it('never fetches gated, blocked or killed sources', async () => {
        const { summary, transport } = await collect(['x', 'cato', 'npr'], { env: { ...TEST_ENV, SOURCE_NPR_ENABLED: 'false' } });
        expect(summary.sources.map(s => [s.slug, s.status, s.outcome])).toEqual([
            ['x', 'awaiting_licence', 'skipped'], ['cato', 'blocked', 'skipped'], ['npr', 'disabled', 'skipped'],
        ]);
        expect(transport.calls).toHaveLength(0);
        // Nothing processed → no processing_jobs row (created lazily).
        expect(summary.jobId).toBeNull();
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM processing_jobs')).n).toBe(0);
    });

    it('a run that stores nothing new records its source run without an empty job row', async () => {
        await collect(['hacker_news']);
        await dbRun(`UPDATE source_collection_state SET last_attempt_at = NOW() - INTERVAL '1 day'`);
        const again = await collect(['hacker_news']);
        expect(again.summary.jobId).toBeNull();
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM processing_jobs')).n).toBe(1);
        const runs = await dbAll(`SELECT job_id, outcome, posts_new FROM source_runs ORDER BY started_at`);
        expect(runs).toHaveLength(2);
        expect(runs[1]).toEqual({ job_id: null, outcome: 'ok', posts_new: 0 });
    });

    it('completes a caller-owned job even when nothing was processed (POST /api/refresh)', async () => {
        const job = await dbGet(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('api', 'running') RETURNING id`);
        const s = await runCollection({ slugs: ['x'], jobId: job.id, env: TEST_ENV, transport: fixtureTransport([]), queues: queuesMock() });
        expect(s.jobId).toBe(job.id);
        expect(await dbGet('SELECT status, posts_processed FROM processing_jobs WHERE id = $1', [job.id]))
            .toEqual({ status: 'completed', posts_processed: 0 });
    });

    it('a refusal (403) is recorded as the source\'s error, never retried', async () => {
        const transport = fixtureTransport([[/hn\.algolia\.com/, { status: 403, body: 'denied' }]]);
        const { summary } = await collect(['hacker_news'], { transport });
        expect(summary.sources[0]).toMatchObject({ outcome: 'error', error: expect.stringMatching(/refused access \(HTTP 403\)/) });
        expect(transport.calls).toHaveLength(1);
        const st = await dbGet(`SELECT consecutive_failures, last_error FROM source_collection_state s
            JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = 'hacker_news'`);
        expect(st.consecutive_failures).toBe(1);
        expect(st.last_error).toMatch(/403/);
    });

    it('dedups across runs: a re-collected item is not stored or scored twice', async () => {
        const first = await collect(['hacker_news']);
        await dbRun(`UPDATE source_collection_state SET last_attempt_at = NOW() - INTERVAL '1 day'`);
        const second = await collect(['hacker_news']);
        expect(first.summary.postsProcessed).toBeGreaterThan(0);
        expect(second.summary.postsProcessed).toBe(0);
    });

    it('a missing methodology version fails the job loudly (never scores under a guessed version)', async () => {
        // A runner whose methodology lookup fails. No methodology row is
        // touched: the failure is injected with an isolated module mock.
        let isolated;
        jest.isolateModules(() => {
            jest.doMock('../../src/pipeline/methodology', () => ({
                resolveCurrentMethodology: jest.fn().mockRejectedValue(new Error('methodology not registered for discourse@1.1.0-DQI')),
            }));
            isolated = require('../../src/collectors/runner');
        });
        const opts = { slugs: ['hacker_news'], env: TEST_ENV, transport: fixtureTransport(ROUTES), queues: queuesMock() };
        await expect(isolated.runCollection({ ...opts, triggeredBy: 'test' })).rejects.toThrow(/methodology not registered/);
        // Nothing was fetched or stored, so no job row exists to mark.
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM raw_posts')).n).toBe(0);
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM processing_jobs')).n).toBe(0);
        // A caller-owned job (POST /api/refresh) is marked failed with the reason.
        const job = await dbGet(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('api', 'running') RETURNING id`);
        await expect(isolated.runCollection({ ...opts, jobId: job.id })).rejects.toThrow(/methodology not registered/);
        expect(await dbGet('SELECT status, error_details FROM processing_jobs WHERE id = $1', [job.id]))
            .toEqual({ status: 'failed', error_details: expect.stringMatching(/methodology not registered/) });
    });

    it('a collected, pipeline-scored post replays to PASS', async () => {
        const { summary } = await collect(['arxiv']);
        const post = await dbGet(`SELECT DISTINCT raw_post_id AS id FROM decision_audit_log WHERE job_id = $1 LIMIT 1`, [summary.jobId]);
        const lines = [];
        const code = await replayMain(['--post', post.id], { db, out: l => lines.push(l), err: l => lines.push(l) });
        expect(lines.join('\n')).toMatch(/RESULT: PASS/);
        expect(lines.join('\n')).not.toMatch(/config drift/);
        expect(code).toBe(0);
    });

    it('G10-9: after the collection deadline no further source starts, and each skip is logged', async () => {
        const ac = new AbortController();
        const lines = [];
        const transport = fixtureTransport(ROUTES);
        const first = [/hn\.algolia\.com/, 'recorded/hn-algolia.json'];
        const summary = await runCollection({
            slugs: ['hacker_news', 'arxiv'], triggeredBy: 'test', env: TEST_ENV, now: NOW, signal: ac.signal,
            transport: (url, init) => { if (/hn\.algolia/.test(url)) ac.abort(); return transport(url, init); },
            queues: queuesMock(), log: l => lines.push(l), collectorCtx: { sleep: () => Promise.resolve() },
        });
        expect(first).toBeDefined();
        expect(summary.sources[1]).toMatchObject({ slug: 'arxiv', outcome: 'skipped', reason: 'collection deadline reached before this source started' });
        expect(lines.join('\n')).toMatch(/arxiv: skipped — collection deadline/);
        expect(transport.calls.some(c => /arxiv/.test(c.url))).toBe(false);
    });
});

