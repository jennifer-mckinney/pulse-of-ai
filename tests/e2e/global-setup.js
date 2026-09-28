// tests/e2e/global-setup.js
// Playwright globalSetup — re-freshens the dev-seed timestamps before every
// e2e run so the suite never decays out of the trailing-hour window
// (docs/evidence/e2e-findings/2026-09-28-dev-seed-staleness.md).
//
// Failure policy: if the dev DB is unreachable, warn loudly and continue —
// the demo-fallback spec is deliberately runnable without a DB, and the
// live-data specs will fail with their own honest errors. Any other failure
// (SQL error against a reachable DB) aborts the run: silently running e2e
// against stale data is exactly the decay this setup exists to prevent.

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async () => {
    const script = path.join(__dirname, '..', '..', 'scripts', 'test', 'freshen-seed.sh');
    try {
        const out = execFileSync('bash', [script], { encoding: 'utf8' });
        process.stdout.write(out);
    } catch (err) {
        const output = `${err.stdout || ''}${err.stderr || ''}`;
        // Connection-level failures (DB down) → warn and continue; the
        // demo-fallback spec needs no DB. Anything else is a real error.
        if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Connection terminated|timeout expired/i.test(output)) {
            console.warn('[e2e global-setup] Dev DB unreachable — seed NOT freshened. '
                + 'Live-data specs will fail; only the demo-fallback spec can pass.\n' + output);
            return;
        }
        throw new Error(`freshen-seed.sh failed:\n${output}`);
    }
};
