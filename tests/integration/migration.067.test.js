// tests/integration/migration.067.test.js
// Relevance-accuracy Stage 0, P0 (Jennifer McKinney 2026-09-30, D1 "Count
// only AI-relevant (Recommended)"): until the aggregation switch ships with
// the Stage-1 lexicon, the receipt must say what is true today. Migration 067
// registers audit_narration@1.5.0 against a REAL PostgreSQL, field for field
// as the registry defines it and idempotently, and attaches an erratum to
// every released audit_narration row (1.1.0 to 1.4.0), whose rows stay
// unedited. Wording only: every stored post still counts toward the totals,
// and `npm run replay` still reproduces a post.

'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../../src/server');
const db = require('../../src/db/connection');
const { storeRawPost } = require('../../src/pipeline/ingest');
const { saveSentiment } = require('../../src/pipeline/sentiment');
const { saveRelevance } = require('../../src/pipeline/relevance');
const { saveDQI } = require('../../src/pipeline/discourse');
const { resolveCurrentMethodology } = require('../../src/pipeline/methodology');
const { main: replayMain } = require('../../scripts/replay');
const { seedMethodology, seedErrata } = require('../../scripts/seed');
const { METHODOLOGY_VERSIONS, METHODOLOGY_ERRATA } = require('../../src/config/methodology-registry');
const { NARRATION_VERSION, RELEVANCE_PUBLIC } = require('../../src/config/audit-narration');
const { insertJob } = require('./helpers');

const { dbAll, dbGet, dbRun, dbTransaction } = db;
const read = f => fs.readFileSync(path.join(__dirname, '../../src/db/migrations', f), 'utf8');
// The released migrations that registered audit_narration@1.1.0 … 1.4.0,
// applied as they shipped.
const RELEASED = ['009_methodology_registration.sql', '011_audit_narration_demo.sql',
    '017_ingest_provenance.sql', '066_content_hash_wording.sql'].map(read);
const SQL_067 = read('067_relevance_receipt_wording.sql');
const OLD_NARRATION = ['1.1.0', '1.2.0', '1.3.0', '1.4.0'];

const row = (component, version) => dbGet(
    'SELECT * FROM methodology_versions WHERE component = $1 AND version = $2', [component, version]);
const reg = (component, version) => METHODOLOGY_VERSIONS.find(m => m.component === component && m.version === version);
const applyReleased = async () => { for (const sql of RELEASED) await dbTransaction(c => c.query(sql)); };
const insertSource = async name => (await dbRun(
    `INSERT INTO data_sources (name, display_name, source_type, category) VALUES ($1, $1, 'api', 'forums') RETURNING id`,
    [name])).id;

describe('migration 067_relevance_receipt_wording.sql', () => {
    it('registers audit_narration@1.5.0 as in the registry, after the released rows, idempotently', async () => {
        await applyReleased();
        const before = {};
        for (const v of OLD_NARRATION) before[v] = await row('audit_narration', v);
        for (const v of OLD_NARRATION) expect(before[v]).toBeTruthy();

        await dbTransaction(c => c.query(SQL_067));
        await dbTransaction(c => c.query(SQL_067));

        // Released rows are never edited.
        for (const v of OLD_NARRATION) expect(await row('audit_narration', v)).toEqual(before[v]);
        const r = reg('audit_narration', '1.5.0');
        const got = await row('audit_narration', '1.5.0');
        expect(got).toMatchObject({ model_name: r.model_name, config: r.config, justification: r.justification });
        // "latest effective_from wins" agrees with the code's CURRENT version.
        expect(new Date(got.effective_from).getTime()).toBeGreaterThan(new Date(before['1.4.0'].effective_from).getTime());
        const latest = await dbGet(
            `SELECT version FROM methodology_versions WHERE component = 'audit_narration' ORDER BY effective_from DESC LIMIT 1`);
        expect(latest.version).toBe('1.5.0');
        expect(got.config.relevance_public).toEqual(RELEVANCE_PUBLIC);
        expect(await dbAll(`SELECT id FROM methodology_versions WHERE component = 'audit_narration'`)).toHaveLength(5);
    });

    it('attaches the registry\'s erratum to every released audit_narration row, and the API serves it', async () => {
        await applyReleased();
        await dbTransaction(c => c.query(SQL_067));
        await dbTransaction(c => c.query(SQL_067));
        await seedErrata();   // the seed path inserts the same rows, never a second copy

        const rows = await dbAll(
            `SELECT mv.version, e.erratum_key, e.corrected_by, e.erratum
             FROM methodology_errata e JOIN methodology_versions mv ON mv.id = e.methodology_version_id
             WHERE e.corrected_by = 'audit_narration@1.5.0' ORDER BY mv.version`);
        const expected = METHODOLOGY_ERRATA.filter(e => e.corrected_by === 'audit_narration@1.5.0');
        expect(rows).toEqual(expected.map(e => ({
            version: e.version, erratum_key: e.erratum_key, corrected_by: e.corrected_by, erratum: e.erratum,
        })));
        expect(rows.map(r => r.version)).toEqual(OLD_NARRATION);

        const res = await request(app).get('/api/methodology');
        expect(res.status).toBe(200);
        for (const v of OLD_NARRATION) {
            const served = res.body.find(r => r.component === 'audit_narration' && r.version === v);
            expect(served.errata.filter(e => e.corrected_by === 'audit_narration@1.5.0')).toEqual([
                expect.objectContaining({ erratum: expected.find(e => e.version === v).erratum }),
            ]);
        }
        expect(res.body.find(r => r.component === 'audit_narration' && r.version === '1.5.0').errata).toEqual([]);
    });

    it('on its own inserts exactly the one new row, and no erratum when the corrected rows are absent', async () => {
        await dbTransaction(c => c.query(SQL_067));
        const rows = await dbAll('SELECT component, version FROM methodology_versions ORDER BY effective_from');
        expect(rows).toEqual([{ component: 'audit_narration', version: '1.5.0' }]);
        expect(await dbAll(`SELECT id FROM methodology_errata WHERE corrected_by = 'audit_narration@1.5.0'`)).toEqual([]);
    });
});

describe('audit_narration@1.5.0 tells the truth about today\'s totals (no behaviour change)', () => {
    beforeEach(async () => { await seedMethodology(); });

    // Stores and scores one post under the current methodology.
    async function scoredPost(name, text) {
        const mv = await resolveCurrentMethodology();
        const src = await insertSource(name);
        const jobId = await insertJob();
        const { postId } = await storeRawPost({ id: `${name}-1`, text }, src, { ingestMvId: mv.ingestMvId });
        await saveSentiment(postId, jobId, mv.sentimentMvId);
        await saveRelevance(postId, jobId, mv.relevanceMvId);
        await saveDQI(postId, jobId, mv.discourseMvId);
        return { postId, src };
    }

    it('a post that matched no AI term is still counted, and its receipt now says so', async () => {
        const { postId, src } = await scoredPost('mv067-none', 'The weather in the harbour was calm and the ferries ran on time.');
        expect(await dbGet('SELECT score::float AS score FROM relevance_results WHERE raw_post_id = $1', [postId]))
            .toEqual({ score: 0 });

        const receipt = (await request(app).get(`/api/audit/${postId}`)).body;
        expect(receipt.narration).toEqual({ component: 'audit_narration', version: NARRATION_VERSION });
        expect(NARRATION_VERSION).toBe('1.5.0');
        const relevance = receipt.decisions.find(d => d.decision_type === 'relevance');
        expect(relevance.audiences.public).toBe(RELEVANCE_PUBLIC.no_match);
        expect(relevance.audiences.public).not.toMatch(/does not count/);

        // What the sentence claims: the zero-relevance post is in the totals
        // the public API serves (here the per-source category counts).
        const ts = (await request(app).get('/api/sources/timeseries?hours=1')).body;
        const forums = ts.find(c => c.category === 'forums');
        expect(forums.series.reduce((n, b) => n + b.total, 0)).toBe(1);
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM raw_posts WHERE source_id = $1', [src])).n).toBe(1);
    });

    it('a matched post says it matched, without claiming that is why it counts', async () => {
        const { postId } = await scoredPost('mv067-ai', 'New machine learning results from the AI lab.');
        const receipt = (await request(app).get(`/api/audit/${postId}`)).body;
        const relevance = receipt.decisions.find(d => d.decision_type === 'relevance');
        expect(relevance.audiences.public).toBe(RELEVANCE_PUBLIC.matched);
    });

    it('replay of a post still passes (wording is read-time only)', async () => {
        const { postId } = await scoredPost('mv067-replay',
            '  Deep learning research shows   transformer models should improve because the evidence is strong. ');
        const out = [];
        const code = await replayMain(['--post', postId], { db, out: l => out.push(l), err: l => out.push(l) });
        expect(code).toBe(0);
        expect(out[out.length - 1]).toBe('RESULT: PASS');
    });
});
