// tests/unit/embeddings.test.js
// TDD tests for src/pipeline/embeddings.js
//
// The embeddings service (python/embeddings_service.py) is an external HTTP dependency.
// HTTP calls are mocked via jest.spyOn(axios, 'post') so tests run without
// a running service.  The DB write (post_embeddings) uses the real test DB.

'use strict';

const axios  = require('axios');
const crypto = require('crypto');
const { dbGet, dbRun } = require('../../src/db/connection');
const { CURRENT_VERSIONS } = require('../../src/config/methodology-registry');
const {
    generateEmbedding,
    saveEmbedding,
    embedPost,
    EMBEDDING_DIMENSIONS,
    embeddingMethodologyVersion,
} = require('../../src/pipeline/embeddings');

// ─── Test helpers ──────────────────────────────────────────────────────────────

/** Build a fake 384-float embedding (all same value, easy to assert on). */
function fakeEmbedding(fill = 0.1) {
    return Array(EMBEDDING_DIMENSIONS).fill(fill);
}

/** Return a jest mock that resolves with a valid OpenAI-compatible response. */
function mockServiceResponse(embedding = fakeEmbedding()) {
    return jest.spyOn(axios, 'post').mockResolvedValue({
        data: {
            model: 'sentence-transformers/all-MiniLM-L6-v2',
            data:  [{ index: 0, embedding }],
        },
    });
}

// The service's GET /health as python/embeddings_service.py serves it when
// it runs the registered embedding methodology (model, revision, library).
const { METHODOLOGY_VERSIONS } = require('../../src/config/methodology-registry');
const REGISTERED = METHODOLOGY_VERSIONS.filter(m => m.component === 'embedding').pop();
const HEALTHY = Object.freeze({
    status: 'healthy', model: REGISTERED.model_name, revision: REGISTERED.config.revision,
    library: REGISTERED.config.library, model_loaded: true, embedding_dims: 384,
});
/** Mock GET /health (grumpy final #3: checked before a vector is stamped). */
function mockHealth(body = HEALTHY, status = 200) {
    return jest.spyOn(axios, 'get').mockResolvedValue({ status, data: body });
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

    it('calls the embeddings service with the correct OpenAI-compatible payload', async () => {
        const spy = mockServiceResponse();

        await generateEmbedding('Hello world');

        expect(spy).toHaveBeenCalledTimes(1);
        const [url, body] = spy.mock.calls[0];
        expect(url).toContain('/embeddings');
        expect(body).toMatchObject({ input: ['Hello world'] });
    });

    it(`returns an array of exactly ${384} floats`, async () => {
        mockServiceResponse();

        const embedding = await generateEmbedding('test text');

        expect(Array.isArray(embedding)).toBe(true);
        expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
        expect(typeof embedding[0]).toBe('number');
    });

    it('throws when the embeddings service is unavailable', async () => {
        jest.spyOn(axios, 'post').mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(generateEmbedding('test')).rejects.toThrow();
    });
});

// ─── saveEmbedding() ──────────────────────────────────────────────────────────

describe('saveEmbedding()', () => {
    beforeEach(() => mockHealth());
    afterEach(() => jest.restoreAllMocks());

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

    // P9-5: each vector records the embedding methodology version that
    // produced it (methodology_versions embedding@<ver> holds model + revision
    // + library). Since migration 065 that is embedding@1.1.0
    // (sentence-transformers 6.1.0); embedding@1.0.0 vectors keep their stamp.
    it('stamps the CURRENT embedding methodology version (1.1.0) on the row', async () => {
        const srcId  = await insertSource();
        const postId = await insertRawPost(srcId, 'save-emb-5');
        await saveEmbedding(postId, fakeEmbedding());
        const row = await dbGet(
            'SELECT methodology_version FROM post_embeddings WHERE raw_post_id = $1', [postId]);
        expect(row.methodology_version).toBe('1.1.0');
        expect(row.methodology_version).toBe(CURRENT_VERSIONS.embedding);
    });

    it('re-embedding a 1.0.0 vector restamps it with the current version', async () => {
        const srcId  = await insertSource();
        const postId = await insertRawPost(srcId, 'save-emb-6');
        await saveEmbedding(postId, fakeEmbedding(0.1));
        await dbRun(`UPDATE post_embeddings SET methodology_version = '1.0.0' WHERE raw_post_id = $1`, [postId]);
        await saveEmbedding(postId, fakeEmbedding(0.2));
        const row = await dbGet(
            'SELECT methodology_version FROM post_embeddings WHERE raw_post_id = $1', [postId]);
        expect(row.methodology_version).toBe('1.1.0');
    });

    it('stamps NULL when the configured model/revision is not the registered one', () => {
        expect(embeddingMethodologyVersion({})).toBe('1.1.0');
        expect(embeddingMethodologyVersion({ EMBED_MODEL: 'other/model' })).toBeNull();
        expect(embeddingMethodologyVersion({ EMBED_MODEL_REVISION: 'main' })).toBeNull();
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
    beforeEach(() => mockHealth());
    afterEach(() => jest.restoreAllMocks());

    it('generates and stores an embedding for the post', async () => {
        const srcId  = await insertSource();
        const postId = await insertRawPost(srcId, 'embed-post-1');
        mockServiceResponse(fakeEmbedding(0.5));

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
        const spy = mockServiceResponse();

        await embedPost(postId);

        const [, body] = spy.mock.calls[0];
        expect(body.input[0]).toContain('embed-post-2');
    });

    it('returns an object with postId, embeddingId, and dimensions', async () => {
        const srcId  = await insertSource();
        const postId = await insertRawPost(srcId, 'embed-post-3');
        mockServiceResponse();

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

// ─── Grumpy final #3: the running service must be the registered one ─────────
// The stamp used to depend only on the worker's EMBED_MODEL /
// EMBED_MODEL_REVISION. The library (sentence-transformers==6.1.0 in
// embedding@1.1.0) was never compared with the service actually running, so
// a host .venv still on 2.7.0 got its vectors labelled 1.1.0. Now every
// vector is stamped only after GET /health reports the registered model,
// revision AND library; otherwise it is stored with methodology_version NULL
// (the convention of migration 012 for a vector that may not match) and the
// mismatch is logged once per process. An unreachable /health fails the job
// (BullMQ retries it) rather than storing an unverified stamp.

describe('the embedding methodology stamp is verified against GET /health (grumpy final #3)', () => {
    let errors;
    beforeEach(() => { errors = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => jest.restoreAllMocks());

    async function embedOne(externalId) {
        const postId = await insertRawPost(await insertSource(), externalId);
        mockServiceResponse();
        const result = await embedPost(postId);
        const row = await dbGet('SELECT methodology_version FROM post_embeddings WHERE raw_post_id = $1', [postId]);
        return { postId, result, stamp: row ? row.methodology_version : undefined };
    }

    it('the registered model, revision and library: stamped with the current version, /health asked', async () => {
        const health = mockHealth();
        const { result, stamp } = await embedOne('gf3-ok');
        expect(stamp).toBe(CURRENT_VERSIONS.embedding);
        expect(result.methodologyVersion).toBe(CURRENT_VERSIONS.embedding);
        expect(health).toHaveBeenCalledWith(expect.stringMatching(/\/health$/), expect.any(Object));
        expect(errors).not.toHaveBeenCalled();
    });

    it.each([
        ['an older library (a .venv built before the bump)', { library: 'sentence-transformers==2.7.0' }, /library "sentence-transformers==2\.7\.0" \(registered "sentence-transformers==6\.1\.0"\)/],
        ['no library field (another OpenAI-compatible server)', { library: undefined }, /library null \(registered "sentence-transformers==6\.1\.0"\)/],
        ['another model', { model: 'other/model' }, /model "other\/model"/],
        ['another revision', { revision: 'main' }, /revision "main"/],
    ])('%s: stored with methodology_version NULL and logged', async (_label, change, logged) => {
        mockHealth({ ...HEALTHY, ...change });
        const { result, stamp } = await embedOne(`gf3-${Object.keys(change)[0]}-${Math.random()}`);
        expect(stamp).toBeNull();
        expect(result.methodologyVersion).toBeNull();
        expect(errors).toHaveBeenCalledTimes(1);
        expect(errors.mock.calls[0][0]).toMatch(/embedding@1\.1\.0/);
        expect(errors.mock.calls[0][0]).toMatch(logged);
        expect(errors.mock.calls[0][0]).toMatch(/methodology_version NULL/);
    });

    it('the same mismatch is logged once per process, every vector still NULL', async () => {
        mockHealth({ ...HEALTHY, library: 'sentence-transformers==6.0.9' });
        const a = await embedOne('gf3-once-a');
        const b = await embedOne('gf3-once-b');
        expect([a.stamp, b.stamp]).toEqual([null, null]);
        expect(errors).toHaveBeenCalledTimes(1);
    });

    it('a 404 /health (no health endpoint) cannot verify: NULL', async () => {
        mockHealth({ detail: 'Not Found' }, 404);
        const { stamp } = await embedOne('gf3-404');
        expect(stamp).toBeNull();
        expect(errors.mock.calls[0][0]).toMatch(/GET \/health answered HTTP 404/);
    });

    it('an unreachable /health fails the job (retried) and stores no vector', async () => {
        jest.spyOn(axios, 'get').mockRejectedValue(new Error('connect ECONNREFUSED'));
        const postId = await insertRawPost(await insertSource(), 'gf3-down');
        mockServiceResponse();
        await expect(embedPost(postId)).rejects.toThrow(/\/health unavailable \(connect ECONNREFUSED\).*cannot be verified/);
        expect(await dbGet('SELECT 1 FROM post_embeddings WHERE raw_post_id = $1', [postId])).toBeUndefined();
    });

    it('a model/revision override in the worker env claims nothing and needs no /health', async () => {
        const saved = process.env.EMBED_MODEL_REVISION;
        process.env.EMBED_MODEL_REVISION = 'main';
        try {
            let mod;
            jest.isolateModules(() => { mod = require('../../src/pipeline/embeddings'); });
            const health = mockHealth();
            expect(await mod.verifiedMethodologyVersion()).toBeNull();
            expect(health).not.toHaveBeenCalled();
        } finally {
            if (saved === undefined) delete process.env.EMBED_MODEL_REVISION; else process.env.EMBED_MODEL_REVISION = saved;
        }
    });

    it('saveEmbedding goes through the same check', async () => {
        mockHealth({ ...HEALTHY, library: 'sentence-transformers==2.7.0' });
        const postId = await insertRawPost(await insertSource(), 'gf3-save');
        await saveEmbedding(postId, fakeEmbedding());
        const row = await dbGet('SELECT methodology_version FROM post_embeddings WHERE raw_post_id = $1', [postId]);
        expect(row.methodology_version).toBeNull();
    });
});
