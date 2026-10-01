// tests/unit/pure/routeKillSwitch.test.js
// Migration 073: the per-ROUTE kill switch, pure parts — the registry's
// route gate (env COLLECTORS_DISABLED_ROUTES and the database rows passed as
// `routeKills`), buildCollectors, the CLI's argument rules, the supervised
// dry run, collect:smoke and the fixture recorder (both read the database
// state through an injected `governance`). No database: the DB module throws
// on any use.
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
const smoke = require('../../../scripts/collect-smoke');
const recorder = require('../../../scripts/test/record-collector-fixtures');
const { HttpClient } = require('../../../src/collectors/http');
const { fixtureTransport, TEST_ENV } = require('../../helpers/fixtureTransport');

const {
    SOURCES, getSource, getRoute, parseDisabledRoutes, routeKillReasons, staleRouteKills, sourceStatus, openRoutes, pollIntervalSec,
    killReason, ROUTE_KILL_ENV, ROUTE_ID_PATTERN, registryEnvVars, envClass, ENV_DOCS,
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

    it('resolves case, hyphen / underscore and invisible-character variants to the source and route they spell', () => {
        const p = parseDisabledRoutes({ [ROUTE_KILL_ENV]: 'Hugging-Face/Forum_Latest,\u200bGITLAB/forum-latest\uFEFF' });
        expect([...p.routes.get('hugging_face')]).toEqual(['forum-latest']);
        expect([...p.routes.get('gitlab')]).toEqual(['forum-latest']);
        expect([p.held.size, p.invalid]).toEqual([0, []]);
    });

    it('sorts the rest into held (a registry source, unknown route) and invalid (no registry source)', () => {
        const p = parseDisabledRoutes({ [ROUTE_KILL_ENV]: 'hugging_face/forum,gitlab,nope/forum-latest,/forum-latest,huggingface/forum-latest' });
        expect(p.held.get('hugging_face')).toEqual(['hugging_face/forum']);
        expect(p.held.get('gitlab')).toEqual(['gitlab']);            // no route given at all
        expect(p.invalid).toEqual(['nope/forum-latest', '/forum-latest', 'huggingface/forum-latest']);
        expect(p.routes.size).toBe(0);
    });

    // Security review F2: a slug typo in a takedown must not fail open.
    it('an entry naming no registry source holds EVERY source disabled until it is fixed', () => {
        const env = withRoutes('huggingface/forum-latest');
        for (const src of [HF, GITLAB, HN]) {
            const st = sourceStatus(src, env);
            expect([st.status, st.openRoutes]).toEqual(['disabled', []]);
            expect(st.reason).toBe('kill switch COLLECTORS_DISABLED_ROUTES has an entry naming no registry source ("huggingface/forum-latest"); '
                + 'every source is held disabled until it is fixed (entries are "slug/route")');
        }
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
            id: 'forum-latest', status: 'disabled', reason: `kill switch (database): route disabled since 2026-09-30 by ${APPROVER} — forum terms`,
        });
    });

    it('ignores database rows that are cleared (or empty)', () => {
        const st = sourceStatus(HF, TEST_ENV, { routeKills: [dbKill('forum-latest', { disabled_at: null }), dbKill('nope', { disabled_at: null }), null] });
        expect(st.openRoutes).toEqual(['daily-papers', 'blog-rss', 'forum-latest']);
        expect(st.disabledRoutes).toEqual([]);
        expect(st.reason).toBe('collecting via daily-papers, blog-rss, forum-latest');
    });

    // Security review F3 / grumpy #1: a recorded takedown never fails open
    // when the registry renames or removes the route it names.
    it('a database row naming a route the registry no longer has holds the whole source disabled', () => {
        expect(staleRouteKills(HF, [dbKill('old-forum'), dbKill('topic-projects'), dbKill('forum-latest'), dbKill('old-forum')]))
            .toEqual(['old-forum', 'topic-projects']);
        const st = sourceStatus(HF, TEST_ENV, { routeKills: [dbKill('old-forum')] });
        expect([st.status, st.openRoutes]).toEqual(['disabled', []]);
        expect(st.reason).toBe('kill switch (database) names route old-forum, which is not a route of hugging_face '
            + '(routes: daily-papers, blog-rss, forum-latest); the whole source is held disabled until it is cleared with '
            + 'npm run source:enable -- hugging_face --route <id>');
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
        expect(killReason(HF, withRoutes('hugging_face/forum'))).toMatch(/names "hugging_face\/forum", which is not a route of hugging_face/);
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

    it('every registry route id fits the database CHECK (a takedown can always be recorded)', () => {
        for (const s of SOURCES) for (const r of s.routes) expect([s.slug, r.id, ROUTE_ID_PATTERN.test(r.id)]).toEqual([s.slug, r.id, true]);
        expect(ROUTE_ID_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]{0,63}$');
        const sql = require('fs').readFileSync(require.resolve('../../../src/db/migrations/073_source_route_kill_switch.sql'), 'utf8');
        expect(sql).toContain(`CHECK (route_id ~ '${ROUTE_ID_PATTERN.source}')`);
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
            .toEqual({ command: 'disable', slug: 'hugging_face', route: 'forum-latest', staleRoute: false, note: null, reason: 'forum terms' });
        expect(admin.parseArgs(['enable', 'gitlab', '--route', 'forum-latest', '--note', 'cleared']))
            .toEqual({ command: 'enable', slug: 'gitlab', route: 'forum-latest', staleRoute: false, note: 'cleared', reason: null });
        // Flag order does not matter.
        expect(admin.parseArgs(['disable', 'gitlab', '--reason', 'r', '--route', 'forum-latest']).route).toBe('forum-latest');
    });

    it('refuses a route that is not a registry route of THAT source', () => {
        for (const route of ['forum', 'Forum-Latest', 'topic-projects', '../forum-latest', 'forum-latest;drop']) {
            const r = admin.parseArgs(['disable', 'hugging_face', '--route', route, '--reason', 'x']);
            expect(r.error).toMatch(new RegExp(`unknown route '.*' of hugging_face \\(registry routes: daily-papers, blog-rss, forum-latest\\)`));
        }
    });

    it('source:enable may name a well-formed id the registry no longer has (to clear a stale switch); disable may not', () => {
        expect(admin.parseArgs(['enable', 'hugging_face', '--route', 'old-forum'])).toMatchObject({ route: 'old-forum', staleRoute: true });
        expect(admin.parseArgs(['disable', 'hugging_face', '--route', 'old-forum', '--reason', 'x']).error).toMatch(/unknown route 'old-forum'/);
        for (const bad of ['../forum', 'Old-Forum', 'old_forum', '-x']) {
            expect(admin.parseArgs(['enable', 'hugging_face', '--route', bad]).error).toMatch(/unknown route/);
        }
    });

    it('refuses a flag the command does not take, and control characters in a reason or note', () => {
        expect(admin.parseArgs(['enable', 'hugging_face', '--route', 'forum-latest', '--reason', 'why']).error)
            .toMatch(/^source:enable does not take --reason/);
        expect(admin.parseArgs(['disable', 'hugging_face', '--reason', 'x', '--note', 'n']).error).toMatch(/^source:disable does not take --note/);
        expect(admin.parseArgs(['reset', 'hugging_face', '--reason', 'x']).error).toMatch(/^source:reset does not take --reason/);
        expect(admin.parseArgs(['disable', 'hugging_face', '--reason', 'line one\nline two']).error).toMatch(/--reason must not contain control characters/);
        expect(admin.parseArgs(['enable', 'hugging_face', '--note', 'x\u001b[31m']).error).toMatch(/--note must not contain control characters/);
    });

    it('refuses --route without a value, on reset, twice, or a stray argument', () => {
        expect(admin.parseArgs(['disable', 'hugging_face', '--route']).error).toBe(admin.USAGE);
        expect(admin.parseArgs(['disable', 'hugging_face', '--route', '--reason', 'x']).error).toBe(admin.USAGE);
        expect(admin.parseArgs(['reset', 'hugging_face', '--route', 'forum-latest']).error).toMatch(/source:reset does not take --route/);
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

// Security review F1: `npm run collect:smoke` honours both database switches.
describe('collect:smoke honours the database kill switches (no request to a disabled route or source)', () => {
    const HF_LIVE = [
        ['https://huggingface.co/api/daily_papers?limit=30', 'recorded/hf-daily-papers.json'],
        ['https://huggingface.co/blog/feed.xml', 'recorded/substack-importai.xml'],
        [/discuss\.huggingface\.co/, { status: 500, body: 'must not be asked' }],
    ];
    const OPEN_GOV = { disabled_at: null, access_denied_at: null, refused_until: null, route_kills: [] };
    const run = async (gov) => {
        const transport = fixtureTransport(HF_LIVE);
        const http = new HttpClient({ env: TEST_ENV, transport, sleep: () => Promise.resolve() });
        const row = await smoke.smokeSource(HF, TEST_ENV, http, undefined, gov);
        return { row, transport, forum: transport.calls.filter(c => /discuss\.huggingface\.co/.test(c.url)) };
    };

    it('skips a route switched off in the database', async () => {
        const { row, forum } = await run({ ...OPEN_GOV, route_kills: [dbKill('forum-latest')] });
        expect(forum).toHaveLength(0);
        expect(row.routes.map(r => r.id)).toEqual(['daily-papers', 'blog-rss']);
    });

    it('skips a source switched off in the database, or with no data_sources row, before any request', async () => {
        const off = await run({ ...OPEN_GOV, disabled_at: '2026-09-30T12:00:00Z', disabled_by: APPROVER, disabled_reason: 'stop' });
        expect([off.row.status, off.transport.calls.length]).toEqual(['disabled', 0]);
        expect(off.row.skipped).toMatch(/disabled by the database kill switch/);
        const none = await run(null);
        expect([none.row.skipped, none.transport.calls.length]).toEqual([expect.stringMatching(/has no data_sources row/), 0]);
        const all = await run({ ...OPEN_GOV, route_kills: ['daily-papers', 'blog-rss', 'forum-latest'].map(id => dbKill(id)) });
        expect([all.row.status, all.transport.calls.length]).toEqual(['disabled', 0]);
    });

    it('fetches nothing when the database state cannot be read (fail closed)', async () => {
        const out = [];
        const governance = async () => { throw new Error('connect ECONNREFUSED'); };
        expect(await smoke.main(['--only', 'hugging_face'], TEST_ENV, l => out.push(l), { governance })).toBe(2);
        expect(out.join('\n')).toMatch(/could not be read \(connect ECONNREFUSED\) — nothing was fetched/);
    });
});

// Security review F4: the fixture recorder honours every kill switch too.
describe('the fixture recorder never fetches a switched-off source or route', () => {
    const OPEN_GOV = async () => ({ disabled_at: null, route_kills: [] });

    it('every target names a registry route', () => {
        for (const [key] of recorder.TARGETS) {
            const [slug, routeId] = key.split('/');
            expect([key, !!getRoute(getSource(slug), routeId)]).toEqual([key, true]);
        }
    });

    it('killedTarget: env and database switches, source and route', () => {
        const gov = { disabled_at: null, route_kills: [] };
        expect(recorder.killedTarget('hugging_face/forum-latest', TEST_ENV, gov)).toBeNull();
        expect(recorder.killedTarget('hugging_face/forum-latest', withRoutes('hugging_face/forum-latest'), gov)).toMatch(/COLLECTORS_DISABLED_ROUTES/);
        expect(recorder.killedTarget('hugging_face/forum-latest', { ...TEST_ENV, SOURCE_HUGGING_FACE_ENABLED: 'false' }, gov)).toMatch(/=false/);
        expect(recorder.killedTarget('hugging_face/forum-latest', TEST_ENV, { ...gov, route_kills: [dbKill('forum-latest')] }))
            .toMatch(/^kill switch \(database\): route disabled/);
        expect(recorder.killedTarget('hugging_face/daily-papers', TEST_ENV, { ...gov, route_kills: [dbKill('forum-latest')] })).toBeNull();
        expect(recorder.killedTarget('hugging_face/daily-papers', TEST_ENV, { ...gov, disabled_at: '2026-09-30T12:00:00Z' })).toMatch(/database kill switch/);
        expect(recorder.killedTarget('hugging_face/daily-papers', TEST_ENV, { ...gov, route_kills: [dbKill('old-forum')] })).toMatch(/held disabled/);
        expect(recorder.killedTarget('hugging_face/daily-papers', TEST_ENV, null)).toMatch(/no data_sources row/);
    });

    it('main skips a switched-off route, keeps its earlier manifest entry, and records nothing when the database is unreadable', async () => {
        const calls = [];
        const http = { request: async (url) => { calls.push(url); return { body: url.includes('.json') || url.includes('api') ? '[]' : '<rss></rss>' }; } };
        const written = {};
        const lines = [];
        const governance = async slug => (slug === 'hugging_face'
            ? { disabled_at: null, route_kills: [dbKill('forum-latest')] } : OPEN_GOV());
        const code = await recorder.main({
            env: TEST_ENV, governance, http, dir: require('path').join(__dirname, '../../fixtures/collectors/recorded'),
            write: (f, body) => { written[require('path').basename(f)] = body; }, log: l => lines.push(l),
        });
        expect(code).toBe(0);
        expect(calls.some(u => /discuss\.huggingface\.co/.test(u))).toBe(false);
        expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/^SKIPPED hf-forum-latest\.json \(hugging_face\/forum-latest\): kill switch \(database\)/)]));
        const manifest = JSON.parse(written['manifest.json']);
        expect(manifest.files['https://discuss.huggingface.co/latest.json']).toBe('hf-forum-latest.json');   // kept, not re-recorded
        expect(written['hf-forum-latest.json']).toBeUndefined();

        calls.length = 0;
        const failing = async () => { throw new Error('connect ECONNREFUSED'); };
        expect(await recorder.main({ env: TEST_ENV, governance: failing, http, write: () => { throw new Error('wrote'); }, log: () => {} })).toBe(2);
        expect(calls).toEqual([]);
    });
});
