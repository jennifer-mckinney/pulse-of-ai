// tests/unit/pure/collectorNetguard.test.js
// F10-2 (redirect / SSRF / credential forwarding) and F10-4 (response size,
// decompression bombs): src/collectors/netguard.js, src/collectors/
// transport.js and their enforcement in src/collectors/http.js.

'use strict';

const zlib = require('zlib');
const { PassThrough, Readable } = require('stream');
const { EventEmitter } = require('events');
const {
    checkUrl, isBlockedAddress, createGuardedLookup, hostAllowed, HostRefusedError, RedirectRefusedError,
} = require('../../../src/collectors/netguard');
const { createNetworkTransport, readBody, ResponseTooLargeError, DEFAULT_MAX_BYTES, ROBOTS_MAX_BYTES } =
    require('../../../src/collectors/transport');
const { HttpClient } = require('../../../src/collectors/http');
const { classifyError } = require('../../../src/collectors/errors');
const registry = require('../../../src/config/source-registry');
const { fixtureTransport, TEST_ENV } = require('../../helpers/fixtureTransport');

const sleep = () => Promise.resolve();
const client = transport => new HttpClient({ env: TEST_ENV, transport, sleep });

describe('isBlockedAddress', () => {
    test.each([
        '127.0.0.1', '127.8.8.8', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '100.64.0.1',
        '100.127.255.255', '169.254.169.254', '0.0.0.0', '0.1.2.3', '224.0.0.1', '255.255.255.255',
        '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
        '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1', '64:ff9b::a9fe:a9fe',
        'not-an-ip',
    ])('%s is blocked', ip => expect(isBlockedAddress(ip)).toBe(true));

    test.each(['8.8.8.8', '151.101.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
        '%s is public', ip => expect(isBlockedAddress(ip)).toBe(false),
    );
});

describe('checkUrl', () => {
    test.each([
        ['http://feeds.example.org/rss', /not https/],
        ['ftp://feeds.example.org/rss', /not https/],
        ['data:text/plain,hi', /not https/],
        ['https://127.0.0.1/x', /not a public address/],
        ['https://[::1]/x', /not a public address/],
        ['https://169.254.169.254/latest/meta-data/', /not a public address/],
        ['https://10.0.0.5/', /not a public address/],
        ['https://redis/', /local or internal/],
        ['https://postgres:5432/', /local or internal/],
        ['https://web:3000/api/health', /local or internal/],
        ['https://embeddings:8000/embed', /local or internal/],
        ['https://metadata.google.internal/', /local or internal/],
        ['https://printer.local/', /local or internal/],
        ['https://app.localhost/', /local or internal/],
    ])('%s is refused', (url, why) => {
        expect(() => checkUrl(url)).toThrow(HostRefusedError);
        expect(() => checkUrl(url)).toThrow(why);
    });

    test('allowedHosts: only the listed hosts, www. ignored both ways', () => {
        expect(checkUrl('https://www.example.org/a', { allowedHosts: ['example.org'] }).host).toBe('www.example.org');
        expect(checkUrl('https://example.org/a', { allowedHosts: ['www.example.org'] }).host).toBe('example.org');
        expect(() => checkUrl('https://evil.example.net/a', { allowedHosts: ['example.org'] })).toThrow(/not an allowed host/);
        expect(hostAllowed('FEEDS.Example.org', ['feeds.example.org'])).toBe(true);
    });
});

describe('createGuardedLookup (DNS answers checked, then pinned)', () => {
    const fakeDns = answers => (host, opts, cb) => cb(null, answers[host]);

    test('a public host resolves to its checked address', (done) => {
        const lookup = createGuardedLookup(fakeDns({ 'a.example': [{ address: '93.184.216.34', family: 4 }] }));
        lookup('a.example', {}, (err, address, family) => {
            expect(err).toBeNull();
            expect([address, family]).toEqual(['93.184.216.34', 4]);
            done();
        });
    });

    test('any private address in the answer refuses the connection (DNS rebinding to 127.0.0.1)', (done) => {
        const lookup = createGuardedLookup(fakeDns({
            'rebind.example': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
        }));
        lookup('rebind.example', {}, (err) => {
            expect(err).toBeInstanceOf(HostRefusedError);
            expect(err.message).toMatch(/resolves to 127\.0\.0\.1/);
            done();
        });
    });

    test('all: true returns the checked list (Node autoSelectFamily)', (done) => {
        const list = [{ address: '2606:4700::1111', family: 6 }, { address: '1.1.1.1', family: 4 }];
        createGuardedLookup(fakeDns({ 'b.example': list }))('b.example', { all: true }, (err, out) => {
            expect(err).toBeNull();
            expect(out).toEqual(list);
            done();
        });
    });

    test('a metadata-service IPv6 mapping is refused', (done) => {
        createGuardedLookup(fakeDns({ 'm.example': [{ address: '::ffff:169.254.169.254', family: 6 }] }))(
            'm.example', {}, (err) => { expect(err).toBeInstanceOf(HostRefusedError); done(); });
    });
});

describe('HttpClient redirect hops (F10-2)', () => {
    const redirect = (to, status = 302) => ({ status, headers: { location: to }, body: '' });

    test('a cross-host 302 of a request with Authorization is refused; the second hop is never sent', async () => {
        const t = fixtureTransport([[/api\.github\.com/, redirect('https://attacker.example/x')]]);
        const err = await client(t).request('https://api.github.com/search/issues?q=ai', {
            headers: { Authorization: 'Bearer ghp_secret' }, allowedHosts: ['api.github.com', 'attacker.example'],
        }).catch(e => e);
        expect(err).toBeInstanceOf(RedirectRefusedError);
        expect(classifyError(err).error_kind).toBe('redirect_refused');
        expect(t.calls.map(c => c.url)).toEqual(['https://api.github.com/search/issues?q=ai']);
    });

    test.each([
        ['PRIVATE-TOKEN', { 'PRIVATE-TOKEN': 'glpat-x' }],
        ['x-api-key', { 'x-api-key': 'k' }],
        ['X-ELS-APIKey', { 'X-ELS-APIKey': 'k' }],
        ['Cookie', { Cookie: 'sid=1' }],
    ])('%s makes a request credentialed: a cross-origin redirect is refused', async (_, headers) => {
        const t = fixtureTransport([[/api\.example\.org/, redirect('https://other.example.org/')]]);
        await expect(client(t).request('https://api.example.org/', { headers, allowedHosts: ['api.example.org', 'other.example.org'] }))
            .rejects.toBeInstanceOf(RedirectRefusedError);
        expect(t.calls).toHaveLength(1);
    });

    test('a 307 on the token POST to another host is refused: client_secret is never re-posted', async () => {
        const t = fixtureTransport([[/open\.tiktokapis\.com/, redirect('https://attacker.example/token', 307)]]);
        const err = await client(t).request('https://open.tiktokapis.com/v2/oauth/token/', {
            method: 'POST', body: 'client_key=k&client_secret=s', allowedHosts: ['open.tiktokapis.com', 'attacker.example'],
        }).catch(e => e);
        expect(err).toBeInstanceOf(RedirectRefusedError);
        expect(t.calls).toHaveLength(1);
        expect(t.calls.filter(c => /attacker/.test(c.url))).toEqual([]);
    });

    test('a same-origin 307 keeps the method and body', async () => {
        const t = fixtureTransport([
            [u => u.endsWith('/v1/a'), redirect('/v1/b', 307)],
            [u => u.endsWith('/v1/b'), { status: 200, body: '{}' }],
        ]);
        await client(t).request('https://api.example.org/v1/a', { method: 'POST', body: 'x=1', headers: { Authorization: 'Bearer t' } });
        expect(t.calls.map(c => [c.method, c.body, c.headers.Authorization])).toEqual([['POST', 'x=1', 'Bearer t'], ['POST', 'x=1', 'Bearer t']]);
    });

    test.each([
        ['http://feeds.example.org/rss', /not https/],               // downgrade
        ['https://127.0.0.1/admin', /not a public address/],
        ['https://169.254.169.254/latest/meta-data/iam/security-credentials/', /not a public address/],
        ['https://redis/', /local or internal/],
        ['https://embeddings:8000/embeddings', /local or internal/],
    ])('a redirect to %s is refused before it is sent', async (to, why) => {
        const t = fixtureTransport([[/feeds\.example\.org\/rss/, redirect(to)]]);
        await expect(client(t).request('https://feeds.example.org/rss', { allowedHosts: ['feeds.example.org'] })).rejects.toThrow(why);
        expect(t.calls).toHaveLength(1);
    });

    test('allowedHosts enforce the blocked-4 boundary: a feed redirecting into cato.org is refused', async () => {
        const bbc = registry.getSource('bbc_news');
        const hosts = registry.allowedHosts(bbc, TEST_ENV);
        const t = fixtureTransport([[/feeds\.bbci\.co\.uk\/news/, redirect('https://www.cato.org/rss/recent-opeds')]]);
        await expect(client(t).request('https://feeds.bbci.co.uk/news/technology/rss.xml', { allowedHosts: hosts }))
            .rejects.toThrow(/www\.cato\.org is not an allowed host/);
        expect(t.calls).toHaveLength(1);
    });

    test('an uncredentialed GET may follow an allowed cross-origin redirect', async () => {
        const t = fixtureTransport([
            [/^https:\/\/example\.org\/feed/, redirect('https://www.example.org/feed')],
            [/^https:\/\/www\.example\.org\/feed/, { status: 200, body: 'ok' }],
        ]);
        const res = await client(t).request('https://example.org/feed', { allowedHosts: ['example.org'] });
        expect(res.body).toBe('ok');
        expect(res.url).toBe('https://www.example.org/feed');
    });

    test('the first request is checked too (a registry or env URL on a private host never goes out)', async () => {
        const t = fixtureTransport([]);
        await expect(client(t).request('https://10.1.2.3/feed')).rejects.toBeInstanceOf(HostRefusedError);
        await expect(client(t).request('https://feeds.example.org/', { allowedHosts: ['other.example.org'] }))
            .rejects.toThrow(/not an allowed host/);
        expect(t.calls).toEqual([]);
    });

    test('robots.txt redirects are checked: one into a private address makes robots unreachable (complete disallow)', async () => {
        const t = fixtureTransport([
            ['https://feeds.example.org/robots.txt', redirect('https://192.168.1.1/robots.txt')],
            [/rss/, { status: 200, body: '<rss/>' }],
        ]);
        await expect(client(t).request('https://feeds.example.org/rss', { robots: true, allowedHosts: ['feeds.example.org'] }))
            .rejects.toThrow(/robots\.txt unreachable/);
        expect(t.calls.map(c => c.url)).toEqual(['https://feeds.example.org/robots.txt']);
    });
});

describe('registry allowedHosts (derived from route URLs and adapter hosts)', () => {
    const everything = {};
    for (const k of registry.registryEnvVars()) everything[k] = k.endsWith('_URL') ? `https://${k.toLowerCase().replace(/_/g, '-')}.example.org/feed` : 'set';

    test('every network route has at least one allowed host; file and mailbox routes have none', () => {
        for (const s of registry.SOURCES) {
            for (const r of s.routes) {
                const hosts = registry.routeAllowedHosts(r, everything);
                const offline = ['meta-content-library', 'jstor-dataset', 'blocked-researchgate', 'scholar-imap'].includes(r.adapter);
                expect([s.slug, r.id, offline ? hosts.length === 0 : hosts.length > 0]).toEqual([s.slug, r.id, true]);
            }
        }
    });

    test('the blocked-4 hosts belong to their own source only', () => {
        const blockedHosts = ['cato.org', 'researchgate.net', 'telegram.org', 'weixin.qq.com', 'sogou.com'];
        for (const s of registry.SOURCES) {
            const own = ['cato', 'researchgate', 'telegram', 'wechat'].includes(s.slug);
            if (own) continue;
            for (const h of registry.allowedHosts(s, everything)) {
                expect([s.slug, blockedHosts.some(b => h === b || h.endsWith(`.${b}`))]).toEqual([s.slug, false]);
            }
        }
    });

    test('an env-configured contract feed contributes exactly its own host', () => {
        const cnn = registry.getSource('cnn').routes[0];
        expect(registry.routeAllowedHosts(cnn, { CNN_FEED_URL: 'https://wire.cnn-contract.example/feed?x=1' }))
            .toEqual(['wire.cnn-contract.example']);
        expect(registry.routeAllowedHosts(cnn, {})).toEqual([]);
    });
});

describe('F10-4: response size caps and decompression bombs', () => {
    function streamOf(buf, headers) {
        const s = Readable.from([buf]);
        s.headers = headers;
        return s;
    }

    test('a gzip bomb (64 MB of zeros, ~64 KB compressed) is cut off at the cap, fast', async () => {
        const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024));
        expect(bomb.length).toBeLessThan(200 * 1024);
        const t0 = Date.now();
        await expect(readBody(streamOf(bomb, { 'content-encoding': 'gzip' }), { maxBytes: DEFAULT_MAX_BYTES }))
            .rejects.toBeInstanceOf(ResponseTooLargeError);
        expect(Date.now() - t0).toBeLessThan(2000);
    });

    test('a brotli bomb and a deflate bomb are capped too', async () => {
        const zeros = Buffer.alloc(16 * 1024 * 1024);
        await expect(readBody(streamOf(zlib.brotliCompressSync(zeros), { 'content-encoding': 'br' }), { maxBytes: 1024 * 1024 }))
            .rejects.toThrow(/exceeds the 1048576-byte cap \(decoded\)/);
        await expect(readBody(streamOf(zlib.deflateSync(zeros), { 'content-encoding': 'deflate' }), { maxBytes: 1024 * 1024 }))
            .rejects.toBeInstanceOf(ResponseTooLargeError);
    });

    test('a Content-Length over the cap is refused before the body is read', async () => {
        const s = new PassThrough();
        s.headers = { 'content-length': String(DEFAULT_MAX_BYTES + 1) };
        const read = jest.spyOn(s, 'read');
        await expect(readBody(s, { maxBytes: DEFAULT_MAX_BYTES })).rejects.toThrow(/declares 5242881 bytes/);
        expect(read).not.toHaveBeenCalled();
    });

    test('an endless plain body stops at the cap', async () => {
        let n = 0;
        const endless = new Readable({ read() { n++; this.push(Buffer.alloc(64 * 1024, 97)); } });
        endless.headers = {};
        await expect(readBody(endless, { maxBytes: ROBOTS_MAX_BYTES })).rejects.toBeInstanceOf(ResponseTooLargeError);
        expect(n * 64 * 1024).toBeLessThan(ROBOTS_MAX_BYTES + 256 * 1024);
    });

    test('a normal gzip body decodes', async () => {
        await expect(readBody(streamOf(zlib.gzipSync('héllo'), { 'content-encoding': 'gzip' }))).resolves.toBe('héllo');
    });

    // Diagnosis 2026-09-30 (Internet Archive blog feed): blog.archive.org
    // answers the conditional GET with a 304 that repeats
    // "Content-Encoding: gzip" and has no body (valid, RFC 9110 §15.4.5).
    // Gunzip over zero bytes threw Z_BUF_ERROR "unexpected end of file"
    // before http.js could see the 304, in 91% of runs.
    describe('responses that carry no content are never decoded (RFC 9110 §6.4.1)', () => {
        const empty = (headers, statusCode) => Object.assign(streamOf(Buffer.alloc(0), headers), { statusCode });

        test.each(['gzip', 'x-gzip', 'deflate', 'br'])('a 304 with Content-Encoding: %s and no body resolves ""', async (enc) => {
            await expect(readBody(empty({ 'content-encoding': enc }, 304))).resolves.toBe('');
        });

        test('the status can be passed explicitly (304, 204, 1xx) and HEAD is bodiless', async () => {
            const gz = { 'content-encoding': 'gzip' };
            await expect(readBody(streamOf(Buffer.alloc(0), gz), { status: 304 })).resolves.toBe('');
            await expect(readBody(streamOf(Buffer.alloc(0), gz), { status: 204 })).resolves.toBe('');
            await expect(readBody(streamOf(Buffer.alloc(0), gz), { status: 103 })).resolves.toBe('');
            await expect(readBody(streamOf(Buffer.alloc(0), gz), { status: 200, method: 'HEAD' })).resolves.toBe('');
        });

        test('Content-Length: 0 with a Content-Encoding resolves ""', async () => {
            await expect(readBody(empty({ 'content-encoding': 'gzip', 'content-length': '0' }, 200))).resolves.toBe('');
        });

        test('a bodiless response is drained, not left paused (the socket is released)', async () => {
            const s = empty({ 'content-encoding': 'gzip' }, 304);
            const resume = jest.spyOn(s, 'resume');
            await readBody(s);
            expect(resume).toHaveBeenCalled();
        });

        test('a 200 with an empty body and Content-Encoding (no Content-Length) resolves "" instead of throwing', async () => {
            await expect(readBody(empty({ 'content-encoding': 'gzip' }, 200))).resolves.toBe('');
        });

        test('a real gzipped 200 still decodes, and a TRUNCATED gzip body still fails as a decode error', async () => {
            const gz = zlib.gzipSync('<rss><channel><item>x</item></channel></rss>');
            await expect(readBody(Object.assign(streamOf(gz, { 'content-encoding': 'gzip' }), { statusCode: 200 })))
                .resolves.toBe('<rss><channel><item>x</item></channel></rss>');
            const cut = gz.subarray(0, gz.length - 12);
            const err = await readBody(Object.assign(streamOf(cut, { 'content-encoding': 'gzip' }), { statusCode: 200 })).catch(e => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.kind).toBe('parse');
            expect(err.decode).toBe(true);
            expect(classifyError(err).error_kind).toBe('parse');
        });

        test('createNetworkTransport resolves { status: 304, body: "" } for the IA 304-with-gzip response', async () => {
            // The exact response recorded on 2026-09-30 (scratch net/ia-probe.out).
            const request = (u, opts, onResponse) => {
                const req = new EventEmitter();
                req.write = () => {};
                req.end = () => setImmediate(() => {
                    onResponse(Object.assign(streamOf(Buffer.alloc(0), {
                        'content-encoding': 'gzip', etag: '"d35aeb5e6ecdb8f9de4f9422b04c0ffa-gzip"',
                        'last-modified': 'Wed, 30 Sep 2026 16:29:56 GMT', server: 'Caddy', vary: 'Accept-Encoding',
                    }), { statusCode: 304 }));
                });
                return req;
            };
            const transport = createNetworkTransport({ request, lookup: () => {} });
            const res = await transport('https://blog.archive.org/feed/', {
                headers: { 'If-None-Match': '"d35aeb5e6ecdb8f9de4f9422b04c0ffa-gzip"' },
            });
            expect(res).toMatchObject({ status: 304, body: '' });
            expect(res.headers.etag).toBe('"d35aeb5e6ecdb8f9de4f9422b04c0ffa-gzip"');
        });

        test('HttpClient: that 304 is notModified after ONE request, validators unchanged', async () => {
            let calls = 0;
            const transport = createNetworkTransport({
                lookup: () => {},
                request: (u, opts, onResponse) => {
                    calls++;
                    const req = new EventEmitter();
                    req.write = () => {};
                    req.end = () => setImmediate(() => onResponse(Object.assign(
                        streamOf(Buffer.alloc(0), { 'content-encoding': 'gzip', etag: '"v1"' }), { statusCode: 304 })));
                    return req;
                },
            });
            const http = client(transport);
            const cache = { 'https://blog.archive.org/feed/': { etag: '"v1"', last_modified: null } };
            const res = await http.request('https://blog.archive.org/feed/', { cache });
            expect(res.notModified).toBe(true);
            expect(calls).toBe(1);
            expect(http.requests).toBe(1);
            expect(cache).toEqual({ 'https://blog.archive.org/feed/': { etag: '"v1"', last_modified: null } });
        });

        test('a decode error is deterministic: NOT retried, classified parse', async () => {
            let calls = 0;
            const gz = zlib.gzipSync('x'.repeat(1000));
            const transport = createNetworkTransport({
                lookup: () => {},
                request: (u, opts, onResponse) => {
                    calls++;
                    const req = new EventEmitter();
                    req.write = () => {};
                    req.end = () => setImmediate(() => onResponse(Object.assign(
                        streamOf(gz.subarray(0, 10), { 'content-encoding': 'gzip' }), { statusCode: 200 })));
                    return req;
                },
            });
            const err = await client(transport).request('https://blog.archive.org/feed/').catch(e => e);
            expect(calls).toBe(1);
            expect(classifyError(err).error_kind).toBe('parse');
            expect(err.message).toMatch(/could not be decoded/);
        });
    });

    test('the network transport: https only, guarded lookup, TLS >= 1.2 verified, compression negotiated, capped', async () => {
        const seen = [];
        const request = (u, opts, onResponse) => {
            seen.push({ url: u.toString(), opts });
            const req = new EventEmitter();
            req.write = () => {};
            req.end = () => setImmediate(() => {
                const res = streamOf(zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024)), { 'content-encoding': 'gzip' });
                res.statusCode = 200;
                onResponse(res);
            });
            return req;
        };
        const lookup = () => {};
        const transport = createNetworkTransport({ request, lookup });
        await expect(transport('http://feeds.example.org/x')).rejects.toThrow(/not https/);
        await expect(transport('https://feeds.example.org/x', { maxBytes: 1024 * 1024 })).rejects.toBeInstanceOf(ResponseTooLargeError);
        expect(seen).toHaveLength(1);
        expect(seen[0].opts).toMatchObject({ lookup, minVersion: 'TLSv1.2', rejectUnauthorized: true });
        expect(seen[0].opts.headers['Accept-Encoding']).toBe('gzip, deflate, br');
    });

    test('a bulk dataset file over the cap is refused, not read (never marked seen)', async () => {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const { JstorDatasetCollector } = require('../../../src/collectors/adapters/academic');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-cap-'));
        const file = path.join(dir, 'big.jsonl');
        fs.writeFileSync(file, `${JSON.stringify({ id: 'a', title: 'AI', abstract: 'x'.repeat(200) })}\n`);
        const src = registry.getSource('jstor');
        const route = { ...src.routes[0], params: { ...(src.routes[0].params || {}), maxFileBytes: 100 } };
        const env = { ...TEST_ENV };
        for (const k of route.requires) env[k] = k === 'JSTOR_DATASET_PATH' ? file : 'REF';
        const cursor = {};
        const c = new JstorDatasetCollector({ source: src, route, env, http: null, cursor });
        const read = jest.spyOn(fs, 'readFileSync');
        await expect(c.fetchItems()).rejects.toThrow(/over the 100-byte cap/);
        expect(read).not.toHaveBeenCalledWith(file, 'utf8');
        read.mockRestore();
        expect(cursor.files || {}).toEqual({});
        expect(classifyError(await c.fetchItems().catch(e => e)).error_kind).toBe('too_large');
    });

    test('HttpClient passes the cap: robots.txt 500 KiB, a route its maxBytes', async () => {
        const t = fixtureTransport([[/./, { status: 200, body: 'User-agent: *\nAllow: /' }]]);
        const http = client(t);
        await http.request('https://feeds.example.org/rss', { robots: true, maxBytes: 12345 });
        expect(t.calls.map(c => c.url)).toEqual(['https://feeds.example.org/robots.txt', 'https://feeds.example.org/rss']);
        const caps = [];
        const t2 = async (url, init) => { caps.push(init.maxBytes); return { status: 200, headers: {}, body: '' }; };
        const http2 = client(t2);
        await http2.request('https://feeds.example.org/rss', { robots: true, maxBytes: 12345 });
        expect(caps).toEqual([ROBOTS_MAX_BYTES, 12345]);
    });
});
