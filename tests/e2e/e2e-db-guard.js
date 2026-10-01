// tests/e2e/e2e-db-guard.js
// The ONLY code path that drops a database, and the guard in front of it.
//
// Why the e2e database is recreated on every run: the fixture dataset
// (scripts/test/seed-e2e.js) links every audit row, bias assessment and
// alert to the methodology version that was current WHEN IT WAS SEEDED, and
// it skips itself when the fixture already exists. On a reused e2e database
// those rows kept their old lineage (e.g. bias assessments pointing at
// bias@1.3.0, whose layer note predates the bias@1.4.0 minimum-sample rule),
// so the suite asserted against history instead of the current registry.
// Upserting the fixture in place is not an option: several governance tables
// are append-only by trigger (migration 036, 060), and one-off migration
// backfills only match a database that ran them on the same data. A database
// created from scratch is the only state that equals a fresh CI run.
//
// Because that is destructive, recreateE2eDatabase() refuses any target that
// is not unmistakably a disposable e2e database:
//   - the name must match E2E_DB_PATTERN (pulse_of_ai_e2e, optionally with
//     a _suffix such as pulse_of_ai_e2e_fresh) — which also makes it a safe
//     SQL identifier (lower-case letters, digits and underscores only);
//   - never the dev database (pulse_of_ai, or whatever POSTGRES_DB names),
//     the Jest test database (pulse_of_ai_test / POSTGRES_TEST_DB), or a
//     Postgres system database;
//   - never on the Jest test Postgres port (5433, or POSTGRES_TEST_PORT);
//   - never the database the maintenance connection itself is using.
// Pure module (no I/O of its own): unit-tested in
// tests/unit/pure/e2eDbGuard.test.js.

'use strict';

// pulse_of_ai_e2e, or pulse_of_ai_e2e_<suffix> (lower-case, digits, '_').
const E2E_DB_PATTERN = /^pulse_of_ai_e2e(?:_[a-z0-9]+)*$/;

// Postgres truncates identifiers longer than 63 bytes (NAMEDATALEN - 1); a
// truncated name could alias another database, so longer names are refused.
const MAX_IDENTIFIER_LENGTH = 63;

// Never dropped, whatever the pattern says (defense in depth).
const PROTECTED_DATABASES = Object.freeze([
    'pulse_of_ai', 'pulse_of_ai_test', 'postgres', 'template0', 'template1',
]);

// The Jest test Postgres (compose service postgres_test). Its databases are
// owned by the Jest harness, never by the e2e suite.
const DEFAULT_TEST_DB_PORT = 5433;

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
 * Throws unless `database` on `port` is a disposable e2e database.
 * @param {object} target
 * @param {string} target.database  the database to be dropped and recreated
 * @param {number|string} target.port  the Postgres port it lives on
 * @param {object} [target.env]  environment (POSTGRES_DB, POSTGRES_TEST_DB, POSTGRES_TEST_PORT)
 * @returns {string} the validated database name
 */
function assertDisposableE2eDatabase({ database, port, env = process.env } = {}) {
    if (typeof database !== 'string' || !E2E_DB_PATTERN.test(database)) {
        throw new Error(`[e2e db guard] refusing to recreate database ${JSON.stringify(database)}: `
            + `only e2e databases matching ${E2E_DB_PATTERN} may be dropped (set E2E_DB to such a name)`);
    }
    if (database.length > MAX_IDENTIFIER_LENGTH) {
        throw new Error(`[e2e db guard] refusing to recreate database "${database}": `
            + `name is longer than ${MAX_IDENTIFIER_LENGTH} characters`);
    }
    const protectedNames = new Set(PROTECTED_DATABASES);
    if (env.POSTGRES_DB) protectedNames.add(env.POSTGRES_DB);
    if (env.POSTGRES_TEST_DB) protectedNames.add(env.POSTGRES_TEST_DB);
    if (protectedNames.has(database)) {
        throw new Error(`[e2e db guard] refusing to recreate database "${database}": `
            + 'it is the dev database (POSTGRES_DB), the test database (POSTGRES_TEST_DB) or a system database');
    }
    const p = parsePort(port);
    if (p === null) {
        throw new Error(`[e2e db guard] refusing to recreate database "${database}": `
            + `invalid Postgres port ${JSON.stringify(port)}`);
    }
    const testPorts = new Set([DEFAULT_TEST_DB_PORT]);
    if (!isUnset(env.POSTGRES_TEST_PORT)) {
        // Fail closed: a malformed POSTGRES_TEST_PORT (e.g. '45433oops',
        // which src/db/connection.js's parseInt still reads as 45433) means
        // the test Postgres cannot be told apart from the target.
        const configuredTestPort = parsePort(env.POSTGRES_TEST_PORT);
        if (configuredTestPort === null) {
            throw new Error(`[e2e db guard] refusing to recreate database "${database}": `
                + `invalid POSTGRES_TEST_PORT ${JSON.stringify(env.POSTGRES_TEST_PORT)}`);
        }
        testPorts.add(configuredTestPort);
    }
    if (testPorts.has(p)) {
        throw new Error(`[e2e db guard] refusing to recreate database "${database}" on port ${p}: `
            + 'that is the Jest test Postgres (POSTGRES_TEST_PORT), not the e2e host');
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
    E2E_DB_PATTERN,
    MAX_IDENTIFIER_LENGTH,
    PROTECTED_DATABASES,
    DEFAULT_TEST_DB_PORT,
    assertDisposableE2eDatabase,
    parsePort,
    quoteIdentifier,
    recreateE2eDatabase,
};
