// tests/globalTeardown.js
// Runs ONCE after all test suites complete.
// Closes the database pool so Jest can exit cleanly.

'use strict';

const { closePool } = require('../src/db/connection');

module.exports = async function globalTeardown() {
    await closePool();
};
