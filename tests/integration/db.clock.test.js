// tests/integration/db.clock.test.js — the window anchor (src/db/clock.js
// dbNow) is never earlier than a row stored before it was taken, even within
// the same millisecond (JS Dates truncate PostgreSQL's microseconds).

'use strict';

const { dbGet, dbRun } = require('../../src/db/connection');
const clock = require('../../src/db/clock');

it('dbNow is at or after every row created before it (100 same-millisecond races)', async () => {
    const job = await dbRun(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('test', 'completed') RETURNING id`);
    let late = 0;
    for (let i = 0; i < 100; i++) {
        const row = await dbRun(
            `INSERT INTO bias_assessments (job_id, assessment_type, group_field, group_value, metric_name, metric_value, threshold, is_violation)
             VALUES ($1, 'negative_dominance', 'global', 'all', 'negative_share', 0.1, 0.6, false) RETURNING created_at`,
            [job.id]);
        const anchor = await clock.dbNow();
        const ok = await dbGet(`SELECT (SELECT MAX(created_at) FROM bias_assessments) <= $1::timestamptz AS ok`, [anchor]);
        if (!ok.ok) late++;
        expect(row).toBeTruthy();
    }
    expect(late).toBe(0);
});

it('dbNow is a whole millisecond, next to the database NOW()', async () => {
    const a = await clock.dbNow();
    const r = await dbGet(`SELECT EXTRACT(EPOCH FROM (NOW() - $1::timestamptz)) * 1000 AS lag_ms`, [a]);
    expect(a.getTime() % 1).toBe(0);
    expect(Math.abs(Number(r.lag_ms))).toBeLessThan(1000);
});
