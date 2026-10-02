// tests/unit/pure/e2eDbGuard.test.js
// The e2e globalSetup DROPS and recreates its database on every run so a
// reused e2e database can never carry fixture rows seeded under an older
// methodology version. These tests pin the guard in front of that drop (the
// DROP rule of scripts/lib/fixture-db-guard.js — one module with the fixture
// WRITE rule since the PR #42 / PR #44 reconciliation; the write rule and the
// shared definition are pinned in fixtureDbGuard.test.js) and its wiring
// into tests/e2e/global-setup.js:
// only pulse_of_ai_e2e[_suffix] may be dropped, never the dev database, the
// Jest test database or the test Postgres port, and a refusal happens before
// any connection is opened. Pure: pg, dotenv and child_process are mocked.

'use strict';

const {
    E2E_DB_PATTERN,
    PROTECTED_DATABASES,
    assertDisposableE2eDatabase,
    parsePort,
    quoteIdentifier,
    recreateE2eDatabase,
} = require('../../../scripts/lib/fixture-db-guard');

// The environment shape of a developer .env (dev DB on 5434, Jest DB on 5433).
const DEV_ENV = Object.freeze({
    POSTGRES_DB: 'pulse_of_ai',
    POSTGRES_PORT: '5434',
    POSTGRES_TEST_DB: 'pulse_of_ai_test',
    POSTGRES_TEST_PORT: '5433',
});

/** A pg-client double that records every statement. */
function fakeClient(database = 'postgres') {
    const queries = [];
    return { database, queries, query: jest.fn(async (sql) => { queries.push(sql); return { rows: [] }; }) };
}

describe('assertDisposableE2eDatabase — accepts only e2e databases off the test port', () => {
    test.each([
        ['pulse_of_ai_e2e', 5434],
        ['pulse_of_ai_e2e', '5434'],
        ['pulse_of_ai_e2e_fresh', 5434],
        ['pulse_of_ai_e2e_gate_2', 45434],
    ])('accepts %s on port %s', (database, port) => {
        expect(assertDisposableE2eDatabase({ database, port, env: DEV_ENV })).toBe(database);
    });

    test.each([
        ['the dev database', 'pulse_of_ai'],
        ['the Jest test database', 'pulse_of_ai_test'],
        ['the postgres maintenance database', 'postgres'],
        ['template0', 'template0'],
        ['template1', 'template1'],
        ['an empty name', ''],
        ['a missing name', undefined],
        ['a non-string name', 42],
        ['upper case', 'PULSE_OF_AI_E2E'],
        ['a prefix match only', 'pulse_of_ai_e2ex'],
        ['a hyphenated suffix', 'pulse_of_ai_e2e-fresh'],
        ['a trailing underscore', 'pulse_of_ai_e2e_'],
        ['the name embedded later', 'x_pulse_of_ai_e2e'],
        ['a quoted injection', 'pulse_of_ai_e2e"; DROP DATABASE pulse_of_ai; --'],
        ['a newline injection', 'pulse_of_ai_e2e\nDROP DATABASE pulse_of_ai'],
    ])('refuses %s', (_label, database) => {
        expect(() => assertDisposableE2eDatabase({ database, port: 5434, env: DEV_ENV }))
            .toThrow(/\[fixture-db-guard\] refusing/);
    });

    test('every protected database fails the e2e name pattern too (two independent layers)', () => {
        for (const name of PROTECTED_DATABASES) expect(E2E_DB_PATTERN.test(name)).toBe(false);
    });

    test('refuses an e2e-pattern name that IS the configured dev database (POSTGRES_DB)', () => {
        const env = { ...DEV_ENV, POSTGRES_DB: 'pulse_of_ai_e2e' };
        expect(() => assertDisposableE2eDatabase({ database: 'pulse_of_ai_e2e', port: 5434, env }))
            .toThrow(/dev database \(POSTGRES_DB\)/);
    });

    test('refuses an e2e-pattern name that IS the configured test database (POSTGRES_TEST_DB)', () => {
        const env = { ...DEV_ENV, POSTGRES_TEST_DB: 'pulse_of_ai_e2e_t' };
        expect(() => assertDisposableE2eDatabase({ database: 'pulse_of_ai_e2e_t', port: 5434, env }))
            .toThrow(/test database \(POSTGRES_TEST_DB\)/);
    });

    test('refuses the default Jest test Postgres port 5433, even when POSTGRES_TEST_PORT moved', () => {
        expect(() => assertDisposableE2eDatabase({ database: 'pulse_of_ai_e2e', port: 5433, env: DEV_ENV }))
            .toThrow(/port 5433/);
        const moved = { ...DEV_ENV, POSTGRES_TEST_PORT: '45433' };
        expect(() => assertDisposableE2eDatabase({ database: 'pulse_of_ai_e2e', port: '5433', env: moved }))
            .toThrow(/port 5433/);
    });

    test('refuses the configured POSTGRES_TEST_PORT', () => {
        const env = { ...DEV_ENV, POSTGRES_TEST_PORT: '45433' };
        expect(() => assertDisposableE2eDatabase({ database: 'pulse_of_ai_e2e', port: 45433, env }))
            .toThrow(/port 45433/);
    });

    test.each([
        [undefined], [''], ['abc'], [0], [70000], [5434.5],
        // parseInt-lenient spellings: each reads as a different port elsewhere.
        ['5434oops'], [' 5434'], ['5434 '], ['0x1532'], ['5434.0'], ['+5434'], ['1e4'],
    ])('refuses an invalid port %p', (port) => {
        expect(() => assertDisposableE2eDatabase({ database: 'pulse_of_ai_e2e', port, env: DEV_ENV }))
            .toThrow(/invalid Postgres port/);
    });

    test.each([['45433oops'], ['abc'], ['0x1'], ['70000'], [' 45433']])(
        'fails closed on a malformed POSTGRES_TEST_PORT %p (PR #42 Copilot review)', (testPort) => {
            const env = { ...DEV_ENV, POSTGRES_TEST_PORT: testPort };
            // 45433 is what src/db/connection.js's parseInt would read for '45433oops'.
            expect(() => assertDisposableE2eDatabase({ database: 'pulse_of_ai_e2e', port: 45433, env }))
                .toThrow(/invalid POSTGRES_TEST_PORT/);
            expect(() => assertDisposableE2eDatabase({ database: 'pulse_of_ai_e2e', port: 5434, env }))
                .toThrow(/invalid POSTGRES_TEST_PORT/);
        });

    test('an unset or empty POSTGRES_TEST_PORT falls back to refusing only 5433', () => {
        for (const POSTGRES_TEST_PORT of [undefined, '']) {
            const env = { ...DEV_ENV, POSTGRES_TEST_PORT };
            expect(assertDisposableE2eDatabase({ database: 'pulse_of_ai_e2e', port: 5434, env })).toBe('pulse_of_ai_e2e');
            expect(() => assertDisposableE2eDatabase({ database: 'pulse_of_ai_e2e', port: 5433, env }))
                .toThrow(/port 5433/);
        }
    });

    test('refuses a name Postgres would truncate (> 63 characters)', () => {
        const long = `pulse_of_ai_e2e_${'a'.repeat(48)}`;   // 64 characters
        expect(long).toHaveLength(64);
        expect(() => assertDisposableE2eDatabase({ database: long, port: 5434, env: DEV_ENV }))
            .toThrow(/longer than 63/);
        const max = `pulse_of_ai_e2e_${'a'.repeat(47)}`;   // 63 characters
        expect(assertDisposableE2eDatabase({ database: max, port: 5434, env: DEV_ENV })).toBe(max);
    });

    test('called with no argument it refuses instead of crashing', () => {
        expect(() => assertDisposableE2eDatabase()).toThrow(/\[fixture-db-guard\] refusing/);
    });
});

describe('parsePort — strict', () => {
    test('accepts integers and pure decimal-digit strings', () => {
        expect(parsePort(5434)).toBe(5434);
        expect(parsePort('5434')).toBe(5434);
        expect(parsePort('65535')).toBe(65535);
    });
    test.each([[null], [undefined], [''], ['5434oops'], [' 5434'], ['0x1532'], ['1e4'], ['0'], [65536], [NaN], [{}]])(
        'returns null for %p', (v) => {
            expect(parsePort(v)).toBeNull();
        });
});

describe('quoteIdentifier', () => {
    test('double-quotes and escapes embedded quotes', () => {
        expect(quoteIdentifier('pulse_of_ai_e2e')).toBe('"pulse_of_ai_e2e"');
        expect(quoteIdentifier('a"b')).toBe('"a""b"');
    });
});

describe('recreateE2eDatabase — the only destructive path', () => {
    test('drops (forcing other sessions off) then creates the guarded database, in that order', async () => {
        const client = fakeClient();
        await expect(recreateE2eDatabase(client, { database: 'pulse_of_ai_e2e', port: 5434, env: DEV_ENV }))
            .resolves.toBe('pulse_of_ai_e2e');
        expect(client.queries).toEqual([
            'DROP DATABASE IF EXISTS "pulse_of_ai_e2e" WITH (FORCE)',
            'CREATE DATABASE "pulse_of_ai_e2e"',
        ]);
    });

    test.each([
        ['the dev database', { database: 'pulse_of_ai', port: 5434 }],
        ['the Jest test database', { database: 'pulse_of_ai_test', port: 5434 }],
        ['an e2e name on the test port', { database: 'pulse_of_ai_e2e', port: 5433 }],
    ])('issues NO statement for %s', async (_label, target) => {
        const client = fakeClient();
        await expect(recreateE2eDatabase(client, { ...target, env: DEV_ENV })).rejects.toThrow(/refusing/);
        expect(client.query).not.toHaveBeenCalled();
    });

    test('refuses to drop the database its own connection is using', async () => {
        const client = fakeClient('pulse_of_ai_e2e');
        await expect(recreateE2eDatabase(client, { database: 'pulse_of_ai_e2e', port: 5434, env: DEV_ENV }))
            .rejects.toThrow(/maintenance connection is using it/);
        expect(client.query).not.toHaveBeenCalled();
    });

    test('a failing DROP stops before CREATE and surfaces the error', async () => {
        const client = fakeClient();
        client.query.mockRejectedValueOnce(new Error('permission denied to drop database'));
        await expect(recreateE2eDatabase(client, { database: 'pulse_of_ai_e2e', port: 5434, env: DEV_ENV }))
            .rejects.toThrow('permission denied to drop database');
        expect(client.query).toHaveBeenCalledTimes(1);
    });
});

describe('tests/e2e/global-setup.js wiring', () => {
    const ENV_KEYS = ['E2E_DB', 'POSTGRES_DB', 'POSTGRES_PORT', 'POSTGRES_TEST_DB', 'POSTGRES_TEST_PORT'];
    let saved;

    beforeEach(() => {
        saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
        Object.assign(process.env, DEV_ENV);
        delete process.env.E2E_DB;
    });
    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
        jest.resetModules();
    });

    /**
     * Load global-setup with pg / dotenv / child_process mocked. Returns the
     * setup function plus the doubles to inspect.
     */
    function loadGlobalSetup({ guardOverrides } = {}) {
        const client = fakeClient();
        client.connect = jest.fn(async () => {});
        client.end = jest.fn(async () => {});
        const Client = jest.fn(() => client);
        const execFileSync = jest.fn(() => '');
        let setup;
        jest.isolateModules(() => {
            jest.doMock('dotenv', () => ({ config: jest.fn() }));
            jest.doMock('pg', () => ({ Client }));
            jest.doMock('child_process', () => ({ execFileSync }));
            if (guardOverrides) {
                jest.doMock('../../../scripts/lib/fixture-db-guard', () => ({
                    ...jest.requireActual('../../../scripts/lib/fixture-db-guard'),
                    ...guardOverrides,
                }));
            }
            setup = require('../../e2e/global-setup');
        });
        return { setup, Client, client, execFileSync };
    }

    test('default run: recreates pulse_of_ai_e2e from the maintenance DB, then migrates + seeds it', async () => {
        const { setup, Client, client, execFileSync } = loadGlobalSetup();
        const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await setup();
        } finally {
            write.mockRestore();
            log.mockRestore();
        }
        expect(Client).toHaveBeenCalledWith(expect.objectContaining({ database: 'postgres', port: 5434 }));
        expect(client.queries).toEqual([
            'DROP DATABASE IF EXISTS "pulse_of_ai_e2e" WITH (FORCE)',
            'CREATE DATABASE "pulse_of_ai_e2e"',
        ]);
        expect(client.end).toHaveBeenCalled();
        // Every provisioning step targets the e2e database, never the dev one.
        expect(execFileSync).toHaveBeenCalledTimes(4);
        for (const call of execFileSync.mock.calls) {
            expect(call[2].env.POSTGRES_DB).toBe('pulse_of_ai_e2e');
        }
    });

    test.each([
        ['E2E_DB=pulse_of_ai (the dev database)', { E2E_DB: 'pulse_of_ai' }],
        ['E2E_DB=pulse_of_ai_test (the Jest database)', { E2E_DB: 'pulse_of_ai_test' }],
        ['POSTGRES_PORT=5433 (the Jest test Postgres)', { POSTGRES_PORT: '5433' }],
        // PR #42 Copilot review: malformed ports are refused, never normalized
        // (parseInt would have read 'abc' as the 5432 default, '5434oops' as 5434).
        ['POSTGRES_PORT=abc (malformed)', { POSTGRES_PORT: 'abc' }],
        ['POSTGRES_PORT=5434oops (malformed)', { POSTGRES_PORT: '5434oops' }],
        ['POSTGRES_TEST_PORT=45433oops (malformed)', { POSTGRES_TEST_PORT: '45433oops' }],
    ])('%s: refuses before opening any connection or running any step', async (_label, overrides) => {
        Object.assign(process.env, overrides);
        const { setup, Client, execFileSync } = loadGlobalSetup();
        await expect(setup()).rejects.toThrow(/\[fixture-db-guard\] refusing/);
        expect(Client).not.toHaveBeenCalled();
        expect(execFileSync).not.toHaveBeenCalled();
    });

    test.each([[undefined], ['']])('POSTGRES_PORT=%p falls back to 5432, as src/db/connection.js does', async (value) => {
        if (value === undefined) delete process.env.POSTGRES_PORT; else process.env.POSTGRES_PORT = value;
        const { setup, Client, client } = loadGlobalSetup();
        const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await setup();
        } finally {
            write.mockRestore();
            log.mockRestore();
        }
        expect(Client).toHaveBeenCalledWith(expect.objectContaining({ database: 'postgres', port: 5432 }));
        expect(client.queries[0]).toBe('DROP DATABASE IF EXISTS "pulse_of_ai_e2e" WITH (FORCE)');
    });

    // PR #42 / PR #44 reconciliation: globalSetup also checks the fixture
    // WRITE rule against the exact env its steps get, before connecting — so
    // the drop can never run and the fixture steps then refuse mid-provisioning.
    test('checks the WRITE rule against the provisioning steps\' env, before any connection', async () => {
        const assertFixtureTarget = jest.fn(() => { throw new Error('write rule refused'); });
        const { setup, Client, execFileSync } = loadGlobalSetup({ guardOverrides: { assertFixtureTarget } });
        await expect(setup()).rejects.toThrow('write rule refused');
        expect(assertFixtureTarget).toHaveBeenCalledWith(
            expect.objectContaining({ POSTGRES_DB: 'pulse_of_ai_e2e', NODE_ENV: 'development', POSTGRES_PORT: '5434' }));
        expect(Client).not.toHaveBeenCalled();
        expect(execFileSync).not.toHaveBeenCalled();
    });

    test('a FIXTURE_DB_ALLOW in the caller\'s env opts nothing into the drop', async () => {
        process.env.E2E_DB = 'pulse_of_ai';
        process.env.FIXTURE_DB_ALLOW = 'pulse_of_ai';
        try {
            const { setup, Client, execFileSync } = loadGlobalSetup();
            await expect(setup()).rejects.toThrow(/\[fixture-db-guard\] refusing/);
            expect(Client).not.toHaveBeenCalled();
            expect(execFileSync).not.toHaveBeenCalled();
        } finally {
            delete process.env.FIXTURE_DB_ALLOW;
        }
    });
});
