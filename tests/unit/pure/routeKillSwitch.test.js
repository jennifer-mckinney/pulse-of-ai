// tests/unit/pure/routeKillSwitch.test.js
// Migration 073: the per-ROUTE kill switch, pure parts — the registry's
// route gate (env COLLECTORS_DISABLED_ROUTES and the database rows passed as
// `routeKills`), buildCollectors, the CLI's argument rules and the
// supervised dry run. No database: the DB module throws on any use.
// The database switch itself is covered against Postgres in
// tests/integration/collect.routeKillSwitch.test.js.

'use strict';

jest.mock('../../../src/db/connection', () => new Proxy({}, {
    get: (_, k) => (k === '__esModule' ? false : () => { throw new Error(`pure test touched the database (${String(k)})`); }),
}));

const registry = require('../../../src/config/source-registry');
const { buildCollectors } = require('../../../src/collectors/index');
const admin = require('../../../scripts/source-admin');
const collect = require('../../../scripts/collect');
const { fixtureTransport, TEST_ENV } = require('../../helpers/fixtureTransport');

const {
    getSource, getRoute, parseDisabledRoutes, routeKillReasons, sourceStatus, openRoutes, pollIntervalSec,
    killReason, ROUTE_KILL_ENV, registryEnvVars, envClass, ENV_DOCS,
} = registry;

const HF = getSource('hugging_face');
const GITLAB = getSource('gitlab');
const HN = getSource('hacker_news');
const APPROVER = 'Tess Tester 2026-09-30';
const dbKill = (route_id, extra = {}) => ({ route_id, disabled_at: '2026-09-30T12:00:00Z', reason: 'forum terms', by: APPROVER, ...extra });
const withRoutes = (v) => ({ ...TEST_ENV, [ROUTE_KILL_ENV]: v });

describe('getRoute: an exact registry route id only', () => {
    it('matches a route id of the source and nothing else', () => {
        expect(getRoute(HF, 'forum-latest')).toBe(HF.routes.find(r => r.id === 'forum-latest'));
        for (const bad of ['Forum-Latest', 'forum-latest ', ' forum-latest', 'forum', '', null, undefined, 42, '__proto__', 'constructor']) {
            expect(getRoute(HF, bad)).toBeNull();
        }
        expect(getRoute(null, 'forum-latest')).toBeNull();
        // A route id of ANOTHER source is not a route of this one.
        expect(getRoute(HN, 'forum-latest')).toBeNull();
    });
});

describe('parseDisabledRoutes (COLLECTORS_DISABLED_ROUTES), validated against the registry', () => {
    it('is empty when unset or blank', () => {
        for (const env of [{}, { [ROUTE_KILL_ENV]: '' }, { [ROUTE_KILL_ENV]: '  ' }, undefined, null]) {
            const p = parseDisabledRoutes(env);
            expect([p.routes.size, p.held.size, p.invalid]).toEqual([0, 0, []]);
        }
    });

    it('collects slug/route entries, trimming whitespace and empty items', () => {
        const p = parseDisabledRoutes({ [ROUTE_KILL_ENV]: ' hugging_face/forum-latest ,, gitlab / forum-latest,hugging_face/blog-rss' });
        expect([...p.routes.get('hugging_face')]).toEqual(['forum-latest', 'blog-rss']);
        expect([...p.routes.get('gitlab')]).toEqual(['forum-latest']);
        expect(p.held.size).toBe(0);
        expect(p.invalid).toEqual([]);
    });

    it('HOLDS a registry source whose entry names a route it does not have (fail closed), and ignores unknown sources', () => {
        const p = parseDisabledRoutes({ [ROUTE_KILL_ENV]: 'hugging_face/forum,gitlab,nope/forum-latest,/forum-latest' });
        expect(p.held.get('hugging_face')).toEqual(['hugging_face/forum']);
        expect(p.held.get('gitlab')).toEqual(['gitlab']);            // no route given at all
        expect(p.invalid).toEqual(['nope/forum-latest', '/forum-latest']);
        expect(p.routes.size).toBe(0);
    });
});

describe('sourceStatus with a route kill switch', () => {
    it('env: the source keeps collecting through its other routes; the killed route is reported disabled with why', () => {
        const st = sourceStatus(HF, withRoutes('hugging_face/forum-latest'));
        expect(st.status).toBe('collecting');
        expect(st.openRoutes).toEqual(['daily-papers', 'blog-rss']);
        expect(st.disabledRoutes).toEqual(['forum-latest']);
        expect(st.routes).toEqual([
            { id: 'daily-papers', status: 'open', reason: 'collecting' },
            { id: 'blog-rss', status: 'open', reason: 'collecting' },
            { id: 'forum-latest', status: 'disabled', reason: 'kill switch COLLECTORS_DISABLED_ROUTES lists hugging_face/forum-latest' },
        ]);
        expect(st.reason).toMatch(/^collecting via daily-papers, blog-rss; route disabled: forum-latest \(kill switch COLLECTORS_DISABLED_ROUTES/);
        expect(openRoutes(HF, withRoutes('hugging_face/forum-latest')).map(r => r.id)).toEqual(['daily-papers', 'blog-rss']);
    });

    it('database: the same, with who and why from the source_route_state row', () => {
        const st = sourceStatus(GITLAB, TEST_ENV, { routeKills: [dbKill('forum-latest')] });
        expect(st.status).toBe('collecting');
        expect(st.openRoutes).toEqual(['topic-projects']);
        expect(st.routes.find(r => r.id === 'forum-latest')).toEqual({
            id: 'forum-latest', status: 'disabled', reason: `kill switch (database): route disabled by ${APPROVER} — forum terms`,
        });
    });

    it('ignores database rows that are cleared or name no registry route of the source', () => {
        const st = sourceStatus(HF, TEST_ENV, {
            routeKills: [dbKill('forum-latest', { disabled_at: null }), dbKill('topic-projects'), dbKill('nope'), null],
        });
        expect(st.openRoutes).toEqual(['daily-papers', 'blog-rss', 'forum-latest']);
        expect(st.disabledRoutes).toEqual([]);
        expect(st.reason).toBe('collecting via daily-papers, blog-rss, forum-latest');
    });

    it('a source with EVERY route switched off is disabled and has no open route', () => {
        const st = sourceStatus(HN, TEST_ENV, { routeKills: [dbKill('algolia-search')] });
        expect(st.status).toBe('disabled');
        expect(st.openRoutes).toEqual([]);
        expect(st.reason).toMatch(/^every route that would run is switched off by a route kill switch — algolia-search \(kill switch \(database\)/);
        const all = sourceStatus(HF, withRoutes('hugging_face/forum-latest,hugging_face/blog-rss,hugging_face/daily-papers'));
        expect([all.status, all.openRoutes, all.disabledRoutes]).toEqual(['disabled', [], ['daily-papers', 'blog-rss', 'forum-latest']]);
    });

    it('a mistyped env entry holds the whole source disabled until it is fixed', () => {
        expect(killReason(HF, withRoutes('hugging_face/forum'))).toMatch(/names hugging_face\/forum, which is not a route of hugging_face/);
        const st = sourceStatus(HF, withRoutes('hugging_face/forum'));
        expect([st.status, st.openRoutes]).toEqual(['disabled', []]);
        // Other sources are untouched by it.
        expect(sourceStatus(GITLAB, withRoutes('hugging_face/forum')).status).toBe('collecting');
    });

    it('a disabled source lists no open route, and its routes say why', () => {
        const st = sourceStatus(HF, { ...TEST_ENV, COLLECTORS_DISABLED: 'hugging_face' });
        expect([st.status, st.openRoutes]).toEqual(['disabled', []]);
        expect(st.routes.map(r => [r.id, r.status, r.reason])).toEqual([
            ['daily-papers', 'closed', 'the source is disabled'],
            ['blog-rss', 'closed', 'the source is disabled'],
            ['forum-latest', 'closed', 'the source is disabled'],
        ]);
    });

    it('killing a replacing route never reopens the route it replaced', () => {
        const nyt = getSource('nyt');
        const env = { ...TEST_ENV, NYT_API_KEY: 'k', NYT_LICENSE_REF: 'ref' };
        expect(openRoutes(nyt, env).map(r => r.id)).toEqual(['article-search']);
        const st = sourceStatus(nyt, { ...env, [ROUTE_KILL_ENV]: 'nyt/article-search' });
        expect(st.openRoutes).toEqual([]);
        expect(st.status).toBe('disabled');
        expect(st.routes.find(r => r.id === 'technology-rss')).toEqual({ id: 'technology-rss', status: 'closed', reason: 'replaced by article-search' });
    });

    it('a killed route\'s missing env vars and pending approval no longer count', () => {
        const yt = getSource('youtube');
        expect(sourceStatus(yt, TEST_ENV).missing).toContain('YOUTUBE_API_KEY');
        const st = sourceStatus(yt, TEST_ENV, { routeKills: [dbKill('data-api')] });
        expect(st.missing).not.toContain('YOUTUBE_API_KEY');
        expect(st.status).toBe('disabled');
        const pending = sourceStatus(yt, { ...TEST_ENV, YOUTUBE_API_KEY: 'k', GATE_APPROVED_BY: '' }, { routeKills: [dbKill('data-api')] });
        expect(pending.awaitingApproval).toEqual([]);
    });

    it('the poll interval stops honouring a killed route\'s quota', () => {
        const yt = getSource('youtube');
        const env = { ...TEST_ENV, YOUTUBE_API_KEY: 'k' };
        expect(pollIntervalSec(yt, env)).toBe(900);
        expect(pollIntervalSec(yt, env, { routeKills: [dbKill('data-api')] })).toBe(yt.pollIntervalSec);
    });

    it('routeKillReasons: the database reason wins over an env entry for the same route; registry order', () => {
        const reasons = routeKillReasons(HF, withRoutes('hugging_face/forum-latest,hugging_face/daily-papers'), [dbKill('forum-latest')]);
        expect([...reasons.keys()]).toEqual(['daily-papers', 'forum-latest']);
        expect(reasons.get('forum-latest')).toMatch(/^kill switch \(database\)/);
    });
});

describe('buildCollectors never builds a switched-off route', () => {
    it('env and database kills are both honoured', () => {
        const ids = (env, routeKills) => buildCollectors(HF, { env, http: {}, routeKills }).map(c => c.route.id);
        expect(ids(TEST_ENV)).toEqual(['daily-papers', 'blog-rss', 'forum-latest']);
        expect(ids(withRoutes('hugging_face/forum-latest'))).toEqual(['daily-papers', 'blog-rss']);
        expect(ids(TEST_ENV, [dbKill('blog-rss')])).toEqual(['daily-papers', 'forum-latest']);
        // routeKills is a gate input, never handed to a collector.
        for (const c of buildCollectors(HF, { env: TEST_ENV, http: {}, routeKills: [dbKill('blog-rss')] })) {
            expect(c).not.toHaveProperty('routeKills');
        }
    });
});

describe('COLLECTORS_DISABLED_ROUTES is catalogued as a kill-switch setting', () => {
    it('is in the registry env catalogue, documented, and reaches every collecting role as a setting', () => {
        expect(registryEnvVars()).toContain(ROUTE_KILL_ENV);
        expect(ENV_DOCS[ROUTE_KILL_ENV]).toEqual(expect.objectContaining({ group: 'kill-switch', signup: null }));
        expect(envClass(ROUTE_KILL_ENV)).toBe('setting');
    });
});

describe('source-admin --route argument rules (migration 073)', () => {
    it('accepts a registry route of the source on disable and enable', () => {
        expect(admin.parseArgs(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'forum terms']))
            .toEqual({ command: 'disable', slug: 'hugging_face', route: 'forum-latest', note: null, reason: 'forum terms' });
        expect(admin.parseArgs(['enable', 'gitlab', '--route', 'forum-latest', '--note', 'cleared']))
            .toEqual({ command: 'enable', slug: 'gitlab', route: 'forum-latest', note: 'cleared', reason: null });
        // Flag order does not matter.
        expect(admin.parseArgs(['disable', 'gitlab', '--reason', 'r', '--route', 'forum-latest']).route).toBe('forum-latest');
    });

    it('refuses a route that is not a registry route of THAT source', () => {
        for (const route of ['forum', 'Forum-Latest', 'topic-projects', '../forum-latest', 'forum-latest;drop']) {
            const r = admin.parseArgs(['disable', 'hugging_face', '--route', route, '--reason', 'x']);
            expect(r.error).toMatch(new RegExp(`unknown route '.*' of hugging_face \\(registry routes: daily-papers, blog-rss, forum-latest\\)`));
        }
    });

    it('refuses --route without a value, on reset, twice, or a stray argument', () => {
        expect(admin.parseArgs(['disable', 'hugging_face', '--route']).error).toBe(admin.USAGE);
        expect(admin.parseArgs(['disable', 'hugging_face', '--route', '--reason', 'x']).error).toBe(admin.USAGE);
        expect(admin.parseArgs(['reset', 'hugging_face', '--route', 'forum-latest']).error).toMatch(/source:reset applies to a whole source/);
        expect(admin.parseArgs(['disable', 'hugging_face', '--route', 'forum-latest', '--route', 'blog-rss', '--reason', 'x']).error)
            .toMatch(/--route is given more than once/);
        expect(admin.parseArgs(['disable', 'hugging_face', 'forum-latest', '--reason', 'x']).error).toMatch(/unexpected argument 'forum-latest'/);
        expect(admin.parseArgs(['enable', 'hugging_face', '--route', 'forum-latest', 'extra']).error).toMatch(/unexpected argument 'extra'/);
    });

    it('a route takedown needs a non-blank reason', () => {
        expect(admin.parseArgs(['disable', 'hugging_face', '--route', 'forum-latest']).error).toMatch(/needs --reason/);
        expect(admin.parseArgs(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', '   ']).error).toMatch(/needs --reason/);
    });

    it('main refuses without a valid named approval before touching the database', async () => {
        const lines = [];
        const io = { out: l => lines.push(l), err: l => lines.push(l), db: { dbGet: () => { throw new Error('db used'); } } };
        for (const env of [{}, { GATE_APPROVED_BY: 'tester' }, { GATE_APPROVED_BY: 'Name 2026-09-30' }]) {
            const code = await admin.main(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'x'], { ...io, env });
            expect(code).toBe(2);
        }
        expect(lines.join('\n')).not.toMatch(/db used/);
        expect(lines.every(l => /needs a named approval/.test(l))).toBe(true);
    });

    it('main refuses an unknown route before touching the database', async () => {
        const lines = [];
        const code = await admin.main(['disable', 'hugging_face', '--route', 'nope', '--reason', 'x'],
            { err: l => lines.push(l), out: l => lines.push(l), env: { GATE_APPROVED_BY: APPROVER }, db: {} });
        expect(code).toBe(2);
        expect(lines.join('\n')).toMatch(/unknown route 'nope' of hugging_face/);
    });
});

describe('supervised dry run honours the database route kill switch (no request to a disabled route)', () => {
    const HF_FIXTURES = [
        ['https://huggingface.co/api/daily_papers?limit=30', 'recorded/hf-daily-papers.json'],
        ['https://huggingface.co/blog/feed.xml', 'recorded/substack-importai.xml'],
        [/discuss\.huggingface\.co/, { status: 500, body: 'must not be asked' }],
    ];
    const gov = (route_kills) => async () => ({ disabled_at: null, access_denied_at: null, refused_until: null, route_kills });

    it('skips the disabled route and names it', async () => {
        const out = [];
        const transport = fixtureTransport(HF_FIXTURES);
        const r = await collect.supervisedRun({
            slug: 'hugging_face', env: TEST_ENV, transport, out: l => out.push(l), governance: gov([dbKill('forum-latest')]),
        });
        expect(transport.calls.some(c => /discuss\.huggingface\.co/.test(c.url))).toBe(false);
        expect(r.routes.map(x => x.route)).toEqual(['daily-papers', 'blog-rss']);
        expect(out[0]).toBe('SUPERVISED DRY RUN — Hugging Face (hugging_face); routes: daily-papers, blog-rss (disabled: forum-latest)');
    });

    it('refuses the run when every route that would run is disabled', async () => {
        const transport = fixtureTransport(HF_FIXTURES);
        await expect(collect.supervisedRun({
            slug: 'hugging_face', env: TEST_ENV, transport, out: () => {},
            governance: gov(['daily-papers', 'blog-rss', 'forum-latest'].map(id => dbKill(id))),
        })).rejects.toThrow(/hugging_face is not collecting: every route that would run is switched off/);
        expect(transport.calls).toHaveLength(0);
    });
});
