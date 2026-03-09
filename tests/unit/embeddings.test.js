// tests/unit/embeddings.test.js
// TDD tests for src/pipeline/embeddings.js
//
// The Infinity embedding service is an external HTTP dependency.
// HTTP calls are mocked via jest.spyOn(axios, 'post') so tests run without
// a running service.  The DB write (post_embeddings) uses the real test DB.

'use strict';

const axios  = require('axios');
const crypto = require('crypto');
const { dbGet, dbRun } = require('../../src/db/connection');
const {
    generateEmbedding,
    saveEmbedding,
    embedPost,
    EMBEDDING_DIMENSIONS,
} = require('../../src/pipeline/embeddings');

// ─── Test helpers ──────────────────────────────────────────────────────────────

/** Build a fake 384-float embedding (all same value, easy to assert on). */
function fakeEmbedding(fill = 0.1) {
    return Array(EMBEDDING_DIMENSIONS).fill(fill);
}

/** Return a jest mock that resolves with a valid Infinity-format response. */
function mockInfinityResponse(embedding = fakeEmbedding()) {
    return jest.spyOn(axios, 'post').mockResolvedValue({
        data: {
            model: 'sentence-transformers/all-MiniLM-L6-v2',
            data:  [{ index: 0, embedding }],
        },
    });
}

async function insertSource() {
    const row = await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category)
         VALUES ('embed-test-src', 'Embed Test', 'reddit', 'social')
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
    );
    return row.id;
}

async function insertRawPost(sourceId, externalId = 'emb-test-1') {
    const content = `Test embedding post ${externalId}`;
    const hash    = crypto.createHash('sha256').update(content).digest('hex');
    const row = await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (source_id, external_id) DO UPDATE SET content = EXCLUDED.content
         RETURNING id`,
        [sourceId, externalId, content, hash],
    );
    return row.id;
}

// ─── generateEmbedding() ──────────────────────────────────────────────────────

describe('generateEmbedding()', () => {
    afterEach(() => jest.restoreAllMocks());

    it('calls the Infinity service with the correct OpenAI-compatible payload', async () => {
        const spy = mockInfinityResponse();

        await generateEmbedding('Hello world');

        expect(spy).toHaveBeenCalledTimes(1);
        const [url, body] = spy.mock.calls[0];
        expect(url).toContain('/embeddings');
        expect(body).toMatchObject({ input: ['Hello world'] });
    });

    it(`returns an array of exactly ${384} floats`, async () => {
        mockInfinityResponse();

        const embedding = await generateEmbedding('test text');

        expect(Array.isArray(embedding)).toBe(true);
        expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
        expect(typeof embedding[0]).toBe('number');
    });

    it('throws when the Infinity service is unavailable', async () => {
        jest.spyOn(axios, 'post').mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(generateEmbedding('test')).rejects.toThrow();
    });
});

// ─── saveEmbedding() ──────────────────────────────────────────────────────────

describe('saveEmbedding()', () => {
    it('writes a row to post_embeddings', async () => {
        const srcId  = await insertSource();
        const postId = await insertRawPost(srcId, 'save-emb-1');

        await saveEmbedding(postId, fakeEmbedding(0.2));

        const row = await dbGet(
            'SELECT * FROM post_embeddings WHERE raw_post_id = $1',
            [postId],
        );
        expect(row).toBeDefined();
        expect(row.raw_post_id).toBe(postId);
    });

    it('stores the model_name on the row', async () => {
        const srcId  = await insertSource();
        const postId = await insertRawPost(srcId, 'save-emb-2');

        await saveEmbedding(postId, fakeEmbedding(), 'test-model-v1');

        const row = await dbGet(
            'SELECT model_name FROM post_embeddings WHERE raw_post_id = $1',
            [postId],
        );
        expect(row.model_name).toBe('test-model-v1');
    });

    it('is idempotent: re-saving the same postId does not create a duplicate row', async () => {
        const srcId  = await insertSource();
        const postId = await insertRawPost(srcId, 'save-emb-3');

        await saveEmbedding(postId, fakeEmbedding(0.1));
        await saveEmbedding(postId, fakeEmbedding(0.9)); // overwrite

        const rows = await dbGet(
            'SELECT COUNT(*)::int AS cnt FROM post_embeddings WHERE raw_post_id = $1',
            [postId],
        );
        expect(rows.cnt).toBe(1);
    });

    it('returns the UUID of the created/updated embedding row', async () => {
        const srcId  = await insertSource();
        const postId = await insertRawPost(srcId, 'save-emb-4');

        const id = await saveEmbedding(postId, fakeEmbedding());

        expect(typeof id).toBe('string');
        expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
    });
});

// ─── embedPost() ──────────────────────────────────────────────────────────────

describe('embedPost()', () => {
    afterEach(() => jest.restoreAllMocks());

    it('generates and stores an embedding for the post', async () => {
        const srcId  = await insertSource();
        const postId = await insertRawPost(srcId, 'embed-post-1');
        mockInfinityResponse(fakeEmbedding(0.5));

        await embedPost(postId);

        const row = await dbGet(
            'SELECT * FROM post_embeddings WHERE raw_post_id = $1',
            [postId],
        );
        expect(row).toBeDefined();
    });

    it('passes the post content to the embedding service', async () => {
        const srcId  = await insertSource();
        const postId = await insertRawPost(srcId, 'embed-post-2');
        const spy = mockInfinityResponse();

        await embedPost(postId);

        const [, body] = spy.mock.calls[0];
        expect(body.input[0]).toContain('embed-post-2');
    });

    it('returns an object with postId, embeddingId, and dimensions', async () => {
        const srcId  = await insertSource();
        const postId = await insertRawPost(srcId, 'embed-post-3');
        mockInfinityResponse();

        const result = await embedPost(postId);

        expect(result).toMatchObject({
            postId:     postId,
            embeddingId: expect.any(String),
            dimensions:  EMBEDDING_DIMENSIONS,
        });
    });

    it('throws a clear error when the post does not exist', async () => {
        // No mock needed — should fail before calling the embedding service
        await expect(
            embedPost('00000000-0000-0000-0000-000000000000'),
        ).rejects.toThrow(/not found/i);
    });
});
