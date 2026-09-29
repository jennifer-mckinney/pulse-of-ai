// tests/unit/pure/collectorIdentity.test.js
// Decision D2 (ingest@1.3.0): in-text identity redaction, identity links and
// the provenance fingerprint (F10-6, F10-14, P10-15).

'use strict';

const crypto = require('crypto');
const { isIdentityUrl, redactText } = require('../../../src/collectors/identity');
const {
    provenanceKey, provenanceFingerprint, isIdentityBearingId, storedExternalId, verify,
} = require('../../../src/collectors/provenance');
const { toPayload } = require('../../../src/collectors/normalize');

const KEY = 'k'.repeat(64);

describe('isIdentityUrl (profile and user-namespace links)', () => {
    test.each([
        'https://www.openstreetmap.org/user/jane/diary/1',
        'https://github.com/alice',
        'https://gitlab.com/bob',
        'https://x.com/someone/status/1',
        'https://twitter.com/someone',
        'https://www.linkedin.com/in/jane-doe',
        'https://medium.com/@bob/a-post',
        'https://medium.com/bob',
        'https://jane.substack.com',
        'https://jane.substack.com/about',
        'https://www.facebook.com/jane.doe',
        'https://instagram.com/jane',
        'https://t.me/somechannel',
        'https://www.youtube.com/channel/UC123',
        'https://en.wikipedia.org/wiki/User:Example',
        'https://en.wikipedia.org/wiki/User_talk:Example',
        'https://en.wikipedia.org/wiki/Special:Contributions/192.0.2.1',
        'https://discourse.example/u/jane',
    ])('%s identifies a person', (u) => expect(isIdentityUrl(u)).toBe(true));

    test.each([
        'https://github.com/openai/gpt-2',
        'https://github.com/topics/machine-learning',
        'https://jane.substack.com/p/ai-post',
        'https://medium.com/tag/ai',
        'https://www.bbc.co.uk/news/technology-1',
        'https://arxiv.org/abs/2401.00001',
        'https://news.ycombinator.com/item?id=1',
        'https://en.wikipedia.org/wiki/Talk:Artificial_intelligence',
    ])('%s is content, kept', (u) => expect(isIdentityUrl(u)).toBe(false));
});

describe('redactText (ingest@1.3.0)', () => {
    test('e-mail addresses and @handles', () => {
        expect(redactText('mail a.b@example.org or ping @alice_1')).toBe('mail [email] or ping @[user]');
    });

    test('phone numbers: E.164 and NANP; ordinary numbers stay', () => {
        expect(redactText('Call +44 20 7946 0958 or (415) 555-2671 or 415.555.2671 or +1 415 555 2671'))
            .toBe('Call [phone] or [phone] or [phone] or [phone]');
        expect(redactText('GPT-4 has 1760000000000 params; year 2024; v3.14159265; ISBN 978-3-16-148410-0'))
            .toBe('GPT-4 has 1760000000000 params; year 2024; v3.14159265; ISBN 978-3-16-148410-0');
    });

    test('identity links inside the text become [profile link]; content links stay', () => {
        expect(redactText('see https://github.com/alice and https://github.com/openai/gpt-2 and https://jane.substack.com'))
            .toBe('see [profile link] and https://github.com/openai/gpt-2 and [profile link]');
    });

    test('"cc <Name>" lines', () => {
        expect(redactText('Fixed in #12. cc John Smith for review')).toBe('Fixed in #12. cc [name] for review');
        expect(redactText('CC: Alice')).toBe('CC [name]');
        expect(redactText('cc @bob')).toBe('cc [name]');
    });

    test('trailing sign-offs are removed; a mid-text dash clause stays', () => {
        expect(redactText('Models are improving fast. — Jane Doe')).toBe('Models are improving fast.');
        expect(redactText('Good summary –John')).toBe('Good summary');
        expect(redactText('Transformers — the future of AI')).toBe('Transformers — the future of AI');
    });

    test('Wikipedia unsigned-comment notes go, name or IP and timestamp included', () => {
        expect(redactText('Nice point. —Preceding unsigned comment added by 192.0.2.1 (talk) 12:00, 5 May 2020 (UTC)'))
            .toBe('Nice point.');
        expect(redactText('Agree — Preceding unsigned comment added by Foo Bar (talk • contribs)')).toBe('Agree');
    });

    test('linear on hostile 1 MB inputs (F10-3): each under 200 ms', () => {
        for (const s of ['a', '<', '1', '+', '—', ' ', '@', 'h', 'https://x.com/', 'cc Ab ', '— Ab ', '(415) ']) {
            const input = s.repeat(Math.ceil((1 << 20) / s.length));
            const t = process.hrtime.bigint();
            redactText(input);
            expect(Number(process.hrtime.bigint() - t) / 1e6).toBeLessThan(200);
        }
    });
});

describe('provenance fingerprint (D2)', () => {
    test('key: PROVENANCE_KEY, else AUDIT_HASH_KEY, else none', () => {
        expect(provenanceKey({ PROVENANCE_KEY: 'p', AUDIT_HASH_KEY: 'a' })).toBe('p');
        expect(provenanceKey({ AUDIT_HASH_KEY: ' a ' })).toBe('a');
        expect(provenanceKey({ PROVENANCE_KEY: '  ' })).toBeNull();
        expect(provenanceKey({})).toBeNull();
    });

    test('HMAC-SHA256(key, slug:rawId:url), exactly', () => {
        const want = crypto.createHmac('sha256', KEY).update('hacker-news:123:https://news.ycombinator.com/item?id=123').digest('hex');
        expect(provenanceFingerprint(KEY, 'hacker-news', '123', 'https://news.ycombinator.com/item?id=123')).toBe(want);
        expect(provenanceFingerprint(KEY, 'hacker-news', '123', '')).toBe(
            crypto.createHmac('sha256', KEY).update('hacker-news:123:').digest('hex'));
        expect(provenanceFingerprint(null, 'x', '1', 'u')).toBeNull();
    });

    test('verify matches only the exact original (timing-safe), never without a key', () => {
        const stored = provenanceFingerprint(KEY, 's', '1', 'https://a.example/1');
        expect(verify({ key: KEY, slug: 's', rawId: '1', url: 'https://a.example/1', stored }).match).toBe(true);
        expect(verify({ key: KEY, slug: 's', rawId: '1', url: 'https://a.example/2', stored }).match).toBe(false);
        expect(verify({ key: 'other', slug: 's', rawId: '1', url: 'https://a.example/1', stored }).match).toBe(false);
        expect(verify({ key: null, slug: 's', rawId: '1', url: 'https://a.example/1', stored }).match).toBe(false);
        expect(verify({ key: KEY, slug: 's', rawId: '1', url: 'https://a.example/1', stored: null }).match).toBe(false);
    });
});

describe('stored external ids (F10-14)', () => {
    test.each(['123456', '2401.00001v2', 'PMID:3456', '10.1038/s41586-021-03819-2', 'item-42', 'r/abc_def'])(
        'a clean id %s is stored as-is', (id) => {
            expect(isIdentityBearingId(id)).toBe(false);
            expect(storedExternalId('route', id, KEY)).toBe(`route:${id}`);
        });

    test.each([
        'https://example.com/post?utm_source=x&token=abc',
        'https://www.openstreetmap.org/user/jane/diary/1',
        'https://github.com/alice',
        'id#frag', 'a@b', 'a%20b', 'has space', 'x'.repeat(201),
    ])('an identity-bearing or token-carrying id %s is fingerprinted', (id) => {
        expect(isIdentityBearingId(id)).toBe(true);
        const s = storedExternalId('route', id, KEY);
        expect(s).toBe(`route:fp:${crypto.createHmac('sha256', KEY).update(`id:route:${id}`).digest('hex')}`);
        expect(s).not.toContain(id.slice(0, 20));
    });

    test('without a key the id is still unreadable (unkeyed SHA-256); empty stays empty', () => {
        expect(storedExternalId('r', 'a@b', null)).toBe(`r:${crypto.createHash('sha256').update('a@b').digest('hex')}`);
        expect(storedExternalId('r', '  ', KEY)).toBe('');
        expect(storedExternalId('r', null, KEY)).toBe('');
    });
});

describe('toPayload carries the provenance fingerprint', () => {
    const source = { slug: 'hacker-news', category: 'forums' };
    const route = { id: 'hn-algolia', scope: 'all' };

    test('fingerprint over the raw upstream id and URL; the permalink is kept', () => {
        const p = toPayload({ id: '42', title: 'AI', text: 'LLM news', url: 'https://news.ycombinator.com/item?id=42' },
            source, route, { key: KEY });
        expect(p.id).toBe('hn-algolia:42');
        expect(p.url).toBe('https://news.ycombinator.com/item?id=42');
        expect(p.provenance_fingerprint).toBe(provenanceFingerprint(KEY, 'hacker-news', '42', 'https://news.ycombinator.com/item?id=42'));
    });

    test('an identity permalink is dropped but still fingerprinted, so the original proves the match', () => {
        const u = 'https://www.openstreetmap.org/user/jane/diary/7';
        const p = toPayload({ id: u, title: 'AI mapping', text: 'machine learning', url: u }, source, route, { key: KEY });
        expect(p.url).toBeNull();
        expect(p.id).toMatch(/^hn-algolia:fp:[0-9a-f]{64}$/);
        expect(p.provenance_fingerprint).toBe(provenanceFingerprint(KEY, 'hacker-news', u, u));
    });

    test('no key: no fingerprint (the receipt says so)', () => {
        const p = toPayload({ id: '1', text: 'AI' }, source, route);
        expect(p.provenance_fingerprint).toBeNull();
    });

    test('text is redacted with the 1.3.0 rules before storage', () => {
        const p = toPayload({ id: '1', text: 'AI is here, call (415) 555-2671 cc John Smith — Jane Doe' }, source, route, { key: KEY });
        expect(p.text).toBe('AI is here, call [phone] cc [name]');
    });
});
