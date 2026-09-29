// tests/integration/collect.storefail.test.js — G10-5: a store failure never
// loses items. The route's cursor and HTTP validators are restored (the
// next run fetches the items again), the run counts as an error, a bulk
// dataset file is marked seen only once its records are stored, and NUL
// bytes (rejected by PostgreSQL TEXT / JSONB) are stripped before storing.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { dbGet } = require('../../src/db/connection');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV, FIXTURE_ROOT } = require('../helpers/fixtureTransport');

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

// storeRawPost fails for the next `mockFailStores` calls, then stores.
let mockFailStores = 0;
jest.mock('../../src/pipeline/ingest', () => {
    const real = jest.requireActual('../../src/pipeline/ingest');
    return {
        ...real,
        storeRawPost: async (...a) => {
            if (mockFailStores > 0) { mockFailStores--; throw new Error('db blip'); }
            return real.storeRawPost(...a);
        },
    };
});
const { runCollection } = require('../../src/collectors/runner');
function runnerFailingStores(n) {
    mockFailStores = n;
    return runCollection;
}
const opts = (slugs, env, routes) => ({
    slugs, triggeredBy: 'test', env, now: () => Date.parse(RECORDED_AT), transport: fixtureTransport(routes),
    queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
    collectorCtx: { sleep: () => Promise.resolve() },
});
const stateOf = slug => dbGet(`SELECT s.cursor, s.http_cache, s.last_success_at FROM source_collection_state s
    JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = $1`, [slug]);
const BBC = [
    ['https://feeds.bbci.co.uk/robots.txt', 'recorded/bbc-robots.txt'],
    ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'recorded/bbc-technology.xml'],
];

it('a store failure restores the route\'s HTTP validators and makes the run an error', async () => {
    const s = await runnerFailingStores(1)(opts(['bbc_news'], TEST_ENV, BBC));
    expect(s.sources[0]).toMatchObject({ outcome: 'error', errorKind: 'store' });
    const st = await stateOf('bbc_news');
    expect(st.http_cache).toEqual({});           // no ETag kept: the next run refetches the feed
    expect(st.last_success_at).toBeNull();
    // Control: without a failure the validators are kept.
    await require('../../src/db/connection').dbRun(`UPDATE source_collection_state SET last_attempt_at = NOW() - interval '1 day'`);
    const ok = await runCollection(opts(['bbc_news'], TEST_ENV, [BBC[0], [BBC[1][0], { status: 200, body: fs.readFileSync(path.join(FIXTURE_ROOT, 'recorded/bbc-technology.xml'), 'utf8'), headers: { etag: '"v1"', 'content-type': 'application/rss+xml' } }]]));
    expect(ok.sources[0].outcome).toBe('ok');
    expect(JSON.stringify((await stateOf('bbc_news')).http_cache)).toMatch(/v1/);
});

it('a bulk dataset file is marked seen only when every record stored', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jstor-'));
    const file = path.join(dir, 'batch.jsonl');
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'gated/jstor.jsonl'), file);
    const env = { ...TEST_ENV, JSTOR_DATASET_PATH: dir };
    const failed = await runnerFailingStores(1)(opts(['jstor'], env, []));
    expect(failed.sources[0]).toMatchObject({ outcome: 'error', kept: 1 });
    expect(JSON.stringify((await stateOf('jstor')).cursor)).not.toContain('batch.jsonl');
    await require('../../src/db/connection').dbRun(`UPDATE source_collection_state SET last_attempt_at = NOW() - interval '1 day'`);
    const again = await runCollection(opts(['jstor'], env, []));
    expect(again.sources[0]).toMatchObject({ outcome: 'ok', new: 1 });
    expect(JSON.stringify((await stateOf('jstor')).cursor)).toContain('batch.jsonl');
    fs.rmSync(dir, { recursive: true, force: true });
});

it('NUL bytes are stripped from the text and the stored payload', async () => {
    const src = await dbGet(`SELECT id FROM data_sources WHERE name = 'hacker_news'`);
    const { storeRawPost } = jest.requireActual('../../src/pipeline/ingest');
    const { postId } = await storeRawPost({ id: 'nul-1', text: 'AI\u0000 text', title: 'T\u0000', url: 'https://x.example/\u0000a', extra: ['a\u0000'] }, src.id);
    const row = await dbGet('SELECT content, raw_payload FROM raw_posts WHERE id = $1', [postId]);
    expect(row.content).toBe('AI text');
    expect(JSON.stringify(row.raw_payload)).not.toMatch(/\\u0000/);
    expect(row.raw_payload.extra).toEqual(['a']);
});

// Copilot 4129565586: every route cursor kind is restored on a failed store
// — X since_id, HN created_at, the Scholar mailbox lastUid (bulk-file mtimes
// are the test above).
describe('cursor restore per route kind (G10-5)', () => {
    const X1 = 'https://api.x.com/2/tweets/search/recent?query=%28%22artificial+intelligence%22+OR+AI%29+-is%3Aretweet+lang%3Aen&max_results=20&tweet.fields=created_at%2Clang';
    const HN_URL = 'https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=50';
    const again = () => require('../../src/db/connection').dbRun(`UPDATE source_collection_state SET last_attempt_at = NOW() - interval '1 day'`);

    it.each([
        ['x', { X_BEARER_TOKEN: 'tok' }, [[X1, 'gated/x-recent.json']], 'recent-search', 'sinceId'],
        ['hacker_news', {}, [[HN_URL, 'recorded/hn-algolia.json']], 'algolia-search', 'since'],
    ])('%s: a failed store keeps the old cursor; a clean run advances it', async (slug, env, routes, routeId, key) => {
        const failed = await runnerFailingStores(1)(opts([slug], { ...TEST_ENV, ...env }, routes));
        expect(failed.sources[0].outcome).toBe('error');
        expect(((await stateOf(slug)).cursor[routeId] || {})[key]).toBeUndefined();
        await again();
        const ok = await runCollection(opts([slug], { ...TEST_ENV, ...env }, routes));
        expect(ok.sources[0].outcome).toBe('ok');
        expect((await stateOf(slug)).cursor[routeId][key]).toBeDefined();
    });

    it('google_scholar: a failed store keeps lastUid, so the alert is read again', async () => {
        const source = fs.readFileSync(path.join(FIXTURE_ROOT, 'gated/scholar-alert.eml'));
        const imapFactory = () => ({
            connect: async () => {}, getMailboxLock: async () => ({ release: () => {} }),
            search: async () => [41], fetchOne: async (uid, what) => (what.size ? { size: source.length } : { source }),
            logout: async () => {},
        });
        const env = { ...TEST_ENV, SCHOLAR_ALERTS_IMAP_HOST: 'imap.example', SCHOLAR_ALERTS_IMAP_USER: 'u', SCHOLAR_ALERTS_IMAP_PASSWORD: 'p' };
        const o = { ...opts(['google_scholar'], env, []), collectorCtx: { sleep: () => Promise.resolve(), imapFactory } };
        const failed = await runnerFailingStores(1)(o);
        expect(failed.sources[0].outcome).toBe('error');
        expect(((await stateOf('google_scholar')).cursor['alert-mailbox'] || {}).lastUid).toBeUndefined();
        await again();
        const ok = await runCollection(o);
        expect(ok.sources[0].outcome).toBe('ok');
        expect((await stateOf('google_scholar')).cursor['alert-mailbox'].lastUid).toBe(41);
    });
});
