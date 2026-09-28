// tests/e2e/e2e-env.js
// The e2e suite's isolated environment — shared by playwright.config.js
// (webServer env + baseURL) and global-setup.js (database provisioning).
'use strict';

module.exports = {
    E2E_DB: 'pulse_of_ai_e2e',   // own database on the dev Postgres (port 5434)
    E2E_PORT: 3100,              // own server; never the dev server on 3000
};
