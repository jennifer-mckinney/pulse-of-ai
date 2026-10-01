// tests/integration/correlation.notimplemented.test.js
// PR #22 grumpy M7, end to end against the real test DB and the real Redis:
// with the DPIA gate's every switch set (DPIA reference, CORRELATION_ENABLED,
// a real per-deployment salt), a post is embedded, NO correlate job is
// queued, a correlate job added by hand is refused as "not implemented:
// signal design pending DPIA", and no pseudonymous_users or
// user_platform_sightings row is ever written. Only the HTTP embedding
// service is stubbed; the gate, the workers and the correlation module are
// the real ones.

'use strict';

const axios = require('axios');
const { dbGet } = require('../../src/db/connection');
const { EMBEDDING_DIMENSIONS } = require('../../src/pipeline/embeddings');
const { processEmbedJob } = require('../../src/workers/embed.worker');
const { processCorrelateJob } = require('../../src/workers/correlate.worker');
const { correlateUser, computeSignalHash, CorrelationNotImplementedError } = require('../../src/pipeline/correlation');
const { correlateQueue } = require('../../src/queues/index');
const { insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

const OPEN = {
    CORRELATION_DPIA_REF: 'DPIA-TEST-2026-09',
    CORRELATION_ENABLED: 'true',
    CORRELATION_SALT: '5b1e0c7f9a2d4e6b8c3f1a0d9e7b5c2a4f6e8d0c1b3a5f7e9d2c4b6a8e0f1c3d',
};

const count = async (t) => (await dbGet(`SELECT COUNT(*)::int AS n FROM ${t}`)).n;
const queued = async () => {
    const c = await correlateQueue.getJobCounts('waiting', 'delayed', 'active', 'prioritized');
    return Object.values(c).reduce((a, b) => a + b, 0);
};

afterEach(() => jest.restoreAllMocks());
afterAll(() => correlateQueue.close());

it('every switch set: embedded, nothing queued, a hand-added job refused, no profile written', async () => {
    const src = await insertSource('m7-src', 'forums');
    const post = await insertPostWithFullPipeline(src, await insertJob(), await insertMethodologyVersions(), { externalId: 'm7-1' });
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { data: [{ index: 0, embedding: Array(EMBEDDING_DIMENSIONS).fill(0.2) }] } });
    // GET /health: the registered embedding methodology (checked before the stamp).
    const reg = require('../../src/config/methodology-registry').METHODOLOGY_VERSIONS.filter(m => m.component === 'embedding').pop();
    jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { model: reg.model_name, revision: reg.config.revision, library: reg.config.library } });
    const before = await queued();

    const r = await processEmbedJob({ data: { rawPostId: post } }, { env: OPEN });
    expect(r).toMatchObject({ postId: post, embeddingId: expect.any(String), correlation: { queued: false, status: 'not_implemented' } });
    expect(await count('post_embeddings')).toBe(1);
    expect(await queued()).toBe(before);

    // A job that reaches the correlate worker anyway is refused, not run.
    const job = { data: { rawPostId: post, sourceId: src, signalHash: computeSignalHash({ topics: ['llm'], hour: 9 }, OPEN.CORRELATION_SALT), topicAffinity: ['llm'], confidence: 1 } };
    const refused = await processCorrelateJob(job, { env: OPEN });
    expect(refused).toMatchObject({ correlated: false, refused: 'not_implemented', reason: expect.stringMatching(/^not implemented: signal design pending DPIA/) });
    // And the library itself refuses, whatever confidence it is handed.
    await expect(correlateUser({ ...job.data })).rejects.toBeInstanceOf(CorrelationNotImplementedError);

    expect(await count('pseudonymous_users')).toBe(0);
    expect(await count('user_platform_sightings')).toBe(0);
});
