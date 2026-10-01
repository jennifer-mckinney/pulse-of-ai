// tests/unit/pure/embeddingsBind.test.js
// Runs scripts/test/embeddings-bind.test.sh from jest, so `npm run verify`
// covers the embeddings service's listen address: python/start.sh binds
// 127.0.0.1 unless EMBEDDINGS_HOST opts in to another address, and the
// container keeps its explicit 0.0.0.0 CMD for the compose network. Needs
// only bash and sh — no Docker, no Python virtualenv, no database.

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '../../../scripts/test/embeddings-bind.test.sh');

describe('embeddings service bind address (python/start.sh, python/Dockerfile)', () => {
    test('every embeddings-bind case passes', () => {
        const res = spawnSync('bash', [SCRIPT], { encoding: 'utf8', timeout: 60000 });
        const out = `${res.stdout || ''}${res.stderr || ''}`;
        // Surface the failing case names in the jest output.
        if (res.status !== 0) console.error(out);
        expect(res.error).toBeUndefined();
        expect(out).toMatch(/\d+ passed, 0 failed/);
        expect(res.status).toBe(0);
    }, 70000);
});
