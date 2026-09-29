// tests/unit/pure/collectorRedact.test.js
// src/collectors/redact.js and errors.js classifyError (F10-1, F10-13).

'use strict';

const { redactUrl, redactUrlsIn, scrub, secretEnvValues } = require('../../../src/collectors/redact');
const { classifyError, HttpError, AccessDeniedError, RobotsDisallowedError, GateClosedError, ParseError, ERROR_KINDS } =
    require('../../../src/collectors/errors');
const { HttpClient } = require('../../../src/collectors/http');
const { TEST_ENV } = require('../../helpers/fixtureTransport');

describe('redactUrl', () => {
    test.each([
        ['https://www.googleapis.com/youtube/v3/search?part=snippet&key=AIzaSECRET&q=ai', 'key'],
        ['https://api.nytimes.com/svc/search/v2/articlesearch.json?fq=x&api-key=NYTSECRET', 'api-key'],
        ['https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?api_key=NCBI&email=ops%40example.org', 'api_key'],
        ['https://ieeexploreapi.ieee.org/api/v1/search/articles?apikey=IEEESECRET', 'apikey'],
        ['https://x.example/?access_token=T&client_secret=C&sig=S&signature=S2&token=T2', 'access_token'],
    ])('%s: every credential parameter is REDACTED', (url) => {
        const out = redactUrl(url);
        expect(out).not.toMatch(/SECRET|=T\b|=C\b|=S\b|=S2|=T2|NCBI&|ops%40/);
        expect(out).toMatch(/REDACTED/);
    });

    test('non-secret parameters, host and path are kept', () => {
        expect(redactUrl('https://hn.algolia.com/api/v1/search_by_date?query=ai&tags=story'))
            .toBe('https://hn.algolia.com/api/v1/search_by_date?query=ai&tags=story');
    });

    test('Telegram bot token in the path and URL userinfo are redacted', () => {
        expect(redactUrl('https://api.telegram.org/bot123:ABCsecret/getUpdates?offset=1'))
            .toBe('https://api.telegram.org/botREDACTED/getUpdates?offset=1');
        expect(redactUrl('https://user:pass@feeds.example.org/x')).toBe('https://REDACTED:REDACTED@feeds.example.org/x');
    });

    test('an unparseable URL yields no fragment of it', () => {
        expect(redactUrl('not a url ?key=SECRET')).toBe('[unparseable url]');
    });

    test('redactUrlsIn rewrites every URL inside prose, keeping trailing punctuation', () => {
        expect(redactUrlsIn('failed for https://a.example/x?key=K1, then https://b.example/?token=K2.'))
            .toBe('failed for https://a.example/x?key=REDACTED, then https://b.example/?token=REDACTED.');
    });
});

describe('scrub', () => {
    const env = {
        YOUTUBE_API_KEY: 'AIza+Secret/Value=', NCBI_EMAIL: 'ops@example.org', SOME_OTHER_TOKEN: 'tok-1234',
        POSTGRES_PASSWORD: 'pgpass-xyz', COLLECTOR_CONTACT_URL: 'https://contact.example/me', NCBI_TOOL: 'pulse-of-ai',
    };

    test('removes every secret env value, raw and URL-encoded', () => {
        const text = [
            'raw AIza+Secret/Value=', `enc ${encodeURIComponent('AIza+Secret/Value=')}`,
            `form ${new URLSearchParams({ v: 'AIza+Secret/Value=' }).toString().slice(2)}`,
            'mail ops@example.org', `mail-enc ${encodeURIComponent('ops@example.org')}`, 'tok tok-1234', 'db pgpass-xyz',
        ].join(' | ');
        const out = scrub(text, env);
        for (const v of ['AIza+Secret/Value=', 'ops@example.org', 'tok-1234', 'pgpass-xyz', encodeURIComponent('AIza+Secret/Value=')]) {
            expect(out).not.toContain(v);
        }
        expect(out.match(/\[redacted\]/g)).toHaveLength(7);
    });

    test('keeps settings (contact URL, NCBI tool) and redacts URL credentials without env help', () => {
        const out = scrub('ua https://contact.example/me tool pulse-of-ai https://x.example/?key=UNKNOWN', env);
        expect(out).toBe('ua https://contact.example/me tool pulse-of-ai https://x.example/?key=REDACTED');
    });

    test('ignores values too short to be secrets and caps the length', () => {
        expect(secretEnvValues({ GITHUB_TOKEN: 'ab', HF_TOKEN: '  ' })).toEqual([]);
        expect(scrub('x'.repeat(5000), {})).toHaveLength(2000);
        expect(scrub(null, env)).toBeNull();
    });
});

describe('classifyError', () => {
    test('every kind returned is a declared kind; no free text', () => {
        const cases = [
            [new AccessDeniedError('m', { status: 403 }), { error_kind: 'access_denied', http_status: 403 }],
            [new RobotsDisallowedError('m'), { error_kind: 'robots', http_status: null }],
            [new GateClosedError('m'), { error_kind: 'gate', http_status: null }],
            [new ParseError('m', { status: 200 }), { error_kind: 'parse', http_status: 200 }],
            [new SyntaxError('Unexpected token < in JSON'), { error_kind: 'parse', http_status: null }],
            [new HttpError('m', { status: 503 }), { error_kind: 'http_5xx', http_status: 503 }],
            [new HttpError('m', { status: 404 }), { error_kind: 'http_4xx', http_status: 404 }],
            [new HttpError('request failed', { cause: { name: 'TimeoutError', message: 'x' } }), { error_kind: 'timeout', http_status: null }],
            [new HttpError('request failed: ECONNRESET'), { error_kind: 'network', http_status: null }],
            [Object.assign(new Error('x'), { kind: 'store' }), { error_kind: 'store', http_status: null }],
            [new Error('anything else'), { error_kind: 'internal', http_status: null }],
        ];
        for (const [err, want] of cases) {
            const got = classifyError(err);
            expect(got).toEqual(want);
            expect(ERROR_KINDS).toContain(got.error_kind);
        }
    });
});

describe('HttpClient errors carry redacted URLs only (F10-1) and never a body (F10-13)', () => {
    const sleep = () => Promise.resolve();

    test('a 503 after retries names the URL with the key REDACTED', async () => {
        const http = new HttpClient({ env: TEST_ENV, sleep, transport: async () => ({ status: 503, headers: {}, body: 'down' }) });
        const err = await http.request('https://api.example.org/v1?q=ai&key=SECRETKEY').catch(e => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err.message).toBe('HTTP 503 from https://api.example.org/v1?q=ai&key=REDACTED');
        expect(err.url).toBe('https://api.example.org/v1?q=ai&key=REDACTED');
        expect(JSON.stringify({ ...err, m: err.message })).not.toContain('SECRETKEY');
    });

    test('a transport error that quotes the URL is redacted too', async () => {
        const http = new HttpClient({
            env: TEST_ENV, sleep,
            transport: async (url) => { throw Object.assign(new Error(`aborted due to timeout: ${url}`), { name: 'TimeoutError' }); },
        });
        const err = await http.request('https://api.example.org/v1?api_key=SECRETKEY').catch(e => e);
        expect(err.message).not.toContain('SECRETKEY');
        expect(classifyError(err).error_kind).toBe('timeout');
    });

    test('invalid JSON is a ParseError that does not quote the body', async () => {
        const http = new HttpClient({ env: TEST_ENV, sleep, transport: async () => ({ status: 200, headers: {}, body: '<html>secret internal page' }) });
        const err = await http.json('https://api.example.org/v1?token=T0KEN').catch(e => e);
        expect(err).toBeInstanceOf(ParseError);
        expect(err.message).toBe('invalid JSON from https://api.example.org/v1?token=REDACTED');
        expect(err.message).not.toMatch(/secret internal|Unexpected token/);
    });
});
