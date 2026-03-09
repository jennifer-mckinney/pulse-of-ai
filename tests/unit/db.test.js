// tests/unit/db.test.js
// Validates all db/connection.js helpers against the live test database.
// Runs against postgres_test (port 5433) via NODE_ENV=test.
// These helpers underpin every other pipeline and route module.

'use strict';

const {
    dbAll, dbGet, dbRun, dbTransaction, isConnected, closePool,
} = require('../../src/db/connection');

// ─── isConnected ─────────────────────────────────────────────────────────────

describe('isConnected()', () => {
    it('returns true when database is reachable', async () => {
        const result = await isConnected();
        expect(result).toBe(true);
    });
});

// ─── dbAll ───────────────────────────────────────────────────────────────────

describe('dbAll()', () => {
    it('returns an array of rows', async () => {
        const rows = await dbAll('SELECT 1 AS n UNION SELECT 2 AS n ORDER BY n');
        expect(Array.isArray(rows)).toBe(true);
        expect(rows).toHaveLength(2);
        expect(rows[0].n).toBe(1);
        expect(rows[1].n).toBe(2);
    });

    it('returns an empty array when no rows match', async () => {
        const rows = await dbAll(
            'SELECT id FROM data_sources WHERE name = $1',
            ['__nonexistent__'],
        );
        expect(rows).toEqual([]);
    });

    it('accepts parameterised queries', async () => {
        const rows = await dbAll(
            'SELECT $1::text AS val',
            ['hello'],
        );
        expect(rows[0].val).toBe('hello');
    });
});

// ─── dbGet ───────────────────────────────────────────────────────────────────

describe('dbGet()', () => {
    it('returns the first row when matches exist', async () => {
        const row = await dbGet('SELECT 42 AS answer');
        expect(row).toBeDefined();
        expect(row.answer).toBe(42);
    });

    it('returns undefined when no rows match', async () => {
        const row = await dbGet(
            'SELECT id FROM data_sources WHERE name = $1',
            ['__nonexistent__'],
        );
        expect(row).toBeUndefined();
    });

    it('returns only the first row when multiple rows exist', async () => {
        // Insert two jobs to guarantee multiple rows (beforeEach truncates seeded data)
        await dbRun(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('a', 'running')`);
        await dbRun(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('b', 'running')`);

        const row = await dbGet(
            'SELECT triggered_by FROM processing_jobs ORDER BY triggered_by ASC',
        );
        expect(row.triggered_by).toBe('a'); // only the first of the two
    });
});

// ─── dbRun ───────────────────────────────────────────────────────────────────

describe('dbRun()', () => {
    it('inserts a row and returns it via RETURNING', async () => {
        const job = await dbRun(
            `INSERT INTO processing_jobs (triggered_by, status)
             VALUES ($1, $2) RETURNING id, triggered_by, status`,
            ['test', 'running'],
        );
        expect(job).toBeDefined();
        expect(job.triggered_by).toBe('test');
        expect(job.status).toBe('running');
        expect(typeof job.id).toBe('string');   // UUID string
    });

    it('executes UPDATE and returns updated row via RETURNING', async () => {
        // Insert first, then update
        const created = await dbRun(
            `INSERT INTO processing_jobs (triggered_by, status)
             VALUES ('test', 'running') RETURNING id`,
            [],
        );
        const updated = await dbRun(
            `UPDATE processing_jobs SET status = 'completed'
             WHERE id = $1 RETURNING id, status`,
            [created.id],
        );
        expect(updated.status).toBe('completed');
    });

    it('returns undefined for queries without RETURNING', async () => {
        // Inserts without RETURNING — dbRun should not throw
        await expect(
            dbRun(
                `INSERT INTO processing_jobs (triggered_by, status) VALUES ('noop', 'running')`,
                [],
            ),
        ).resolves.not.toThrow();
    });
});

// ─── dbTransaction ───────────────────────────────────────────────────────────

describe('dbTransaction()', () => {
    it('commits when the callback resolves', async () => {
        const result = await dbTransaction(async (client) => {
            const r = await client.query(
                `INSERT INTO processing_jobs (triggered_by, status)
                 VALUES ('txn-test', 'running') RETURNING id`,
            );
            return r.rows[0].id;
        });
        expect(typeof result).toBe('string');

        // Verify it actually persisted
        const row = await dbGet(
            'SELECT id FROM processing_jobs WHERE id = $1',
            [result],
        );
        expect(row).toBeDefined();
    });

    it('rolls back when the callback throws', async () => {
        const countBefore = (await dbGet(
            'SELECT COUNT(*)::int AS c FROM processing_jobs',
        )).c;

        await expect(
            dbTransaction(async (client) => {
                await client.query(
                    `INSERT INTO processing_jobs (triggered_by, status)
                     VALUES ('rollback-test', 'running')`,
                );
                throw new Error('intentional rollback');
            }),
        ).rejects.toThrow('intentional rollback');

        const countAfter = (await dbGet(
            'SELECT COUNT(*)::int AS c FROM processing_jobs',
        )).c;

        // Row count must not have increased — transaction was rolled back
        expect(countAfter).toBe(countBefore);
    });

    it('returns the value returned by the callback', async () => {
        const val = await dbTransaction(async () => 'hello-from-txn');
        expect(val).toBe('hello-from-txn');
    });
});
