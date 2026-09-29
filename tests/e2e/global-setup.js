// tests/e2e/global-setup.js
// Playwright globalSetup — provisions the suite's ISOLATED database
// (pulse_of_ai_e2e on the dev Postgres, see tests/e2e/e2e-env.js) before
// every run:
//   1. CREATE DATABASE pulse_of_ai_e2e if it does not exist;
//   2. npm run migrate            (all migrations, idempotent);
//   3. npm run seed               (sources + methodology registry, idempotent);
//   4. npm run seed:e2e           (deterministic fixture dataset, idempotent);
//   5. scripts/test/freshen-seed.sh — shifts the fixture's collected_at into
//      the trailing hour so the suite never decays
//      (docs/evidence/e2e-findings/2026-09-28-dev-seed-staleness.md).
// Steps 2-5 run with POSTGRES_DB=pulse_of_ai_e2e, so the dev database is
// never read or written by the suite.
//
// Failure policy: if Postgres is unreachable, warn loudly and continue — the
// demo-fallback spec is deliberately runnable without a DB, and the
// live-data specs will fail with their own honest errors. Any other failure
// aborts the run: silently running e2e against a half-provisioned database
// is exactly the decay this setup exists to prevent.

'use strict';

require('dotenv').config();
const { execFileSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');
const { E2E_DB } = require('./e2e-env');

const ROOT = path.join(__dirname, '..', '..');
const UNREACHABLE = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Connection terminated|timeout expired/i;

async function ensureDatabase() {
    // Connect to the maintenance DB to create the e2e DB when missing.
    const client = new Client({
        host:     process.env.POSTGRES_HOST || 'localhost',
        port:     parseInt(process.env.POSTGRES_PORT, 10) || 5432,
        database: 'postgres',
        user:     process.env.POSTGRES_USER || 'pulse_user',
        password: process.env.POSTGRES_PASSWORD,
        connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
        const { rowCount } = await client.query(
            'SELECT 1 FROM pg_database WHERE datname = $1', [E2E_DB]);
        if (rowCount === 0) {
            // Identifier is a fixed constant (not input) — safe to inline.
            await client.query(`CREATE DATABASE ${E2E_DB}`);
            console.log(`[e2e global-setup] created database ${E2E_DB}`);
        }
    } finally {
        await client.end();
    }
}

function run(cmd, args) {
    const out = execFileSync(cmd, args, {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, POSTGRES_DB: E2E_DB, NODE_ENV: 'development' },
    });
    process.stdout.write(out);
}

module.exports = async () => {
    try {
        await ensureDatabase();
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
