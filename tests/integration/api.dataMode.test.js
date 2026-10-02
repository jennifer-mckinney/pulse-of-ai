// tests/integration/api.dataMode.test.js
// Data-origin honesty (standup demo population): the API tells the frontend
// whether the posts it serves are live, demo-feed, mixed, or absent — on
// GET /api/health (trailing hour) and per row of the aggregated snapshot —
// and the audit receipt describes demo-feed posts as fictional demo content.
// Demo is classified by SOURCE (data_sources.source_type = 'demo'),
// see src/config/data-mode.js.

'use strict';

const { useServer } = require('../helpers/server');
const app = require('../../src/server');
const request = useServer(app);   // one listener per file (tests/helpers/server.js)
const { dbRun } = require('../../src/db/connection');
const { NARRATION_VERSION } = require('../../src/config/audit-narration');
const {
    insertSource, insertJob, insertMethodologyVersions, insertIngestMethodology,
    insertPostWithFullPipeline, insertPostWithRelevanceOnly,
} = require('./helpers');

async function insertDemoSource(name = 'demo_news', category = 'news') {
    const row = await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category, active)
         VALUES ($1, 'Demo feed — News (fictional)', 'demo', $2, FALSE)
         RETURNING id`,
        [name, category],
    );
    return row.id;
}

async function scenario({ live = 0, demo = 0, liveHoursAgo = 0 } = {}) {
    const jobId = await insertJob();
    const mv = await insertMethodologyVersions();
    const liveSrc = await insertSource('real-src', 'social');
    const demoSrc = await insertDemoSource();
    const ids = { live: [], demo: [] };
    const at = liveHoursAgo ? new Date(Date.now() - liveHoursAgo * 3600000) : null;
    for (let i = 0; i < live; i++) {
        ids.live.push(await insertPostWithFullPipeline(liveSrc, jobId, mv,
            { externalId: `live-${i}`, location: 'London', collectedAt: at }));
    }
    for (let i = 0; i < demo; i++) {
        ids.demo.push(await insertPostWithFullPipeline(demoSrc, jobId, mv,
            { externalId: `demo-${i}`, location: 'London' }));
    }
    return ids;
}

describe('GET /api/health — data_mode', () => {
    it("reports 'none' with an empty trailing hour and counts only real sources", async () => {
        await insertSource('real-a', 'social');
        await insertDemoSource('demo_social', 'social');
        const res = await request().get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            data_mode: 'none',
            data_window: { hours: 1, posts: 0, demo_posts: 0, stored_posts: 0, stored_demo_posts: 0 },
            active_sources: 1,        // the demo feed is never a source
            demo_feeds: 1,
        });
    });

    it("reports 'demo' when every post in the hour is from a demo feed", async () => {
        await scenario({ demo: 3 });
        const res = await request().get('/api/health');
        expect(res.body.data_mode).toBe('demo');
        expect(res.body.data_window).toMatchObject({ hours: 1, posts: 3, demo_posts: 3 });
    });

    it("reports 'live' for real-source posts and 'mixed' when both are present", async () => {
        await scenario({ live: 2 });
        expect((await request().get('/api/health')).body.data_mode).toBe('live');
        const demoSrc = (await dbRun(`SELECT id FROM data_sources WHERE source_type = 'demo'`)).id;
        const mv = await insertMethodologyVersions();
        await insertPostWithFullPipeline(demoSrc, await insertJob(), mv, { externalId: 'demo-x' });
        expect((await request().get('/api/health')).body.data_mode).toBe('mixed');
    });

    it('classifies only the trailing hour: older live posts do not make demo data "mixed"', async () => {
        await scenario({ live: 2, demo: 2, liveHoursAgo: 3 });
        const res = await request().get('/api/health');
        expect(res.body.data_mode).toBe('demo');
        expect(res.body.data_window).toMatchObject({ hours: 1, posts: 2, demo_posts: 2 });
    });

    // G9-2: data_mode uses the GLOBE's rule — scored posts (sentiment result)
    // at a registry city — so the kicker and the globe can never disagree.
    // Posts the globe does not show are reported separately, never classified.
    it('classifies only what the globe shows: unscored or unplaced demo posts do not make live data "mixed"', async () => {
        const ids = await scenario({ live: 2 });
        const demoSrc = (await dbRun(`SELECT id FROM data_sources WHERE source_type = 'demo'`)).id;
        const mv = await insertMethodologyVersions();
        const job = await insertJob();
        // Demo post at a location the city registry does not know (globe drops it)…
        await insertPostWithFullPipeline(demoSrc, job, mv, { externalId: 'demo-atlantis', location: 'Atlantis' });
        // …and a demo post at a registry city that has no sentiment result yet.
        await insertPostWithRelevanceOnly(demoSrc, job, mv, { externalId: 'demo-unscored', location: 'London' });

        const health = (await request().get('/api/health')).body;
        expect(health.data_mode).toBe('live');
        expect(health.data_window).toEqual({
            hours: 1, posts: 2, demo_posts: 0,          // what the globe shows
            stored_posts: 4, stored_demo_posts: 2,      // everything stored in the hour
        });
        expect(ids.live).toHaveLength(2);

        // Same answer as the aggregated rows the globe renders (placed rows only).
        const from = new Date(Date.now() - 3600e3).toISOString();
        const rows = (await request().get(`/api/posts/aggregated-by-location?from=${encodeURIComponent(from)}`)).body;
        const placed = rows.filter(r => r.lat !== null);
        const total = placed.reduce((n, r) => n + r.total, 0);
        const demo = placed.reduce((n, r) => n + r.demo_posts, 0);
        expect({ total, demo }).toEqual({ total: 2, demo: 0 });
    });
});

describe('GET /api/posts/aggregated-by-location — per-row data origin', () => {
    it('carries demo_posts and data_mode on every row, still a plain array', async () => {
        await scenario({ live: 1, demo: 2 });
        const res = await request().get('/api/posts/aggregated-by-location');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        const london = res.body.find(r => r.city === 'London');
        expect(london).toMatchObject({ total: 3, demo_posts: 2, data_mode: 'mixed' });
    });

    it("an all-demo row is 'demo'; an all-live row is 'live' with demo_posts 0", async () => {
        await scenario({ demo: 2 });
        let rows = (await request().get('/api/posts/aggregated-by-location?platform=news')).body;
        expect(rows[0]).toMatchObject({ total: 2, demo_posts: 2, data_mode: 'demo' });
        rows = (await request().get('/api/posts/aggregated-by-location?platform=social')).body;
        expect(rows).toEqual([]);
    });
});

describe('GET /api/audit/:post_id — demo ingestion wording (audit_narration 1.2.0+)', () => {
    it('describes a demo-feed post as fictional demo content, never as a public source', async () => {
        await insertIngestMethodology();
        const ids = await scenario({ live: 1, demo: 1 });

        const demo = (await request().get(`/api/audit/${ids.demo[0]}`)).body;
        expect(demo.narration.version).toBe(NARRATION_VERSION);
        expect(NARRATION_VERSION).toBe('1.4.0');
        expect(demo.post.data_origin).toBe('demo');
        // D2: demo content has no provenance to verify, and says why.
        expect(demo.provenance.fingerprint).toBeNull();
        expect(demo.provenance.verifiable).toMatch(/fictional demo content/);
        expect(demo.ingest.audiences.public)
            .toMatch(/fictional demo post generated for this installation/);
        expect(demo.ingest.audiences.public).not.toMatch(/came from a public source/);
        expect(demo.ingest.audiences.config).toMatchObject({ content_origin: 'demo_feed', fictional: true });

        const live = (await request().get(`/api/audit/${ids.live[0]}`)).body;
        expect(live.post.data_origin).toBe('live');
        expect(live.ingest.audiences.public).toMatch(/^This post came from a public source\./);
    });
});
