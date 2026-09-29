// tests/integration/composeConfig.test.js
// Runs scripts/test/check-compose.sh — the policy checks on the RESOLVED
// docker-compose.yml (published ports bound to an explicit host IP, …; the
// script header lists every check) — so `npm run verify` enforces the same
// policy CI does. `docker compose config` only: no daemon call, nothing is
// started. Skipped (with a visible note) where docker compose or jq is
// missing; CI's docker-images job runs the script unconditionally.

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '../../scripts/test/check-compose.sh');

const have = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0;
const available = have('docker', ['compose', 'version']) && have('jq', ['--version']);

(available ? describe : describe.skip)('docker-compose.yml policy (scripts/test/check-compose.sh)', () => {
    test('every policy check passes', () => {
        const res = spawnSync('bash', [SCRIPT], { encoding: 'utf8', timeout: 60000 });
        const out = `${res.stdout || ''}${res.stderr || ''}`;
        if (res.status !== 0) console.error(out);
        expect(out).toMatch(/check-compose: \d+ passed, 0 failed/);
        expect(res.status).toBe(0);
    }, 70000);
});

if (!available) {
    // eslint-disable-next-line no-console
    console.warn('composeConfig.test.js: docker compose or jq not found — policy check skipped');
}
