// scripts/lib/fixture-db-guard.js
// The guard in front of every script that writes FIXTURE data
// (scripts/test/seed-e2e.js, scripts/test/freshen-seed.sh).
//
// Why (diagnosis 2026-10-01): the e2e fixture seed spreads its synthetic
// posts over the ACTIVE REAL source rows — by design, so the e2e suite sees
// "live" data. Run bare (`npm run seed:e2e`, then a CLAUDE.md Quick Start
// step) it targeted the DEV database from .env: 66 `dev-seed-*` posts there
// are counted as live data under real sources to this day, next to 240
// `demo-<city>-<n>` posts from the removed scripts/seed-demo.js. Run bare,
// freshen-seed.sh shifted collected_at of EVERY post in the dev database.
//
// The rule: a fixture script writes only to an e2e database
// (pulse_of_ai_e2e, or pulse_of_ai_e2e_<suffix> — the names the Playwright
// globalSetup uses, tests/e2e/e2e-env.js), or to the ONE database an
// operator names in FIXTURE_DB_ALLOW because it is disposable (CI's
// Postgres service container). Everything else — the dev database, the Jest
// test database, any other name — is refused before a connection is opened.
//
// The database is resolved exactly as src/db/connection.js resolves it.
// Pure module (no I/O): unit-tested in tests/unit/pure/fixtureDbGuard.test.js.

'use strict';

const FIXTURE_DB_ALLOW_ENV = 'FIXTURE_DB_ALLOW';

// pulse_of_ai_e2e, or pulse_of_ai_e2e_<suffix> (lower-case, digits, '_').
const E2E_DB_PATTERN = /^pulse_of_ai_e2e(?:_[a-z0-9]+)*$/;

/** The database src/db/connection.js would connect to under `env`. */
function targetDatabase(env) {
    return env.NODE_ENV === 'test'
        ? (env.POSTGRES_TEST_DB || 'pulse_of_ai_test')
        : (env.POSTGRES_DB || 'pulse_of_ai');
}

/**
 * @param {object} env
 * @returns {{ ok: boolean, database: string, reason: string }}
 */
function fixtureTarget(env = process.env) {
    const database = targetDatabase(env);
    if (E2E_DB_PATTERN.test(database)) {
        return { ok: true, database, reason: `"${database}" is an e2e database` };
    }
    const allowed = String(env[FIXTURE_DB_ALLOW_ENV] || '').trim();
    if (allowed && allowed === database) {
        return { ok: true, database, reason: `"${database}" is named in ${FIXTURE_DB_ALLOW_ENV} (a disposable database)` };
    }
    return {
        ok: false,
        database,
        reason: `refusing to write fixture data into database "${database}": the e2e fixture writes synthetic posts `
            + 'under REAL source rows, so in any database that is not disposable they are counted as live data. '
            + 'Run it through the e2e suite (npm run test:e2e provisions pulse_of_ai_e2e), point POSTGRES_DB at '
            + `pulse_of_ai_e2e[_<suffix>], or — for a disposable database only — set ${FIXTURE_DB_ALLOW_ENV}=${database}.`,
    };
}

/** @throws {Error} the refusal; @returns {string} the allowed database */
function assertFixtureTarget(env = process.env) {
    const v = fixtureTarget(env);
    if (!v.ok) throw new Error(v.reason);
    return v.database;
}

module.exports = { fixtureTarget, assertFixtureTarget, targetDatabase, FIXTURE_DB_ALLOW_ENV, E2E_DB_PATTERN };
