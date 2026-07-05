// Jest configuration for PURE unit tests — no database, no Docker.
// Deliberately excludes the DB wiring from jest.config.js (globalSetup /
// globalTeardown / setupFilesAfterEach) so this loop runs anywhere, instantly.
// Scope is limited to tests/unit/pure/ — suites there must not require the DB,
// Redis, or any running service. Run via: npm run test:pure
module.exports = {
    testEnvironment: 'node',

    // Only pure suites — never picks up integration or DB-backed unit tests
    testMatch: ['**/tests/unit/pure/**/*.test.js'],

    // Coverage off by default (use the main jest.config.js for the coverage gate)
    collectCoverage: false,

    verbose: true,

    // Same ignore list as the main config (avoids Haste collisions);
    // modulePathIgnorePatterns fully silences the duplicate-package.json warning
    testPathIgnorePatterns: ['/node_modules/', '/exported-assets/'],
    modulePathIgnorePatterns: ['/exported-assets/'],

    // Pure tests are fast; a short timeout catches accidental I/O immediately
    testTimeout: 5000
};
