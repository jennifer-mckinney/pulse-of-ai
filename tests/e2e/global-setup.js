// tests/e2e/global-setup.js
// Playwright globalSetup — provisions the suite's ISOLATED database
// (pulse_of_ai_e2e on the dev Postgres, see tests/e2e/e2e-env.js) before
// every run:
//   1. DROP + CREATE the e2e database (scripts/lib/fixture-db-guard.js, the
//      drop rule): every run starts from an empty database, so no row seeded
//      under an older methodology version (or left behind by an earlier run)
//      survives. The guard refuses anything that is not an e2e database:
//      never the dev database (pulse_of_ai / POSTGRES_DB), never the Jest
//      test Postgres (port 5433 / POSTGRES_TEST_PORT);
//   2. npm run migrate            (all migrations);
//   3. npm run seed               (sources + methodology registry);
//   4. npm run seed:e2e           (deterministic fixture dataset);
//   5. scripts/test/freshen-seed.sh — shifts the fixture's collected_at into
//      the trailing hour so the suite never decays
//      (docs/evidence/e2e-findings/2026-09-28-dev-seed-staleness.md).
// Steps 2-5 run with POSTGRES_DB=<the e2e database>, so the dev database is
// never read or written by the suite. Steps 4-5 are the fixture scripts,
// which apply the same module's write rule themselves; this setup checks
// that rule against the exact environment it hands them, up front, so the
// two rules can never disagree mid-run (one guard module since the PR #42 /
// PR #44 reconciliation).
//
// Failure policy: a guard refusal (drop or write rule) always aborts the run
// (both are checked before any connection is opened). If Postgres is unreachable, warn loudly
// and continue — the demo-fallback spec is deliberately runnable without a
// DB, and the live-data specs will fail with their own honest errors. Any
// other failure aborts the run: silently running e2e against a
// half-provisioned database is exactly the decay this setup exists to
// prevent.

'use strict';

require('dotenv').config();
const { execFileSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');
const { E2E_DB } = require('./e2e-env');
const {
    assertDisposableE2eDatabase, assertFixtureTarget, parsePort, recreateE2eDatabase, targetPortSetting,
} = require('../../scripts/lib/fixture-db-guard');

const ROOT = path.join(__dirname, '..', '..');
const UNREACHABLE = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Connection terminated|timeout expired/i;

async function recreateDatabase(port) {
    // Connect to the maintenance DB: a database cannot drop itself.
    const client = new Client({
        host:     process.env.POSTGRES_HOST || 'localhost',
        port,
        database: 'postgres',
        user:     process.env.POSTGRES_USER || 'pulse_user',
        password: process.env.POSTGRES_PASSWORD,
        connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
        await recreateE2eDatabase(client, { database: E2E_DB, port, env: process.env });
        console.log(`[e2e global-setup] recreated database ${E2E_DB} from scratch`);
    } finally {
        await client.end();
    }
}

/** The environment every provisioning step (migrate, seed, fixture) runs with. */
function stepEnv() {
    return { ...process.env, POSTGRES_DB: E2E_DB, NODE_ENV: 'development' };
}

function run(cmd, args) {
    const out = execFileSync(cmd, args, {
        cwd: ROOT,
        encoding: 'utf8',
        env: stepEnv(),
    });
    process.stdout.write(out);
}

module.exports = async () => {
    // Refuse a non-e2e target BEFORE connecting, so the "Postgres
    // unreachable" leniency below can never mask a refusal.
    const portSetting = targetPortSetting(process.env);
    assertDisposableE2eDatabase({ database: E2E_DB, port: portSetting, env: process.env });
    // The write rule the fixture steps will apply, against their own env.
    assertFixtureTarget(stepEnv());
    try {
        // The guard accepted the setting, so it parses strictly to a port.
        await recreateDatabase(parsePort(portSetting));
    } catch (err) {
        if (UNREACHABLE.test(err.message)) {
            console.warn('[e2e global-setup] Postgres unreachable — e2e database NOT provisioned. '
                + 'Live-data specs will fail; only the demo-fallback spec can pass.\n' + err.message);
            return;
        }
        throw err;
    }
    try {
        run('node', ['scripts/migrate.js']);
        run('node', ['scripts/seed.js']);
        run('node', ['scripts/test/seed-e2e.js']);
        run('bash', ['scripts/test/freshen-seed.sh']);
    } catch (err) {
        throw new Error(`e2e database provisioning failed:\n${err.stdout || ''}${err.stderr || err.message}`);
    }
};
