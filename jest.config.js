// Jest configuration for Pulse of AI
// Test environment: Node.js (not browser)
// Test DB is a separate PostgreSQL instance (port 5433) — never the production DB
module.exports = {
    testEnvironment: 'node',

    // Match all test files under tests/
    testMatch: ['**/tests/**/*.test.js'],

    // Run once before all test suites (migrate + seed test DB)
    globalSetup: './tests/globalSetup.js',
    // Run once after all test suites (close pg pool)
    globalTeardown: './tests/globalTeardown.js',
    // Run before each test FILE (truncate all tables for a clean slate)
    setupFilesAfterEnv: ['./tests/setup.js'],

    // Coverage from src/ plus the four PURE frontend modules (unit-tested in
    // tests/unit/pure/). Browser-only frontend files (globe.js, story.js, …)
    // are deliberately excluded — they will be preview-verified when they
    // land (Batch 3+), and including them would tank the gate with
    // untestable DOM/WebGL code.
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/server.js',        // entry point — integration tested via supertest, not unit
        '!src/workers/start.js', // process entry point — no logic
        'public/js/utils.js',
        'public/js/data.js',
        'public/js/insights.js',
        'public/js/chapters.js'
    ],

    // 80% line coverage required to pass CI
    coverageThreshold: {
        global: {
            lines: 80,
            functions: 80,
            branches: 70
        }
    },

    // Verbose output — see each test name as it runs
    verbose: true,

    // Fail fast in CI: stop after first test suite failure
    bail: process.env.CI ? 1 : 0,

    // Exclude generated/export directories that have their own package.json
    // (avoids Haste module naming collision warnings)
    testPathIgnorePatterns: ['/node_modules/', '/exported-assets/'],

    // Force Jest to exit after all tests finish (closes pg pool / open handles)
    forceExit: true,

    // Integration tests hit a real DB; allow extra time for cross-suite warm-up
    // (the first test in a suite can wait briefly for pg pool connections recycled
    // by the previous suite — 15 s is sufficient headroom without masking real hangs)
    testTimeout: 15000,

    // Run test files serially — all suites share the same test DB; parallel runs cause
    // beforeEach(TRUNCATE) in one suite to wipe rows being used by another.
    maxWorkers: 1
};
