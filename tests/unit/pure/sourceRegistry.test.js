// tests/unit/pure/sourceRegistry.test.js
// The code registry (src/config/source-registry.js) against the REGISTRY OF
// RECORD — the workbook itself (docs/requirements/Top_50_Global_Online_
// Sources.xlsx, Rev. 3) and its committed CSV export. Jennifer's ruling:
// "use the 51 sources exactly. no exceptions." (ADR 0001).

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
const CSV = path.join(ROOT, 'docs/requirements/Top_51_Global_Online_Sources.rev3.csv');

const { SOURCES } = registry;
const workbook = readWorkbookSources(XLSX);
const ENV = { COLLECTOR_CONTACT_URL: 'https://example.org/contact' };

describe('workbook (registry of record)', () => {
    test('has exactly 51 source rows, ranked 1..51', () => {
        expect(workbook).toHaveLength(51);
        expect(workbook.map(r => r.rank)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
    });

    test('Rev. 3: Hacker News and Stack Overflow sit in Forums', () => {
        const forums = workbook.filter(r => r.category === 'forums').map(r => r.source);
        expect(forums).toEqual(['Stack Overflow', 'Hacker News (Y Combinator)']);
        expect(workbook.filter(r => r.category === 'developer').map(r => r.source))
            .toEqual(['GitHub', 'GitLab', 'Docker Hub', 'Hugging Face']);
    });

    test('category counts follow the 8-category canon', () => {
        const counts = {};
        for (const r of workbook) counts[r.category] = (counts[r.category] || 0) + 1;
        expect(counts).toEqual({
            social: 8, news: 11, academic: 8, policy: 7, nonprofit: 6, developer: 4, forums: 2, blog: 5,
        });
        expect(Object.keys(counts).sort()).toEqual([...CATEGORY_SLUGS].sort());
    });

    test('the committed CSV export is the workbook, row for row', () => {
        const text = fs.readFileSync(CSV, 'utf8');
        expect(text).toBe(toCsv(workbook));
        const rows = fromCsv(text);
        expect(rows).toHaveLength(51);
        expect(rows.map(r => [r.rank, r.source, r.category]))
            .toEqual(workbook.map(r => [r.rank, r.source, r.category]));
    });
});

describe('source registry ↔ workbook: 1:1', () => {
    test('exactly 51 entries — no additions, substitutes or drops', () => {
        expect(SOURCES).toHaveLength(51);
    });

    test('rank, name and category match the workbook exactly', () => {
        expect(SOURCES.map(s => [s.rank, s.name, s.category]))
            .toEqual(workbook.map(r => [r.rank, r.source, r.category]));
    });

    test('slugs are unique, lower snake case', () => {
        const slugs = SOURCES.map(s => s.slug);
        expect(new Set(slugs).size).toBe(51);
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

    test('permission-gated news RSS is ENABLED now under the legal-risk ruling', () => {
        for (const slug of ['bbc_news', 'nbc_news', 'ars_technica', 'nyt', 'washington_post',
            'guardian', 'al_jazeera', 'wsj']) {
            const st = status(slug);
            expect(st.status).toBe('collecting');
            expect(st.reason).toMatch(/Jennifer explicitly accepted that legal risk/);
        }
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

    test('ScienceDirect, IEEE Xplore and JSTOR wait for key/permission', () => {
        expect(status('sciencedirect').status).toBe('awaiting_approval');
        expect(status('ieee_xplore').status).toBe('awaiting_licence');
        expect(status('jstor').status).toBe('awaiting_approval');
        expect(status('jstor', { ...ENV, JSTOR_DATASET_PATH: '/data/jstor.jsonl' }).status).toBe('collecting');
    });

    test('a paid tier replaces the free feed when its key is set', () => {
        const src = registry.getSource('guardian');
        expect(registry.openRoutes(src, ENV).map(r => r.id)).toEqual(['ai-tag-rss']);
        expect(registry.openRoutes(src, { ...ENV, GUARDIAN_API_KEY: 'k' }).map(r => r.id)).toEqual(['content-api']);
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

    test('status counts with no keys set', () => {
        const counts = {};
        for (const s of SOURCES) {
            const st = registry.sourceStatus(s, ENV).status;
            counts[st] = (counts[st] || 0) + 1;
        }
        expect(counts).toEqual({
            collecting: 31, awaiting_key: 4, awaiting_approval: 7, awaiting_licence: 5, blocked: 4,
        });
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
