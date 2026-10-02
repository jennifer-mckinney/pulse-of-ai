// tests/integration/migration.032.test.js
// bias@1.4.0 and the audited resolution of open bias alerts it would not
// raise (Jennifer's live dashboard: 39 active alerts from tiny cycles):
//   - small-sample location, parity and negative-dominance alerts are
//     resolved with an alert_resolutions row linked to bias@1.4.0;
//   - an alert whose job still fails the 1.4.0 rules stays open;
//   - the original alert and assessment rows are kept (history), resolved
//     alerts leave /api/health's active_alerts and the chip's count;
//   - idempotent.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { useServer } = require('../helpers/server');
const app = require('../../src/server');
const request = useServer(app);   // one listener per file (tests/helpers/server.js)
const { dbAll, dbGet, dbRun, dbTransaction } = require('../../src/db/connection');
const { seedMethodology } = require('../../scripts/seed');
const { insertSource, insertJob, insertMethodologyVersions } = require('./helpers');

const SQL_032 = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/032_bias_sample_rules.sql'), 'utf8');

let n = 0;
async function scored(sourceId, jobId, mvId, { location = '', comparative = 0, indicator = 'neutral' } = {}) {
    const content = `m032 post ${n++}`;
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const post = await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [sourceId, `m-${n}`, content, hash, location]);
    const audit = await dbRun(
        `INSERT INTO decision_audit_log (raw_post_id, job_id, methodology_version_id, decision_type, model_name, input_hash, output)
         VALUES ($1, $2, $3, 'sentiment', 'afinn', $4, '{}'::jsonb) RETURNING id`, [post.id, jobId, mvId, hash]);
    await dbRun(
        `INSERT INTO sentiment_results (raw_post_id, audit_id, score, comparative, indicator) VALUES ($1, $2, 0, $3, $4)`,
        [post.id, audit.id, comparative, indicator]);
}

const alert = async (type, jobId, severity = 'critical') => (await dbRun(
    `INSERT INTO alert_events (alert_type, severity, source_table, details)
     VALUES ($1, $2, 'bias_assessments', jsonb_build_object('jobId', $3::text)) RETURNING id`, [type, severity, jobId])).id;

describe('migration 032_bias_sample_rules.sql', () => {
    it('resolves small-sample alerts (linked to bias@1.4.0), keeps real ones open and every row in history', async () => {
        await seedMethodology();
        const mv = (await insertMethodologyVersions()).sentimentMvId;
        const dev = await insertSource('m032-dev', 'developer');
        const forums = await insertSource('m032-forums', 'forums');

        const tiny = await insertJob();                          // 1 post, New York
        await scored(dev, tiny, mv, { location: 'New York', indicator: 'negative', comparative: -0.5 });
        const smallParity = await insertJob();                   // 4 vs 3 posts
        for (let i = 0; i < 4; i++) await scored(dev, smallParity, mv, { comparative: 0.4 });
        for (let i = 0; i < 3; i++) await scored(forums, smallParity, mv, { comparative: -0.1 });
        const realParity = await insertJob();                    // 10 vs 10, gap 0.5
        for (let i = 0; i < 10; i++) await scored(dev, realParity, mv, { comparative: 0.4 });
        for (let i = 0; i < 10; i++) await scored(forums, realParity, mv, { comparative: -0.1 });

        const aLoc = await alert('location_concentration', tiny);
        const aNeg = await alert('negative_dominance', tiny, 'warning');
        const aParSmall = await alert('platform_sentiment_parity', smallParity, 'warning');
        const aParReal = await alert('platform_sentiment_parity', realParity, 'warning');
        const other = await alert('source_refused', tiny);

        const before = await request().get('/api/health');
        expect(before.body.active_alerts).toHaveLength(5);

        await dbTransaction(c => c.query(SQL_032));
        await dbTransaction(c => c.query(SQL_032));   // idempotent

        const rows = Object.fromEntries((await dbAll('SELECT id, resolved_at FROM alert_events')).map(r => [r.id, r.resolved_at]));
        expect(Object.keys(rows)).toHaveLength(5);                                    // nothing deleted
        for (const id of [aLoc, aNeg, aParSmall]) expect(rows[id]).not.toBeNull();
        for (const id of [aParReal, other]) expect(rows[id]).toBeNull();

        const v14 = await dbGet(`SELECT id FROM methodology_versions WHERE component = 'bias' AND version = '1.4.0'`);
        const res = await dbAll('SELECT alert_id, resolved_by, resolution, basis, methodology_version_id FROM alert_resolutions');
        expect(res).toHaveLength(3);
        for (const r of res) {
            expect(r).toMatchObject({ resolved_by: 'migration 032_bias_sample_rules.sql', methodology_version_id: v14.id });
            expect(r.resolution).toMatch(/^Superseded by bias@1\.4\.0: insufficient sample/);
        }
        expect(res.find(r => r.alert_id === aParSmall).basis).toMatchObject({ categories_with_min_posts: 0, min_per_category: 10 });

        // The health chip counts only unresolved alerts; history keeps all.
        const after = await request().get('/api/health');
        expect(after.body.active_alerts.map(a => a.id).sort()).toEqual([aParReal, other].sort());
    });
});
