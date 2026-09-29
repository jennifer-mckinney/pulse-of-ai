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

const app = require('../../src/server');
const populate = require('../../scripts/populate');
const { run } = require('../../scripts/smoke-check');
const { insertSource, insertRegisteredMethodology } = require('./helpers');

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
    for (const [name, cat] of [['real-social', 'social'], ['real-news', 'news'], ['real-policy', 'policy']]) {
        await insertSource(name, cat);
    }
    for (const c of ['sentiment', 'relevance', 'discourse', 'bias', 'ingest']) {
        await insertRegisteredMethodology(c);
    }
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
        expect(text).toContain('SMOKE: FAIL');
    }, 30000);

    // P9-7: worker liveness + Redis reachability come from /api/health.
    // Without a running worker it WARNs by default; standup passes
    // --expect-worker, which makes it a FAIL.
    it('reports worker liveness: WARN without a worker, FAIL when a worker is expected', async () => {
        const health = require('../../src/routes/health');
        health._setRedisClientForTests({ ping: async () => 'PONG', get: async () => null });
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
});
