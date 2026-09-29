// tests/unit/pure/collectDeadline.test.js — G10-9: a collection deadline
// (AbortSignal) through the HTTP client; standup's populate step is bounded.

'use strict';

const fs = require('fs');
const path = require('path');
const { HttpClient } = require('../../../src/collectors/http');
const { classifyError } = require('../../../src/collectors/errors');
const { fixtureTransport, TEST_ENV } = require('../../helpers/fixtureTransport');

const URL1 = 'https://api.example.org/items';
const noSleep = () => Promise.resolve();

test('a passed deadline: no request starts, error kind deadline, never retried', async () => {
    const transport = fixtureTransport([[URL1, { status: 200, body: '{}' }]]);
    const ac = new AbortController();
    ac.abort();
    const http = new HttpClient({ env: TEST_ENV, transport, sleep: noSleep, signal: ac.signal });
    const err = await http.request(URL1).catch(e => e);
    expect(classifyError(err).error_kind).toBe('deadline');
    expect(transport.calls).toHaveLength(0);
});

test('the deadline aborts an in-flight request, reported as deadline (not a network retry)', async () => {
    const ac = new AbortController();
    let calls = 0;
    const transport = (url, { signal }) => { calls++; return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        setTimeout(() => ac.abort(), 5);
    }); };
    const http = new HttpClient({ env: TEST_ENV, transport, sleep: noSleep, signal: ac.signal });
    const err = await http.request(URL1).catch(e => e);
    expect(err.kind).toBe('deadline');
    expect(calls).toBe(1);
});

test('a deadline during robots.txt is not cached as an unreachable robots.txt', async () => {
    const ac = new AbortController();
    ac.abort();
    const cache = new Map();
    const http = new HttpClient({ env: TEST_ENV, transport: fixtureTransport([]), sleep: noSleep, signal: ac.signal, robotsCache: cache });
    const err = await http.request('https://feeds.example.org/rss.xml', { robots: true }).catch(e => e);
    expect(err.kind).toBe('deadline');
    expect(cache.size).toBe(0);
});

test('populate --once has a collection deadline; standup bounds the populate step', () => {
    const populate = require('../../../scripts/populate');
    expect(populate.parseArgs(['--once']).deadlineSec).toBe(populate.DEFAULT_COLLECT_DEADLINE_SEC);
    expect(populate.parseArgs(['--once', '--collect-deadline', '60']).deadlineSec).toBe(60);
    const standup = fs.readFileSync(path.join(__dirname, '../../../scripts/standup.sh'), 'utf8');
    expect(standup).toMatch(/run_with_timeout "\$POPULATE_TIMEOUT_SEC" compose_all run --rm --no-deps -T populate node scripts\/populate\.js/);
    const src = fs.readFileSync(path.join(__dirname, '../../../scripts/populate.js'), 'utf8');
    expect(src).not.toMatch(/opts\.verbose/);   // progress is logged unconditionally
});

test('G10-10: the DATA_MODE probe cannot abort standup under set -e / pipefail', () => {
    const standup = fs.readFileSync(path.join(__dirname, '../../../scripts/standup.sh'), 'utf8');
    const line = standup.split('\n').findIndex(l => l.startsWith('DATA_MODE=$('));
    expect(line).toBeGreaterThan(-1);
    expect(standup.split('\n')[line + 1]).toMatch(/\) \|\| true\b/);
});
