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
