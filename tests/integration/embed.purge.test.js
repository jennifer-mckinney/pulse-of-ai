// tests/integration/embed.purge.test.js
// Embed jobs whose post was removed after they were queued (standup bug:
// 9 embed jobs failed with "Post not found").
//
// Root cause: the only code that deletes raw_posts rows is the demo purge
// (scripts/compact.js purgeDemoBatch, run by the worker's maintenance job);
// it deleted the posts but left their queued embed jobs, and embedPost threw
// "Post not found" for each — BullMQ retried, then failed them. Retention
// blanking (src/collectors/retention.js) does not delete, but an embed job
// that ran after it embedded the removal NOTICE as if it were the post.
//
// Against the real test DB and a real Redis (throwaway queues, obliterated
// afterwards), this suite proves:
//   - a purged demo post's job completes as a no-op, reason 'purged_demo';
//   - a blanked post's job completes as a no-op, reason 'text_removed', and
//     the notice is never sent to the embedding service nor stored;
//   - a post purged or blanked WHILE its vector is computed gets no vector;
//   - a post missing with no purge record still fails loudly;
//   - the purge removes the purged posts' pending embed jobs (waiting and
//     delayed) and leaves every other job;
//   - through a real BullMQ Worker: the purged post's job completes and the
//     queue's failed count stays 0.

'use strict';

const axios = require('axios');
const { Queue, Worker, QueueEvents } = require('bullmq');
const { dbGet, dbRun, dbTransaction } = require('../../src/db/connection');
const { redisConnection } = require('../../src/queues/connection');
const { embedPost, findDemoPurgeRecord, EMBEDDING_DIMENSIONS } = require('../../src/pipeline/embeddings');
const { processEmbedJob } = require('../../src/workers/embed.worker');
const { removePendingEmbedJobs } = require('../../src/queues/embed-cleanup');
const { removeTextBatch, DETAIL_NOTICE } = require('../../src/collectors/retention');
const { purgeDemoPosts, purgeDemoBatch } = require('../../scripts/compact');
const { insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

const connection = redisConnection(process.env);
const SUFFIX = `${Date.now()}-${process.pid}`;
const queues = [];
function throwawayQueue(name) {
    const q = new Queue(`test-embed-${name}-${SUFFIX}`, { connection });
    queues.push(q);
    return q;
}

afterAll(async () => {
    for (const q of queues) {
        await q.obliterate({ force: true });
        await q.close();
    }
});

const CUTOFF = new Date('2026-04-01T00:00:00Z');
const OLD = '2026-01-10T12:00:00Z';     // past the retention boundary
const quiet = () => {};

function fakeEmbedding(fill = 0.1) {
    return Array(EMBEDDING_DIMENSIONS).fill(fill);
}
function mockEmbeddingService(onCall = async () => {}) {
    return jest.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        await onCall(body);
        return { data: { data: [{ index: 0, embedding: fakeEmbedding() }] } };
    });
}

async function insertDemoSource() {
    return (await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category, active)
         VALUES ('demo_social', 'Demo feed — Social (fictional)', 'demo', 'social', FALSE)
         RETURNING id`,
    )).id;
}

async function embeddingCount(postId) {
    return (await dbGet('SELECT COUNT(*)::int AS n FROM post_embeddings WHERE raw_post_id = $1', [postId])).n;
}

function blank(slug, postId) {
    return dbTransaction(client => removeTextBatch(client, slug, [postId], {
        reason: '90-day detail window ended', rule: '90-day detail window (spec §19)',
        performedBy: 'tests/integration/embed.purge.test.js', platform: false,
    }));
}

let job;
let mv;
let demoSrc;
let liveSrc;
beforeEach(async () => {
    job = await insertJob();
    mv = await insertMethodologyVersions();
    demoSrc = await insertDemoSource();
    liveSrc = await insertSource('real-news', 'news');
});
afterEach(() => jest.restoreAllMocks());

describe('embed job for a post purged by the demo purge', () => {
    it('completes as a no-op with reason purged_demo; the embedding service is never called', async () => {
        const postId = await insertPostWithFullPipeline(demoSrc, job, mv, { externalId: 'demo-1', collectedAt: OLD });
        const spy = mockEmbeddingService();

        const purge = await purgeDemoPosts({ cutoff: CUTOFF, log: quiet });
        expect(purge.counts.raw_posts).toBe(1);
        // The purge log lists the ids it deleted: the lookup key below.
        const log = await dbGet(`SELECT reason FROM data_retention_log WHERE action = 'purged_demo'`);
        expect(JSON.parse(log.reason).post_ids).toEqual([postId]);

        const result = await processEmbedJob({ data: { rawPostId: postId } }, { env: {} });
        expect(result).toMatchObject({
            postId, skipped: true, reason: 'purged_demo', at: expect.any(String),
            correlation: { queued: false, status: 'skipped' },
        });
        expect(spy).not.toHaveBeenCalled();
        expect(await findDemoPurgeRecord(postId)).not.toBeNull();
    });

    it('a post purged while its vector is computed gets no vector and no-ops', async () => {
        const postId = await insertPostWithFullPipeline(demoSrc, job, mv, { externalId: 'demo-race', collectedAt: OLD });
        mockEmbeddingService(() => purgeDemoPosts({ cutoff: CUTOFF, log: quiet }));

        const result = await embedPost(postId);
        expect(result).toMatchObject({ postId, skipped: true, reason: 'purged_demo' });
        expect(await embeddingCount(postId)).toBe(0);
    });

    it('a purge that commits DURING the vector insert (foreign-key violation) also no-ops', async () => {
        const postId = await insertPostWithFullPipeline(demoSrc, job, mv, { externalId: 'demo-fk', collectedAt: OLD });
        let release;
        let purgeTx;
        mockEmbeddingService(async () => {
            // The purge deletes the post in an OPEN transaction: the insert's
            // SELECT still sees the row, its FK check waits on the row lock,
            // and the commit below turns it into error 23503.
            let deleted;
            const deletedP = new Promise((r) => { deleted = r; });
            purgeTx = dbTransaction(async (client) => {
                await purgeDemoBatch(client, { cutoff: CUTOFF, batchSize: 10 });
                deleted();
                await new Promise((r) => { release = r; });
            });
            await deletedP;
            setTimeout(() => release(), 300);
        });

        const result = await embedPost(postId);
        await purgeTx;
        expect(result).toMatchObject({ postId, skipped: true, reason: 'purged_demo' });
        expect(await embeddingCount(postId)).toBe(0);
    });
});

describe('embed job for a post whose text retention removed', () => {
    it('completes as a no-op with reason text_removed; the notice is never embedded', async () => {
        const postId = await insertPostWithFullPipeline(liveSrc, job, mv, { externalId: 'live-blank' });
        expect(await blank('real-news', postId)).toEqual([postId]);
        const spy = mockEmbeddingService();

        const result = await processEmbedJob({ data: { rawPostId: postId } }, { env: {} });
        expect(result).toMatchObject({ postId, skipped: true, reason: 'text_removed', at: expect.any(String) });
        expect(spy).not.toHaveBeenCalled();
        expect(await embeddingCount(postId)).toBe(0);
        expect((await dbGet('SELECT content FROM raw_posts WHERE id = $1', [postId])).content).toBe(DETAIL_NOTICE);
    });

    it('a post blanked while its vector is computed gets no vector (the removed text is not stored)', async () => {
        const postId = await insertPostWithFullPipeline(liveSrc, job, mv, { externalId: 'live-race' });
        mockEmbeddingService(() => blank('real-news', postId));

        const result = await embedPost(postId);
        expect(result).toMatchObject({ postId, skipped: true, reason: 'text_removed' });
        expect(await embeddingCount(postId)).toBe(0);
    });

    it('a post with its text stored is still embedded', async () => {
        const postId = await insertPostWithFullPipeline(liveSrc, job, mv, { externalId: 'live-ok' });
        mockEmbeddingService();
        const result = await embedPost(postId);
        expect(result).toMatchObject({ postId, embeddingId: expect.any(String), dimensions: EMBEDDING_DIMENSIONS });
        expect(await embeddingCount(postId)).toBe(1);
    });
});

describe('other storage errors are not mistaken for a removal', () => {
    it('a vector the column rejects (wrong dimensions) fails the job', async () => {
        const postId = await insertPostWithFullPipeline(liveSrc, job, mv, { externalId: 'live-dims' });
        jest.spyOn(axios, 'post').mockResolvedValue({ data: { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] } });
        await expect(embedPost(postId)).rejects.toThrow(/dimensions/i);
        expect(await embeddingCount(postId)).toBe(0);
    });
});

describe('embed job for a genuinely missing post', () => {
    it('still fails loudly with "Post not found" (no purge record)', async () => {
        const spy = mockEmbeddingService();
        const missing = '00000000-0000-0000-0000-00000000abcd';
        await expect(processEmbedJob({ data: { rawPostId: missing } }, { env: {} }))
            .rejects.toThrow(`Post not found: ${missing}`);
        expect(spy).not.toHaveBeenCalled();
    });

    it('a purge record for OTHER posts does not excuse it', async () => {
        await insertPostWithFullPipeline(demoSrc, job, mv, { externalId: 'demo-other', collectedAt: OLD });
        await purgeDemoPosts({ cutoff: CUTOFF, log: quiet });
        // A free-text reason on another action is never cast to jsonb.
        await dbRun(`INSERT INTO data_retention_log (raw_post_id, action, reason) VALUES (NULL, 'compacted', 'not json')`);
        await expect(embedPost('00000000-0000-0000-0000-00000000abcd')).rejects.toThrow(/Post not found/);
    });
});

describe('the purge removes the purged posts\' pending embed jobs', () => {
    it('removes waiting and delayed jobs of purged posts only', async () => {
        const q = throwawayQueue('cleanup');
        const purged = await insertPostWithFullPipeline(demoSrc, job, mv, { externalId: 'demo-p', collectedAt: OLD });
        const kept = await insertPostWithFullPipeline(liveSrc, job, mv, { externalId: 'live-k', collectedAt: OLD });
        await q.add('embed-post', { rawPostId: purged });
        await q.add('embed-post', { rawPostId: purged }, { delay: 60000 });   // a retry waiting in 'delayed'
        await q.add('embed-post', { rawPostId: kept });

        const result = await purgeDemoPosts({
            cutoff: CUTOFF, log: quiet,
            removeEmbedJobs: ids => removePendingEmbedJobs(q, ids, { pageSize: 1 }),
        });

        expect(result.counts.raw_posts).toBe(1);
        expect(result.embedJobs).toEqual({ scanned: 3, removed: 2, inFlight: 0 });
        const left = await q.getJobs(['wait', 'delayed']);
        expect(left.map(j => j.data.rawPostId)).toEqual([kept]);
    });

    it('a queue failure is reported, never thrown (the purge is already committed)', async () => {
        await insertPostWithFullPipeline(demoSrc, job, mv, { externalId: 'demo-q', collectedAt: OLD });
        const lines = [];
        const result = await purgeDemoPosts({
            cutoff: CUTOFF, log: l => lines.push(l),
            removeEmbedJobs: async () => { throw new Error('redis down'); },
        });
        expect(result.counts.raw_posts).toBe(1);
        expect(result.embedJobs).toEqual({ error: 'redis down' });
        expect(lines.join('\n')).toContain('pending embed jobs not removed (redis down)');
    });

    it('nothing purged: the queue is not touched', async () => {
        const removeEmbedJobs = jest.fn();
        const result = await purgeDemoPosts({ cutoff: CUTOFF, log: quiet, removeEmbedJobs });
        expect(result.batches).toBe(0);
        expect(removeEmbedJobs).not.toHaveBeenCalled();
    });

    it('removePendingEmbedJobs with no ids scans nothing', async () => {
        const q = throwawayQueue('noop');
        expect(await removePendingEmbedJobs(q, [])).toEqual({ scanned: 0, removed: 0, inFlight: 0 });
    });

    it('counts a job it cannot remove (taken by a worker) as in flight', async () => {
        const jobStub = { data: { rawPostId: 'p1' }, remove: async () => { throw new Error('locked'); } };
        const q = { getJobs: async ([state]) => (state === 'wait' ? [jobStub] : []) };
        expect(await removePendingEmbedJobs(q, ['p1'])).toEqual({ scanned: 1, removed: 0, inFlight: 1 });
    });
});

describe('through a real BullMQ worker: failed-job count stays 0', () => {
    it('a job queued before its post was purged completes; a genuinely missing post fails', async () => {
        const q = throwawayQueue('worker');
        const events = new QueueEvents(q.name, { connection });
        await events.waitUntilReady();
        mockEmbeddingService();
        const postId = await insertPostWithFullPipeline(demoSrc, job, mv, { externalId: 'demo-w', collectedAt: OLD });
        const queued = await q.add('embed-post', { rawPostId: postId }, { attempts: 1 });
        // Purge WITHOUT queue cleanup: the job is left behind (e.g. already
        // taken by a worker) and must still not fail.
        await purgeDemoPosts({ cutoff: CUTOFF, log: quiet });

        const worker = new Worker(q.name, j => processEmbedJob(j, { env: {} }), { connection, concurrency: 1 });
        try {
            const value = await queued.waitUntilFinished(events, 15000);
            expect(value).toMatchObject({ postId, skipped: true, reason: 'purged_demo' });
            expect((await q.getJobCounts('failed')).failed).toBe(0);

            const missing = await q.add('embed-post', { rawPostId: '00000000-0000-0000-0000-00000000dead' }, { attempts: 1 });
            await expect(missing.waitUntilFinished(events, 15000)).rejects.toThrow(/Post not found/);
            expect((await q.getJobCounts('failed')).failed).toBe(1);
        } finally {
            await worker.close();
            await events.close();
        }
    }, 30000);
});
