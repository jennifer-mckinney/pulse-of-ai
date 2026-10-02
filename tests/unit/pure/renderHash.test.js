// tests/unit/pure/renderHash.test.js
// Runs scripts/test/render-hash.test.sh from jest, so `npm run test:pure`
// and `npm run verify` cover the diagram PNG hash guard (docs audit R2-7):
// render.sh embeds the SHA-256 of each .mmd in its PNG, and
// `render.sh --check` fails with png-stale-mmd-hash when a PNG was not
// rendered from the current .mmd. Needs bash and python3 only; the shell
// test uses `--check --hash-only`, so no Node, mmdc or Chromium is started.

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '../../../scripts/test/render-hash.test.sh');

describe('docs/diagrams PNG hash guard', () => {
    test('the committed diagrams pass and every audit mutation fails', () => {
        const res = spawnSync('bash', [SCRIPT], { encoding: 'utf8', timeout: 60000 });
        const out = `${res.stdout || ''}${res.stderr || ''}`;
        // Surface the failing case names in the jest output.
        if (res.status !== 0) console.error(out);
        expect(res.error).toBeUndefined();
        expect(out).toMatch(/\d+ passed, 0 failed/);
        expect(res.status).toBe(0);
    }, 60000);
});
