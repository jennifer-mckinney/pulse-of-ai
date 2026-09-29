// tests/unit/pure/stackLib.test.js
// Runs scripts/test/stack-lib.test.sh (the behaviour tests for
// scripts/lib/stack.sh, used by standup.sh / teardown.sh) from jest, so
// `npm run verify` covers the shell library. Needs only bash — no Docker,
// no database. On macOS /bin/bash is 3.2.57, which is exactly the version
// the scripts must support (G9-3: bash 3.2 semantics); CI additionally runs
// the same file under the bash:3.2 image.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '../../../scripts/test/stack-lib.test.sh');

// /bin/bash first (the macOS 3.2 system shell), then whatever `bash` is.
const shells = ['/bin/bash', 'bash'].filter((sh, i, all) => {
    if (sh.startsWith('/')) return fs.existsSync(sh);
    return all.indexOf(sh) === i;
});

describe.each(shells)('scripts/lib/stack.sh under %s', (shell) => {
    test('every stack-lib behaviour case passes', () => {
        const res = spawnSync(shell, [SCRIPT], { encoding: 'utf8', timeout: 120000 });
        const out = `${res.stdout || ''}${res.stderr || ''}`;
        // Surface the failing case names in the jest output.
        if (res.status !== 0) console.error(out);
        expect(res.error).toBeUndefined();
        expect(out).toMatch(/\d+ passed, 0 failed/);
        expect(res.status).toBe(0);
    }, 130000);
});
