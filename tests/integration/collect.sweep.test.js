// tests/integration/collect.sweep.test.js — G10-4: a failed retry enqueue is
// never swallowed, and posts left unscored are re-queued by the sweep.

'use strict';

const crypto = require('crypto');
const { dbRun, dbGet } = require('../../src/db/connection');
const { sweepUnscored } = require('../../src/collectors/sweep');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

it('scoring fails and the retry cannot be queued: the run is an error (kind queue), not silent', async () => {
    let runCollection;
    jest.isolateModules(() => {
        jest.doMock('../../src/pipeline/ingest', () => ({
            ...jest.requireActual('../../src/pipeline/ingest'),
            scorePost: jest.fn().mockRejectedValue(new Error('scoring down')),
        }));
        ({ runCollection } = require('../../src/collectors/runner'));
    });
    const s = await runCollection({
        slugs: ['hacker_news'], triggeredBy: 'test', env: TEST_ENV, now: () => Date.parse(RECORDED_AT),
        transport: fixtureTransport([[/hn\.algolia\.com/, 'recorded/hn-algolia.json']]),
        queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => { throw new Error('ECONNREFUSED'); } },
        collectorCtx: { sleep: () => Promise.resolve() },
    });
    expect(s.sources[0]).toMatchObject({ outcome: 'error', errorKind: 'queue' });
    expect(s.sources[0].error).toMatch(/retry could not be queued \(ECONNREFUSED\)/);
    const st = await dbGet(`SELECT last_error_kind FROM source_collection_state s JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = 'hacker_news'`);
    expect(st.last_error_kind).toBe('queue');
});

describe('sweepUnscored', () => {
    async function post(ext, collectedAgo, scored = false) {
        const src = await dbGet(`SELECT id FROM data_sources WHERE name = 'hacker_news'`);
        const p = await dbRun(
            `INSERT INTO raw_posts (source_id, external_id, content, content_hash, collected_at)
             VALUES ($1, $2, 'AI text', $3, NOW() - $4::interval) RETURNING id`,
            [src.id, ext, crypto.randomUUID(), collectedAgo]);
        if (scored) {
            const { saveSentiment } = require('../../src/pipeline/sentiment');
            const { resolveCurrentMethodology } = require('../../src/pipeline/methodology');
            const job = await dbRun(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('test', 'completed') RETURNING id`);
            await saveSentiment(p.id, job.id, (await resolveCurrentMethodology()).sentimentMvId);
        }
        return p.id;
    }

    it('re-queues only unscored posts from the last 24 h that have settled, once per hour', async () => {
        const unscored = await post('a', '1 hour');
        await post('b', '2 hours', true);         // scored
        await post('c', '1 minute');              // still being scored inline
        await post('d', '25 hours');              // outside the window
        const calls = [];
        const now = () => Date.parse('2026-09-29T10:30:00Z');
        const r = await sweepUnscored({ enqueue: async (data, key) => calls.push([data, key]), now });
        expect(r).toEqual({ found: 1, queued: 1, failed: 0 });
        expect(calls[0][0]).toEqual({ rawPostId: unscored, sourceId: expect.any(String), jobId: null });
        expect(calls[0][1]).toBe(`sweep-${unscored}-${Math.floor(now() / 3600000)}`);
        const failing = await sweepUnscored({ enqueue: async () => { throw new Error('down'); }, now });
        expect(failing).toEqual({ found: 1, queued: 0, failed: 1 });
    });
});
