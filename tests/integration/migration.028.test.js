// tests/integration/migration.028.test.js
// Migration 028 (P10-5): bias@1.3.0 plus the AUDITED resolution of stale
// location-concentration alerts, against a real PostgreSQL (test DB).
//
//   - an open alert whose job has < 30 content-located posts (the one-source
//     cron runs of before the cycle fix) is resolved: alert_events keeps the
//     row (resolved_at + details.resolution), alert_resolutions records who,
//     why and the re-evaluated evidence;
//   - publisher-located posts are excluded from the re-evaluation (D3);
//   - an alert whose job still fails bias@1.3.0's rules stays open;
//   - other alert types are never touched; nothing is deleted;
//   - re-running the migration changes nothing (idempotent).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dbAll, dbGet, dbRun, dbTransaction } = require('../../src/db/connection');
const { insertSource, insertJob, insertMethodologyVersions } = require('./helpers');

const SQL_028 = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/028_bias_min_sample.sql'), 'utf8');

async function postInJob(sourceId, jobId, mvId, { location, basis = 'content', n }) {
    const content = `post ${n} ${location} ${basis}`;
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const post = await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location, raw_payload)
         VALUES ($1, $2, $3, $4, $5, jsonb_build_object('location_basis', $6::text)) RETURNING id`,
        [sourceId, `x-${n}`, content, hash, location, basis],
    );
    await dbRun(
        `INSERT INTO decision_audit_log (raw_post_id, job_id, methodology_version_id, decision_type, model_name, input_hash, output)
         VALUES ($1, $2, $3, 'sentiment', 'afinn', $4, '{}'::jsonb)`,
        [post.id, jobId, mvId, hash],
    );
}

async function alertFor(jobId, type = 'location_concentration') {
    return (await dbRun(
        `INSERT INTO alert_events (alert_type, severity, source_table, details)
         VALUES ($1, 'critical', 'bias_assessments', jsonb_build_object('jobId', $2::text, 'share', 1)) RETURNING id`,
        [type, jobId],
    )).id;
}

describe('migration 028_bias_min_sample.sql — stale alert resolution', () => {
    let src; let mv; let n = 0;
    const add = (jobId, location, count, basis) => {
        const jobs = [];
        for (let i = 0; i < count; i++) jobs.push(postInJob(src, jobId, mv, { location, basis, n: n++ }));
        return Promise.all(jobs);
    };

    beforeEach(async () => {
        src = await insertSource('m028-src', 'news');
        mv = (await insertMethodologyVersions()).sentimentMvId;
    });

    it('resolves stale alerts with a resolution record, keeps real ones open, deletes nothing, and is idempotent', async () => {
        // One-source run: 12 London posts (insufficient sample).
        const small = await insertJob('completed');
        await add(small, 'London', 12);
        // 40 publisher-located London posts + 10 content posts: < 30 once D3 excludes them.
        const pub = await insertJob('completed');
        await add(pub, 'London', 40, 'publisher');
        await add(pub, 'Paris', 10);
        // A genuine concentration: 40 content-located posts, 36 in Tokyo.
        const real = await insertJob('completed');
        await add(real, 'Tokyo', 36);
        await add(real, 'Seoul', 4);
        // 30 content-located posts spread out: within threshold → stale.
        const spread = await insertJob('completed');
        for (const c of ['London', 'Paris', 'Berlin']) await add(spread, c, 10);

        const aSmall = await alertFor(small);
        const aPub = await alertFor(pub);
        const aReal = await alertFor(real);
        const aSpread = await alertFor(spread);
        const aOther = await alertFor(small, 'negative_dominance');
        const before = await dbGet('SELECT COUNT(*)::int AS n FROM alert_events');

        await dbTransaction(c => c.query(SQL_028));

        const rows = await dbAll('SELECT id, resolved_at, details FROM alert_events');
        const byId = Object.fromEntries(rows.map(r => [r.id, r]));
        expect(rows).toHaveLength(before.n);                 // nothing deleted
        expect(byId[aSmall].resolved_at).not.toBeNull();
        expect(byId[aPub].resolved_at).not.toBeNull();
        expect(byId[aSpread].resolved_at).not.toBeNull();
        expect(byId[aReal].resolved_at).toBeNull();           // still fails 1.3.0
        expect(byId[aOther].resolved_at).toBeNull();          // other types untouched
        expect(byId[aSmall].details.resolution_ref).toMatch(/^alert_resolutions [0-9a-f-]{36} \(migration 028, bias@1\.3\.0\)$/);
        expect(byId[aSmall].details.jobId).toBe(small);       // original details kept

        const res = await dbAll('SELECT alert_id, resolved_by, resolution, basis, methodology_version_id FROM alert_resolutions ORDER BY alert_id');
        expect(res).toHaveLength(3);
        // PR #22 principal #9: linked to bias@1.3.0 ON INSERT (no later edit).
        const v13 = await dbGet(`SELECT id FROM methodology_versions WHERE component = 'bias' AND version = '1.3.0'`);
        for (const r of res) expect(r.methodology_version_id).toBe(v13.id);
        const bySmall = res.find(r => r.alert_id === aSmall);
        expect(bySmall.resolved_by).toBe('migration 028_bias_min_sample.sql');
        expect(bySmall.basis).toMatchObject({
            job_id: small, methodology: 'bias@1.3.0', content_located_posts: 12,
            publisher_located_posts_excluded: 0, verdict: 'insufficient sample', min_sample: 30,
        });
        expect(res.find(r => r.alert_id === aPub).basis).toMatchObject({
            content_located_posts: 10, publisher_located_posts_excluded: 40, verdict: 'insufficient sample',
        });
        expect(res.find(r => r.alert_id === aSpread).basis).toMatchObject({
            content_located_posts: 30, verdict: 'within threshold once publisher-located posts are excluded',
        });

        // Idempotent: a second run adds nothing and changes nothing.
        const snapshot = await dbAll('SELECT id, resolved_at, details FROM alert_events ORDER BY id');
        await dbTransaction(c => c.query(SQL_028));
        expect(await dbAll('SELECT id, resolved_at, details FROM alert_events ORDER BY id')).toEqual(snapshot);
        expect((await dbAll('SELECT id FROM alert_resolutions'))).toHaveLength(3);
        expect(await dbGet(`SELECT COUNT(*)::int AS n FROM methodology_versions WHERE component = 'bias' AND version = '1.3.0'`)).toEqual({ n: 1 });
    });

    it('never overwrites a key of the original alert evidence (resolution_ref added only when absent)', async () => {
        const small = await insertJob('completed');
        await add(small, 'London', 3);
        const id = (await dbRun(
            `INSERT INTO alert_events (alert_type, severity, source_table, details)
             VALUES ('location_concentration', 'critical', 'bias_assessments',
                     jsonb_build_object('jobId', $1::text, 'resolution', 'original evidence', 'resolution_ref', 'x')) RETURNING id`,
            [small])).id;
        await dbTransaction(c => c.query(SQL_028));
        const row = await dbGet('SELECT resolved_at, details FROM alert_events WHERE id = $1', [id]);
        expect(row.resolved_at).not.toBeNull();
        expect(row.details).toMatchObject({ resolution: 'original evidence', resolution_ref: 'x', jobId: small });
    });
});
