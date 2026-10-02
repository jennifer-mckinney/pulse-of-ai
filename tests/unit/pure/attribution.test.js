// Pure unit tests for src/config/attribution.js — K1: the source credit and
// the canonical link every excerpt and receipt carries. The credit is derived
// at read time from the source registry; the link is the stored permalink,
// validated here. Demo posts and unknown (retired) slugs never get a credit.
'use strict';

const { SOURCES } = require('../../../src/config/source-registry');
const {
    creditFor, safeSourceUrl, safeIsoDate, postAttribution, creditsCatalogue, linkDomains, registrable, SITE_NOTICES,
} = require('../../../src/config/attribution');
const browser = require('../../../public/js/attribution');

describe('safeSourceUrl: the base rule (no slug)', () => {
    test.each([
        'https://www.npr.org/2026/09/30/story',
        'http://example.org/a?b=c#d',
        'https://news.ycombinator.com/item?id=1',
        'https://en.wikipedia.org/wiki/Talk:Artificial_intelligence',
        'https://xn--pple-43d.com/',
    ])('accepts %s', (u) => {
        expect(safeSourceUrl(u)).toBe(u);
    });

    test.each([
        ['javascript:alert(1)'],
        ['data:text/html,<script>1</script>'],
        ['ftp://example.org/file'],
        ['//example.org/x'],
        ['/relative/path'],
        ['https:/example.org'],
        ['https://user:pw@example.org/'],
        ['https://user@example.org/'],
        ['https://example.org@evil.com/'],
        ['https://localhost/x'],
        ['https://foo.localhost/x'],
        ['https://intranet/x'],
        ['https://127.0.0.1/x'],
        ['https://2130706433/x'],
        ['https://0x7f.1/x'],
        ['https://[::1]/x'],
        ['https://10.0.0.5/x'],
        ['https://example.org/a b'],
        ['https://example.org/a\nb'],
        ['https://example.org/a\tb'],
        ['https://example.org/\u0000'],
        ['https://example.org/‮exe.pdf'],
        ['https://example.org/​'],
        ['https://example.org/' + 'a'.repeat(2100)],
        // trailing dot / private-network names / malformed labels (security review F2-F4)
        ['http://localhost.:3000/admin'],
        ['http://foo.localhost./'],
        ['http://intranet./'],
        ['http://localhost../'],
        ['https://metadata.google.internal/'],
        ['https://router.local/'],
        ['https://intranet.corp/'],
        ['https://nas.home.arpa/'],
        ['https://%2e/'],
        ['https://ex_ample.org/'],
        ['https://-bad.example.org/'],
        ['https://example.123/'],
        ['https://example.org..evil.com/'],
        [''],
        ['   '],
        [null],
        [undefined],
        [42],
        [{ href: 'https://example.org' }],
    ])('rejects %p', (u) => {
        expect(safeSourceUrl(u)).toBeNull();
    });

    test('trims surrounding whitespace and returns the normalised href', () => {
        expect(safeSourceUrl('  https://example.org/x \n')).toBe('https://example.org/x');
        expect(safeSourceUrl('HTTPS://Example.ORG')).toBe('https://example.org/');
    });

    test('a trailing dot on a real host is accepted and removed (the served host is the dotless name)', () => {
        expect(safeSourceUrl('https://example.org./x')).toBe('https://example.org/x');
        expect(safeSourceUrl('https://www.npr.org./story', 'npr')).toBe('https://www.npr.org/story');
    });

    test('tracking and credential query keys are removed, everything else is kept byte for byte', () => {
        expect(safeSourceUrl('https://example.org/a?id=7&utm_source=x&fbclid=y&token=SECRET&q=a%20b'))
            .toBe('https://example.org/a?id=7&q=a%20b');
        expect(safeSourceUrl('https://example.org/a?utm_medium=x&api_key=k&sig=z')).toBe('https://example.org/a');
        expect(safeSourceUrl('https://example.org/a?KEY=1&Access_Token=2&p=3#frag')).toBe('https://example.org/a?p=3#frag');
        expect(safeSourceUrl('https://news.ycombinator.com/item?id=1')).toBe('https://news.ycombinator.com/item?id=1');
    });

    test('only a default port is accepted', () => {
        expect(safeSourceUrl('https://example.org:8443/x')).toBeNull();
        expect(safeSourceUrl('https://example.org:0/x')).toBeNull();
        expect(safeSourceUrl('http://example.org:80/x')).toBe('http://example.org/x');
        expect(safeSourceUrl('https://example.org:443/x')).toBe('https://example.org/x');
    });

    test('credential keys are also removed from a key=value fragment and after a semicolon; plain anchors stay', () => {
        expect(safeSourceUrl('https://example.org/x#access_token=abc&state=1')).toBe('https://example.org/x#state=1');
        expect(safeSourceUrl('https://example.org/x#token=abc')).toBe('https://example.org/x');
        expect(safeSourceUrl('https://example.org/x?a=1;token=abc')).toBe('https://example.org/x?a=1');
        expect(safeSourceUrl('https://en.wikipedia.org/wiki/Talk:AI#c-Example-2026-09-29')).toBe('https://en.wikipedia.org/wiki/Talk:AI#c-Example-2026-09-29');
    });

    test('the server base rule IS the browser rule (one function: no drift)', () => {
        const vectors = [
            'https://www.npr.org/x?utm_source=a', 'javascript:alert(1)', 'https://localhost./x', 'https://example.org/a b',
            'https://example.org/‮', 'https://[::1]/', 'https://u:p@example.org/', 'https://example.org/ok',
        ];
        for (const v of vectors) expect(safeSourceUrl(v)).toBe(browser.safeHttpUrl(v));
    });
});

describe('safeSourceUrl: bound to the source', () => {
    test('a link on the source domain, or a subdomain of it, is kept', () => {
        const ok = [
            ['https://www.npr.org/2026/story', 'npr'],
            ['https://npr.org/x', 'npr'],
            ['https://github.com/openai/gym', 'github'],
            ['https://github.blog/ai-and-ml/post/', 'github'],
            ['https://www.bbc.co.uk/news/articles/x', 'bbc_news'],
            ['https://news.ycombinator.com/item?id=9', 'hacker_news'],
            ['https://stackoverflow.com/questions/1', 'stack_overflow'],
            ['https://pubmed.ncbi.nlm.nih.gov/123/', 'pubmed'],
            ['https://arxiv.org/abs/2601.00001', 'arxiv'],
            ['https://www.reddit.com/comments/abc', 'reddit'],
            ['https://importai.substack.com/p/x', 'substack'],
        ];
        for (const [url, slug] of ok) expect([slug, safeSourceUrl(url, slug)]).toEqual([slug, url]);
    });

    test('a link that is NOT on the source domain is dropped (open redirect / phishing)', () => {
        expect(safeSourceUrl('https://evil.example/login', 'npr')).toBeNull();
        expect(safeSourceUrl('https://example.org/redirect?u=https://evil.com', 'npr')).toBeNull();
        expect(safeSourceUrl('https://www.npr.org.evil.example/x', 'npr')).toBeNull();
        expect(safeSourceUrl('https://notnpr.org/x', 'npr')).toBeNull();
        expect(safeSourceUrl('https://evil.example/?next=https://www.npr.org/', 'npr')).toBeNull();
        expect(safeSourceUrl('https://example.org/x', 'npr')).toBeNull();
    });

    test('an unregistered slug has no link at all (legacy rows)', () => {
        expect(safeSourceUrl('https://example.org/x', 'wired_ai')).toBeNull();
        expect(safeSourceUrl('https://example.org/x', '')).toBeNull();
        expect(safeSourceUrl('https://example.org/x', null)).toBeNull();
        expect(safeSourceUrl('https://example.org/x', {})).toBeNull();
    });

    test('an identity link of a legacy row is never published, even on the source domain', () => {
        expect(safeSourceUrl('https://github.com/someuser', 'github')).toBeNull();
        expect(safeSourceUrl('https://www.reddit.com/user/someone', 'reddit')).toBeNull();
        expect(safeSourceUrl('https://stackoverflow.com/users/12/someone', 'stack_overflow')).toBeNull();
        expect(safeSourceUrl('https://www.openstreetmap.org/user/jane/diary/7', 'openstreetmap')).toBeNull();
        expect(safeSourceUrl('https://www.npr.org/u/someone', 'npr')).toBeNull();
    });

    test('profile pages the ingest identity rule does not cover are never published', () => {
        expect(safeSourceUrl('https://news.ycombinator.com/user?id=pg', 'hacker_news')).toBeNull();
        expect(safeSourceUrl('https://scholar.google.com/citations?user=abc', 'google_scholar')).toBeNull();
        expect(safeSourceUrl('https://news.ycombinator.com/item?id=1', 'hacker_news')).toBe('https://news.ycombinator.com/item?id=1');
    });

    test('a multi-tenant platform host is not shared across sources (One Useful Thing is not any Substack)', () => {
        expect(safeSourceUrl('https://evil.substack.com/p/x', 'one_useful_thing')).toBeNull();
        expect(safeSourceUrl('https://www.oneusefulthing.org/p/x', 'one_useful_thing')).toBe('https://www.oneusefulthing.org/p/x');
        expect(safeSourceUrl('https://importai.substack.com/p/x', 'substack')).toBe('https://importai.substack.com/p/x');
    });

    test('linkOnly sources do not derive link domains from their feed host', () => {
        const dom = (slug) => [...linkDomains(SOURCES.find(s => s.slug === slug))].sort();
        expect(dom('wsj')).toEqual(['dowjones.com', 'wsj.com']);
        expect(dom('bbc_news')).toEqual(['bbc.co.uk', 'bbc.com']);
    });

    test('the base rule still applies with a slug', () => {
        expect(safeSourceUrl('javascript:alert(1)', 'npr')).toBeNull();
        expect(safeSourceUrl('https://www.npr.org/x?token=S&id=1', 'npr')).toBe('https://www.npr.org/x?id=1');
    });

    test('every registry source can link somewhere: its link domains are never empty', () => {
        for (const src of SOURCES) {
            expect([src.slug, linkDomains(src).size > 0]).toEqual([src.slug, true]);
        }
    });

    test('API-only parent domains are never link domains (they can serve user content or unrelated sites)', () => {
        const dom = (slug) => [...linkDomains(SOURCES.find(s => s.slug === slug))];
        expect(dom('youtube')).not.toContain('googleapis.com');
        expect(dom('tiktok')).not.toContain('tiktokapis.com');
        expect(dom('guardian')).not.toContain('guardianapis.com');
        expect(dom('wsj')).not.toContain('dowjones.io');
        expect(dom('hacker_news')).not.toContain('algolia.com');
        expect(dom('reuters')).not.toContain('thomsonreuters.com');
        expect(dom('sciencedirect')).not.toContain('elsevier.com');
        expect(dom('pubmed')).not.toContain('nih.gov');
        expect(safeSourceUrl('https://storage.googleapis.com/evil/x', 'youtube')).toBeNull();
    });

    test('one permalink shape per adapter without a recorded fixture passes its own source rule', () => {
        const samples = [
            ['docker_hub', 'https://hub.docker.com/r/x/y'],
            ['congress_gov', 'https://www.congress.gov/bill/118th-congress/house-bill/1'],
            ['youtube', 'https://www.youtube.com/watch?v=x'],
            ['x', 'https://x.com/i/web/status/1'],
            ['springerlink', 'https://link.springer.com/article/10.1/x'],
            ['ieee_xplore', 'https://ieeexplore.ieee.org/document/1'],
            ['nyt', 'https://www.nytimes.com/2026/09/30/technology/x.html'],
            ['guardian', 'https://www.theguardian.com/technology/2026/sep/30/x'],
            ['jstor', 'https://www.jstor.org/stable/1'],
            ['sciencedirect', 'https://www.sciencedirect.com/science/article/pii/S1'],
            ['gitlab', 'https://gitlab.com/group/project'],
            ['hugging_face', 'https://huggingface.co/papers/2601.00001'],
            ['internet_archive', 'https://archive.org/details/x'],
            ['wikipedia', 'https://en.wikipedia.org/wiki/Talk:Artificial_intelligence#c-1'],
            ['pew', 'https://www.pewresearch.org/short-reads/2026/09/30/x/'],
            ['reddit', 'https://www.reddit.com/comments/abc123'],
        ];
        for (const [slug, url] of samples) expect([slug, safeSourceUrl(url, slug)]).toEqual([slug, url]);
    });

    test('registrable() keeps three labels under a country second level', () => {
        expect(registrable('feeds.bbci.co.uk')).toBe('bbci.co.uk');
        expect(registrable('api.github.com')).toBe('github.com');
        expect(registrable('eutils.ncbi.nlm.nih.gov')).toBe('nih.gov');
        expect(registrable('example.org')).toBe('example.org');
        expect(registrable('localhost')).toBe('localhost');
    });
});

describe('safeIsoDate', () => {
    test('normalises a date to ISO UTC, null for anything else', () => {
        expect(safeIsoDate('2026-09-29T10:00:00Z')).toBe('2026-09-29T10:00:00.000Z');
        expect(safeIsoDate('2026-09-29')).toBe('2026-09-29T00:00:00.000Z');
        // a calendar day that does not exist is not rolled over, a zoneless time is UTC
        expect(safeIsoDate('2026-02-31')).toBeNull();
        expect(safeIsoDate('2026-13-01')).toBeNull();
        expect(safeIsoDate('2026-09-29T10:00')).toBe('2026-09-29T10:00:00.000Z');
        expect(safeIsoDate('2026-09-29 10:00:00')).toBe('2026-09-29T10:00:00.000Z');
        expect(safeIsoDate('2026-09-29T10:00:00+02:00')).toBe('2026-09-29T08:00:00.000Z');
        expect(safeIsoDate('<img src=x onerror=1>')).toBeNull();
        expect(safeIsoDate('')).toBeNull();
        expect(safeIsoDate(5)).toBeNull();
        expect(safeIsoDate('x'.repeat(100))).toBeNull();
        expect(safeIsoDate(null)).toBeNull();
    });
});

describe('creditFor', () => {
    test('NPR: "NPR" is the credit and the terms require it', () => {
        expect(creditFor('npr')).toEqual(expect.objectContaining({ text: 'NPR', required: true, license: null }));
    });

    test('NBC News keeps the "NBCNews.com" wording the RSS terms ask for', () => {
        expect(creditFor('nbc_news').text).toBe('NBCNews.com');
    });

    test('Pew: full citation form, with the publication date', () => {
        const c = creditFor('pew');
        expect(c.text).toBe('Pew Research Center, Washington, D.C.');
        expect(c.cite_date).toBe(true);
        expect(c.required).toBe(true);
    });

    test('licence in the registry attribution is shown once, as a link', () => {
        const wiki = creditFor('wikipedia');
        expect(wiki.text).toBe('Wikipedia');
        expect(wiki.license).toBe('CC BY-SA 4.0');
        expect(wiki.license_url).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
        expect(wiki.modified).toBe(true);
        const so = creditFor('stack_overflow');
        expect(so.text).toBe('Stack Exchange');
        expect(so.license_url).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
        const owid = creditFor('owid');
        expect(owid.text).toBe('Our World in Data');
        expect(owid.license_url).toBe('https://creativecommons.org/licenses/by/4.0/');
        expect(owid.modified).toBe(true);
    });

    test('arXiv and PubMed carry the notices their terms require', () => {
        expect(creditFor('arxiv').notice).toBe('Thank you to arXiv for use of its open access interoperability.');
        const pm = creditFor('pubmed');
        expect(pm.notice).toMatch(/National Library of Medicine/);
        expect(pm.notice_url).toBe('https://www.ncbi.nlm.nih.gov/home/about/policies/');
    });

    test('a source with no required credit still gets one (decision D1): the name, parenthetical removed', () => {
        expect(creditFor('hacker_news')).toEqual(expect.objectContaining({ text: 'Hacker News', required: false }));
        expect(creditFor('tldr').text).toBe('TLDR');
        expect(creditFor('mozilla').text).toBe('Mozilla');
        expect(creditFor('github').text).toBe('GitHub');
    });

    test('no licence is claimed where the registry does not record one', () => {
        expect(creditFor('mozilla').license).toBeNull();
        expect(creditFor('mozilla').license_url).toBeNull();
        expect(creditFor('hacker_news').modified).toBe(false);
    });

    test('unknown, empty and non-string slugs have no credit', () => {
        expect(creditFor('reddit_artificial')).toBeNull();
        expect(creditFor('')).toBeNull();
        expect(creditFor(null)).toBeNull();
        expect(creditFor(undefined)).toBeNull();
        expect(creditFor({})).toBeNull();
    });

    test('inherited Object properties are not slugs', () => {
        expect(creditFor('constructor')).toBeNull();
        expect(creditFor('__proto__')).toBeNull();
    });

    test('the returned object is a copy: a caller cannot mutate the registry', () => {
        const a = creditFor('npr');
        a.text = 'tampered';
        expect(creditFor('npr').text).toBe('NPR');
    });
});

describe('every registry source', () => {
    test.each(SOURCES.map(s => [s.slug, s]))('%s has a non-empty credit and consistent licence/notice fields', (slug, src) => {
        const c = creditFor(slug);
        expect(c).not.toBeNull();
        expect(typeof c.text).toBe('string');
        expect(c.text.trim()).not.toBe('');
        // never a credit text that still carries a trailing "(licence)" duplicate
        if (c.license) expect(c.text).not.toContain(`(${c.license})`);
        // a registered licence URL is https and paired with a licence name
        if (src.licenseUrl) {
            expect(src.licenseUrl).toMatch(/^https:\/\//);
            expect(c.license).toBeTruthy();
        }
        // a notice URL needs a notice
        if (c.notice_url) expect(c.notice).toBeTruthy();
    });

    test('the credit is REQUIRED exactly for the sources whose terms name one', () => {
        const required = SOURCES.filter(s => creditFor(s.slug).required).map(s => s.slug).sort();
        expect(required).toEqual(['nbc_news', 'npr', 'owid', 'pew', 'reddit', 'stack_overflow', 'wikipedia']);
    });

    test('the registry attribution field is unchanged (API back-compat)', () => {
        const by = Object.fromEntries(SOURCES.map(s => [s.slug, s.attribution]));
        expect(by.npr).toBe('NPR');
        expect(by.wikipedia).toBe('Wikipedia (CC BY-SA 4.0)');
        expect(by.pew).toBe('Pew Research Center');
    });
});

describe('postAttribution', () => {
    test('a live registry post: credit, validated link, the registry attribution, date', () => {
        const a = postAttribution({
            sourceName: 'npr', sourceType: 'rss',
            url: 'https://www.npr.org/story', publishedAt: '2026-09-30T10:00:00Z',
        });
        expect(a.data_origin).toBe('live');
        expect(a.source_url).toBe('https://www.npr.org/story');
        expect(a.published_at).toBe('2026-09-30T10:00:00.000Z');
        expect(a.attribution).toBe('NPR');
        expect(a.credit.text).toBe('NPR');
    });

    test('a hostile permalink becomes null, the credit stays', () => {
        const a = postAttribution({ sourceName: 'npr', sourceType: 'rss', url: 'javascript:alert(1)' });
        expect(a.source_url).toBeNull();
        expect(a.credit.text).toBe('NPR');
    });

    test('a permalink on another site is dropped, the credit stays', () => {
        const a = postAttribution({ sourceName: 'npr', sourceType: 'rss', url: 'https://evil.example/login' });
        expect(a.source_url).toBeNull();
        expect(a.credit.text).toBe('NPR');
    });

    test('a demo post: no credit, no link, no attribution, labelled demo', () => {
        const a = postAttribution({
            sourceName: 'npr', sourceType: 'demo', url: 'https://www.npr.org/story',
        });
        expect(a.data_origin).toBe('demo');
        expect(a.credit).toBeNull();
        expect(a.source_url).toBeNull();
        expect(a.attribution).toBeNull();
    });

    test('an unknown (retired) slug: no credit, no attribution and no link (D5)', () => {
        const a = postAttribution({ sourceName: 'wired_ai', sourceType: 'rss', url: 'https://example.org/x' });
        expect(a.credit).toBeNull();
        expect(a.attribution).toBeNull();
        expect(a.source_url).toBeNull();
        expect(a.data_origin).toBe('live');
    });

    test('a removed-text post that kept no URL: credit, no link', () => {
        const a = postAttribution({ sourceName: 'hacker_news', sourceType: 'api', url: null });
        expect(a.credit.text).toBe('Hacker News');
        expect(a.source_url).toBeNull();
        expect(a.published_at).toBeNull();
    });

    test('published_at: only a real date is passed through, as ISO UTC', () => {
        const at = (publishedAt) => postAttribution({ sourceName: 'npr', sourceType: 'rss', publishedAt }).published_at;
        expect(at(5)).toBeNull();
        expect(at('x'.repeat(100))).toBeNull();
        expect(at('')).toBeNull();
        expect(at('<img src=x onerror=1>')).toBeNull();
        expect(at('2026-09-29T10:00:00Z')).toBe('2026-09-29T10:00:00.000Z');
    });

    test('a missing source name never yields a link (it fails closed, not to the base rule)', () => {
        expect(postAttribution({ sourceType: 'rss', url: 'https://example.org/x' }).source_url).toBeNull();
        expect(postAttribution({ sourceType: 'rss', sourceName: null, url: 'https://example.org/x' }).source_url).toBeNull();
        expect(postAttribution({ sourceType: 'rss', sourceName: 'npr', url: 'https://www.npr.org/x' }).source_url).toBe('https://www.npr.org/x');
    });

    test('a missing source type throws: a demo post can never be credited by omission', () => {
        expect(() => postAttribution()).toThrow(/sourceType is required/);
        expect(() => postAttribution({ sourceName: 'npr' })).toThrow(/sourceType is required/);
        expect(() => postAttribution({ sourceName: 'npr', sourceType: '' })).toThrow(/sourceType is required/);
        expect(() => postAttribution({ sourceName: 'npr', sourceType: null })).toThrow(/sourceType is required/);
    });
});

describe('creditsCatalogue', () => {
    test('returns one entry per requested slug that has a credit, in registry order, with its terms link', () => {
        const rows = creditsCatalogue(['arxiv', 'npr', 'reddit_artificial', 'npr']);
        expect(rows.map(r => r.slug)).toEqual(['npr', 'arxiv']);
        const npr = rows.find(r => r.slug === 'npr');
        expect(npr).toEqual(expect.objectContaining({
            name: 'NPR', category: 'news', terms_url: 'https://www.npr.org/about-npr/179876898/terms-of-use',
        }));
        expect(npr.credit.text).toBe('NPR');
    });

    test('an empty or non-array input is an empty catalogue', () => {
        expect(creditsCatalogue([])).toEqual([]);
        expect(creditsCatalogue(null)).toEqual([]);
    });

    test('site notices state the redaction and linking policy', () => {
        expect(SITE_NOTICES.excerpts).toMatch(/shortened/);
        expect(SITE_NOTICES.excerpts).toMatch(/redacted/);
        expect(SITE_NOTICES.demo).toMatch(/fictional/);
        expect(SITE_NOTICES.links).toMatch(/original/);
    });
});
