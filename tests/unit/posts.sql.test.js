// tests/unit/posts.sql.test.js
// G9-7: GET /api/posts/aggregated-by-location must BIND the demo source
// type as a query parameter, never interpolate it into the SQL text. The
// db module is mocked so the exact SQL + params can be inspected; the
// integration suite (api.dataMode.test.js) covers the results on a real DB.

'use strict';

jest.mock('../../src/db/connection', () => ({ dbAll: jest.fn() }));

const express = require('express');
const { useServer } = require('../helpers/server');
const { dbAll } = require('../../src/db/connection');
const { DEMO_SOURCE_TYPE } = require('../../src/config/data-mode');

// NODE_ENV=test bypasses the route's 10 s response cache, so one app serves
// every test with fresh SQL calls, on one listener for the whole file
// (tests/helpers/server.js).
const router = require('../../src/routes/posts');

const app = express();
app.use('/api', router);
const request = useServer(app);

beforeEach(() => {
    dbAll.mockReset();
    dbAll.mockResolvedValue([]);
});

describe('aggregated-by-location SQL (G9-7)', () => {
    test.each([
        ['no filters', ''],
        ['platform + from + to', '?platform=social&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z'],
    ])('the demo source type is a bound parameter (%s)', async (_label, qs) => {
        const res = await request().get(`/api/posts/aggregated-by-location${qs}`);
        expect(res.status).toBe(200);
        const [sql, params] = dbAll.mock.calls[0];
        // No quoted literal of the demo type anywhere in the SQL text…
        expect(sql).not.toMatch(new RegExp(`'${DEMO_SOURCE_TYPE}'`));
        // …it is referenced as the LAST placeholder and bound to that value.
        const n = params.length;
        expect(params[n - 1]).toBe(DEMO_SOURCE_TYPE);
        expect(sql).toContain(`ds.source_type = $${n}`);
        // Every placeholder the SQL references has a bound value.
        const refs = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
        expect(Math.max(...refs)).toBe(n);
    });

    test('the per-source breakdown query gets exactly the placeholders it uses', async () => {
        await request().get('/api/posts/aggregated-by-location?platform=social');
        const [sql, params] = dbAll.mock.calls[1];
        const refs = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
        expect(Math.max(0, ...refs)).toBe(params.length);
    });
});
