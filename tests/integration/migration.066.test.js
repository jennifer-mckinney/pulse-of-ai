// tests/integration/migration.066.test.js
// Content-hash wording (2026-09-30): migration 066 registers ingest@1.8.0 and
// audit_narration@1.4.0 against a REAL PostgreSQL — field for field as the
// registry defines them, idempotently — and attaches an erratum to every
// released ingest row (1.0.0 to 1.7.0), whose rows stay unedited. Wording
// only: posts keep the ingest version they were stored under, the stored
// content hash is the digest the scoring steps record as input_hash, and
// `npm run replay` still reproduces a post stored before 066.

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
const { NARRATION_VERSION, INGEST_HASH_NOTE } = require('../../src/config/audit-narration');
const { insertJob, insertMethodologyVersions } = require('./helpers');

const { dbAll, dbGet, dbRun, dbTransaction } = db;
// An 'api' source: normalisePost reads the payload's text field (a 'reddit'
// source would build the text from title + selftext).
const insertSource = async name => (await dbRun(
    `INSERT INTO data_sources (name, display_name, source_type, category) VALUES ($1, $1, 'api', 'forums') RETURNING id`,
    [name])).id;
const read = f => fs.readFileSync(path.join(__dirname, '../../src/db/migrations', f), 'utf8');
// The released migrations that registered ingest@1.0.0 … 1.7.0 and
// audit_narration@1.1.0 … 1.3.0, applied as they shipped.
const RELEASED = [
    '009_methodology_registration.sql', '011_audit_narration_demo.sql', '014_methodology_alignment.sql',
    '015_ingest_text_redaction.sql', '017_ingest_provenance.sql', '024_ingest_single_char_handles.sql',
    '026_ingest_reddit_handles.sql', '031_text_retention.sql', '055_ingest_retention_rulings.sql',
].map(read);
const SQL_066 = read('066_content_hash_wording.sql');
const OLD_INGEST = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0', '1.6.0', '1.7.0'];

const row = (component, version) => dbGet(
    'SELECT * FROM methodology_versions WHERE component = $1 AND version = $2', [component, version]);
const reg = (component, version) => METHODOLOGY_VERSIONS.find(m => m.component === component && m.version === version);
const applyReleased = async () => { for (const sql of RELEASED) await dbTransaction(c => c.query(sql)); };

describe('migration 066_content_hash_wording.sql', () => {
    it('registers ingest@1.8.0 and audit_narration@1.4.0 as in the registry, after the released rows, idempotently', async () => {
        await applyReleased();
        const before = {};
        for (const v of OLD_INGEST) before[v] = await row('ingest', v);
        const narr13 = await row('audit_narration', '1.3.0');

        await dbTransaction(c => c.query(SQL_066));
        await dbTransaction(c => c.query(SQL_066));

        // Released rows are never edited.
        for (const v of OLD_INGEST) expect(await row('ingest', v)).toEqual(before[v]);
        expect(await row('audit_narration', '1.3.0')).toEqual(narr13);

        for (const [component, version, prev] of [['ingest', '1.8.0', before['1.7.0']], ['audit_narration', '1.4.0', narr13]]) {
            const r = reg(component, version);
            const got = await row(component, version);
            expect(got).toMatchObject({ model_name: r.model_name, config: r.config, justification: r.justification });
            // "latest effective_from wins" agrees with the code's CURRENT version.
            expect(new Date(got.effective_from).getTime()).toBeGreaterThan(new Date(prev.effective_from).getTime());
        }
        const latest = await dbGet(
            `SELECT version FROM methodology_versions WHERE component = 'ingest' ORDER BY effective_from DESC LIMIT 1`);
        expect(latest.version).toBe('1.8.0');
        expect((await row('ingest', '1.8.0')).config.dedup_strategy).not.toMatch(/join key/);
        expect((await row('audit_narration', '1.4.0')).config.ingest_hash_note).toBe(INGEST_HASH_NOTE);
    });

    it('attaches the registry\'s erratum to every released ingest row, and the API serves it with that version', async () => {
        await applyReleased();
        await dbTransaction(c => c.query(SQL_066));
        await dbTransaction(c => c.query(SQL_066));
        await seedErrata();   // the seed path inserts the same rows, never a second copy

        const rows = await dbAll(
            `SELECT mv.version, e.erratum_key, e.corrected_by, e.erratum
             FROM methodology_errata e JOIN methodology_versions mv ON mv.id = e.methodology_version_id
             WHERE e.corrected_by = 'ingest@1.8.0' ORDER BY mv.version`);
        const expected = METHODOLOGY_ERRATA.filter(e => e.corrected_by === 'ingest@1.8.0');
        expect(rows).toEqual(expected.map(e => ({
            version: e.version, erratum_key: e.erratum_key, corrected_by: e.corrected_by, erratum: e.erratum,
        })));
        expect(rows.map(r => r.version)).toEqual(OLD_INGEST);

        const res = await request(app).get('/api/methodology');
        expect(res.status).toBe(200);
        for (const v of OLD_INGEST) {
            const served = res.body.find(r => r.component === 'ingest' && r.version === v);
            expect(served.errata).toHaveLength(1);
            expect(served.errata[0]).toMatchObject({
                corrected_by: 'ingest@1.8.0', erratum: expected.find(e => e.version === v).erratum });
        }
        expect(res.body.find(r => r.component === 'ingest' && r.version === '1.8.0').errata).toEqual([]);
    });

    it('on its own inserts exactly the two new rows, and no erratum when the corrected rows are absent', async () => {
        await dbTransaction(c => c.query(SQL_066));
        const rows = await dbAll('SELECT component, version FROM methodology_versions ORDER BY effective_from');
        expect(rows).toEqual([{ component: 'ingest', version: '1.8.0' }, { component: 'audit_narration', version: '1.4.0' }]);
        expect(await dbAll(`SELECT id FROM methodology_errata WHERE corrected_by = 'ingest@1.8.0'`)).toEqual([]);
    });
});

describe('ingest@1.8.0 is wording only (no behaviour change)', () => {
    beforeEach(async () => { await seedMethodology(); });

    it('new posts record ingest@1.8.0; a post stored under 1.7.0 keeps 1.7.0 on its receipt', async () => {
        const current = await resolveCurrentMethodology();
        expect(current.versions.ingest).toBe('1.8.0');
        const v17 = await row('ingest', '1.7.0');
        const src = await insertSource('mv066-src');
        const { postId: oldId } = await storeRawPost({ id: 'old-1', text: 'AI text stored earlier' }, src, { ingestMvId: v17.id });
        const { postId: newId } = await storeRawPost({ id: 'new-1', text: 'AI text stored now' }, src, { ingestMvId: current.ingestMvId });

        const oldReceipt = (await request(app).get(`/api/audit/${oldId}`)).body;
        const newReceipt = (await request(app).get(`/api/audit/${newId}`)).body;
        expect(oldReceipt.ingest).toMatchObject({ methodology_version: '1.7.0', lineage: 'recorded' });
        expect(newReceipt.ingest).toMatchObject({ methodology_version: '1.8.0', lineage: 'recorded' });
        // The receipt is rendered by the current templates (read-time).
        expect(newReceipt.narration).toEqual({ component: 'audit_narration', version: NARRATION_VERSION });
        expect(NARRATION_VERSION).toBe('1.5.0');
        for (const r of [oldReceipt, newReceipt]) {
            expect(r.ingest.audiences.researcher).toContain(INGEST_HASH_NOTE);
            expect(r.ingest.audiences.researcher).not.toMatch(/join key across/);
        }
    });

    it('content_hash is the digest every scoring step records as input_hash, and replay of a pre-066 post still passes', async () => {
        const v17 = await row('ingest', '1.7.0');
        const src = await insertSource('mv066-replay');
        const jobId = await insertJob();
        const mv = await insertMethodologyVersions();
        const { postId } = await storeRawPost({
            id: 'replay-1',
            text: '  Deep learning research shows   transformer models should improve because the evidence is strong. ',
        }, src, { ingestMvId: v17.id });
        await saveSentiment(postId, jobId, mv.sentimentMvId);
        await saveRelevance(postId, jobId, mv.relevanceMvId);
        await saveDQI(postId, jobId, mv.discourseMvId);

        const post = await dbGet('SELECT content_hash FROM raw_posts WHERE id = $1', [postId]);
        const hashes = await dbAll(
            'SELECT decision_type, input_hash FROM decision_audit_log WHERE raw_post_id = $1 ORDER BY decision_type', [postId]);
        expect(hashes.map(h => h.decision_type)).toEqual(['discourse', 'relevance', 'sentiment']);
        for (const h of hashes) expect(h.input_hash).toBe(post.content_hash);

        // Nothing reads content_hash: the replay verifies input_hash against
        // the stored text and reproduces every stage of the 1.7.0-era post.
        const out = [];
        const code = await replayMain(['--post', postId], { db, out: l => out.push(l), err: l => out.push(l) });
        expect(code).toBe(0);
        expect(out[out.length - 1]).toBe('RESULT: PASS');
        expect(await dbGet('SELECT ingest_mv_id FROM raw_posts WHERE id = $1', [postId])).toEqual({ ingest_mv_id: v17.id });
    });

    it('deduplication is by (source, external id) only: same text under a new id is stored, same id is not', async () => {
        const { ingestMvId } = await resolveCurrentMethodology();
        const src = await insertSource('mv066-dedup');
        const a = await storeRawPost({ id: 'd-1', text: 'Same AI text' }, src, { ingestMvId });
        const b = await storeRawPost({ id: 'd-2', text: 'Same AI text' }, src, { ingestMvId });
        const c = await storeRawPost({ id: 'd-1', text: 'Different AI text' }, src, { ingestMvId });
        expect(a.isNew).toBe(true);
        expect(b.isNew).toBe(true);
        expect(c).toEqual({ postId: a.postId, isNew: false });
        const n = await dbGet('SELECT COUNT(DISTINCT content_hash)::int AS hashes, COUNT(*)::int AS posts FROM raw_posts WHERE source_id = $1', [src]);
        expect(n).toEqual({ hashes: 1, posts: 2 });
    });
});
