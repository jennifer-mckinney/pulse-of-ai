// Playwright E2E configuration — Pulse of AI globe storytelling frontend.
//
// Scope: tests/e2e/*.spec.ts — chunked verification specs (one concern per
// file, each independently runnable via `npm run test:e2e -- <spec-name>`).
//
// Isolation: the suite runs against its OWN database, `pulse_of_ai_e2e`, on
// the dev Postgres (compose project pulse-of-ai, port 5434), served by its
// OWN server on port 3100. The globalSetup (tests/e2e/global-setup.js)
// drops and recreates that database (guarded: e2e names only, never the dev
// or Jest test database — tests/e2e/e2e-db-guard.js), migrates it, runs
// `seed` + `seed:e2e` (the deterministic fixture dataset) and freshens its
// timestamps. Every run therefore starts from the same rows as a fresh CI
// database: nothing the suite asserts can be shadowed by whatever the dev
// database holds or by rows an older run seeded, and the suite never writes
// to the dev database.
//
// NOTE: deliberately NOT wired into `npm run verify` — the verify gate's
// runtime is kept stable; run E2E explicitly with `npm run test:e2e`.
const { defineConfig } = require('@playwright/test');
const { E2E_DB, E2E_PORT } = require('./tests/e2e/e2e-env');

module.exports = defineConfig({
    testDir: 'tests/e2e',

    // Provision + freshen the isolated e2e database before every run.
    globalSetup: require.resolve('./tests/e2e/global-setup.js'),
    timeout: 90000,
    expect: { timeout: 10000 },

    // Specs drive one shared server + seeded DB; serial keeps the
    // refresh-poll and health states deterministic across specs.
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [['list']],

    use: {
        baseURL: `http://localhost:${E2E_PORT}`,
        viewport: { width: 1440, height: 900 },
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },

    // A dedicated server bound to the e2e database. Env passed here wins over
    // .env (dotenv never overrides variables that are already set). Never
    // reuse an unknown server: it could be pointed at another database.
    webServer: {
        command: 'node src/server.js',
        port: E2E_PORT,
        reuseExistingServer: false,
        timeout: 30000,
        // The gate statuses the drawer shows are pinned too, so they are the
        // same on every host: a contact URL (the server never collects —
        // there is no worker) and no Reddit credential, so Reddit (#52)
        // reads "awaiting approval" (ADR 0001 ruling 8).
        env: {
            PORT: String(E2E_PORT), POSTGRES_DB: E2E_DB,
            COLLECTOR_CONTACT_URL: 'https://example.org/pulse-e2e',
            REDDIT_CLIENT_ID: '', REDDIT_CLIENT_SECRET: '', REDDIT_USER_AGENT: '', REDDIT_API_APPROVAL_REF: '',
        },
    },
});
