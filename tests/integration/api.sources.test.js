// tests/integration/api.sources.test.js
// Tests for GET /api/sources
// Verifies: returns data sources, correct shape, category ordering.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { insertSource } = require('./helpers');
const { SOURCES } = require('../../src/config/source-registry');

describe('GET /api/sources', () => {
    it('returns 200 with an array', async () => {
        const res = await request(app).get('/api/sources');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns empty array when no sources exist', async () => {
        const res = await request(app).get('/api/sources');
        expect(res.body).toHaveLength(0);
    });

    it('returns all inserted sources', async () => {
        await insertSource('source-a', 'social');
        await insertSource('source-b', 'news');
        await insertSource('source-c', 'academic');

        const res = await request(app).get('/api/sources');
        expect(res.body.length).toBeGreaterThanOrEqual(3);
    });

    it('each source has required shape fields', async () => {
        await insertSource('shape-source', 'social');

        const res    = await request(app).get('/api/sources');
        const source = res.body.find(s => s.name === 'shape-source');

        expect(source).toBeDefined();
        expect(source).toMatchObject({
            id:           expect.any(String),
            name:         'shape-source',
            display_name: expect.any(String),
            source_type:  expect.any(String),
            category:     'social',
            active:       expect.any(Boolean),
        });
    });

    it('only returns active sources by default', async () => {
        const { dbRun } = require('../../src/db/connection');

        await insertSource('active-src',   'social');
        const inactiveId = await insertSource('inactive-src', 'news');

        // Mark as inactive
        await dbRun('UPDATE data_sources SET active = false WHERE id = $1', [inactiveId]);

        const res = await request(app).get('/api/sources');
        const names = res.body.map(s => s.name);

        expect(names).toContain('active-src');
        expect(names).not.toContain('inactive-src');
    });

    it('supports ?include_inactive=true to return all sources', async () => {
        const { dbRun } = require('../../src/db/connection');

        await insertSource('active-src-2',   'social');
        const inactiveId = await insertSource('inactive-src-2', 'news');
        await dbRun('UPDATE data_sources SET active = false WHERE id = $1', [inactiveId]);

        const res   = await request(app).get('/api/sources?include_inactive=true');
        const names = res.body.map(s => s.name);

        expect(names).toContain('active-src-2');
        expect(names).toContain('inactive-src-2');
    });

    // ─── Registry of record + runtime status (ADR 0001) ─────────────────────
    describe('registry status', () => {
        const { dbRun } = require('../../src/db/connection');
        const { seedSources } = require('../../scripts/seed');
        const saved = {};
        const setEnv = (k, v) => { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
        afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; delete saved[k]; } });

        it('serves every registry source (52: SOURCES.length) in rank order with status and terms citation', async () => {
            setEnv('COLLECTOR_CONTACT_URL', 'https://example.org/c');
            setEnv('PERMISSION_GATED_FEEDS_ACCEPTED_BY', 'Test Operator 2026-09-29');
            setEnv('GATE_APPROVED_BY', 'Test Operator 2026-09-29');   // PR #22 decision G5
            for (const k of ['X_BEARER_TOKEN', 'YOUTUBE_API_KEY', 'COLLECTORS_DISABLED', 'COLLECTORS_ENABLED',
                'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT', 'REDDIT_API_APPROVAL_REF']) setEnv(k, undefined);
            await seedSources();
            const res = await request(app).get('/api/sources');
            expect(res.body).toHaveLength(SOURCES.length);
            expect(SOURCES.length).toBe(52);
            expect(res.body.map(s => s.rank)).toEqual(Array.from({ length: SOURCES.length }, (_, i) => i + 1));
            expect(res.body[res.body.length - 1]).toMatchObject({ slug: 'reddit', category: 'forums', status: 'awaiting_approval',
                missing_env: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT', 'REDDIT_API_APPROVAL_REF'],
                terms_url: 'https://redditinc.com/policies/data-api-terms' });
            const by = Object.fromEntries(res.body.map(s => [s.slug, s]));
            expect(by.wechat).toMatchObject({ status: 'blocked', status_reason: expect.stringMatching(/^blocked: no compliant access/),
                terms_url: 'https://weixin.qq.com/agreement?lang=en_US', blocked: expect.objectContaining({ remedy: expect.any(String) }) });
            expect(by.x).toMatchObject({ status: 'awaiting_licence', missing_env: ['X_BEARER_TOKEN'] });
            expect(by.youtube.status).toBe('awaiting_key');
            expect(by.bbc_news).toMatchObject({ status: 'collecting', ruling: expect.stringMatching(/legal risk/), online: false });
            expect(by.npr.attribution).toBe('NPR');
            expect(by.hacker_news.category).toBe('forums');
            // env var NAMES only — never a value
            expect(JSON.stringify(res.body)).not.toContain('https://example.org/c');
            expect(JSON.stringify(res.body)).not.toContain('Test Operator');
        });

        it('marks a collecting source online after a recent successful run', async () => {
            setEnv('COLLECTOR_CONTACT_URL', 'https://example.org/c');
            setEnv('PERMISSION_GATED_FEEDS_ACCEPTED_BY', undefined);
            await seedSources();
            await dbRun(`INSERT INTO source_collection_state (source_id, last_success_at, last_item_count)
                         SELECT id, NOW(), 7 FROM data_sources WHERE name = 'npr'`);
            await dbRun(`INSERT INTO source_collection_state (source_id, last_success_at)
                         SELECT id, NOW() - INTERVAL '2 hours' FROM data_sources WHERE name = 'arxiv'`);
            const res = await request(app).get('/api/sources');
            const by = Object.fromEntries(res.body.map(s => [s.slug, s]));
            expect(by.npr).toMatchObject({ online: true, last_item_count: 7 });
            expect(by.arxiv.online).toBe(false);
            const health = await request(app).get('/api/health');
            // D1: without the operator acknowledgement the 8 gated feeds wait.
            expect(health.body.sources).toMatchObject({ registry: SOURCES.length, seeded: SOURCES.length, collecting: 23, online: 1,
                by_status: { collecting: 23, awaiting_key: 4, awaiting_approval: 11, awaiting_licence: 10, blocked: 4, disabled: 0 } });
        });

        it('a kill switch shows the source as disabled', async () => {
            setEnv('COLLECTOR_CONTACT_URL', 'https://example.org/c');
            setEnv('SOURCE_NPR_ENABLED', 'false');
            await seedSources();
            const res = await request(app).get('/api/sources');
            const npr = res.body.find(s => s.slug === 'npr');
            expect(npr).toMatchObject({ status: 'disabled', kill_switch_env: 'SOURCE_NPR_ENABLED' });
        });

        it('include_inactive adds retired rows (flagged) and demo feeds (not registry)', async () => {
            await seedSources();
            await insertSource('techcrunch_ai', 'news');
            await dbRun(`UPDATE data_sources SET active = FALSE, retired_at = NOW(), retired_note = 'retired' WHERE name = 'techcrunch_ai'`);
            await dbRun(`INSERT INTO data_sources (name, display_name, source_type, category, active)
                         VALUES ('demo_news', 'Demo feed — News (fictional)', 'demo', 'news', FALSE)`);
            const res = await request(app).get('/api/sources?include_inactive=true');
            expect(res.body.filter(s => s.registry)).toHaveLength(SOURCES.length);
            expect(res.body.find(s => s.name === 'techcrunch_ai')).toMatchObject({ retired: true, registry: false, retired_note: 'retired' });
            expect(res.body.find(s => s.name === 'demo_news')).toMatchObject({ registry: false, source_type: 'demo' });
        });
    });
});
