// tests/unit/pure/sourceRegistry.test.js
// The code registry (src/config/source-registry.js) against the REGISTRY OF
// RECORD — the workbook itself (docs/requirements/Top_50_Global_Online_
// Sources.xlsx, Rev. 4) and its committed CSV export. Jennifer's rulings
// (ADR 0001): "use the 51 sources exactly. no exceptions.", superseded on
// 2026-09-29 by "can we add reddit to the source lis. Update the excel file
// to capture as well" — the registry is exactly the workbook's 52 rows.
// Every count below comes from the workbook or SOURCES.length, never a
// literal source count.

'use strict';

const fs = require('fs');
const path = require('path');
const {
    readWorkbookSources, fromCsv, toCsv, parseCsv, extractSources, parseSheet, unzip,
} = require('../../../src/config/workbook');
const registry = require('../../../src/config/source-registry');
const { CATEGORY_SLUGS } = require('../../../src/config/categories');
const { findCity } = require('../../../public/js/config/cities.config.js');

const ROOT = path.join(__dirname, '../../..');
const XLSX = path.join(ROOT, 'docs/requirements/Top_50_Global_Online_Sources.xlsx');
const CSV = path.join(ROOT, 'docs/requirements/Top_52_Global_Online_Sources.rev4.csv');

const { SOURCES } = registry;
const workbook = readWorkbookSources(XLSX);
const ENV = { COLLECTOR_CONTACT_URL: 'https://example.org/contact' };

describe('workbook (registry of record)', () => {
    test('Rev. 4 has exactly 52 source rows, ranked 1..52 (each rank once)', () => {
        expect(workbook).toHaveLength(52);
        expect(workbook.map(r => r.rank).sort((a, b) => a - b)).toEqual(Array.from({ length: 52 }, (_, i) => i + 1));
    });

    test('Rev. 4: Reddit is #52, the last row of Forums; no other row was renumbered', () => {
        const reddit = workbook.find(r => r.source === 'Reddit');
        expect(reddit).toEqual(expect.objectContaining({
            rank: 52, category: 'forums', metric_type: 'Daily active uniques (DAUq)', value: '130.3M',
            value_numeric: '130300000', as_of: 'Q2 2026 (quarter avg., ended 30 Jun 2026)',
            figure_type: 'Company-reported', confidence: 'High',
        }));
        expect(reddit.credibility_basis).toMatch(/unaudited company KPI/);
        // Sheet order: ranks 1..46 and 47..51 are unchanged; Reddit sits
        // between Hacker News (46) and the Blogs block (47).
        expect(workbook.map(r => r.rank)).toEqual([
            ...Array.from({ length: 46 }, (_, i) => i + 1), 52, 47, 48, 49, 50, 51,
        ]);
    });

    test('Rev. 3: Hacker News and Stack Overflow sit in Forums (Reddit joins them in Rev. 4)', () => {
        const forums = workbook.filter(r => r.category === 'forums').map(r => r.source);
        expect(forums).toEqual(['Stack Overflow', 'Hacker News (Y Combinator)', 'Reddit']);
        expect(workbook.filter(r => r.category === 'developer').map(r => r.source))
            .toEqual(['GitHub', 'GitLab', 'Docker Hub', 'Hugging Face']);
    });

    test('category counts follow the 8-category canon', () => {
        const counts = {};
        for (const r of workbook) counts[r.category] = (counts[r.category] || 0) + 1;
        expect(counts).toEqual({
            social: 8, news: 11, academic: 8, policy: 7, nonprofit: 6, developer: 4, forums: 3, blog: 5,
        });
        expect(Object.keys(counts).sort()).toEqual([...CATEGORY_SLUGS].sort());
    });

    test('the committed CSV export is the workbook, row for row', () => {
        const text = fs.readFileSync(CSV, 'utf8');
        expect(text).toBe(toCsv(workbook));
        const rows = fromCsv(text);
        expect(rows).toHaveLength(workbook.length);
        expect(rows.map(r => [r.rank, r.source, r.category]))
            .toEqual(workbook.map(r => [r.rank, r.source, r.category]));
    });
});

describe('source registry ↔ workbook: 1:1', () => {
    test('exactly the workbook\'s 52 entries — no additions, substitutes or drops', () => {
        expect(SOURCES).toHaveLength(workbook.length);
        expect(SOURCES).toHaveLength(52);
    });

    test('rank, name and category match the workbook exactly', () => {
        expect(SOURCES.map(s => [s.rank, s.name, s.category]))
            .toEqual(workbook.map(r => [r.rank, r.source, r.category]));
    });

    test('slugs are unique, lower snake case', () => {
        const slugs = SOURCES.map(s => s.slug);
        expect(new Set(slugs).size).toBe(SOURCES.length);
        for (const s of slugs) expect(s).toMatch(/^[a-z][a-z0-9_]*$/);
    });
});

describe('registry entry shape', () => {
    test.each(SOURCES.map(s => [s.slug, s]))('%s records every required field', (_slug, s) => {
        expect(registry.SOURCE_TYPES).toContain(s.sourceType);
        expect(registry.AUTH_KINDS).toContain(s.auth.kind);
        expect(typeof s.auth.program).toBe('string');
        expect(s.auth.signup).toMatch(/^https:\/\//);
        expect(s.termsUrl).toMatch(/^https:\/\//);
        expect(s.termsNote.length).toBeGreaterThan(20);
        expect(typeof s.region).toBe('string');
        expect(s.rateLimit).toEqual(expect.objectContaining({ minIntervalMs: expect.any(Number) }));
        expect(s.pollIntervalSec).toBeGreaterThanOrEqual(120);
        expect(registry.GATE_STATUSES).toContain(s.closedStatus);
        expect(s.routes.length).toBeGreaterThan(0);
        for (const r of s.routes) {
            expect(typeof r.adapter).toBe('string');
            expect(['ai', 'filter']).toContain(r.scope);
            for (const url of (r.params && r.params.urls) || []) expect(url).toMatch(/^https:\/\//);
        }
        if (s.homeCity) expect(findCity(s.homeCity)).not.toBeNull();
    });

    test('every referenced env var is documented with its group', () => {
        for (const k of registry.registryEnvVars()) {
            expect(registry.ENV_DOCS[k]).toEqual(expect.objectContaining({ group: expect.any(String) }));
        }
    });

    test('dead or stale endpoints named by the research are not used', () => {
        const urls = SOURCES.flatMap(s => s.routes.flatMap(r => (r.params && r.params.urls) || []));
        for (const dead of ['feeds.reuters.com', 'rss.cnn.com', 'feeds.a.dj.com',
            '/topics/artificial-intelligence.xml', 'foundation.mozilla.org', 'youtube.com/feeds',
            'billstatus.xml']) {
            expect(urls.some(u => u.includes(dead))).toBe(false);
        }
    });
});

describe('gate status (Jennifer\'s rulings, ADR 0001)', () => {
    const status = (slug, env = ENV) => registry.sourceStatus(registry.getSource(slug), env);

    test('the 4 BLOCKED sources are exactly WeChat, Telegram, ResearchGate and Cato', () => {
        const blocked = SOURCES.filter(s => s.auth.kind === 'blocked').map(s => s.slug);
        expect(blocked).toEqual(['wechat', 'telegram', 'researchgate', 'cato']);
        for (const slug of blocked) {
            const st = status(slug);
            expect(st.status).toBe('blocked');
            expect(st.reason).toMatch(/^blocked: no compliant access/);
            expect(registry.getSource(slug).blocked.remedy.length).toBeGreaterThan(10);
        }
    });

    test('a blocked source runs only when its official permission env is set', () => {
        expect(status('cato', { ...ENV, CATO_ALLOWLIST_REF: 'CATO-2026-1' }).status).toBe('collecting');
        expect(status('telegram', { ...ENV, TELEGRAM_BOT_TOKEN: 't' }).status).toBe('blocked');
    });

    // D1 ("Off for others, on for you"): the 8 ruling-4 feeds open only when
    // the OPERATOR records their acceptance of the legal risk.
    const GATED = ['bbc_news', 'nbc_news', 'ars_technica', 'nyt', 'washington_post', 'guardian', 'al_jazeera', 'wsj'];
    const ACK = { ...ENV, PERMISSION_GATED_FEEDS_ACCEPTED_BY: 'Test Operator 2026-09-29' };

    test('exactly the 8 ruling-4 feeds are permission-gated, each on the acknowledgement', () => {
        const gated = SOURCES.filter(s => s.routes.some(r => r.permissionGated)).map(s => s.slug).sort();
        expect(gated).toEqual([...GATED].sort());
        for (const s of SOURCES) {
            for (const r of s.routes) {
                if (r.permissionGated) expect(r.requires).toEqual([registry.PERMISSION_GATED_ACK_ENV]);
                else expect(r.requires || []).not.toContain(registry.PERMISSION_GATED_ACK_ENV);
            }
        }
        expect(registry.PERMISSION_GATED_ACK_ENV).toBe('PERMISSION_GATED_FEEDS_ACCEPTED_BY');
        expect(registry.envClass('PERMISSION_GATED_FEEDS_ACCEPTED_BY')).toBe('setting');
    });

    test('permission-gated news RSS stays CLOSED without the operator acknowledgement', () => {
        for (const slug of GATED) {
            const st = status(slug);
            expect(st.status).toMatch(/^awaiting_(approval|licence)$/);
            expect(st.reason).toMatch(/permission-gated feed.*PERMISSION_GATED_FEEDS_ACCEPTED_BY/);
            expect(st.missing).toContain('PERMISSION_GATED_FEEDS_ACCEPTED_BY');
        }
        // A blank or whitespace-only acknowledgement is not one.
        expect(status('bbc_news', { ...ENV, PERMISSION_GATED_FEEDS_ACCEPTED_BY: '   ' }).status).toBe('awaiting_approval');
    });

    test('the acknowledgement opens them under the legal-risk ruling', () => {
        for (const slug of GATED) {
            const st = status(slug, ACK);
            expect(st.status).toBe('collecting');
            expect(st.reason).toMatch(/Jennifer explicitly accepted that legal risk/);
            expect(st.reason).toMatch(/operator's acknowledgement \(PERMISSION_GATED_FEEDS_ACCEPTED_BY\)/);
        }
    });

    test('a licensed route of a gated source does not need the acknowledgement', () => {
        const st = status('nyt', { ...ENV, NYT_API_KEY: 'k', NYT_LICENSE_REF: 'r' });
        expect(st.status).toBe('collecting');
        expect(st.openRoutes).toEqual(['article-search']);
        expect(st.reason).not.toMatch(/legal risk/);
    });

    test('paid APIs wait for their key: X, AP, Reuters, CNN', () => {
        for (const slug of ['x', 'ap', 'reuters', 'cnn']) expect(status(slug).status).toBe('awaiting_licence');
        expect(status('x', { ...ENV, X_BEARER_TOKEN: 'b' }).status).toBe('collecting');
    });

    test('researcher programs wait for approval credentials', () => {
        for (const slug of ['whatsapp', 'instagram', 'facebook', 'tiktok']) {
            expect(status(slug).status).toBe('awaiting_approval');
        }
        expect(status('tiktok', { ...ENV, TIKTOK_RESEARCH_CLIENT_KEY: 'k', TIKTOK_RESEARCH_CLIENT_SECRET: 's' }).status)
            .toBe('collecting');
    });

    // ADR 0001 rulings 8 and 9: Reddit is built now, off until approved.
    const REDDIT_ENV = {
        ...ENV,
        REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 's',
        REDDIT_USER_AGENT: 'server:pulse-of-ai:v1.0.0 (by /u/example_user)', REDDIT_API_APPROVAL_REF: 'RBP-1',
    };

    test('Reddit is "awaiting approval" until ALL FOUR variables are set, and cites its terms', () => {
        const st = status('reddit');
        expect(st.status).toBe('awaiting_approval');
        expect(st.missing).toEqual(['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT', 'REDDIT_API_APPROVAL_REF']);
        expect(st.reason).toMatch(/Responsible Builder Policy/);
        for (const k of st.missing) {
            const partial = { ...REDDIT_ENV, [k]: '' };
            expect([k, status('reddit', partial).status]).toEqual([k, 'awaiting_approval']);
        }
        expect(status('reddit', REDDIT_ENV).status).toBe('collecting');
        const src = registry.getSource('reddit');
        expect(src.termsUrl).toBe('https://redditinc.com/policies/data-api-terms');
        expect(src.auth.kind).toBe('approval');
        expect(src.attribution).toBe('Reddit');
        expect(src.ruling).toMatch(/Blank text, keep audit rows/);
        expect(src.retention).toEqual(expect.objectContaining({ maxAgeHours: 48, recheckHours: 6 }));
    });

    test('Reddit\'s kill switch closes it even with every credential', () => {
        expect(registry.killSwitchEnv('reddit')).toBe('SOURCE_REDDIT_ENABLED');
        expect(status('reddit', { ...REDDIT_ENV, SOURCE_REDDIT_ENABLED: 'false' }).status).toBe('disabled');
        expect(status('reddit', { ...REDDIT_ENV, COLLECTORS_DISABLED: 'reddit' }).status).toBe('disabled');
    });

    test('Reddit may reach only oauth.reddit.com and the www.reddit.com token host; the secret is worker-only', () => {
        expect(registry.allowedHosts(registry.getSource('reddit'), REDDIT_ENV)).toEqual(['oauth.reddit.com', 'www.reddit.com']);
        expect(registry.envClass('REDDIT_CLIENT_SECRET')).toBe('credential');
        expect(registry.envClass('REDDIT_CLIENT_ID')).toBe('credential');
        expect(registry.envClass('REDDIT_USER_AGENT')).toBe('credential');
        expect(registry.envClass('REDDIT_API_APPROVAL_REF')).toBe('setting');
        expect(registry.envClass('REDDIT_MIN_AI_POSTS_7D')).toBe('setting');
    });

    test('ScienceDirect, IEEE Xplore and JSTOR wait for key/permission', () => {
        expect(status('sciencedirect').status).toBe('awaiting_approval');
        expect(status('ieee_xplore').status).toBe('awaiting_licence');
        expect(status('jstor').status).toBe('awaiting_approval');
        expect(status('jstor', { ...ENV, JSTOR_DATASET_PATH: '/data/jstor.jsonl' }).status).toBe('collecting');
    });

    test('a paid tier replaces the free feed when its key is set', () => {
        const src = registry.getSource('guardian');
        expect(registry.openRoutes(src, ENV).map(r => r.id)).toEqual([]);
        expect(registry.openRoutes(src, ACK).map(r => r.id)).toEqual(['ai-tag-rss']);
        // P10-7: the commercial key alone does not open the Content API; its
        // licence reference is required too (like Elsevier and IEEE).
        expect(registry.openRoutes(src, { ...ACK, GUARDIAN_API_KEY: 'k' }).map(r => r.id)).toEqual(['ai-tag-rss']);
        expect(registry.openRoutes(src, { ...ACK, GUARDIAN_API_KEY: 'k', GUARDIAN_COMMERCIAL_LICENSE_REF: 'L-1' }).map(r => r.id))
            .toEqual(['content-api']);
        expect(registry.sourceStatus(src, { ...ENV, GUARDIAN_API_KEY: 'k' }).missing).toContain('GUARDIAN_COMMERCIAL_LICENSE_REF');
    });

    test('CFR is held until CFR confirms (robots "Disallow: /feed/" read conservatively)', () => {
        expect(status('cfr').status).toBe('awaiting_approval');
        expect(status('cfr', { ...ENV, CFR_FEED_PERMISSION_REF: 'CFR-OK' }).status).toBe('collecting');
    });

    test('every source has a kill switch (per-source env, list, global)', () => {
        for (const s of SOURCES) {
            expect(registry.killSwitchEnv(s.slug)).toMatch(/^SOURCE_[A-Z0-9_]+_ENABLED$/);
        }
        expect(status('npr', { ...ENV, SOURCE_NPR_ENABLED: 'false' }).status).toBe('disabled');
        expect(status('npr', { ...ENV, COLLECTORS_DISABLED: 'bbc_news, npr' }).status).toBe('disabled');
        expect(status('npr', { ...ENV, COLLECTORS_ENABLED: 'false' }).status).toBe('disabled');
        expect(status('npr', { ...ENV, SOURCE_NPR_ENABLED: 'true' }).status).toBe('collecting');
    });

    test('no collection without a User-Agent contact URL; blocked stays blocked regardless', () => {
        const st = status('arxiv', {});
        expect(st.status).toBe('disabled');
        expect(st.reason).toMatch(/COLLECTOR_CONTACT_URL/);
        expect(status('wechat', {}).status).toBe('blocked');
        expect(status('wechat', { SOURCE_WECHAT_ENABLED: 'false' }).status).toBe('disabled');
    });

    const countStatuses = (env) => {
        const counts = {};
        for (const s of SOURCES) {
            const st = registry.sourceStatus(s, env).status;
            counts[st] = (counts[st] || 0) + 1;
        }
        return counts;
    };

    test('status counts with no keys set: contact URL only (gated feeds closed)', () => {
        expect(countStatuses(ENV)).toEqual({
            collecting: 23, awaiting_key: 4, awaiting_approval: 11, awaiting_licence: 10, blocked: 4,
        });
    });

    test('status counts with the contact URL and the acknowledgement', () => {
        expect(countStatuses(ACK)).toEqual({
            collecting: 31, awaiting_key: 4, awaiting_approval: 8, awaiting_licence: 5, blocked: 4,
        });
    });

    test('a fresh clone (no contact URL) collects nothing: every non-blocked source is disabled', () => {
        expect(countStatuses({})).toEqual({ disabled: SOURCES.length - 4, blocked: 4 });
        expect(SOURCES.length - 4).toBe(48);
    });

    test('attribution is recorded where the terms require it', () => {
        expect(registry.getSource('npr').attribution).toBe('NPR');
        expect(registry.getSource('nbc_news').attribution).toBe('NBCNews.com');
        expect(registry.getSource('stack_overflow').attribution).toMatch(/Stack Exchange/);
        expect(registry.getSource('wikipedia').attribution).toMatch(/CC BY-SA/);
    });

    test('a key shortens a keyless cadence where the quota allows', () => {
        const so = registry.getSource('stack_overflow');
        expect(registry.pollIntervalSec(so, ENV)).toBe(900);
        expect(registry.pollIntervalSec(so, { STACKEXCHANGE_KEY: 'k' })).toBe(registry.DEFAULT_POLL_SEC);
    });

    // D4 (Jennifer, 2026-09-29: "Keep 2–3 minutes for all") and P10-7.
    describe('D4 cadence band and the keyed-route quota audit', () => {
        const ALL_OPEN = Object.fromEntries(registry.registryEnvVars().map(k => [k, 'x']));
        const ENV_ALL = { ...ALL_OPEN, COLLECTORS_ENABLED: 'true', COLLECTORS_DISABLED: '', COLLECT_WINDOW_MS: '' };
        // Documented quotas that cannot be met even at 180 s (reported), and
        // IEEE, whose quota is set at key registration and not published.
        const EXCEPTIONS = { youtube: 900, stack_overflow: 900, ieee_xplore: 900 };

        test('every source runs every 2–3 minutes, except the reported quota exceptions', () => {
            for (const s of SOURCES) {
                for (const env of [ENV, ENV_ALL]) {
                    const sec = registry.pollIntervalSec(s, env);
                    const keylessSo = s.slug === 'stack_overflow' && !env.STACKEXCHANGE_KEY;
                    const opened = s.slug !== 'stack_overflow' && env === ENV_ALL;
                    if ((EXCEPTIONS[s.slug] && (keylessSo || opened))) expect([s.slug, sec]).toEqual([s.slug, EXCEPTIONS[s.slug]]);
                    else {
                        expect([s.slug, sec >= registry.CADENCE_BAND_SEC.min]).toEqual([s.slug, true]);
                        expect([s.slug, sec <= registry.CADENCE_BAND_SEC.max]).toEqual([s.slug, true]);
                    }
                }
            }
        });

        test('every route with a documented quota meets it at its cadence', () => {
            const audited = [];
            for (const s of SOURCES) for (const r of s.routes) {
                for (const env of [ENV, { ...ENV, STACKEXCHANGE_KEY: 'k' }]) {
                    const a = registry.quotaAudit(s, r, env);
                    if (!a) continue;
                    audited.push(`${s.slug}/${r.id}`);
                    expect([s.slug, r.id, a.fitsQuota]).toEqual([s.slug, r.id, true]);
                    if (!a.inBand) expect(Object.keys(EXCEPTIONS)).toContain(s.slug);
                    if (!a.inBand && !a.unpublished) expect(a.minIntervalSec).toBeGreaterThan(registry.CADENCE_BAND_SEC.max);
                }
            }
            for (const k of ['nyt/article-search', 'guardian/content-api', 'youtube/data-api', 'tiktok/research-api', 'x/recent-search',
                'sciencedirect/search-api', 'springerlink/meta-api', 'ieee_xplore/metadata-api', 'govinfo/search-api',
                'congress_gov/bill-api', 'stack_overflow/questions', 'gitlab/topic-projects', 'github/repo-search', 'reddit/data-api']) {
                expect(audited).toContain(k);
            }
        });

        test('NYT Article Search polls at 180 s (500/day); its RSS stays at 150 s', () => {
            const nyt = registry.getSource('nyt');
            expect(registry.pollIntervalSec(nyt, ACK)).toBe(150);
            expect(registry.pollIntervalSec(nyt, { ...ACK, NYT_API_KEY: 'k', NYT_LICENSE_REF: 'L' })).toBe(180);
            const a = registry.quotaAudit(nyt, nyt.routes.find(r => r.id === 'article-search'), {});
            expect(a).toMatchObject({ intervalSec: 180, runsPerDay: 480, perDay: 500, fitsQuota: true, inBand: true });
        });

        test('Stack Overflow keyless cannot fit the band (300/day, 2 requests/run needs >= 576 s)', () => {
            const so = registry.getSource('stack_overflow');
            expect(registry.quotaAudit(so, so.routes[0], ENV)).toMatchObject({ minIntervalSec: 576, inBand: false, fitsQuota: true });
            expect(registry.quotaAudit(so, so.routes[0], { STACKEXCHANGE_KEY: 'k' })).toMatchObject({ intervalSec: 150, inBand: true, fitsQuota: true });
        });
    });
});

describe('workbook reader internals', () => {
    test('parseCsv handles quotes, commas and embedded newlines', () => {
        expect(parseCsv('a,"b,""c""",d\n1,"x\ny",z\n')).toEqual([['a', 'b,"c"', 'd'], ['1', 'x\ny', 'z']]);
    });

    test('shared-string cells and gaps are parsed', () => {
        const xml = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>7</v></c></row>';
        expect(parseSheet(xml, ['hello'])).toEqual([['hello', '', '7']]);
    });

    test('an unknown section or a row before any section is rejected', () => {
        expect(() => extractSources([['9. MYSTERY (1)'], ['1', 'X']])).toThrow(/unknown workbook section/);
        expect(() => extractSources([['1', 'X']])).toThrow(/before any section/);
    });

    test('a non-zip buffer is rejected', () => {
        expect(() => unzip(Buffer.alloc(40))).toThrow(/not a zip/);
    });
});
