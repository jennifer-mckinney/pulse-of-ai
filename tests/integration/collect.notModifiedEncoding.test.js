// tests/integration/collect.notModifiedEncoding.test.js
// Diagnosis 2026-09-30 (Internet Archive, route blog-rss): blog.archive.org
// answers the worker's conditional GET with 304 Not Modified and repeats
// "Content-Encoding: gzip" with no body (valid, RFC 9110 §15.4.5). The
// transport ran gunzip over the empty body, threw Z_BUF_ERROR "unexpected
// end of file", retried twice and failed the route in 91% of runs.
//
// Driven through the REAL network transport (src/collectors/transport.js)
// with an injected node:https-shaped `request`, so readBody runs exactly as
// in production; no socket is opened.

'use strict';

const zlib = require('zlib');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const { dbGet, dbAll } = require('../../src/db/connection');
const { runCollection } = require('../../src/collectors/runner');
const { createNetworkTransport } = require('../../src/collectors/transport');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { readFixture, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

const FEED = 'https://blog.archive.org/feed/';
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>IA blog</title>
<item><title>Artificial intelligence and the archive</title><link>https://blog.archive.org/2026/09/28/ai/</link>
<guid>https://blog.archive.org/?p=1</guid><pubDate>${new Date(RECORDED_AT).toUTCString()}</pubDate>
<description>Machine learning and AI at the Internet Archive.</description></item></channel></rss>`;

/** A node:https-shaped request answering from `answer(url, headers)` → { status, headers, body: Buffer }. */
function fakeHttps(answer) {
    const calls = [];
    const request = (u, opts, onResponse) => {
        calls.push({ url: u.toString(), headers: opts.headers });
        const req = new EventEmitter();
        req.write = () => {};
        req.end = () => setImmediate(() => {
            const r = answer(u, opts.headers || {});
            const res = Readable.from(r.body.length ? [r.body] : []);
            res.statusCode = r.status;
            res.headers = r.headers || {};
            onResponse(res);
        });
        return req;
    };
    return { request, calls };
}

// The feed: a gzipped 200 with validators the first time, then the recorded
// 304 (Content-Encoding: gzip, no body) whenever the validator is sent.
function iaServer() {
    return fakeHttps((u, h) => {
        if (u.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
        if (u.host === 'archive.org') {
            return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(readFixture('recorded/ia-search.json')) };
        }
        if (u.toString() === FEED) {
            const validators = { etag: '"d35aeb5e-gzip"', 'last-modified': 'Wed, 30 Sep 2026 16:29:56 GMT', vary: 'Accept-Encoding' };
            if (h['If-None-Match'] === '"d35aeb5e-gzip"') {
                return { status: 304, headers: { ...validators, 'content-encoding': 'gzip', server: 'Caddy' }, body: Buffer.alloc(0) };
            }
            return { status: 200, headers: { ...validators, 'content-encoding': 'gzip', 'content-type': 'application/rss+xml' },
                body: zlib.gzipSync(RSS) };
        }
        throw new Error(`unexpected request ${u}`);
    });
}

async function collect(server) {
    return (await runCollection({
        slugs: ['internet_archive'], triggeredBy: 'test', env: TEST_ENV,
        transport: createNetworkTransport({ request: server.request, lookup: () => {} }),
        now: () => Date.parse(RECORDED_AT),
        queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
        collectorCtx: { sleep: () => Promise.resolve() },
    })).sources[0];
}
const stateOf = () => dbGet(`SELECT s.* FROM source_collection_state s JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = 'internet_archive'`);
const nextPoll = () => dbGet(`UPDATE source_collection_state SET last_attempt_at = NOW() - interval '1 day'
    WHERE source_id = (SELECT id FROM data_sources WHERE name = 'internet_archive') RETURNING source_id`);

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

describe('304 Not Modified with Content-Encoding: gzip (Internet Archive blog feed)', () => {
    it('the conditional run is ok: ONE feed request, no error, validators kept', async () => {
        const server = iaServer();
        const first = await collect(server);
        expect(first).toMatchObject({ outcome: 'ok', error: null });
        const cached = (await stateOf()).http_cache;
        expect(cached[FEED]).toEqual({ etag: '"d35aeb5e-gzip"', last_modified: 'Wed, 30 Sep 2026 16:29:56 GMT' });

        await nextPoll();
        const before = server.calls.filter(c => c.url === FEED).length;
        const second = await collect(server);
        const feedCalls = server.calls.filter(c => c.url === FEED).slice(before);
        // Before the fix: 3 feed requests (1 + 2 retries) and
        // "blog-rss: … unexpected end of file".
        expect(feedCalls).toHaveLength(1);
        expect(feedCalls[0].headers['If-None-Match']).toBe('"d35aeb5e-gzip"');
        expect(second).toMatchObject({ outcome: 'ok', error: null });
        const st = await stateOf();
        expect(st).toMatchObject({ last_error: null, consecutive_failures: 0 });
        expect(st.http_cache[FEED]).toEqual(cached[FEED]);
        const errors = await dbAll(
            `SELECT r.error FROM source_runs r JOIN data_sources ds ON ds.id = r.source_id
             WHERE ds.name = 'internet_archive' AND r.error IS NOT NULL`);
        expect(errors).toEqual([]);
    });
});
