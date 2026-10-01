// tests/e2e/e2e-env.js
// The e2e suite's isolated environment — shared by playwright.config.js
// (webServer env + baseURL) and global-setup.js (database provisioning).
'use strict';

module.exports = {
    // Own database on the dev Postgres (port 5434). E2E_DB overrides it, so a
    // gate run can use another database on a throwaway compose project. The
    // globalSetup DROPS and recreates this database on every run, so the
    // override must match the e2e naming pattern (pulse_of_ai_e2e or
    // pulse_of_ai_e2e_<suffix>); tests/e2e/e2e-db-guard.js refuses anything
    // else, including the dev database and the Jest test database.
    E2E_DB: process.env.E2E_DB || 'pulse_of_ai_e2e',
    E2E_PORT: 3100,              // own server; never the dev server on 3000
};
