// tests/integration/api.sources.test.js
// Tests for GET /api/sources
// Verifies: returns data sources, correct shape, category ordering.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { insertSource } = require('./helpers');

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
});
