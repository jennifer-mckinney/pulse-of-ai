// tests/unit/pure/collectScripts.test.js — G10-23: collect-smoke runs the
// routes production would run (a keyed route that `replaces` a free one
// wins), `--only` without a value is a clean usage error in both scripts,
// and collect.js never opens Redis only to close it.

'use strict';

const { getSource } = require('../../../src/config/source-registry');
const smoke = require('../../../scripts/collect-smoke');
const collect = require('../../../scripts/collect');
const { TEST_ENV } = require('../../helpers/fixtureTransport');

test('smoke honours `replaces`: with a Guardian key the free AI-tag feed is not smoke-run', () => {
    const g = getSource('guardian');
    expect(smoke.smokeRoutes(g, TEST_ENV).map(r => r.id)).toEqual(['ai-tag-rss']);
    expect(smoke.smokeRoutes(g, { ...TEST_ENV, GUARDIAN_API_KEY: 'k', GUARDIAN_COMMERCIAL_LICENSE_REF: 'L' })).toEqual([]);
    expect(smoke.smokeRoutes(getSource('stack_overflow'), TEST_ENV).map(r => r.id)).toEqual(['questions']);
    expect(smoke.smokeRoutes(getSource('cato'), { ...TEST_ENV, CATO_ALLOWLIST_REF: 'x' })).toEqual([]);   // blocked 4
    expect(smoke.smokeRoutes(g, { COLLECTOR_CONTACT_URL: 'https://example.org/c' })).toEqual([]);           // no D1 ack
});

test('smoke: `--only` without a value is a usage error (exit 2), not a crash', async () => {
    const out = [];
    expect(await smoke.main(['--only'], TEST_ENV, l => out.push(l))).toBe(2);
    expect(await smoke.main(['--only', '--json'], TEST_ENV, l => out.push(l))).toBe(2);
    expect(out.join('\n')).toMatch(/--only needs a comma-separated list[\s\S]*usage: npm run collect:smoke/);
});

test('smoke honours the stored rate-limit holds (security F7): a held host is reported HELD, never asked', async () => {
    const holds = { 'hn.algolia.com': { until: new Date(Date.now() + 600000).toISOString(), http_status: 429, signal: 'http_429', count: 1, weak: 0 } };
    const out = [];
    // The default transport refuses the network under NODE_ENV=test: had the
    // held host been asked, the route would report a network error instead.
    const code = await smoke.main(['--only', 'hacker_news'], TEST_ENV, l => out.push(l), { governance: async () => ({ disabled_at: null, route_kills: [] }), loadHolds: async () => holds });
    const text = out.join('\n');
    expect(text).toMatch(/rate-limit holds honoured: 1 host\(s\) on record/);
    expect(text).toMatch(/algolia-search: HELD — not requested: hn\.algolia\.com is rate-limiting us/);
    expect(text).toMatch(/0 HTTP requests/);
    expect(code).toBe(0);
});

test('smoke says so when the holds could not be checked (database unreachable)', async () => {
    const out = [];
    await smoke.main(['--only', 'youtube'], TEST_ENV, l => out.push(l), { governance: async () => ({ disabled_at: null, route_kills: [] }), loadHolds: async () => null });
    expect(out.join('\n')).toMatch(/rate-limit holds NOT checked \(database unreachable\)/);
});

test('collect: `--only` without a value is a usage error', async () => {
    expect(collect.parseArgs(['--only'])).toEqual({ error: expect.stringMatching(/--only needs/) });
    expect(collect.parseArgs(['--only', ' , '])).toEqual({ error: expect.stringMatching(/--only needs/) });
    expect(collect.parseArgs(['--only', 'npr,bbc_news'])).toEqual({ slugs: ['npr', 'bbc_news'] });
    expect(collect.parseArgs([])).toEqual({ slugs: undefined });
    await expect(collect.main(['--only'])).rejects.toBeInstanceOf(collect.UsageError);
});

test('collect: the queues are closed only when the run loaded them (no Redis opened just to close it)', async () => {
    const id = require.resolve('../../../src/queues/index');
    expect(await collect.closeQueuesIfOpened({})).toBe(false);
    const close = jest.fn().mockResolvedValue();
    expect(await collect.closeQueuesIfOpened({ [id]: { exports: { embedQueue: { close }, connection: {} } } })).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    // The entry point never requires the queue module itself.
    const src = require('fs').readFileSync(require.resolve('../../../scripts/collect'), 'utf8');
    expect(src).not.toMatch(/require\('\.\.\/src\/queues\/index'\)/);
});

test('recorder (security F7): says so when the holds could not be checked, and never asks a held host', async () => {
    const recorder = require('../../../scripts/test/record-collector-fixtures');
    const open = async () => ({ disabled_at: null, route_kills: [] });
    const lines = [];
    const written = [];
    await recorder.main({ env: TEST_ENV, governance: open, loadHolds: async () => null, write: f => written.push(f), log: l => lines.push(l) });
    expect(lines.join('\n')).toMatch(/rate-limit holds NOT checked \(database unreachable\)/);
    // Every target host held: nothing is asked (the pure suite refuses the
    // network, so an asked host would read as a network error).
    const until = new Date(Date.now() + 600000).toISOString();
    const hosts = [...new Set(recorder.TARGETS.map(t => new URL(t[2]).hostname))];
    const holds = Object.fromEntries(hosts.map(h => [h, { until, http_status: 429, signal: 'http_429', count: 1, weak: 0 }]));
    const held = [];
    await recorder.main({ env: TEST_ENV, governance: open, loadHolds: async () => holds, write: f => written.push(f), log: l => held.push(l) });
    const failed = held.filter(l => l.startsWith('FAILED'));
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every(l => /not requested/.test(l))).toBe(true);
    expect(written).toEqual([]);
});
