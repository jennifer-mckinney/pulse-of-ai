// tests/integration/collect.secrets.test.js
// F10-1 regression: for EVERY keyed adapter, an upstream 503 and a
// transport timeout leave no secret env value — raw or URL-encoded — in the
// database (source_collection_state, source_runs, processing_jobs), in
// GET /api/sources, or in any log line. The transports below are hostile on
// purpose: the 503 body and the timeout message both quote the full request
// URL (API keys ride in query strings), the dataset paths and the mailbox
// error name the secret, so only the redaction layers keep them out.
//
// Evidence note: no real API key was set during the PR #10 live runs (the
// test5 standup and collect:smoke used keyless routes only), so there was
// nothing to rotate; this test pins that no future key can leak this way.

'use strict';

const request = require('supertest');
const app = require('../../src/server');
const { dbAll } = require('../../src/db/connection');
const { runCollection } = require('../../src/collectors/runner');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { SOURCES, registryEnvVars, envClass } = require('../../src/config/source-registry');
const { TEST_ENV } = require('../helpers/fixtureTransport');

const credentialVars = new Set(registryEnvVars().filter(k => envClass(k) === 'credential'));

/** Sources with at least one credential-bearing route, and those variables. */
const KEYED = SOURCES.map((s) => {
    const vars = new Set();
    for (const r of s.routes) for (const k of [...(r.requires || []), ...(r.optional || [])]) if (credentialVars.has(k)) vars.add(k);
    return { slug: s.slug, vars: [...vars], refs: s.routes.flatMap(r => (r.requires || []).filter(k => !credentialVars.has(k))) };
}).filter(x => x.vars.length > 0);

/** Distinct, recognisable secret per variable; URL- and path-shaped where the adapter needs it. */
function secretFor(k) {
    const token = `S3cr3t-${k}-${Math.random().toString(36).slice(2, 10)}+/=`;
    if (/_URL$/.test(k)) return `https://feed.example.org/${encodeURIComponent(token)}?token=${encodeURIComponent(token)}`;
    if (/_(PATH|DIR)$/.test(k)) return `/nonexistent/${token.replace(/[+/=]/g, '_')}`;
    if (/_EMAIL$/.test(k)) return `ops-${token.replace(/[+/=]/g, '_')}@example.org`;
    if (/_HOST$/.test(k)) return `imap-${token.replace(/[^A-Za-z0-9-]/g, '')}.example.org`;
    return token;
}

function envFor(entry) {
    const env = { ...TEST_ENV };
    for (const k of entry.refs) env[k] = 'REF-on-file';
    const secrets = {};
    for (const k of entry.vars) { env[k] = secretFor(k); secrets[k] = env[k]; }
    return { env, secrets };
}

/** Every form a secret can take in stored or printed text. */
function forms(v) {
    return [...new Set([v, encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2), v.trim()])];
}

function leaks(haystack, secrets) {
    const found = [];
    for (const [k, v] of Object.entries(secrets)) for (const f of forms(v)) if (haystack.includes(f)) found.push(`${k} (${f.slice(0, 24)}…)`);
    return found;
}

const hostile503 = async (url) => (new URL(url).pathname === '/robots.txt'
    ? { status: 404, headers: {}, body: '' }
    : { status: 503, headers: {}, body: `upstream unavailable for ${url}` });

const hostileTimeout = async (url) => {
    if (new URL(url).pathname === '/robots.txt') return { status: 404, headers: {}, body: '' };
    throw Object.assign(new Error(`The operation was aborted due to timeout while fetching ${url}`), { name: 'TimeoutError' });
};

/** IMAP client whose failure quotes the login (as imapflow's responseText can). */
function hostileImap(opts) {
    return {
        connect: async () => { throw new Error(`AUTHENTICATIONFAILED for ${opts.auth.user}:${opts.auth.pass} at ${opts.host}`); },
        logout: async () => {},
        getMailboxLock: async () => ({ release() {} }),
    };
}

async function dbText() {
    const rows = [];
    for (const t of ['source_collection_state', 'source_runs', 'processing_jobs']) {
        rows.push(...(await dbAll(`SELECT row_to_json(x)::text AS j FROM ${t} x`)).map(r => r.j));
    }
    return rows.join('\n');
}

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

test('the keyed adapters under test cover every credential the registry defines', () => {
    const covered = new Set(KEYED.flatMap(x => x.vars));
    // REUTERS_CONNECT_*_URL are registry-level optional overrides, read by the Reuters adapter.
    for (const k of credentialVars) if (!/^REUTERS_CONNECT_(TOKEN|API)_URL$/.test(k)) expect([k, covered.has(k)]).toEqual([k, true]);
    expect(KEYED.length).toBeGreaterThanOrEqual(20);
});

describe.each([['a 503', hostile503], ['a timeout', hostileTimeout]])('F10-1: %s on a keyed route', (label, transport) => {
    test.each(KEYED.map(x => [x.slug, x]))('%s leaves no secret in the DB, the API or the logs', async (slug, entry) => {
        const { env, secrets } = envFor(entry);
        if (entry.vars.some(k => /^REUTERS_/.test(k))) {
            env.REUTERS_CONNECT_TOKEN_URL = secretFor('REUTERS_CONNECT_TOKEN_URL');
            secrets.REUTERS_CONNECT_TOKEN_URL = env.REUTERS_CONNECT_TOKEN_URL;
        }
        const logs = [];
        const spies = ['log', 'error', 'warn'].map(m => jest.spyOn(console, m).mockImplementation((...a) => logs.push(a.join(' '))));
        const saved = { ...process.env };
        try {
            const summary = await runCollection({
                slugs: [slug], triggeredBy: 'test', env, transport,
                queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
                log: m => logs.push(m),
                collectorCtx: { sleep: () => Promise.resolve(), imapFactory: hostileImap },
            });
            const row = summary.sources[0];
            expect(row.status).toBe('collecting');
            expect(row.outcome).toBe('error');
            expect(row.error).toBeTruthy();
            expect(row.errorKind).toEqual(expect.any(String));

            // API: served with the same secrets in the process env.
            Object.assign(process.env, env);
            const api = await request(app).get('/api/sources');
            expect(api.status).toBe(200);
            const served = api.body.find(s => s.slug === slug);
            expect(served).not.toHaveProperty('last_error');
            expect(served.last_error_kind).toBe(row.errorKind);

            const everything = [await dbText(), JSON.stringify(api.body), JSON.stringify(summary), logs.join('\n')].join('\n');
            expect(leaks(everything, secrets)).toEqual([]);
        } finally {
            for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
            Object.assign(process.env, saved);
            spies.forEach(s => s.mockRestore());
        }
    });
});

test('a 503 on an HTTP route is classified http_5xx with its status; a timeout as timeout', async () => {
    const entry = KEYED.find(x => x.slug === 'youtube');
    for (const [transport, kind, status] of [[hostile503, 'http_5xx', 503], [hostileTimeout, 'timeout', null]]) {
        const { env } = envFor(entry);
        await runCollection({
            slugs: ['youtube'], triggeredBy: 'test', env, transport,
            queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
            collectorCtx: { sleep: () => Promise.resolve() },
        });
        const [st] = await dbAll(`SELECT s.last_error_kind, s.last_http_status, s.last_error
                                  FROM source_collection_state s JOIN data_sources d ON d.id = s.source_id
                                  WHERE d.name = 'youtube'`);
        expect(st).toMatchObject({ last_error_kind: kind, last_http_status: status });
        // The server-side text is kept, redacted: the key parameter reads REDACTED.
        if (kind === 'http_5xx') expect(st.last_error).toMatch(/key=REDACTED/);
        await dbAll('UPDATE source_collection_state SET last_attempt_at = NULL');
    }
    const runs = await dbAll(`SELECT r.error_kind, r.http_status FROM source_runs r ORDER BY r.started_at`);
    expect(runs).toEqual([{ error_kind: 'http_5xx', http_status: 503 }, { error_kind: 'timeout', http_status: null }]);
});
