// tests/unit/workers.scheduler.test.js
// src/workers/collector.scheduler.js: one BullMQ job scheduler per
// COLLECTING registry source, on the queue of its source_type (the DB
// vocabulary), staggered across the window, stale schedulers removed.
// DB and queues are mocked; the Redis behavior is covered by
// tests/integration/scheduler.redis.test.js.

'use strict';

jest.mock('../../src/queues/index', () => {
    const q = (name) => ({
        name,
        upsertJobScheduler: jest.fn().mockResolvedValue({}),
        getJobSchedulers:   jest.fn().mockResolvedValue([]),
        removeJobScheduler: jest.fn().mockResolvedValue(true),
    });
    const COLLECT_QUEUES = { rss: q('collect.rss'), api: q('collect.api'), bulk: q('collect.bulk') };
    return { COLLECT_QUEUES };
});
jest.mock('../../src/db/connection', () => ({ dbAll: jest.fn() }));

const { dbAll } = require('../../src/db/connection');
const { COLLECT_QUEUES } = require('../../src/queues/index');
const { scheduleAllSources, collectWindowMs, DEFAULT_COLLECT_WINDOW_MS } = require('../../src/workers/collector.scheduler');
const { SOURCES } = require('../../src/config/source-registry');

const ENV = { COLLECTOR_CONTACT_URL: 'https://example.org/c', PERMISSION_GATED_FEEDS_ACCEPTED_BY: 'Test Operator 2026-09-29', COLLECT_WINDOW_MS: '150000' };
const NOW = 1790000000000;
const rows = (slugs) => slugs.map(slug => {
    const s = SOURCES.find(x => x.slug === slug);
    return { id: `id-${slug}`, name: slug, source_type: s ? s.sourceType : 'rss' };
});
const upserts = () => Object.values(COLLECT_QUEUES).flatMap(q => q.upsertJobScheduler.mock.calls.map(c => [q.name, ...c]));

beforeEach(() => {
    jest.clearAllMocks();
    for (const q of Object.values(COLLECT_QUEUES)) {
        q.upsertJobScheduler.mockResolvedValue({});
        q.getJobSchedulers.mockResolvedValue([]);
        q.removeJobScheduler.mockResolvedValue(true);
    }
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => jest.restoreAllMocks());

test('schedules every collecting source (31 with no keys) on its source_type queue', async () => {
    dbAll.mockResolvedValue(rows(SOURCES.map(s => s.slug)));
    const n = await scheduleAllSources({ env: ENV });
    expect(n).toBe(31);
    for (const [queueName, id, , tmpl] of upserts()) {
        const src = SOURCES.find(s => s.slug === id);
        expect(queueName).toBe(`collect.${src.sourceType}`);
        expect(tmpl).toEqual({ name: 'collect', data: { slug: id, sourceId: `id-${id}`, sourceType: src.sourceType } });
    }
    const ids = upserts().map(u => u[1]);
    for (const blocked of ['wechat', 'telegram', 'researchgate', 'cato', 'x', 'youtube', 'cfr']) expect(ids).not.toContain(blocked);
});

test('cadence: the window, stretched to each source\'s poll interval; staggered starts', async () => {
    dbAll.mockResolvedValue(rows(['bbc_news', 'stack_overflow', 'gitlab']));
    await scheduleAllSources({ env: ENV });
    const byId = Object.fromEntries(upserts().map(([, id, repeat]) => [id, repeat]));
    expect(byId.bbc_news.every).toBe(150000);
    expect(byId.stack_overflow.every).toBe(900000);   // 300/day keyless quota
    expect(byId.gitlab.every).toBe(150000);      // D4: 24 requests/hour of 60
    const starts = Object.values(byId).map(r => r.startDate).sort();
    expect(starts).toEqual([NOW, NOW + 50000, NOW + 100000]);
});

test('kill switch: a disabled source is not scheduled and its stale scheduler is removed', async () => {
    dbAll.mockResolvedValue(rows(['bbc_news', 'npr']));
    COLLECT_QUEUES.rss.getJobSchedulers.mockResolvedValue([{ key: 'npr' }, { key: 'bbc_news' }]);
    const n = await scheduleAllSources({ env: { ...ENV, SOURCE_NPR_ENABLED: 'false' } });
    expect(n).toBe(1);
    expect(COLLECT_QUEUES.rss.removeJobScheduler).toHaveBeenCalledWith('npr');
    expect(COLLECT_QUEUES.rss.removeJobScheduler).not.toHaveBeenCalledWith('bbc_news');
});

test('a new credential schedules its source (X on collect.api)', async () => {
    dbAll.mockResolvedValue(rows(['x']));
    expect(await scheduleAllSources({ env: ENV })).toBe(0);
    expect(await scheduleAllSources({ env: { ...ENV, X_BEARER_TOKEN: 't' } })).toBe(1);
    expect(COLLECT_QUEUES.api.upsertJobScheduler).toHaveBeenCalledWith('x', expect.objectContaining({ every: 180000 }) /* D4: 2–3 min band */, expect.anything());
});

test('non-registry rows and unknown types are skipped with a log line, never crash', async () => {
    const log = jest.fn();
    dbAll.mockResolvedValue([{ id: '1', name: 'techcrunch_ai', source_type: 'rss' }, { id: '2', name: 'npr', source_type: 'scrape' }]);
    expect(await scheduleAllSources({ env: ENV, log })).toBe(0);
    expect(log.mock.calls.join(' ')).toMatch(/not a registry source.*unknown source_type "scrape"/s);
});

test('no contact URL → nothing scheduled, every old scheduler removed', async () => {
    dbAll.mockResolvedValue(rows(['bbc_news']));
    COLLECT_QUEUES.rss.getJobSchedulers.mockResolvedValue([{ id: 'bbc_news' }]);
    expect(await scheduleAllSources({ env: {} })).toBe(0);
    expect(COLLECT_QUEUES.rss.removeJobScheduler).toHaveBeenCalledWith('bbc_news');
});

test('COLLECT_WINDOW_MS falls back to 150 s when missing or invalid', () => {
    expect(DEFAULT_COLLECT_WINDOW_MS).toBe(150000);
    expect(collectWindowMs({})).toBe(150000);
    expect(collectWindowMs({ COLLECT_WINDOW_MS: 'abc' })).toBe(150000);
    expect(collectWindowMs({ COLLECT_WINDOW_MS: '-5' })).toBe(150000);
    expect(collectWindowMs({ COLLECT_WINDOW_MS: '120000' })).toBe(120000);
});
