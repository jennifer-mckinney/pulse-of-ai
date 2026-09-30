// tests/integration/db.locks.test.js
// Item 14: the collector test slowdown. A transaction left open (a test that
// timed out mid-transaction) held its locks; the next file's TRUNCATE waited
// on them with no limit. Under test the pool now sets lock_timeout (5 s) and
// idle_in_transaction_session_timeout, so such a wait fails fast instead.

'use strict';

const { Client } = require('pg');
const db = require('../../src/db/connection');

it('a lock wait fails after lock_timeout instead of hanging', async () => {
    await db.dbRun(`INSERT INTO data_sources (name, display_name, source_type, category) VALUES ('lock-src', 'L', 'rss', 'news')`);
    const holder = new Client({
        host: process.env.POSTGRES_HOST || 'localhost', port: parseInt(process.env.POSTGRES_TEST_PORT, 10) || 5433,
        database: process.env.POSTGRES_TEST_DB || 'pulse_of_ai_test', user: process.env.POSTGRES_USER || 'pulse_user',
        password: process.env.POSTGRES_PASSWORD,
    });
    await holder.connect();
    try {
        await holder.query('BEGIN');
        await holder.query(`SELECT * FROM data_sources WHERE name = 'lock-src' FOR UPDATE`);
        const t0 = Date.now();
        await expect(db.dbRun(`UPDATE data_sources SET display_name = 'x' WHERE name = 'lock-src'`))
            .rejects.toThrow(/lock timeout/);
        expect(Date.now() - t0).toBeLessThan(9000);
        const settings = await db.dbGet(`SELECT current_setting('lock_timeout') AS lt, current_setting('idle_in_transaction_session_timeout') AS it`);
        expect(settings).toEqual({ lt: '5s', it: '20s' });
    } finally {
        await holder.query('ROLLBACK').catch(() => {});
        await holder.end();
    }
}, 15000);
