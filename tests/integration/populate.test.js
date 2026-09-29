// tests/integration/populate.test.js
// scripts/populate.js — the standup's data-population step (demo path).
//
// Proves against the real test DB that demo population never fabricates
// scores: every fictional post is scored by the REAL pipeline save*
// functions (so `npm run replay` reproduces it to PASS), the job-level bias
// checks run with recorded methodology lineage, and the demo is labelled in
// the data (inactive demo_<category> sources, "[Demo]" content, job
// triggered_by 'demo'). The embeddings service and the BullMQ embed queue
// are replaced by fakes (runOnce's `deps`) where embedding is exercised; the
// real worker path is covered by the standup end-to-end run.

'use strict';

const db = require('../../src/db/connection');
const { findCity } = require('../../public/js/config/cities.config.js');
const { main: replayMain } = require('../../scripts/replay');
const populate = require('../../scripts/populate');
const { insertSource, insertRegisteredMethodology } = require('./helpers');

async function registerPipelineMethodology() {
    const ids = {};
    for (const c of ['sentiment', 'relevance', 'discourse', 'bias']) {
        ids[c] = await insertRegisteredMethodology(c);
    }
    return ids;
}

// Silence the script's progress lines inside jest output.
let stdoutSpy;
beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => stdoutSpy.mockRestore());

describe('scripts/populate.js — demo population through the real pipeline', () => {
    it('scores every demo post with the real pipeline and runs the bias checks', async () => {
        await insertSource('real-social', 'social');
        await insertSource('real-news', 'news');
        const mv = await registerPipelineMethodology();

        const r = await populate.runDemoBatch({ size: 6, embed: false, seed: 0 });

        expect(r.postIds).toHaveLength(6);
        expect(r.embedQueued).toBe(0);

        const posts = await db.dbAll(
            `SELECT rp.id, rp.content, rp.location, rp.raw_payload, ds.source_type, ds.active
             FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id
             WHERE rp.id = ANY($1::uuid[])`,
            [r.postIds],
        );
        for (const p of posts) {
            expect(p.content.startsWith(populate.DEMO_PREFIX)).toBe(true);
            expect(findCity(p.location)).toBeTruthy();           // resolvable by the globe
            expect(p.source_type).toBe(populate.DEMO_SOURCE_TYPE);
            expect(p.active).toBe(false);
            expect(p.raw_payload).toMatchObject({ demo: true, fictional: true });
        }

        // Three real decisions per post, each under the registered methodology.
        const decisions = await db.dbAll(
            `SELECT decision_type, methodology_version_id, COUNT(*)::int AS n
             FROM decision_audit_log WHERE job_id = $1
             GROUP BY decision_type, methodology_version_id ORDER BY decision_type`,
            [r.jobId],
        );
        expect(decisions).toEqual([
            { decision_type: 'discourse', methodology_version_id: mv.discourse, n: 6 },
            { decision_type: 'relevance', methodology_version_id: mv.relevance, n: 6 },
            { decision_type: 'sentiment', methodology_version_id: mv.sentiment, n: 6 },
        ]);

        // Job-level bias checks ran, recording the bias version that produced them.
        const bias = await db.dbAll(
            'SELECT assessment_type, methodology_version_id FROM bias_assessments WHERE job_id = $1',
            [r.jobId],
        );
        expect(bias.map(b => b.assessment_type).sort()).toEqual(
            ['location_concentration', 'negative_dominance', 'platform_sentiment_parity']);
        expect(bias.every(b => b.methodology_version_id === mv.bias)).toBe(true);

        const job = await db.dbGet('SELECT * FROM processing_jobs WHERE id = $1', [r.jobId]);
        expect(job).toMatchObject({ triggered_by: 'demo', status: 'completed', posts_processed: 6 });
        expect(job.completed_at).not.toBeNull();
    });

    it('creates inactive demo sources only for categories the real registry covers', async () => {
        await insertSource('real-social', 'social');
        await insertSource('real-policy', 'policy');
        await registerPipelineMethodology();

        const first = await populate.ensureDemoSources();
        const again = await populate.ensureDemoSources();          // idempotent

        expect(first.map(s => s.category)).toEqual(['policy', 'social']);
        expect(again.map(s => s.id)).toEqual(first.map(s => s.id));
        const rows = await db.dbAll(
            `SELECT name, display_name, active FROM data_sources
             WHERE source_type = 'demo' ORDER BY name`);
        expect(rows).toEqual([
            { name: 'demo_policy', display_name: 'Demo feed — Policy (fictional)', active: false },
            { name: 'demo_social', display_name: 'Demo feed — Social (fictional)', active: false },
        ]);
    });

    it('produces posts that `npm run replay` reproduces to PASS', async () => {
        await insertSource('real-social', 'social');
        await registerPipelineMethodology();
        const r = await populate.runDemoBatch({ size: 3, embed: false, seed: 4 });

        for (const postId of r.postIds) {
            const out = [];
            const code = await replayMain(['--post', postId],
                { db, out: l => out.push(l), err: l => out.push(l) });
            expect(out.join('\n')).toContain('RESULT: PASS');
            expect(code).toBe(0);
        }
    });

    it('--once is idempotent: skips when the trailing hour already holds a batch', async () => {
        await insertSource('real-social', 'social');
        await registerPipelineMethodology();
        const opts = { mode: 'once', size: 4, embed: false, waitEmbeddings: 0, force: false };
        const count = async () => (await db.dbGet('SELECT COUNT(*)::int AS n FROM raw_posts')).n;

        await populate.runOnce(opts);
        expect(await count()).toBe(4);
        await populate.runOnce(opts);                              // skipped
        expect(await count()).toBe(4);
        await populate.runOnce({ ...opts, force: true });          // --force adds a batch
        expect(await count()).toBe(8);
    });

    // Copilot 4129574047: an offline first run leaves posts unembedded; the
    // idempotent re-run (batch skipped) must backfill them and wait for them.
    describe('embedding backfill on --once', () => {
        // Stand-in for the embed worker: records what was queued and stores
        // a post_embeddings row per post, as the worker would.
        function fakeWorker({ store = true } = {}) {
            const calls = [];
            return {
                calls,
                enqueueEmbeddings: async (ids) => {
                    calls.push([...ids]);
                    if (!store) return;
                    for (const id of ids) {
                        await db.dbRun(
                            `INSERT INTO post_embeddings (raw_post_id) VALUES ($1)
                             ON CONFLICT (raw_post_id) DO NOTHING`, [id]);
                    }
                },
            };
        }
        const embeddedCount = async () =>
            (await db.dbGet('SELECT COUNT(*)::int AS n FROM post_embeddings')).n;
        const postCount = async () => (await db.dbGet('SELECT COUNT(*)::int AS n FROM raw_posts')).n;
        const base = { mode: 'once', size: 4, embed: true, waitEmbeddings: 5, force: false };

        beforeEach(async () => {
            await insertSource('real-social', 'social');
            await registerPipelineMethodology();
        });

        it('re-run with embeddings healthy backfills the skipped batch and waits for it', async () => {
            // First run: embeddings unavailable (standup passes --no-embed).
            await populate.runOnce({ ...base, embed: false });
            expect(await postCount()).toBe(4);
            expect(await embeddedCount()).toBe(0);

            const worker = fakeWorker();
            await populate.runOnce(base, {
                embeddingsReady: async () => true,
                enqueueEmbeddings: worker.enqueueEmbeddings,
            });

            expect(await postCount()).toBe(4);                      // batch still skipped
            expect(worker.calls).toHaveLength(1);
            expect(worker.calls[0]).toHaveLength(4);
            expect(await embeddedCount()).toBe(4);                  // waited until stored
            expect(await populate.unembeddedDemoPostsInLastHour()).toEqual([]);

            // Nothing left to backfill on a third run.
            const again = fakeWorker();
            await populate.runOnce(base, { embeddingsReady: async () => true, enqueueEmbeddings: again.enqueueEmbeddings });
            expect(again.calls).toEqual([]);
        });

        it('does not backfill while embeddings are not ready, or with --no-embed', async () => {
            await populate.runOnce({ ...base, embed: false });
            const worker = fakeWorker();
            await populate.runOnce(base, { embeddingsReady: async () => false, enqueueEmbeddings: worker.enqueueEmbeddings });
            const ready = jest.fn(async () => true);
            await populate.runOnce({ ...base, embed: false }, { embeddingsReady: ready, enqueueEmbeddings: worker.enqueueEmbeddings });
            expect(ready).not.toHaveBeenCalled();
            expect(worker.calls).toEqual([]);
            expect(await embeddedCount()).toBe(0);
        });

        it('--force queues the new batch and the backlog once each, and skips posts outside the hour', async () => {
            await populate.runOnce({ ...base, size: 3, embed: false });
            const old = await db.dbGet('SELECT id FROM raw_posts ORDER BY id LIMIT 1');
            await db.dbRun(`UPDATE raw_posts SET collected_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, [old.id]);

            const worker = fakeWorker();
            await populate.runOnce({ ...base, size: 3, force: true }, {
                embeddingsReady: async () => true,
                enqueueEmbeddings: worker.enqueueEmbeddings,
            });

            const queued = worker.calls.flat();
            expect(worker.calls).toHaveLength(2);                   // new batch, then backfill
            expect(worker.calls[0]).toHaveLength(3);
            expect(worker.calls[1]).toHaveLength(2);                // 3 old - 1 aged out
            expect(new Set(queued).size).toBe(queued.length);       // no post queued twice
            expect(queued).not.toContain(old.id);
        });

        it('bounds the wait when the worker never stores the embeddings', async () => {
            await populate.runOnce({ ...base, embed: false });
            const worker = fakeWorker({ store: false });
            const t0 = Date.now();
            await expect(populate.runOnce({ ...base, waitEmbeddings: 1 }, {
                embeddingsReady: async () => true,
                enqueueEmbeddings: worker.enqueueEmbeddings,
            })).resolves.toBe(0);
            expect(Date.now() - t0).toBeLessThan(6000);
            expect(worker.calls[0]).toHaveLength(4);
            const lines = stdoutSpy.mock.calls.map(c => String(c[0])).join('');
            expect(lines).toMatch(/embeddings stored: 0\/4 \(timed out/);
        });
    });

    // Copilot 4129574059: the real process, a real SIGTERM. The interval is
    // 10 minutes, so an exit that waited for the sleep would time the test out.
    it('--loop exits promptly and cleanly on SIGTERM, closing its connections', async () => {
        await insertSource('real-social', 'social');
        await registerPipelineMethodology();
        const { spawn } = require('child_process');
        const path = require('path');
        const child = spawn(process.execPath, ['scripts/populate.js', '--loop', '--no-embed', '--size', '3'], {
            cwd: path.join(__dirname, '../..'),
            env: { ...process.env, NODE_ENV: 'test', DEMO_FEED_INTERVAL_MS: String(10 * 60 * 1000) },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
        let signalledAt = 0;
        child.stdout.on('data', (b) => {
            out += b;
            // "data source: DEMO" is printed at the start of the batch: the
            // signal lands while the batch is in flight (or right after it).
            if (!signalledAt && out.includes('data source: DEMO')) {
                signalledAt = Date.now();
                child.kill('SIGTERM');
            }
        });
        child.stderr.on('data', (b) => { out += b; });

        // Never leak the child if this test fails: KILL it after 20 s (the
        // jest timeout is 30 s), so a regression fails here, not by hanging.
        const guard = setTimeout(() => child.kill('SIGKILL'), 20000);
        const { code, signal } = await exited.finally(() => clearTimeout(guard));
        expect({ code, signal }).toEqual({ code: 0, signal: null });
        expect(signalledAt).toBeGreaterThan(0);
        expect(Date.now() - signalledAt).toBeLessThan(10000);
        expect(out).toMatch(/SIGTERM received/);
        expect(out).toMatch(/demo feed stopped/);
        expect(out).toMatch(/connections closed \(database pool\)/);
        // The in-flight batch was completed, never left 'running'.
        const jobs = await db.dbAll("SELECT status FROM processing_jobs WHERE triggered_by = 'demo'");
        expect(jobs.map(j => j.status)).toEqual(['completed']);
    }, 30000);

    it('fails clearly, without creating a job, when the methodology is not registered', async () => {
        await insertSource('real-social', 'social');
        await expect(populate.runDemoBatch({ size: 2, embed: false, seed: 0 }))
            .rejects.toThrow(/methodology 'sentiment' is not registered/);
        const jobs = await db.dbGet('SELECT COUNT(*)::int AS n FROM processing_jobs');
        expect(jobs.n).toBe(0);
    });

    it('reports live collection as unavailable (demo is the only path today)', () => {
        const live = populate.liveCollectionStatus();
        expect(live.available).toBe(false);
        expect(live.reason).toMatch(/not implemented/);
    });

    it('parses flags with the documented defaults', () => {
        expect(populate.parseArgs([])).toMatchObject({ mode: 'once', size: 240, embed: true, force: false });
        expect(populate.parseArgs(['--loop'])).toMatchObject({ mode: 'loop', size: 14 });
        expect(populate.parseArgs(['--once', '--size', '5', '--no-embed', '--force', '--wait-embeddings', '0']))
            .toMatchObject({ size: 5, embed: false, force: true, waitEmbeddings: 0 });
        expect(() => populate.parseArgs(['--bogus'])).toThrow(/unknown argument/);
    });

    it('keeps the fictional corpus free of the demo prefix duplication and non-empty', () => {
        expect(populate.CORPUS.length).toBeGreaterThanOrEqual(20);
        for (const text of populate.CORPUS) {
            expect(text.startsWith('[Demo]')).toBe(false);          // prefix is added once, at ingest
            expect(text).not.toMatch(/@\w|https?:\/\//);            // no handles, no links
        }
    });
});
