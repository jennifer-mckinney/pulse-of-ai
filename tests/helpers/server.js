// tests/helpers/server.js
// One HTTP server per test FILE for supertest.
//
// `supertest(app)` with an express app starts a NEW ephemeral server for every
// request and closes it afterwards. On macOS that listen/close churn alone
// fails about 0.1% of requests with `socket hang up` / `ETIMEDOUT` (11 + 1 in
// 10,000 calls against a bare express app); listening once and reusing the
// server gave 0 in 10,000. A suite of a few hundred requests then flakes now
// and again (seen on collect.secrets.test.js).
//
// useServer(app) listens ONCE on 127.0.0.1:<ephemeral> in beforeAll, closes in
// afterAll, and returns `api`: each `api()` is a fresh supertest request bound
// to that server, used exactly like `request(app)` was (`api().get(...)`).
// Nothing else changes: supertest still opens a fresh, non-keep-alive
// connection per request (superagent's default `agent: false`), the app
// object is the same, and app.locals.boundAddress stays unset, as it was
// under supertest's own `app.listen(0)`.
//
// withServer(app, fn) is the scoped form for an app built inside one test.

'use strict';

const http = require('http');
const supertest = require('supertest');

/** Listen on loopback, ephemeral port; resolves the bound http.Server. */
function listen(app) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(server);
        });
    });
}

/**
 * Close the server, dropping any connection still open so close() cannot hang.
 * Closing a server that is already closed is a no-op, so a double teardown
 * cannot fail a test. closeAllConnections() needs Node 18.2+ (CI runs 22);
 * the typeof guard keeps an older local Node working instead of throwing.
 */
function close(server) {
    return new Promise((resolve, reject) => {
        server.close((err) => {
            if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
            else resolve();
        });
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
}

/**
 * Serve `app` for the whole test file. Call at the top level of the file.
 * @param {import('http').RequestListener} app
 * @returns {() => import('supertest').SuperTest<import('supertest').Test>}
 */
function useServer(app) {
    let server = null;
    beforeAll(async () => { server = await listen(app); });
    afterAll(async () => {
        if (server) await close(server);
        server = null;
    });
    return function api() {
        if (!server) throw new Error('useServer: the server is not listening (call api() inside a test or hook)');
        return supertest(server);
    };
}

/**
 * Serve `app` for the duration of `fn(api)` only, then close it.
 * @template T
 * @param {import('http').RequestListener} app
 * @param {(api: () => import('supertest').SuperTest<import('supertest').Test>) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withServer(app, fn) {
    const server = await listen(app);
    try {
        return await fn(() => supertest(server));
    } finally {
        await close(server);
    }
}

module.exports = { useServer, withServer, listen, close };
