// tests/unit/workers.ingest.test.js
// TDD tests for src/workers/ingest.worker.js
//
// The ingest worker is the highest-throughput stage: it processes one raw post
// through sentiment + relevance + discourse, writes results to the DB, and
// enqueues downstream embed + correlate jobs.
//
// Strategy: mock the pipeline modules and queue clients so tests run fast
// and without Redis. Verify the worker coordinates correctly — it is an
// orchestrator, not an algorithm.

'use strict';

// Mock BullMQ queues before any require() that might connect to Redis
jest.mock('../../src/queues/index', () => ({
    embedQueue:     { add: jest.fn().mockResolvedValue({ id: 'embed-job-1' }) },
    correlateQueue: { add: jest.fn().mockResolvedValue({ id: 'corr-job-1' }) },
    connection:     { host: '127.0.0.1', port: 6379 },
}));

// Mock pipeline modules — they are unit-tested separately
jest.mock('../../src/pipeline/sentiment',  () => ({ analyzeSentiment:  jest.fn() }));
jest.mock('../../src/pipeline/relevance',  () => ({ scoreRelevance:    jest.fn() }));
jest.mock('../../src/pipeline/discourse',  () => ({ scoreDQI:          jest.fn() }));
jest.mock('../../src/pipeline/ingest',     () => ({ saveProcessedPost: jest.fn() }));

const { analyzeSentiment } = require('../../src/pipeline/sentiment');
const { scoreRelevance }   = require('../../src/pipeline/relevance');
const { scoreDQI }         = require('../../src/pipeline/discourse');
const { saveProcessedPost }= require('../../src/pipeline/ingest');
const { embedQueue, correlateQueue } = require('../../src/queues/index');
const { processIngestJob } = require('../../src/workers/ingest.worker');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeJob(overrides = {}) {
    return {
        data: {
            rawPostId:  'post-uuid-123',
            sourceId:   'src-uuid-456',
            content:    'AI systems are reshaping public discourse in unexpected ways.',
            metadata:   { platform: 'reddit', subreddit: 'MachineLearning' },
            ...overrides,
        },
    };
}

function mockPipelineSuccess() {
    analyzeSentiment.mockResolvedValue({
        label: 'positive', score: 0.72, methodologyVersionId: 'mv-sent-1',
    });
    scoreRelevance.mockResolvedValue({
        score: 0.88, methodologyVersionId: 'mv-rel-1',
    });
    scoreDQI.mockResolvedValue({
        score: 0.65, components: { rationality: 0.7, reciprocity: 0.6 },
        methodologyVersionId: 'mv-dqi-1',
    });
    saveProcessedPost.mockResolvedValue({ processingJobId: 'pj-uuid-789' });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
    mockPipelineSuccess();
});

describe('processIngestJob()', () => {
    it('calls analyzeSentiment with the post content', async () => {
        const job = makeJob();
        await processIngestJob(job);
        expect(analyzeSentiment).toHaveBeenCalledWith(job.data.content);
    });

    it('calls scoreRelevance with the post content', async () => {
        const job = makeJob();
        await processIngestJob(job);
        expect(scoreRelevance).toHaveBeenCalledWith(job.data.content);
    });

    it('calls scoreDQI with the post content', async () => {
        const job = makeJob();
        await processIngestJob(job);
        expect(scoreDQI).toHaveBeenCalledWith(job.data.content);
    });

    it('calls saveProcessedPost with all pipeline results', async () => {
        const job = makeJob();
        await processIngestJob(job);

        expect(saveProcessedPost).toHaveBeenCalledWith(
            expect.objectContaining({
                rawPostId:  job.data.rawPostId,
                sourceId:   job.data.sourceId,
                sentiment:  expect.objectContaining({ label: 'positive', score: 0.72 }),
                relevance:  expect.objectContaining({ score: 0.88 }),
                discourse:  expect.objectContaining({ score: 0.65 }),
            }),
        );
    });

    it('enqueues an embed job after successful processing', async () => {
        const job = makeJob();
        await processIngestJob(job);

        expect(embedQueue.add).toHaveBeenCalledWith(
            'embed-post',
            expect.objectContaining({ rawPostId: job.data.rawPostId }),
        );
    });

    it('enqueues a correlate job after successful processing', async () => {
        const job = makeJob();
        await processIngestJob(job);

        expect(correlateQueue.add).toHaveBeenCalledWith(
            'correlate-post',
            expect.objectContaining({
                rawPostId: job.data.rawPostId,
                sourceId:  job.data.sourceId,
            }),
        );
    });

    it('returns a result object with processingJobId and downstream job IDs', async () => {
        const job = makeJob();
        const result = await processIngestJob(job);

        expect(result).toMatchObject({
            processingJobId: 'pj-uuid-789',
            embedJobId:      expect.any(String),
            correlateJobId:  expect.any(String),
        });
    });

    it('does NOT enqueue embed or correlate if saveProcessedPost throws', async () => {
        saveProcessedPost.mockRejectedValue(new Error('DB write failed'));
        const job = makeJob();

        await expect(processIngestJob(job)).rejects.toThrow('DB write failed');
        expect(embedQueue.add).not.toHaveBeenCalled();
        expect(correlateQueue.add).not.toHaveBeenCalled();
    });

    it('does NOT enqueue embed or correlate if relevance score is below threshold', async () => {
        // Posts that score below the relevance threshold should not proceed to
        // expensive downstream stages (embedding is ~50ms per post via Python service).
        scoreRelevance.mockResolvedValue({ score: 0.10, methodologyVersionId: 'mv-rel-1' });
        const job = makeJob();

        await processIngestJob(job);

        expect(embedQueue.add).not.toHaveBeenCalled();
        expect(correlateQueue.add).not.toHaveBeenCalled();
    });

    it('still saves sentiment + discourse even when relevance is low', async () => {
        // Low relevance = skip embedding/correlation, but the base processing record
        // must still be written for audit completeness.
        scoreRelevance.mockResolvedValue({ score: 0.10, methodologyVersionId: 'mv-rel-1' });
        const job = makeJob();

        await processIngestJob(job);

        expect(saveProcessedPost).toHaveBeenCalled();
    });
});
