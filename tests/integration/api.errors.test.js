// tests/integration/api.errors.test.js
// Security audit (2026-09-29):
//   1. a malformed JSON body to POST /api/query or POST /api/refresh is
//      answered as JSON 400 {error:"invalid JSON body"} — never Express's
//      HTML page with a stack trace and absolute paths — in development AND
//      production; any other error is a generic JSON 500;
//   2. route-level error logs go through the secret scrubber.

'use strict';

const request = require('supertest');
const app = require('../../src/server');
const { logRouteError } = require('../../src/middleware/log-error');

const LEAKS = [/\bat\s+\S+\s+\(/, /\/Users\//, /node_modules/, /<html|<pre/i, /SyntaxError/, /Unexpected token/];

describe('malformed JSON bodies', () => {
    const original = app.get('env');
    afterAll(() => app.set('env', original));

    for (const mode of ['development', 'production']) {
        for (const route of ['/api/query', '/api/refresh']) {
            it(`${route} in ${mode}: JSON 400, no stack or path`, async () => {
                app.set('env', mode);
                const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
                const res = await request(app).post(route)
                    .set('Content-Type', 'application/json').set('Sec-Fetch-Site', 'same-origin')
                    .send('{"q": "ai",');
                errors.mockRestore();
                expect(res.status).toBe(400);
                expect(res.headers['content-type']).toMatch(/application\/json/);
                expect(res.body).toEqual({ error: 'invalid JSON body' });
                for (const re of LEAKS) expect(res.text).not.toMatch(re);
            });
        }
    }

    it('any other error reaching the handler is a generic JSON 500 without detail', () => {
        const { jsonErrorHandler } = require('../../src/server');
        const res = { headersSent: false, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        jsonErrorHandler(new Error('ECONNREFUSED 10.0.0.5:5432 at /Users/x/app/src/db.js:10'), {}, res, () => {});
        errors.mockRestore();
        expect(res.code).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });
});

describe('route error logs are scrubbed', () => {
    it('logRouteError removes secret env values from the line', () => {
        const prior = process.env.GUARDIAN_API_KEY;
        process.env.GUARDIAN_API_KEY = 'guardian-secret-7a6b5c4d';
        const lines = [];
        try {
            logRouteError('sources', new Error('upstream said: key=guardian-secret-7a6b5c4d refused'), { sink: l => lines.push(l) });
        } finally {
            if (prior === undefined) delete process.env.GUARDIAN_API_KEY; else process.env.GUARDIAN_API_KEY = prior;
        }
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^\[sources\] upstream said:/);
        expect(lines[0]).not.toContain('guardian-secret-7a6b5c4d');
    });

    it('every route module logs errors only through logRouteError (no raw console.error of err.message)', () => {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '../../src/routes');
        for (const f of fs.readdirSync(dir)) {
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            expect([f, /console\.error\([^)]*err\.message\)/.test(src.replace(/console\.error\(scrub\([^;]*;/g, ''))]).toEqual([f, false]);
        }
    });
});
