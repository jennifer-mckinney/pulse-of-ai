// tests/integration/populate.test.js
// scripts/populate.js — the standup's data-population step (demo path).
//
// Proves against the real test DB that demo population never fabricates
// scores: every fictional post is scored by the REAL pipeline save*
// functions (so `npm run replay` reproduces it to PASS), the job-level bias
// checks run with recorded methodology lineage, and the demo is labelled in
// the data (inactive demo_<category> sources, "[Demo]" content, job
// triggered_by 'demo'). Embeddings are exercised by the standup end-to-end
// run (they need Redis + the embeddings container), so every call here
// passes embed: false.

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
