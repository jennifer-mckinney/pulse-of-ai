// tests/integration/audit.ingestVersion.test.js — G10-11: the receipt shows
// the ingest version a post was STORED under (raw_posts.ingest_mv_id); older
// rows resolve the version effective at their collected_at.

'use strict';

const request = require('supertest');
const app = require('../../src/server');
const { dbRun, dbGet } = require('../../src/db/connection');
const { storeRawPost } = require('../../src/pipeline/ingest');
const { runCollection } = require('../../src/collectors/runner');
const { resolveCurrentMethodology } = require('../../src/pipeline/methodology');
const { METHODOLOGY_VERSIONS } = require('../../src/config/methodology-registry');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const populate = require('../../scripts/populate');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

// Only two ingest versions, at known times: 1.1.0 then 1.3.0.
async function registerIngest(version, effectiveFrom) {
    const m = METHODOLOGY_VERSIONS.find(r => r.component === 'ingest' && r.version === version);
    const row = await dbRun(
        `INSERT INTO methodology_versions (component, version, model_name, config, justification, effective_from)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id`,
        [m.component, m.version, m.model_name, JSON.stringify(m.config), m.justification, effectiveFrom]);
    return row.id;
}
async function source() {
    return (await dbRun(`INSERT INTO data_sources (name, display_name, source_type, category)
        VALUES ('ingest-version-src', 'Ingest Version Src', 'api', 'forums') RETURNING id`)).id;
}
async function postAt(sourceId, ext, collectedAt, ingestMvId = null) {
    const { postId } = await storeRawPost({ id: ext, text: 'AI text' }, sourceId, { ingestMvId });
    await dbRun('UPDATE raw_posts SET collected_at = $2 WHERE id = $1', [postId, collectedAt]);
    return postId;
}
const receipt = async id => (await request(app).get(`/api/audit/${id}`)).body.ingest;

describe('ingest version per post (G10-11)', () => {
    it('recorded: a post stored under 1.1.0 shows 1.1.0 (and its wording), not the latest', async () => {
        const v11 = await registerIngest('1.1.0', '2026-01-01T00:00:00Z');
        await registerIngest('1.3.0', '2026-09-01T00:00:00Z');
        const src = await source();
        const id = await postAt(src, 'r1', '2026-09-20T00:00:00Z', v11);
        const ing = await receipt(id);
        expect(ing).toMatchObject({ methodology_version: '1.1.0', lineage: 'recorded' });
        expect(ing.audiences.public).not.toMatch(/names mentioned in the text itself may remain/);
    });

    it('inferred: rows without a recorded version resolve the version effective at collected_at', async () => {
        await registerIngest('1.1.0', '2026-01-01T00:00:00Z');
        await registerIngest('1.3.0', '2026-09-01T00:00:00Z');
        const src = await source();
        const mid = await postAt(src, 'i1', '2026-05-01T00:00:00Z');
        const late = await postAt(src, 'i2', '2026-09-20T00:00:00Z');
        const early = await postAt(src, 'i3', '2025-06-01T00:00:00Z');
        expect(await receipt(mid)).toMatchObject({ methodology_version: '1.1.0', lineage: 'inferred' });
        expect(await receipt(late)).toMatchObject({ methodology_version: '1.3.0', lineage: 'inferred' });
        expect(await receipt(early)).toMatchObject({ methodology_version: '1.1.0', lineage: 'inferred' });
    });
});

describe('writers record the ingest version', () => {
    beforeEach(async () => {
        await seedSources();
        await seedMethodology();
    });

    it('the collection runner stores the current ingest version on every new post', async () => {
        await runCollection({
            slugs: ['hacker_news'], triggeredBy: 'test', env: TEST_ENV, now: () => Date.parse(RECORDED_AT),
            transport: fixtureTransport([[/hn\.algolia\.com/, 'recorded/hn-algolia.json']]),
            queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
            collectorCtx: { sleep: () => Promise.resolve() },
        });
        const { ingestMvId } = await resolveCurrentMethodology();
        const r = await dbGet(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE ingest_mv_id = $1)::int AS ok FROM raw_posts`, [ingestMvId]);
        expect(r.n).toBeGreaterThan(0);
        expect(r.ok).toBe(r.n);
    });

    it('demo posts are stored with the current ingest version', async () => {
        jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await populate.runDemoBatch({ size: 3, embed: false, seed: 1 });
        } finally {
            process.stdout.write.mockRestore();
        }
        const { ingestMvId } = await resolveCurrentMethodology();
        const r = await dbGet(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE ingest_mv_id = $1)::int AS ok FROM raw_posts`, [ingestMvId]);
        expect(r.n).toBe(3);
        expect(r.ok).toBe(3);
    });
});
