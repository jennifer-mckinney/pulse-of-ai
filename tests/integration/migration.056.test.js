// tests/integration/migration.056.test.js
// PR #22 decision G5 / security L6 / principal #19, against the real test
// DB: migration 056 is idempotent; source_gate_events gains approved_by,
// routes and the 'refusal_reset' event; operator events must name a
// "Name YYYY-MM-DD" approver as actor (rows written before it are not
// rechecked: NOT VALID); correlation_gate_events is append-only.

'use strict';

const fs = require('fs');
const path = require('path');
const { dbGet, dbRun, dbTransaction } = require('../../src/db/connection');
const { insertSource } = require('./helpers');

const SQL_056 = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/056_named_gate_approval.sql'), 'utf8');
const APPROVER = 'Jennifer McKinney 2026-09-29';

// Migration 073 rebuilds the two CHECKs 056 re-creates from its own lists
// (adding the route events). It is re-applied right after 056 is re-run, so
// the shared test DB stays exactly as the migration runner left it for the
// files that run after this one (an afterAll would run after setup.js has
// closed the pool).
const SQL_073 = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/073_source_route_kill_switch.sql'), 'utf8');

describe('migration 056', () => {
    it('re-runs cleanly and keeps its constraint and trigger', async () => {
        await dbTransaction(c => c.query(SQL_056));
        await dbTransaction(c => c.query(SQL_056));   // idempotent
        await dbTransaction(c => c.query(SQL_073));   // restore the later migration's CHECKs
        const con = await dbGet(`SELECT convalidated FROM pg_constraint WHERE conname = 'source_gate_events_named_approval'`);
        expect(con).toEqual({ convalidated: false });   // NOT VALID: earlier rows are never rechecked
        const trg = await dbGet(`SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname = 'correlation_gate_events_append_only'`);
        expect(trg).toEqual({ n: 1 });
    });

    it('accepts a named operator event (refusal_reset included) and a scheduler event without one', async () => {
        const src = await insertSource('m056', 'news');
        for (const event of ['enabled', 'disabled', 'refusal_reset']) {
            await dbRun(`INSERT INTO source_gate_events (source_id, slug, event, actor, approved_by) VALUES ($1, 'm056', $2, $3, $3)`,
                [src, event, APPROVER]);
        }
        await dbRun(`INSERT INTO source_gate_events (source_id, slug, event, gate_status, actor, routes)
                     VALUES ($1, 'm056', 'gate_closed', 'awaiting_key', 'worker scheduler (runtime env)', '{}')`, [src]);
        expect(await dbGet(`SELECT COUNT(*)::int AS n FROM source_gate_events WHERE slug = 'm056'`)).toEqual({ n: 4 });
        await expect(dbRun(`INSERT INTO source_gate_events (source_id, slug, event, actor) VALUES ($1, 'm056', 'bogus', 't')`, [src]))
            .rejects.toThrow(/source_gate_events_event_check/);
    });

    it('rejects an operator event whose actor is not its named approval', async () => {
        const src = await insertSource('m056b', 'news');
        for (const [actor, approved] of [['operator', null], ['operator', 'operator'], ['jennifer', APPROVER], [APPROVER, '2026-09-29']]) {
            await expect(dbRun(`INSERT INTO source_gate_events (source_id, slug, event, actor, approved_by)
                                VALUES ($1, 'm056b', 'refusal_reset', $2, $3)`, [src, actor, approved]))
                .rejects.toThrow(/source_gate_events_named_approval/);
        }
    });

    it('correlation_gate_events is append-only', async () => {
        const { id } = await dbRun(`INSERT INTO correlation_gate_events (status, enabled, reason, actor)
                                    VALUES ('awaiting_dpia', FALSE, 'r', 'worker scheduler (runtime env)') RETURNING id`);
        await expect(dbRun(`UPDATE correlation_gate_events SET status = 'x' WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
        await expect(dbRun(`DELETE FROM correlation_gate_events WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    });
});
