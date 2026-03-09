// tests/integration/api.methodology.test.js
// Tests for GET /api/methodology
// Verifies: returns array of versioned methodology configs with justifications.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { insertMethodologyVersions } = require('./helpers');

describe('GET /api/methodology', () => {
    it('returns 200 with an array', async () => {
        const res = await request(app).get('/api/methodology');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns empty array when no methodology versions exist', async () => {
        const res = await request(app).get('/api/methodology');
        expect(res.body).toHaveLength(0);
    });

    it('returns all inserted methodology versions', async () => {
        await insertMethodologyVersions();

        const res = await request(app).get('/api/methodology');
        expect(res.body.length).toBeGreaterThanOrEqual(3);
    });

    it('each version has required fields including justification', async () => {
        await insertMethodologyVersions();

        const res = await request(app).get('/api/methodology');
        const sentiment = res.body.find(m => m.component === 'sentiment');

        expect(sentiment).toBeDefined();
        expect(sentiment).toMatchObject({
            component:      'sentiment',
            version:        expect.any(String),
            model_name:     expect.any(String),
            config:         expect.any(Object),
            justification:  expect.any(String),
            effective_from: expect.any(String),
        });
    });

    it('justification is a non-empty string (AI Act §13 explainability)', async () => {
        await insertMethodologyVersions();

        const res = await request(app).get('/api/methodology');
        for (const mv of res.body) {
            expect(mv.justification.length).toBeGreaterThan(0);
        }
    });

    it('config is an object (not a raw string)', async () => {
        await insertMethodologyVersions();

        const res = await request(app).get('/api/methodology');
        for (const mv of res.body) {
            expect(typeof mv.config).toBe('object');
        }
    });
});
