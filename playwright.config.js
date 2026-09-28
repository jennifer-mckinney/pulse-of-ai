// Playwright E2E configuration — Pulse of AI globe storytelling frontend.
//
// Scope: tests/e2e/*.spec.ts — chunked verification specs (one concern per
// file, each independently runnable via `npm run test:e2e -- <spec-name>`).
//
// The webServer block boots `npm run dev` (Express on port 3000) when no
// server is already listening, and reuses a running one otherwise — so the
// suite works both against a dev server you started yourself and cold.
// The dev DB (docker compose, port 5434) must be migrated + seeded for the
// live-data specs; the demo-fallback spec blocks /api/** and needs no DB.
//
// NOTE: deliberately NOT wired into `npm run verify` — the verify gate's
// runtime is kept stable; run E2E explicitly with `npm run test:e2e`.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: 'tests/e2e',
    timeout: 90000,
    expect: { timeout: 10000 },

    // Specs drive one shared dev server + seeded DB; serial keeps the
    // refresh-poll and health states deterministic across specs.
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [['list']],

    use: {
        baseURL: 'http://localhost:3000',
        viewport: { width: 1440, height: 900 },
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },

    webServer: {
        command: 'npm run dev',
        port: 3000,
        reuseExistingServer: true,
        timeout: 30000,
    },
});
