// tests/globalSetup.js
// Runs ONCE before all test suites.
// Migrates the test database to a clean schema and seeds initial data.
// Uses execFileSync (not execSync) to avoid shell injection — inputs are hardcoded.

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;    // absolute path to the current node binary

module.exports = async function globalSetup() {
    process.env.NODE_ENV = 'test';
    const env = { ...process.env, NODE_ENV: 'test' };

    console.log('\n[test setup] Running migrations on test DB (--fresh)...');
    execFileSync(NODE, ['scripts/migrate.js', '--fresh'], { cwd: ROOT, env, stdio: 'inherit' });

    console.log('[test setup] Seeding test DB...');
    execFileSync(NODE, ['scripts/seed.js'], { cwd: ROOT, env, stdio: 'inherit' });
};
