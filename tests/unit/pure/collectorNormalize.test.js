// tests/unit/pure/collectorNormalize.test.js
// Collector item → pipeline payload (src/collectors/normalize.js) and the AI
// scope filter (src/collectors/ai-filter.js): allowlisted fields only,
// city-level location with its basis, identity links dropped.

'use strict';

const { toPayload, htmlToText, nearestCity, externalId, isoDate, IDENTITY_URL_RE } = require('../../../src/collectors/normalize');
const { isAiRelated } = require('../../../src/collectors/ai-filter');
const { getSource } = require('../../../src/config/source-registry');
const { PII_FIELDS } = require('../../../src/pipeline/ingest');

const npr = getSource('npr');
const hn = getSource('hacker_news');
const route = (src) => src.routes[0];

describe('toPayload', () => {
    test('builds only allowlisted fields — identity fields cannot pass through', () => {
        const p = toPayload({
            id: '1', title: '<b>AI</b> &amp; jobs', text: '<p>Machine learning&nbsp;news</p>',
            url: 'https://www.npr.org/x', publishedAt: '2026-09-28T08:00:00Z',
            author: 'someone', username: 'someone', user: { location: 'Paris' },
        }, npr, route(npr));
        expect(Object.keys(p).sort()).toEqual(['attribution', 'id', 'language', 'license', 'location', 'location_basis',
            'published_at', 'route', 'source_slug', 'text', 'title', 'url'].sort());
        for (const f of PII_FIELDS) expect(p).not.toHaveProperty(f);
        expect(p.title).toBe('AI & jobs');
        expect(p.text).toBe('AI & jobs\n\nMachine learning news');
        expect(p.attribution).toBe('NPR');
        expect(p.id).toBe('technology-rss:1');
    });

    test('editorial source with no content location → publisher city', () => {
        const p = toPayload({ id: '1', title: 'AI' }, npr, route(npr));
        expect(p).toMatchObject({ location: 'Washington, D.C.', location_basis: 'publisher' });
    });

    test('platform source gets no publisher city', () => {
        const p = toPayload({ id: '1', title: 'AI' }, hn, route(hn));
        expect(p).toMatchObject({ location: '', location_basis: null });
    });

    test('a geotag rounds to the nearest registry city within 50 km (content basis)', () => {
        const osm = getSource('openstreetmap');
        const near = toPayload({ id: '1', title: 'AI map', geo: { lat: 51.52, lng: -0.10 } }, osm, osm.routes[0]);
        expect(near).toMatchObject({ location: 'London', location_basis: 'content' });
        const far = toPayload({ id: '2', title: 'AI map', geo: { lat: 0, lng: -30 } }, osm, osm.routes[0]);
        expect(far.location).toBe('');
        expect(nearestCity('x', 'y')).toBeNull();
    });

    test('an item-level city resolves through the city registry, else is ignored', () => {
        const nyt = getSource('nyt');
        expect(toPayload({ id: '1', title: 'AI', city: 'London' }, nyt, nyt.routes[0]).location).toBe('London');
        expect(toPayload({ id: '1', title: 'AI', city: 'Atlantis' }, nyt, nyt.routes[0])).toMatchObject({ location: 'New York', location_basis: 'publisher' });
    });

    test('a route-level homeCity overrides the source (GitHub blog vs GitHub issues)', () => {
        const gh = getSource('github');
        expect(toPayload({ id: '1', title: 'AI' }, gh, gh.routes[2]).location).toBe('San Francisco');
        expect(toPayload({ id: '1', title: 'AI' }, gh, gh.routes[1]).location).toBe('');
    });

    test('links that name a person are not stored', () => {
        const osm = getSource('openstreetmap');
        const p = toPayload({ id: '1', title: 'AI', url: 'https://www.openstreetmap.org/user/someone/diary/1' }, osm, osm.routes[0]);
        expect(p.url).toBeNull();
        expect(IDENTITY_URL_RE.test('https://medium.com/@someone/post')).toBe(true);
        expect(IDENTITY_URL_RE.test('https://news.ycombinator.com/item?id=1')).toBe(false);
    });

    test('no id or no text → null; long ids are hashed; text is capped', () => {
        expect(toPayload({ title: 'x' }, hn, route(hn))).toBeNull();
        expect(toPayload({ id: '1' }, hn, route(hn))).toBeNull();
        expect(toPayload(null, hn, route(hn))).toBeNull();
        expect(externalId('r', 'c-Someone Name-2026')).toMatch(/^r:[0-9a-f]{64}$/);
        expect(externalId('r', '')).toBe('');
        expect(toPayload({ id: '1', title: 'AI', text: 'x'.repeat(9000) }, hn, route(hn)).text.length).toBeLessThanOrEqual(4000);
    });

    test('dates: ISO strings, epoch seconds and ms; invalid → null; language', () => {
        expect(isoDate(1759050000)).toBe('2025-09-28T09:00:00.000Z');
        expect(isoDate(1759050000000)).toBe('2025-09-28T09:00:00.000Z');
        expect(isoDate('nope')).toBeNull();
        expect(toPayload({ id: '1', title: 'AI', language: 'DE' }, hn, route(hn)).language).toBe('de');
        expect(toPayload({ id: '1', title: 'AI', language: 'en-US' }, hn, route(hn)).language).toBe('en');
    });

    test('in-text @handles and e-mail addresses are redacted before storage', () => {
        const { redactIdentities } = require('../../../src/collectors/normalize');
        expect(redactIdentities('playlog | @Yoyolyang | 2p, ping @a_b.c and mail x.y@example.org'))
            .toBe('playlog | @[user] | 2p, ping @[user] and mail [email]');
        const p = toPayload({ id: '1', title: 'AI issue by @someone' }, hn, route(hn));
        expect(p.title).toBe('AI issue by @[user]');
    });

    test('htmlToText strips scripts, tags and entities', () => {
        expect(htmlToText('<script>x()</script><p>A&#39;s &#x41;I&hellip;</p>')).toBe("A's AI…");
        expect(htmlToText(null)).toBe('');
    });
});

describe('isAiRelated (collection scope filter)', () => {
    test.each([
        'OpenAI cancels model release', 'New AI rules', 'A.I. in schools', 'LLMs and law',
        'Machine learning forecasts', 'Deepfake scandal', 'Robotaxi launch', 'GPT-5 benchmark',
    ])('keeps: %s', t => expect(isAiRelated(t)).toBe(true));

    test.each([
        'Thai food festival', 'He said yes', 'Mortgage rates rise', 'Rain in Spain', '',
    ])('drops: %s', t => expect(isAiRelated(t)).toBe(false));

    test('non-strings are not AI', () => expect(isAiRelated(undefined)).toBe(false));
});
