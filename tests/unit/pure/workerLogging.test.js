// tests/unit/pure/workerLogging.test.js — F10-1 follow-up: every worker log
// line goes through the secret scrubber.

'use strict';

const fs = require('fs');
const path = require('path');
const { log, logError } = require('../../../src/workers/logging');

test('log and logError scrub secret env values', () => {
    const env = { GUARDIAN_API_KEY: 'guardian-secret-9f8e7d', REDIS_PASSWORD: 'redis-pass-1a2b3c4d' };
    const out = [];
    log('fetch https://x.example/?api-key=guardian-secret-9f8e7d failed', env, l => out.push(l));
    logError('[heartbeat] NOAUTH redis-pass-1a2b3c4d rejected', env, l => out.push(l));
    expect(out.join('\n')).not.toMatch(/guardian-secret-9f8e7d|redis-pass-1a2b3c4d/);
    expect(out).toHaveLength(2);
});

test('src/workers/start.js prints nothing except through the scrubbing logger', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/workers/start.js'), 'utf8');
    expect(src).not.toMatch(/console\.(log|error|warn|info)\(/);
    expect(src).toMatch(/require\('\.\/logging'\)/);
});

test('the refresh route scrubs its error logs', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/routes/refresh.js'), 'utf8');
    for (const line of src.split('\n').filter(l => /console\.error\(/.test(l))) expect(line).toMatch(/console\.error\(scrub\(/);
});
