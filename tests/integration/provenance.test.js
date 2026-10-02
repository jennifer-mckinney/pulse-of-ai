// tests/integration/provenance.test.js
// Decision D2 end to end against a real PostgreSQL: a collected payload is
// stored with its provenance fingerprint (migration 017), the audit receipt
// shows the provenance, and `npm run verify-provenance` proves the match
// from the original URL (and the original id when it was fingerprinted).

'use strict';

const { useServer } = require('../helpers/server');
const app = require('../../src/server');
const request = useServer(app);   // one listener per file (tests/helpers/server.js)
const db = require('../../src/db/connection');
const { storeRawPost } = require('../../src/pipeline/ingest');
const { toPayload } = require('../../src/collectors/normalize');
const { provenanceKey } = require('../../src/collectors/provenance');
const { main } = require('../../scripts/verify-provenance');
const { METHODOLOGY_VERSIONS } = require('../../src/config/methodology-registry');

// A collector-type source row (source_type 'api', like the registry seed:
// name = the registry slug). K1: the receipt's permalink is published only for
// a registry source whose link domains include the permalink's host.
async function insertSource() {
    const row = await db.dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category)
         VALUES ('hacker_news', 'Hacker News (Y Combinator)', 'api', 'forums')
         ON CONFLICT (name) DO UPDATE SET source_type = 'api'
         RETURNING id`);
    return row.id;
}

// A dedicated key for this file (the suite does not set AUDIT_HASH_KEY).
const PRIOR_KEY = process.env.PROVENANCE_KEY;
process.env.PROVENANCE_KEY = 'test-provenance-key-0123456789abcdef';
afterAll(() => {
    if (PRIOR_KEY === undefined) delete process.env.PROVENANCE_KEY; else process.env.PROVENANCE_KEY = PRIOR_KEY;
});
const KEY = provenanceKey(process.env);
const HN = { slug: 'hacker-news', category: 'forums' };
const ROUTE = { id: 'hn-algolia', scope: 'all' };

async function registerIngest13() {
    const m = METHODOLOGY_VERSIONS.find(r => r.component === 'ingest' && r.version === '1.3.0');
    await db.dbRun(
        `INSERT INTO methodology_versions (component, version, model_name, config, justification)
         VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (component, version) DO NOTHING`,
        [m.component, m.version, m.model_name, JSON.stringify(m.config), m.justification]);
}

async function collect(item) {
    const sourceId = await insertSource();
    const payload = toPayload(item, HN, ROUTE, { key: KEY });
    const { postId } = await storeRawPost(payload, sourceId);
    return { postId, payload };
}

function capture(env = process.env) {
    const lines = { out: [], err: [] };
    return { lines, io: { db, env, out: l => lines.out.push(l), err: l => lines.err.push(l) } };
}

describe('provenance fingerprint (D2, migration 017)', () => {
    it('is stored in its own column and not duplicated into raw_payload', async () => {
        const { postId, payload } = await collect({ id: '4242', title: 'AI', text: 'LLM news', url: 'https://news.ycombinator.com/item?id=4242', publishedAt: '2026-09-29T10:00:00Z' });
        const row = await db.dbGet('SELECT external_id, provenance_fingerprint, raw_payload FROM raw_posts WHERE id = $1', [postId]);
        expect(row.provenance_fingerprint).toBe(payload.provenance_fingerprint);
        expect(row.provenance_fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(row.raw_payload).not.toHaveProperty('provenance_fingerprint');
        expect(row.external_id).toBe('hn-algolia:4242');
    });

    it('rejects a malformed fingerprint (stored as NULL)', async () => {
        const sourceId = await insertSource();
        const { postId } = await storeRawPost({ id: 'x:1', text: 'AI', provenance_fingerprint: "'; DROP TABLE x; --" }, sourceId);
        expect((await db.dbGet('SELECT provenance_fingerprint FROM raw_posts WHERE id = $1', [postId])).provenance_fingerprint).toBeNull();
    });

    it('the audit receipt shows source, published time, permalink, id, fingerprint and how to verify', async () => {
        await registerIngest13();
        const { postId, payload } = await collect({ id: '77', title: 'AI', text: 'machine learning', url: 'https://news.ycombinator.com/item?id=77', publishedAt: '2026-09-29T10:00:00Z' });
        const res = await request().get(`/api/audit/${postId}`);
        expect(res.status).toBe(200);
        expect(res.body.provenance).toEqual({
            source: 'hacker_news',
            published_at: '2026-09-29T10:00:00.000Z',
            permalink: 'https://news.ycombinator.com/item?id=77',
            external_id: 'hn-algolia:77',
            fingerprint: payload.provenance_fingerprint,
            verifiable: `verifiable: provide the original URL or id to reproduce the fingerprint: npm run verify-provenance -- --post ${postId} --url <original URL> [--id <original id>]`,
            // PR #22 G6: stored here without the runner, so no admission version was recorded.
            admission: { component: 'admission_filter', version: null,
                lineage: 'not recorded: stored before the admission filter was versioned (migration 042)' },
        });
        // The live ingestion step restates ingest@1.3.0's precise claim.
        expect(res.body.ingest.methodology_version).toBe('1.3.0');
        expect(res.body.ingest.audiences.public).toMatch(/names mentioned in the text itself may remain/);
        expect(res.body.ingest.audiences.plain).toContain('free text may still contain names mentioned in content');
        expect(res.body.ingest.audiences.researcher).toContain(payload.provenance_fingerprint);
        expect(res.body.ingest.audiences.config.provenance.fingerprint).toBe(payload.provenance_fingerprint);
    });

    it('a post with no fingerprint says so on the receipt', async () => {
        const sourceId = await insertSource();
        const { postId } = await storeRawPost({ id: 'old-1', text: 'AI before 1.3.0' }, sourceId);
        const res = await request().get(`/api/audit/${postId}`);
        expect(res.body.provenance.fingerprint).toBeNull();
        expect(res.body.provenance.verifiable).toMatch(/no provenance fingerprint was recorded/);
    });

    describe('npm run verify-provenance', () => {
        it('MATCH from the original URL when the upstream id was kept (exit 0)', async () => {
            const { postId } = await collect({ id: '99', text: 'AI', url: 'https://news.ycombinator.com/item?id=99' });
            const { lines, io } = capture();
            expect(await main(['--post', postId, '--url', 'https://news.ycombinator.com/item?id=99'], io)).toBe(0);
            expect(lines.out.join('\n')).toContain('RESULT: MATCH');
        });

        it('NO MATCH for any other URL (exit 1)', async () => {
            const { postId } = await collect({ id: '100', text: 'AI', url: 'https://news.ycombinator.com/item?id=100' });
            const { lines, io } = capture();
            expect(await main(['--post', postId, '--url', 'https://news.ycombinator.com/item?id=101'], io)).toBe(1);
            expect(lines.out.join('\n')).toContain('RESULT: NO MATCH');
        });

        it('an identity link (dropped permalink, fingerprinted id) is proven from the original link alone', async () => {
            const u = 'https://www.openstreetmap.org/user/jane/diary/7';
            const { postId } = await collect({ id: u, title: 'AI mapping', text: 'machine learning', url: u });
            const row = await db.dbGet('SELECT external_id, raw_payload FROM raw_posts WHERE id = $1', [postId]);
            expect(row.external_id).toMatch(/^hn-algolia:fp:[0-9a-f]{64}$/);
            expect(JSON.stringify(row)).not.toContain('jane');
            const { lines, io } = capture();
            expect(await main(['--post', postId, '--url', u, '--json'], io)).toBe(0);
            expect(JSON.parse(lines.out.join('\n'))).toEqual(expect.objectContaining({ result: 'MATCH', idCheck: true }));
        });

        it('a fingerprinted id needs the original id: with --id it matches, a wrong id does not', async () => {
            const id = 'https://example.com/p?utm_source=x&token=abc';
            const { postId } = await collect({ id, text: 'AI', url: 'https://example.com/p' });
            const a = capture();
            expect(await main(['--post', postId, '--url', 'https://example.com/p', '--id', id], a.io)).toBe(0);
            const b = capture();
            expect(await main(['--post', postId, '--url', 'https://example.com/p', '--id', 'https://example.com/p?x=1'], b.io)).toBe(1);
        });

        it('no fingerprint or no key: exit 3; usage and unknown post: exit 2', async () => {
            const sourceId = await insertSource();
            const { postId } = await storeRawPost({ id: 'old-2', text: 'AI' }, sourceId);
            const a = capture();
            expect(await main(['--post', postId, '--url', 'https://x.example/'], a.io)).toBe(3);
            expect(a.lines.out.join('\n')).toContain('RESULT: NO FINGERPRINT');
            const { postId: p2 } = await collect({ id: '5', text: 'AI', url: 'https://news.ycombinator.com/item?id=5' });
            const b = capture({});
            expect(await main(['--post', p2, '--url', 'https://news.ycombinator.com/item?id=5'], b.io)).toBe(3);
            expect(b.lines.out.join('\n')).toContain('RESULT: NO KEY');
            const c = capture();
            expect(await main(['--post', postId], c.io)).toBe(2);
            expect(await main(['--post', 'nope', '--url', 'x'], c.io)).toBe(2);
            expect(await main(['--post', '--url', 'x'], c.io)).toBe(2);
            expect(await main(['--post', '00000000-0000-4000-8000-000000000000', '--url', 'x'], c.io)).toBe(2);
            expect(c.lines.err.join('\n')).toMatch(/usage: npm run verify-provenance[\s\S]*not found/);
        });
    });
});
