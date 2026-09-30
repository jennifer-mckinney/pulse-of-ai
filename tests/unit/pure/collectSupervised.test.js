// tests/unit/pure/collectSupervised.test.js
// P10-17: `npm run collect -- --supervised --only <slug>` — a dry run of ONE
// newly keyed source through the real collectors (recorded fixtures here),
// printing a sample for operator sign-off and touching no database at all
// (the DB module is mocked to throw on any use).

'use strict';

jest.mock('../../../src/db/connection', () => new Proxy({}, {
    get: (_, k) => (k === '__esModule' ? false : () => { throw new Error(`supervised run touched the database (${String(k)})`); }),
}));

const collect = require('../../../scripts/collect');
const { fixtureTransport, TEST_ENV } = require('../../helpers/fixtureTransport');

const HN = [['https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=50', 'recorded/hn-algolia.json']];

describe('--supervised argument rules', () => {
    it('needs --only with exactly one slug', () => {
        expect(collect.parseArgs(['--supervised', '--only', 'hacker_news'])).toEqual({ slugs: ['hacker_news'], supervised: true });
        expect(collect.parseArgs(['--supervised']).error).toMatch(/--supervised needs --only/);
        expect(collect.parseArgs(['--supervised', '--only', 'npr,bbc_news']).error).toMatch(/exactly one source/);
    });
});

describe('supervisedRun', () => {
    it('fetches, prints a redacted sample and stores nothing', async () => {
        const out = [];
        const r = await collect.main(['--supervised', '--only', 'hacker_news'], l => out.push(l),
            { transport: fixtureTransport(HN), env: TEST_ENV });
        const text = out.join('\n');
        expect(text).toMatch(/^SUPERVISED DRY RUN — Hacker News/);
        expect(text).toContain('Nothing is stored');
        expect(text).toMatch(/algolia-search: fetched \d+, kept \d+/);
        expect(text).toMatch(/Sign-off:/);
        expect(r.routes[0]).toMatchObject({ route: 'algolia-search' });
        expect(r.sample.length).toBeGreaterThan(0);
        expect(r.sample.length).toBeLessThanOrEqual(collect.SAMPLE_SIZE);
        for (const p of r.sample) expect(p).not.toHaveProperty('author');
    });

    it('refuses a source that is not collecting under this env (gate, kill switch)', async () => {
        await expect(collect.supervisedRun({ slug: 'youtube', env: TEST_ENV, out: () => {} }))
            .rejects.toThrow(/youtube is not collecting under this environment/);
        await expect(collect.supervisedRun({ slug: 'nope', env: TEST_ENV, out: () => {} })).rejects.toThrow(/unknown source/);
    });
});
