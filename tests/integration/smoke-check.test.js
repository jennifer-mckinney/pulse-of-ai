// tests/integration/smoke-check.test.js
// scripts/smoke-check.js — the standup's post-start smoke check.
//
// Runs the real check against the real Express app (listening on an
// ephemeral port) and the test DB: after a demo batch is populated through
// the real pipeline every check passes (embeddings only WARN, since this
// suite runs without the embeddings service), the receipt and replay checks
// exercise a real post, and the summary labels the data DEMO. Against an
// empty database the check must FAIL instead of passing on status codes.

'use strict';

const { SOURCES } = require('../../src/config/source-registry');
const app = require('../../src/server');
const populate = require('../../scripts/populate');
const { run } = require('../../scripts/smoke-check');
const { seedSources, seedMethodology } = require('../../scripts/seed');

let server;
let baseUrl;

beforeAll(async () => {
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
});

let stdoutSpy;
beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => stdoutSpy.mockRestore());

async function populateDemo() {
    await seedSources();        // the 52-source registry of record (SOURCES.length)
    await seedMethodology();
    await populate.runDemoBatch({ size: 60, embed: false, seed: 0 });
}

describe('scripts/smoke-check.js', () => {
    it('passes on a demo-populated stack and labels the data DEMO', async () => {
        await populateDemo();
        const lines = [];
        const code = await run({ baseUrl, expectEmbeddings: false }, l => lines.push(l));
        const text = lines.join('\n');

        expect(text).not.toContain('[FAIL]');
        expect(code).toBe(0);
        expect(text).toContain('[PASS] globe data (trailing hour) — 30 cities with coordinates');
        expect(text).toMatch(/\[PASS\] audit receipt — post [0-9a-f-]+: 3 decisions, 3 with all four audience views, bias lineage 'recorded'/);
        expect(text).toMatch(/\[PASS\] npm run replay — post [0-9a-f-]+: RESULT PASS \(exit 0\)/);
        expect(text).toContain("[PASS] data mode reported — /api/health data_mode 'demo' matches the globe's rows ('demo': 60 of 60 placed trailing-hour posts from demo feeds)");
        expect(text).toContain('[WARN] embeddings stored');
        expect(text).toContain('data:               DEMO — fictional posts scored by the real pipeline');
        expect(text).toContain(`[PASS] source registry — ${SOURCES.length}/${SOURCES.length} registry sources served`);
        expect(text).toMatch(/ 6\. wechat {13}social {4}blocked — blocked: no compliant access/);
        expect(text).toContain('SMOKE: PASS');
    }, 60000);

    it('fails an empty stack on data, not just status codes', async () => {
        const lines = [];
        const code = await run({ baseUrl, expectEmbeddings: false }, l => lines.push(l));
        const text = lines.join('\n');

        expect(code).toBe(1);
        expect(text).toContain('[PASS] GET /api/health');
        expect(text).toContain('[FAIL] globe data (trailing hour)');
        expect(text).toContain('[FAIL] posts stored');
        expect(text).toContain('NO DEMO FEED DATA');
        expect(text).toContain(`[FAIL] source registry — 0/${SOURCES.length}`);
        expect(text).toContain('SMOKE: FAIL');
    }, 30000);

    // P9-7: worker liveness + Redis reachability come from /api/health.
    // Without a running worker it WARNs by default; standup passes
    // --expect-worker, which makes it a FAIL.
    it('reports worker liveness: WARN without a worker, FAIL when a worker is expected', async () => {
        const health = require('../../src/routes/health');
        health._setRedisClientForTests({ ping: async () => 'PONG', get: async () => null });
        // Queue depth is injected so no real BullMQ connection is opened.
        health._setQueueCountsForTests(async () => ({}));
        try {
            await populateDemo();
            let lines = [];
            await run({ baseUrl, expectEmbeddings: false }, l => lines.push(l));
            expect(lines.join('\n')).toContain('[WARN] worker heartbeat — redis reachable, worker not alive');
            lines = [];
            const code = await run({ baseUrl, expectEmbeddings: false, expectWorker: true }, l => lines.push(l));
            expect(code).toBe(1);
            expect(lines.join('\n')).toContain('[FAIL] worker heartbeat');

            const at = new Date().toISOString();
            health._setRedisClientForTests({ ping: async () => 'PONG', get: async () => at });
            lines = [];
            await run({ baseUrl, expectEmbeddings: false, expectWorker: true }, l => lines.push(l));
            expect(lines.join('\n')).toContain(`[PASS] worker heartbeat — redis reachable, last beat ${at}`);
        } finally {
            health._setRedisClientForTests(null);
            health._setQueueCountsForTests(null);
        }
    }, 60000);

    it('parses --expect-worker', () => {
        const { parseArgs } = require('../../scripts/smoke-check');
        expect(parseArgs(['--expect-worker']).expectWorker).toBe(true);
    });

    it('fails the embeddings check when embeddings were expected', async () => {
        await populateDemo();
        const lines = [];
        const code = await run({ baseUrl, expectEmbeddings: true }, l => lines.push(l));
        expect(code).toBe(1);
        expect(lines.join('\n')).toContain('[FAIL] embeddings stored — 0 — embeddings were expected');
    }, 60000);

    it('labels live-collected data LIVE, and LIVE + demo MIXED, per category', async () => {
        await seedSources();
        await seedMethodology();
        const { storeRawPost, scorePost } = require('../../src/pipeline/ingest');
        const { resolveCurrentMethodology } = require('../../src/pipeline/methodology');
        const { dbGet } = require('../../src/db/connection');
        const mv = await resolveCurrentMethodology();
        const npr = await dbGet(`SELECT id FROM data_sources WHERE name = 'npr'`);
        const job = await dbGet(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('test', 'completed') RETURNING id`);
        const { postId } = await storeRawPost({ id: 'live-1', text: 'Machine learning policy news', location: 'Washington' }, npr.id);
        await scorePost(postId, job.id, mv);

        let lines = [];
        await run({ baseUrl, expectEmbeddings: false }, l => lines.push(l));
        expect(lines.join('\n')).toContain('data:               LIVE — 1 real posts collected from registry sources in the trailing hour');
        expect(lines.join('\n')).toMatch(/news\s+live\s+1\s+demo\s+0/);

        await populate.runDemoBatch({ size: 4, embed: false, seed: 0 });
        lines = [];
        await run({ baseUrl, expectEmbeddings: false }, l => lines.push(l));
        expect(lines.join('\n')).toContain('data:               MIXED — 1 live and 4 demo posts');
    }, 60000);
});
