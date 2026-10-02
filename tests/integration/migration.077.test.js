// tests/integration/migration.077.test.js
// PR #44 + #45 merge: migration 077 moves PR #44's Retry-After holds
// (`retry-after:<host>` keys in source_collection_state.http_cache) into the
// one rate-limit hold store (rate_limited_hosts, migrations 075-076) and
// strips every such key from the HTTP cache, which keeps validators only.

'use strict';

const fs = require('fs');
const path = require('path');
const { dbGet, dbRun, dbTransaction } = require('../../src/db/connection');
const { seedSources } = require('../../scripts/seed');
const rl = require('../../src/collectors/rate-limit');

const SQL_077 = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/077_rate_limit_hold_store_unify.sql'), 'utf8');
const idOf = async slug => (await dbGet('SELECT id FROM data_sources WHERE name = $1', [slug])).id;
const stateOf = async slug => dbGet(
    'SELECT http_cache, rate_limited_hosts, rate_limited_until FROM source_collection_state WHERE source_id = $1', [await idOf(slug)]);
const iso = ms => new Date(ms).toISOString();

beforeEach(async () => {
    await seedSources();
});

describe('migration 077_rate_limit_hold_store_unify.sql', () => {
    it('moves active PR #44 keys into rate_limited_hosts, drops every key from http_cache, keeps validators and existing #45 holds, and is idempotent', async () => {
        const now = Date.now();
        const tldr = await idOf('tldr');
        const github = await idOf('github');
        const owid = await idOf('owid');
        const validator = { etag: '"v1"', last_modified: null };
        await dbRun(`INSERT INTO source_collection_state (source_id, http_cache) VALUES ($1, $2::jsonb)`, [tldr, JSON.stringify({
            'https://tldr.tech/api/rss/ai': validator,
            'retry-after:tldr.tech': { until: iso(now + 3600 * 1000), status: 429 },
            'retry-after:old.example': { until: iso(now - 60 * 1000), status: 429 },
            'retry-after:junk.example': { until: 'soon', status: 429 },
        })]);
        // A #45 hold already stored for the host keeps its streak; the later until wins.
        const existing = { until: iso(now + 60 * 1000), http_status: 403, signal: 'ratelimit_remaining_zero', count: 3, weak: 0, at: iso(now - 1000) };
        await dbRun(`INSERT INTO source_collection_state (source_id, http_cache, rate_limited_hosts, rate_limited_until)
            VALUES ($1, $2::jsonb, $3::jsonb, $4)`, [github, JSON.stringify({
            'retry-after:api.github.com:443': { until: iso(now + 600 * 1000), status: 429 },
            'retry-after:srv.example': { until: iso(now + 48 * 3600 * 1000), status: 503 },
        }), JSON.stringify({ 'api.github.com': existing }), existing.until]);
        // A row without any PR #44 key is not touched.
        await dbRun(`INSERT INTO source_collection_state (source_id, http_cache) VALUES ($1, $2::jsonb)`,
            [owid, JSON.stringify({ 'https://ourworldindata.org/atom.xml': validator })]);
        const owidBefore = await dbGet('SELECT * FROM source_collection_state WHERE source_id = $1', [owid]);

        await dbTransaction(c => c.query(SQL_077));
        const once = { tldr: await stateOf('tldr'), github: await stateOf('github') };
        await dbTransaction(c => c.query(SQL_077));
        expect(await stateOf('tldr')).toEqual(once.tldr);
        expect(await stateOf('github')).toEqual(once.github);
        expect(await dbGet('SELECT * FROM source_collection_state WHERE source_id = $1', [owid])).toEqual(owidBefore);

        // TLDR: the active key is a hold; the expired and garbage keys are gone.
        expect(once.tldr.http_cache).toEqual({ 'https://tldr.tech/api/rss/ai': validator });
        expect(Object.keys(once.tldr.rate_limited_hosts)).toEqual(['tldr.tech']);
        const t = once.tldr.rate_limited_hosts['tldr.tech'];
        expect(t).toMatchObject({ until: iso(now + 3600 * 1000), http_status: 429, signal: 'http_429', count: 1, weak: 0 });
        expect(new Date(once.tldr.rate_limited_until).toISOString()).toBe(t.until);
        // Read back exactly as the runner reads it (sanitizeHolds keeps it).
        expect(rl.heldUntil(rl.sanitizeHolds(once.tldr.rate_limited_hosts, Date.now()), 'tldr.tech', Date.now())).toMatchObject({ http_status: 429 });

        // GitHub: the port is dropped; the existing #45 record keeps its
        // streak with the later until; a 503 is retry_after_5xx (count 0),
        // capped at 1 h (rate-limit.js MAX_5XX_HOLD_MS).
        expect(once.github.http_cache).toEqual({});
        expect(once.github.rate_limited_hosts['api.github.com']).toEqual({ ...existing, until: iso(now + 600 * 1000) });
        const srv = once.github.rate_limited_hosts['srv.example'];
        expect(srv).toMatchObject({ http_status: 503, signal: 'retry_after_5xx', count: 0, weak: 0 });
        expect(Math.abs(Date.parse(srv.until) - (now + rl.MAX_5XX_HOLD_MS))).toBeLessThan(60 * 1000);
        // rate_limited_until: the later RATE-LIMIT hold only — the 503's later hold is not one.
        expect(new Date(once.github.rate_limited_until).toISOString()).toBe(iso(now + 600 * 1000));
        expect(Date.parse(srv.until)).toBeGreaterThan(Date.parse(once.github.rate_limited_until));
    });

    it('Copilot: the expiry keeps its cause — a later 429 over an existing 5xx entry becomes a rate limit; a later 503 over a rate limit does not relabel it', async () => {
        const now = Date.now();
        const tldr = await idOf('tldr');
        const github = await idOf('github');
        const five = { until: iso(now + 600 * 1000), http_status: 503, signal: 'retry_after_5xx', count: 0, weak: 0, at: iso(now - 1000) };
        await dbRun(`INSERT INTO source_collection_state (source_id, http_cache, rate_limited_hosts) VALUES ($1, $2::jsonb, $3::jsonb)`, [tldr, JSON.stringify({
            'retry-after:tldr.tech': { until: iso(now + 3600 * 1000), status: 429 },
        }), JSON.stringify({ 'tldr.tech': five })]);
        const limit = { until: iso(now + 20 * 3600 * 1000), http_status: 429, signal: 'http_429', count: 4, weak: 0, at: iso(now - 1000) };
        await dbRun(`INSERT INTO source_collection_state (source_id, http_cache, rate_limited_hosts) VALUES ($1, $2::jsonb, $3::jsonb)`, [github, JSON.stringify({
            'retry-after:api.github.com': { until: iso(now + 3600 * 1000), status: 503 },
        }), JSON.stringify({ 'api.github.com': limit })]);
        await dbTransaction(c => c.query(SQL_077));
        expect((await stateOf('tldr')).rate_limited_hosts['tldr.tech']).toMatchObject({ signal: 'http_429', http_status: 429, count: 1, until: iso(now + 3600 * 1000) });
        expect((await stateOf('github')).rate_limited_hosts['api.github.com']).toMatchObject({ signal: 'http_429', http_status: 429, count: 4, until: iso(now + 20 * 3600 * 1000) });
    });

    it('security review L1/L2: an impossible timestamp never aborts the migration; a key with a path still names its host', async () => {
        const now = Date.now();
        const tldr = await idOf('tldr');
        const github = await idOf('github');
        await dbRun(`INSERT INTO source_collection_state (source_id, http_cache) VALUES ($1, $2::jsonb)`, [tldr, JSON.stringify({
            'retry-after:impossible.example': { until: '2026-13-45T99:99:99Z', status: 429 },
            'retry-after:path.example/feed': { until: iso(now + 600 * 1000), status: 429 },
        })]);
        // An existing #45 entry whose until is impossible keeps the legacy until.
        await dbRun(`INSERT INTO source_collection_state (source_id, http_cache, rate_limited_hosts) VALUES ($1, $2::jsonb, $3::jsonb)`, [github, JSON.stringify({
            'retry-after:api.github.com': { until: iso(now + 300 * 1000), status: 429 },
        }), JSON.stringify({ 'api.github.com': { until: '2026-99-99T00:00:00Z', http_status: 403, signal: 'http_429', count: 2, weak: 0, at: iso(now) } })]);
        await dbTransaction(c => c.query(SQL_077));
        const t = await stateOf('tldr');
        expect(t.http_cache).toEqual({});
        expect(Object.keys(t.rate_limited_hosts)).toEqual(['path.example']);
        const g = await stateOf('github');
        expect(g.rate_limited_hosts['api.github.com']).toMatchObject({ count: 2, until: iso(now + 300 * 1000) });
        // The helper function is gone (a second run in this session recreates it).
        await dbTransaction(c => c.query(SQL_077));
    });
});
