// tests/unit/pure/collectSupervised.test.js
// P10-17: `npm run collect -- --supervised --only <slug>` — a dry run of ONE
// newly keyed source through the real collectors (recorded fixtures here),
// printing a sample for operator sign-off and WRITING nothing (the DB module
// is mocked to throw on any use). Its one read — the kill switch and refusal
// state (PR #22 security M2) — is injected here as `governance`.

'use strict';

jest.mock('../../../src/db/connection', () => new Proxy({}, {
    get: (_, k) => (k === '__esModule' ? false : () => { throw new Error(`supervised run touched the database (${String(k)})`); }),
}));

const collect = require('../../../scripts/collect');
const { fixtureTransport, TEST_ENV } = require('../../helpers/fixtureTransport');

// A source with no kill switch and no refusal on record.
const OPEN = async () => ({ disabled_at: null, access_denied_at: null, refused_until: null });

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
            { transport: fixtureTransport(HN), env: TEST_ENV, governance: OPEN });
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

// PR #22 security L5: the printed sample (id, text, url) is scrubbed like
// the warnings and errors — a feed link can carry a token or api_key.
describe('supervised sample output is scrubbed (security L5)', () => {
    it('removes secret env values and credential query parameters from every sample line', async () => {
        const SECRET = 'feed-secret-token-5e6f7a8b';
        const env = { ...TEST_ENV, CNN_API_KEY: SECRET };
        const out = [];
        let isolated;
        jest.isolateModules(() => {
            jest.doMock('../../../src/collectors/index', () => ({
                buildCollectors: () => [{
                    route: { id: 'fake-route' },
                    collect: async () => ({
                        fetched: 1,
                        warnings: [],
                        payloads: [{
                            id: `item-${SECRET}`,
                            text: `body mentions ${SECRET} inline`,
                            url: `https://feed.example/item/1?api_key=zzz-leak-999&token=${SECRET}&page=2`,
                            published_at: '2026-09-29T00:00:00Z',
                        }],
                    }),
                }],
            }));
            isolated = require('../../../scripts/collect');
        });
        await isolated.supervisedRun({ slug: 'hacker_news', env, out: l => out.push(l), governance: OPEN });
        jest.dontMock('../../../src/collectors/index');
        const sample = out.slice(out.findIndex(l => l.startsWith('Sample')) + 1, out.findIndex(l => l.startsWith('Sign-off')));
        expect(sample).toHaveLength(3);
        const text = sample.join('\n');
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('zzz-leak-999');
        expect(text).toContain('[redacted]');
        expect(text).toMatch(/api_key=REDACTED/);
        expect(text).toMatch(/page=2/);
    });
});

// PR #22 security M2: the database kill switch and the refusal cooldown
// apply to a supervised run; nothing is fetched when either is closed.
describe('supervisedRun honours the database gates (security M2)', () => {
    const noRequest = async () => { throw new Error('a request was made'); };
    const run = (governance, env = TEST_ENV) => collect.supervisedRun({
        slug: 'hacker_news', env, out: () => {}, transport: noRequest, governance,
    });

    it('refuses a source disabled by the database kill switch, before any request', async () => {
        const gov = async () => ({ disabled_at: new Date(), disabled_by: 'jennifer', disabled_reason: 'terms review' });
        const err = await run(gov).catch(e => e);
        expect(err).toBeInstanceOf(collect.UsageError);
        expect(err.message).toMatch(/hacker_news is disabled by the database kill switch \(by jennifer\) — terms review/);
    });

    it('refuses a source inside its refusal cooldown', async () => {
        const gov = async () => ({
            disabled_at: null, access_denied_at: new Date(Date.now() - 60000), access_denied_status: 403,
            refused_until: new Date(Date.now() + 3600000), refusal_count: 1,
        });
        await expect(run(gov)).rejects.toThrow(/hacker_news is in its refusal cooldown: the source refused access \(HTTP 403\)/);
    });

    it('fails closed when the source has no data_sources row (state cannot be checked)', async () => {
        await expect(run(async () => null)).rejects.toThrow(/no data_sources row.*npm run seed/);
    });

    it('a failed governance read fails the run (never skipped)', async () => {
        await expect(run(async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    });

    it('a cooldown that has ended (probe) or an operator env reset lets the run proceed', () => {
        const ended = { disabled_at: null, access_denied_at: new Date(Date.now() - 7200000), refused_until: new Date(Date.now() - 60000) };
        expect(collect.assertDbGatesOpen('hacker_news', ended, TEST_ENV).state).toBe('probe');
        const cooling = { ...ended, refused_until: new Date(Date.now() + 3600000) };
        const env = { ...TEST_ENV, SOURCE_HACKER_NEWS_RESET: new Date().toISOString() };
        const { resetEnv } = require('../../../src/collectors/refusal');
        expect(resetEnv('hacker_news')).toBe('SOURCE_HACKER_NEWS_RESET');
        expect(collect.assertDbGatesOpen('hacker_news', cooling, env).state).toBe('reset');
        expect(collect.assertDbGatesOpen('hacker_news', { disabled_at: null }, TEST_ENV).state).toBe('none');
    });
});
