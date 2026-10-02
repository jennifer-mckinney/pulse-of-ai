// Pure unit tests for public/js/attribution.js (PulseAttribution) and
// public/js/credits.js (PulseCredits) — K1. A tiny fake document stands in for
// the DOM: the modules must build elements with createElement + textContent
// only (a fake without innerHTML support proves it: any innerHTML write is a
// failure), and hostile data must stay text.
'use strict';

const attribution = require('../../../public/js/attribution');
const credits = require('../../../public/js/credits');
const utils = require('../../../public/js/utils');

// ── Fake DOM ────────────────────────────────────────────────────────────────

function makeDoc() {
    function make(tag) {
        const attrs = {};
        const n = {
            tagName: tag.toUpperCase(),
            className: '',
            children: [],
            textContent: '',
            href: undefined,
            target: undefined,
            rel: undefined,
            setAttribute(k, v) { attrs[k] = String(v); },
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
            appendChild(c) { n.children.push(c); c.parent = n; return c; },
            removeChild(c) { n.children = n.children.filter(x => x !== c); return c; },
            get firstChild() { return n.children[0] || null; },
        };
        // innerHTML must never be used: writing it fails the test loudly
        Object.defineProperty(n, 'innerHTML', {
            set() { throw new Error('innerHTML must not be used'); },
            get() { return ''; },
        });
        return n;
    }
    return { createElement: make };
}

const textOf = (n) => (n.children.length ? n.children.map(textOf).join('') : n.textContent);
const find = (n, pred, out = []) => { if (pred(n)) out.push(n); n.children.forEach(c => find(c, pred, out)); return out; };
const links = (n) => find(n, c => c.tagName === 'A');

const live = (extra = {}) => ({
    isDemo: false,
    data_origin: 'live',
    attribution: 'NPR',
    source_url: 'https://www.npr.org/2026/09/30/story',
    published_at: '2026-09-29T10:00:00.000Z',
    credit: { text: 'NPR', required: true, license: null, license_url: null, modified: false, cite_date: false, notice: null, notice_url: null },
    ...extra,
});

describe('safeHttpUrl (browser mirror of the server rule)', () => {
    test.each([
        'https://www.npr.org/x', 'http://example.org/a?b#c',
    ])('accepts %s', (u) => expect(attribution.safeHttpUrl(u)).toBe(u));

    test('only a default port; credential keys leave a fragment too', () => {
        expect(attribution.safeHttpUrl('https://example.org:8443/x')).toBeNull();
        expect(attribution.safeHttpUrl('https://example.org/x#access_token=abc')).toBe('https://example.org/x');
    });

    test('strips tracking/credential keys, trims, normalises', () => {
        expect(attribution.safeHttpUrl(' https://www.npr.org/x?utm_source=a&id=1 ')).toBe('https://www.npr.org/x?id=1');
        expect(attribution.safeHttpUrl('HTTPS://Example.ORG')).toBe('https://example.org/');
    });

    test.each([
        'javascript:alert(1)', 'data:text/html,x', 'ftp://example.org/', '//example.org', '/x',
        'https://u:p@example.org/', 'https://localhost/', 'https://intranet/', 'https://127.0.0.1/',
        'https://[::1]/', 'https://example.org/a b', 'https://example.org/a\nb', '', null, undefined, 5, {},
        'http://localhost.:3000/x', 'http://intranet./', 'https://router.local/', 'https://metadata.google.internal/',
        'https://%2e/', 'https://ex_ample.org/', 'https://example.org/\u202eexe', 'https://example.org/\u200b',
        'https://example.org/' + 'a'.repeat(2100),
    ])('rejects %p', (u) => expect(attribution.safeHttpUrl(u)).toBeNull());
});

describe('hostOf', () => {
    test('strips www and lower-cases', () => {
        expect(attribution.hostOf('https://WWW.NPR.org/x')).toBe('npr.org');
        expect(attribution.hostOf('https://en.wikipedia.org/wiki/X')).toBe('en.wikipedia.org');
    });
    test('an unparseable URL is an empty host', () => {
        expect(attribution.hostOf('not a url')).toBe('');
    });
});

describe('creditModel: the cite date', () => {
    const pew = (published_at) => live({ published_at, credit: { ...live().credit, cite_date: true } });
    test('an ISO string keeps its own calendar day (no timezone shift)', () => {
        expect(attribution.creditModel(pew('2026-09-29T23:30:00-08:00')).date).toBe('2026-09-29');
        expect(attribution.creditModel(pew('2026-09-29')).date).toBe('2026-09-29');
    });
    test('a calendar day that does not exist is not a date (the server agrees)', () => {
        expect(attribution.creditModel(pew('2026-02-31')).date).toBeNull();
        expect(attribution.parseIsoDate('2026-02-31')).toBeNull();
        expect(attribution.parseIsoDate('2026-09-29T10:00')).toBe('2026-09-29T10:00:00.000Z');
    });
    test('a lenient-but-not-ISO string is not a date', () => {
        expect(attribution.creditModel(pew('<img src=x onerror=1>')).date).toBeNull();
        expect(attribution.creditModel(pew('Sept 29')).date).toBeNull();
        expect(attribution.creditModel(pew('x'.repeat(100))).date).toBeNull();
    });
});

describe('creditModel', () => {
    test('a live post: credit text, link, host', () => {
        const m = attribution.creditModel(live());
        expect(m).toEqual(expect.objectContaining({
            demo: false, text: 'NPR', url: 'https://www.npr.org/2026/09/30/story', host: 'npr.org',
            license: null, modified: false, date: null,
        }));
    });

    test('Pew: the publication date appears only when cite_date is set', () => {
        const pew = live({ credit: { ...live().credit, text: 'Pew Research Center, Washington, D.C.', cite_date: true } });
        expect(attribution.creditModel(pew).date).toBe('2026-09-29');
        expect(attribution.creditModel(live()).date).toBeNull();
        expect(attribution.creditModel({ ...pew, published_at: 'garbage' }).date).toBeNull();
        expect(attribution.creditModel({ ...pew, published_at: null }).date).toBeNull();
    });

    test('a licence link is kept only with a licence name and a safe URL', () => {
        const wiki = live({ credit: { ...live().credit, text: 'Wikipedia', license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', modified: true } });
        expect(attribution.creditModel(wiki)).toEqual(expect.objectContaining({
            license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', modified: true,
        }));
        const bad = live({ credit: { ...wiki.credit, license_url: 'javascript:alert(1)' } });
        expect(attribution.creditModel(bad).licenseUrl).toBeNull();
        expect(attribution.creditModel(bad).license).toBe('CC BY-SA 4.0');
    });

    test('demo: a bundled-fallback post and a demo-feed post both show the demo label, never a credit or link', () => {
        for (const p of [live({ isDemo: true }), live({ data_origin: 'demo' })]) {
            expect(attribution.creditModel(p)).toEqual({ demo: true, label: attribution.DEMO_LABEL });
        }
    });

    test('a row from an older server (no credit object) falls back to its attribution string', () => {
        expect(attribution.creditModel({ attribution: 'NPR' })).toEqual(expect.objectContaining({ text: 'NPR', url: null }));
    });

    test('a hostile source_url is dropped; the credit stays', () => {
        const m = attribution.creditModel(live({ source_url: 'javascript:alert(1)' }));
        expect(m.url).toBeNull();
        expect(m.text).toBe('NPR');
    });

    test('nothing to credit (retired slug, no link) is null; so is a non-object', () => {
        expect(attribution.creditModel({ source_name: 'wired_ai', credit: null, attribution: null, source_url: null })).toBeNull();
        expect(attribution.creditModel(null)).toBeNull();
        expect(attribution.creditModel('x')).toBeNull();
        expect(attribution.creditModel(undefined)).toBeNull();
    });

    test('a link with no credit text still shows the link', () => {
        const m = attribution.creditModel({ credit: null, attribution: null, source_url: 'https://example.org/x' });
        expect(m.text).toBeNull();
        expect(m.url).toBe('https://example.org/x');
    });
});

describe('buildCredit', () => {
    test('credit line: "via NPR" and a safe external link showing the host', () => {
        const doc = makeDoc();
        const line = attribution.buildCredit(doc, live());
        expect(textOf(line)).toBe('via NPR · npr.org ↗');
        const [a] = links(line);
        expect(a.href).toBe('https://www.npr.org/2026/09/30/story');
        expect(a.target).toBe('_blank');
        expect(a.rel).toBe('noopener noreferrer');
        expect(a.getAttribute('aria-label')).toBe('Read the original at npr.org (opens in a new tab)');
        expect(line.className).toBe('credit mono');
    });

    test('Wikipedia: link, licence link and the modified note', () => {
        const doc = makeDoc();
        const wiki = live({
            source_url: 'https://en.wikipedia.org/wiki/Talk:AI',
            credit: { text: 'Wikipedia', required: true, license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', modified: true, cite_date: false, notice: null, notice_url: null },
        });
        const line = attribution.buildCredit(doc, wiki);
        expect(textOf(line)).toBe('via Wikipedia · en.wikipedia.org ↗ · CC BY-SA 4.0 · excerpt shortened and redacted');
        expect(links(line).map(a => a.href)).toEqual([
            'https://en.wikipedia.org/wiki/Talk:AI', 'https://creativecommons.org/licenses/by-sa/4.0/',
        ]);
    });

    test('Pew: citation form with the date', () => {
        const doc = makeDoc();
        const pew = live({ source_url: 'https://www.pewresearch.org/x', credit: { ...live().credit, text: 'Pew Research Center, Washington, D.C.', cite_date: true } });
        expect(textOf(attribution.buildCredit(doc, pew))).toBe('via Pew Research Center, Washington, D.C. (2026-09-29) · pewresearch.org ↗');
    });

    test('arXiv: the acknowledgement notice is shown; a notice link only when safe', () => {
        const doc = makeDoc();
        const ax = live({ source_url: 'https://arxiv.org/abs/1', credit: { ...live().credit, text: 'arXiv', notice: 'Thank you to arXiv for use of its open access interoperability.', notice_url: null } });
        const line = attribution.buildCredit(doc, ax);
        expect(textOf(line)).toContain('Thank you to arXiv for use of its open access interoperability.');
        expect(links(line)).toHaveLength(1);
        const pm = live({ credit: { ...live().credit, text: 'PubMed / PMC', notice: 'NCBI notice', notice_url: 'https://www.ncbi.nlm.nih.gov/home/about/policies/' } });
        expect(links(attribution.buildCredit(doc, pm)).map(a => a.href)).toContain('https://www.ncbi.nlm.nih.gov/home/about/policies/');
        const bad = live({ credit: { ...live().credit, notice: 'x', notice_url: 'javascript:alert(1)' } });
        expect(links(attribution.buildCredit(doc, bad))).toHaveLength(1);
    });

    test('demo: only the demo label, no link, flagged credit-demo', () => {
        const doc = makeDoc();
        const line = attribution.buildCredit(doc, live({ isDemo: true }));
        expect(textOf(line)).toBe(attribution.DEMO_LABEL);
        expect(links(line)).toHaveLength(0);
        expect(line.className).toContain('credit-demo');
    });

    test('hostile text stays text: no innerHTML, markup is not interpreted', () => {
        const doc = makeDoc();
        const evil = live({ credit: { ...live().credit, text: '<img src=x onerror=alert(1)>' } });
        const line = attribution.buildCredit(doc, evil);
        expect(textOf(line)).toContain('<img src=x onerror=alert(1)>');
        expect(find(line, c => c.tagName === 'IMG')).toHaveLength(0);
    });

    test('a javascript: link is never rendered as a link', () => {
        const doc = makeDoc();
        const line = attribution.buildCredit(doc, live({ source_url: 'javascript:alert(1)' }));
        expect(links(line)).toHaveLength(0);
        expect(textOf(line)).toBe('via NPR');
    });

    test('nothing to credit builds nothing; a missing document builds nothing', () => {
        expect(attribution.buildCredit(makeDoc(), { credit: null, attribution: null, source_url: null })).toBeNull();
        expect(attribution.buildCredit(null, live())).toBeNull();
    });

    test('a custom class name is honoured', () => {
        expect(attribution.buildCredit(makeDoc(), live(), 'credit mono extra').className).toBe('credit mono extra');
    });
});

describe('utils re-exports the credit helpers (one mechanism for story.js and ui.js)', () => {
    test('same functions', () => {
        expect(utils.buildCredit).toBe(attribution.buildCredit);
        expect(utils.creditModel).toBe(attribution.creditModel);
        expect(utils.safeHttpUrl).toBe(attribution.safeHttpUrl);
    });
});

describe('PulseCredits.render', () => {
    const mkEls = (doc) => ({ notices: doc.createElement('ul'), sources: doc.createElement('div') });
    const payload = {
        sources: [
            { slug: 'npr', name: 'NPR', category: 'news', terms_url: 'https://www.npr.org/about-npr/179876898/terms-of-use', credit: { text: 'NPR', license: null, license_url: null, notice: null, notice_url: null } },
            { slug: 'wikipedia', name: 'Wikipedia / Wikimedia Foundation', category: 'nonprofit', terms_url: 'https://www.mediawiki.org/x', credit: { text: 'Wikipedia', license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', notice: null, notice_url: null } },
            { slug: 'arxiv', name: 'arXiv', category: 'academic', terms_url: 'javascript:alert(1)', credit: { text: 'arXiv', license: 'CC0 (metadata)', license_url: null, notice: 'Thank you to arXiv for use of its open access interoperability.', notice_url: null } },
        ],
        notices: { excerpts: 'Excerpts are shortened.', links: 'Every excerpt links back.', demo: 'Demo posts are fictional.' },
    };

    test('renders the notices and one row per source, grouped by category', () => {
        const doc = makeDoc();
        const els = mkEls(doc);
        expect(credits.render(doc, payload, els)).toBe(true);
        expect(els.notices.children.map(textOf)).toEqual([
            'Excerpts are shortened.', 'Every excerpt links back.', 'Demo posts are fictional.',
        ]);
        const cats = find(els.sources, c => c.className === 'credits-cat mono').map(textOf);
        expect(cats).toEqual(['News', 'Non-profit', 'Academic']);   // the main page's display labels
        const text = textOf(els.sources);
        expect(text).toContain('Excerpts are credited: via NPR');
        expect(text).toContain('Licence: CC BY-SA 4.0');
        expect(text).toContain('Thank you to arXiv for use of its open access interoperability.');
    });

    test('only safe URLs become links (terms javascript: is dropped; licence name stays as text)', () => {
        const doc = makeDoc();
        const els = mkEls(doc);
        credits.render(doc, payload, els);
        const hrefs = links(els.sources).map(a => a.href);
        expect(hrefs).toContain('https://www.npr.org/about-npr/179876898/terms-of-use');
        expect(hrefs).toContain('https://creativecommons.org/licenses/by-sa/4.0/');
        expect(hrefs.some(h => /^javascript:/.test(h))).toBe(false);
        links(els.sources).forEach(a => { expect(a.rel).toBe('noopener noreferrer'); expect(a.target).toBe('_blank'); });
    });

    test('an empty list says so; a malformed payload says it could not load', () => {
        let doc = makeDoc();
        let els = mkEls(doc);
        expect(credits.render(doc, { sources: [], notices: {} }, els)).toBe(true);
        expect(textOf(els.sources)).toBe('No source has contributed posts yet.');
        doc = makeDoc(); els = mkEls(doc);
        expect(credits.render(doc, null, els)).toBe(false);
        expect(textOf(els.sources)).toMatch(/could not be loaded/);
        doc = makeDoc(); els = mkEls(doc);
        expect(credits.render(doc, { sources: 'x' }, els)).toBe(false);
    });

    test('re-rendering replaces, never appends', () => {
        const doc = makeDoc();
        const els = mkEls(doc);
        credits.render(doc, payload, els);
        credits.render(doc, payload, els);
        expect(find(els.sources, c => c.className === 'credits-row')).toHaveLength(3);
    });

    test('groupByCategory skips malformed rows and keeps first-appearance order', () => {
        const g = credits.groupByCategory([
            { slug: 'a', category: 'news' }, null, { name: 'no slug' }, { slug: 'b', category: 'blog' }, { slug: 'c', category: 'news' }, { slug: 'd' },
        ]);
        expect(g.map(x => [x.category, x.rows.map(r => r.slug)])).toEqual([
            ['news', ['a', 'c']], ['blog', ['b']], ['other', ['d']],
        ]);
        expect(credits.groupByCategory(null)).toEqual([]);
    });
});
