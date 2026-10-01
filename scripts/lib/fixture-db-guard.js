// scripts/lib/fixture-db-guard.js
// THE guard for every operation on fixture databases — one module, one
// definition of "an e2e database", two rules built on it:
//
//   1. WRITE rule — fixtureTarget() / assertFixtureTarget(): in front of every
//      script that writes FIXTURE data (scripts/test/seed-e2e.js,
//      scripts/test/freshen-seed.sh).
//   2. DROP rule — assertDisposableE2eDatabase() / recreateE2eDatabase(): in
//      front of the e2e globalSetup's DROP + CREATE (tests/e2e/global-setup.js),
//      the ONLY code path that drops a database.
//
// PR #42 / PR #44 reconciliation (2026-10-01): the two rules used to live in
// two modules (this one and tests/e2e/e2e-db-guard.js) with their own copies
// of the e2e name pattern, and only the drop rule knew about the Jest test
// Postgres port. They now share the pattern, the identifier-length cap, the
// protected-name list and the strict port parser below, and both refuse the
// Jest test Postgres.
//
// Why fixture writes are guarded (diagnosis 2026-10-01): the e2e fixture
// seed spreads its synthetic posts over the ACTIVE REAL source rows — by
// design, so the e2e suite sees "live" data. Run bare (`npm run seed:e2e`,
// then a CLAUDE.md Quick Start step) it targeted the DEV database from .env:
// 66 `dev-seed-*` posts there are counted as live data under real sources to
// this day, next to 240 `demo-<city>-<n>` posts from the removed
// scripts/seed-demo.js. Run bare, freshen-seed.sh shifted collected_at of
// EVERY post in the dev database.
//
// Why the e2e database is dropped and recreated on every run: the fixture
// dataset links every audit row, bias assessment and alert to the
// methodology version that was current WHEN IT WAS SEEDED, and it skips
// itself when the fixture already exists. On a reused e2e database those
// rows kept their old lineage (e.g. bias assessments pointing at bias@1.3.0,
// whose layer note predates the bias@1.4.0 minimum-sample rule), so the
// suite asserted against history instead of the current registry. Upserting
// the fixture in place is not an option: several governance tables are
// append-only by trigger (migration 036, 060), and one-off migration
// backfills only match a database that ran them on the same data. A
// database created from scratch is the only state that equals a fresh CI run.
//
// The shared definition — an e2e database:
//   - its name matches E2E_DB_PATTERN (pulse_of_ai_e2e, optionally with a
//     _suffix such as pulse_of_ai_e2e_fresh — which also makes it a safe SQL
//     identifier: lower-case letters, digits and underscores only) and is at
//     most 63 characters (Postgres truncates longer identifiers, so a longer
//     name could alias another database);
//   - it is never the Jest test database (pulse_of_ai_test / POSTGRES_TEST_DB)
//     or a Postgres system database;
//   - it never lives on the Jest test Postgres (port 5433, or
//     POSTGRES_TEST_PORT; a malformed POSTGRES_TEST_PORT fails closed).
//
// WRITE rule: the target (resolved exactly as src/db/connection.js resolves
// it, NODE_ENV=test included) must be an e2e database — or the ONE database
// an operator names in FIXTURE_DB_ALLOW because it is disposable (CI's
// Postgres service container). FIXTURE_DB_ALLOW can never name the Jest test
// database or a system database, and never lifts the test-port refusal.
// Everything else — the dev database, any other name — is refused before a
// connection is opened.
//
// DROP rule: stricter. FIXTURE_DB_ALLOW plays NO part: only an e2e database
// may be dropped, and additionally never the configured dev database
// (pulse_of_ai / POSTGRES_DB), never the database the maintenance
// connection itself is using.
//
// Pure module (no I/O of its own beyond the client it is handed):
// unit-tested in tests/unit/pure/fixtureDbGuard.test.js (write rule, shared
// rule, CI wiring) and tests/unit/pure/e2eDbGuard.test.js (drop rule,
// globalSetup wiring).

'use strict';

const FIXTURE_DB_ALLOW_ENV = 'FIXTURE_DB_ALLOW';

// pulse_of_ai_e2e, or pulse_of_ai_e2e_<suffix> (lower-case, digits, '_').
const E2E_DB_PATTERN = /^pulse_of_ai_e2e(?:_[a-z0-9]+)*$/;

// Postgres truncates identifiers longer than 63 bytes (NAMEDATALEN - 1); a
// truncated name could alias another database, so longer names are refused.
const MAX_IDENTIFIER_LENGTH = 63;

// Never dropped, whatever the pattern says (defense in depth). The write rule
// protects the same list minus the dev database, which FIXTURE_DB_ALLOW may
// name when it is disposable (CI).
const DEV_DATABASE = 'pulse_of_ai';
const TEST_DATABASE = 'pulse_of_ai_test';
const SYSTEM_DATABASES = Object.freeze(['postgres', 'template0', 'template1']);
const PROTECTED_DATABASES = Object.freeze([DEV_DATABASE, TEST_DATABASE, ...SYSTEM_DATABASES]);

// The Jest test Postgres (compose service postgres_test). Its databases are
// owned by the Jest harness, never by the e2e suite or the fixture scripts.
const DEFAULT_TEST_DB_PORT = 5433;

// Default dev Postgres port when POSTGRES_PORT is unset or empty, as in
// src/db/connection.js.
const DEFAULT_DB_PORT = 5432;

/**
 * Strictly parse a TCP port: an integer, or a string of decimal digits only.
 * Anything else ('5434oops', ' 5434', '0x1532', '5434.0') is invalid —
 * parseInt-style leniency elsewhere could read such a value as a different
 * port than the one checked here, so the guard never guesses (PR #42
 * Copilot review).
 * @param {unknown} value
 * @returns {number|null} the port, or null when invalid
 */
function parsePort(value) {
    let n = null;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && /^[0-9]+$/.test(value)) n = Number(value);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** True when an env setting is absent (unset or empty: callers fall back to a default). */
function isUnset(value) {
    return value === undefined || value === null || value === '';
}

/**
 * True when `name` is shaped like an e2e database: the pattern and the
 * identifier-length cap. (Protected names and ports are checked separately.)
 * @param {unknown} name
 * @returns {boolean}
 */
function isE2eDatabaseName(name) {
    return typeof name === 'string' && E2E_DB_PATTERN.test(name) && name.length <= MAX_IDENTIFIER_LENGTH;
}

/**
 * The ports of the Jest test Postgres under `env`: always 5433, plus
 * POSTGRES_TEST_PORT when set.
 * @param {object} env
 * @returns {{ ok: true, ports: Set<number> } | { ok: false, reason: string }}
 *          ok:false (fail closed) when POSTGRES_TEST_PORT is malformed —
 *          e.g. '45433oops', which src/db/connection.js's parseInt still
 *          reads as 45433, so the test Postgres cannot be told apart.
 */
function testDbPorts(env) {
    const ports = new Set([DEFAULT_TEST_DB_PORT]);
    if (!isUnset(env.POSTGRES_TEST_PORT)) {
        const configured = parsePort(env.POSTGRES_TEST_PORT);
        if (configured === null) {
            return { ok: false, reason: `invalid POSTGRES_TEST_PORT ${JSON.stringify(env.POSTGRES_TEST_PORT)}` };
        }
        ports.add(configured);
    }
    return { ok: true, ports };
}

/** The Jest test database names under `env` (default plus POSTGRES_TEST_DB). */
function testDbNames(env) {
    const names = new Set([TEST_DATABASE]);
    if (env.POSTGRES_TEST_DB) names.add(env.POSTGRES_TEST_DB);
    return names;
}

// ─── WRITE rule ──────────────────────────────────────────────────────────────

/** The database src/db/connection.js would connect to under `env`. */
function targetDatabase(env) {
    return env.NODE_ENV === 'test'
        ? (env.POSTGRES_TEST_DB || TEST_DATABASE)
        : (env.POSTGRES_DB || DEV_DATABASE);
}

/**
 * The port src/db/connection.js would connect to under `env`, RAW: the
 * default applies only when the setting is unset or empty; a malformed value
 * is returned untouched so the guard refuses it (connection.js's parseInt
 * would read '5434oops' as 5434 and 'abc' as the default).
 * @returns {string|number}
 */
function targetPortSetting(env) {
    if (env.NODE_ENV === 'test') {
        return isUnset(env.POSTGRES_TEST_PORT) ? DEFAULT_TEST_DB_PORT : env.POSTGRES_TEST_PORT;
    }
    return isUnset(env.POSTGRES_PORT) ? DEFAULT_DB_PORT : env.POSTGRES_PORT;
}

/**
 * @param {object} env
 * @returns {{ ok: boolean, database: string, reason: string }}
 */
function fixtureTarget(env = process.env) {
    const database = targetDatabase(env);
    const refuse = (why) => ({
        ok: false,
        database,
        reason: `refusing to write fixture data into database "${database}": ${why}. The e2e fixture writes `
            + 'synthetic posts under REAL source rows, so in any database that is not disposable they are counted '
            + 'as live data. Run it through the e2e suite (npm run test:e2e provisions pulse_of_ai_e2e), point '
            + `POSTGRES_DB at pulse_of_ai_e2e[_<suffix>], or — for a disposable database only — set ${FIXTURE_DB_ALLOW_ENV}=${database}.`,
    });

    // The Jest test Postgres is never a fixture target, whatever the name or
    // FIXTURE_DB_ALLOW says (NODE_ENV=test always resolves to it).
    if (env.NODE_ENV === 'test') return refuse('NODE_ENV=test targets the Jest test Postgres');
    const port = parsePort(targetPortSetting(env));
    if (port === null) return refuse(`invalid Postgres port ${JSON.stringify(env.POSTGRES_PORT)}`);
    const testPorts = testDbPorts(env);
    if (!testPorts.ok) return refuse(testPorts.reason);
    if (testPorts.ports.has(port)) return refuse(`port ${port} is the Jest test Postgres (POSTGRES_TEST_PORT)`);
    if (testDbNames(env).has(database) || SYSTEM_DATABASES.includes(database)) {
        return refuse('it is the Jest test database (POSTGRES_TEST_DB) or a system database');
    }

    if (isE2eDatabaseName(database)) {
        return { ok: true, database, reason: `"${database}" is an e2e database` };
    }
    const allowed = String(env[FIXTURE_DB_ALLOW_ENV] || '').trim();
    if (allowed && allowed === database) {
        return { ok: true, database, reason: `"${database}" is named in ${FIXTURE_DB_ALLOW_ENV} (a disposable database)` };
    }
    return refuse('it is not an e2e database');
}

/** @throws {Error} the refusal; @returns {string} the allowed database */
function assertFixtureTarget(env = process.env) {
    const v = fixtureTarget(env);
    if (!v.ok) throw new Error(v.reason);
    return v.database;
}

// ─── DROP rule ───────────────────────────────────────────────────────────────

/**
 * Throws unless `database` on `port` is a disposable e2e database.
 * FIXTURE_DB_ALLOW is deliberately NOT consulted: it opts a database into
 * fixture WRITES, never into being dropped.
 * @param {object} target
 * @param {string} target.database  the database to be dropped and recreated
 * @param {number|string} target.port  the Postgres port it lives on
 * @param {object} [target.env]  environment (POSTGRES_DB, POSTGRES_TEST_DB, POSTGRES_TEST_PORT)
 * @returns {string} the validated database name
 */
function assertDisposableE2eDatabase({ database, port, env = process.env } = {}) {
    const refuse = (why) => new Error(`[e2e db guard] refusing to recreate database ${JSON.stringify(database)}${why}`);
    if (typeof database !== 'string' || !E2E_DB_PATTERN.test(database)) {
        throw refuse(`: only e2e databases matching ${E2E_DB_PATTERN} may be dropped (set E2E_DB to such a name)`);
    }
    if (database.length > MAX_IDENTIFIER_LENGTH) {
        throw refuse(`: name is longer than ${MAX_IDENTIFIER_LENGTH} characters`);
    }
    const protectedNames = new Set([...PROTECTED_DATABASES, ...testDbNames(env)]);
    if (env.POSTGRES_DB) protectedNames.add(env.POSTGRES_DB);
    if (protectedNames.has(database)) {
        throw refuse(': it is the dev database (POSTGRES_DB), the test database (POSTGRES_TEST_DB) or a system database');
    }
    const p = parsePort(port);
    if (p === null) throw refuse(`: invalid Postgres port ${JSON.stringify(port)}`);
    const testPorts = testDbPorts(env);
    if (!testPorts.ok) throw refuse(`: ${testPorts.reason}`);
    if (testPorts.ports.has(p)) {
        throw refuse(` on port ${p}: that is the Jest test Postgres (POSTGRES_TEST_PORT), not the e2e host`);
    }
    return database;
}

/**
 * Double-quote a SQL identifier. The guard already restricts names to
 * [a-z0-9_]; quoting is a second, independent layer.
 * @param {string} name
 * @returns {string}
 */
function quoteIdentifier(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Drop and create the e2e database from scratch, after the guard accepts it.
 * WITH (FORCE) (Postgres 13+) ends any session still connected to it — a
 * stray dev server or psql pointed at the disposable database must not make
 * the run non-deterministic.
 * @param {{ query: Function, database?: string }} client  pg client connected
 *        to a maintenance database (normally 'postgres') on `port`
 * @param {object} target  as for assertDisposableE2eDatabase
 * @returns {Promise<string>} the recreated database name
 */
async function recreateE2eDatabase(client, target) {
    const database = assertDisposableE2eDatabase(target);
    if (client && client.database === database) {
        throw new Error(`[e2e db guard] refusing to drop "${database}": the maintenance connection is using it`);
    }
    const ident = quoteIdentifier(database);
    await client.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${ident}`);
    return database;
}

module.exports = {
    // shared definition
    E2E_DB_PATTERN,
    MAX_IDENTIFIER_LENGTH,
    PROTECTED_DATABASES,
    DEFAULT_TEST_DB_PORT,
    isE2eDatabaseName,
    parsePort,
    // write rule
    FIXTURE_DB_ALLOW_ENV,
    targetDatabase,
    fixtureTarget,
    assertFixtureTarget,
    // drop rule
    assertDisposableE2eDatabase,
    quoteIdentifier,
    recreateE2eDatabase,
};
