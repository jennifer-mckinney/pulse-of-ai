// tests/integration/api.config.test.js
// Tests for GET /api/config
// Verifies: 200 + { mapboxToken } when MAPBOX_ACCESS_TOKEN is set, and the
// 503 guard branch when the token is missing (map cannot render without it).
//
// server.js loads dotenv, so a developer's real .env may populate the token —
// each test explicitly sets or deletes the env var and restores it afterwards.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');

describe('GET /api/config', () => {
    const ORIGINAL_TOKEN = process.env.MAPBOX_ACCESS_TOKEN;

    afterEach(() => {
        // Restore whatever the environment had before this suite ran
        if (ORIGINAL_TOKEN === undefined) {
            delete process.env.MAPBOX_ACCESS_TOKEN;
        } else {
            process.env.MAPBOX_ACCESS_TOKEN = ORIGINAL_TOKEN;
        }
        jest.restoreAllMocks();
    });

    it('returns 200 with the mapbox token when MAPBOX_ACCESS_TOKEN is set', async () => {
        process.env.MAPBOX_ACCESS_TOKEN = 'pk.test-token-value';

        const res = await request(app).get('/api/config');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ mapboxToken: 'pk.test-token-value' });
    });

    it('returns 503 with an error when MAPBOX_ACCESS_TOKEN is not set', async () => {
        // Silence the expected warning so test output stays clean
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        delete process.env.MAPBOX_ACCESS_TOKEN;

        const res = await request(app).get('/api/config');

        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'Mapbox token not configured' });
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('MAPBOX_ACCESS_TOKEN is not set'),
        );
    });

    it('never leaks a token in the 503 response body', async () => {
        delete process.env.MAPBOX_ACCESS_TOKEN;
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await request(app).get('/api/config');

        expect(res.body).not.toHaveProperty('mapboxToken');
    });
});
