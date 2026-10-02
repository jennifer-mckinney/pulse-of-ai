// tests/unit/testServerHelper.test.js
// tests/helpers/server.js: supertest against ONE listener per test file
// instead of supertest's per-request ephemeral server, whose listen/close
// churn failed ~0.1% of requests on macOS (`socket hang up` / `ETIMEDOUT`).
//
// Every test here is self-contained (no shared variable, no reliance on
// describe order), and "is it closed" is asserted on the http.Server object
// (`server.listening`), never by connecting to its old port, so another
// process grabbing the freed ephemeral port cannot cause a false failure.

'use strict';

const http = require('http');
const net = require('net');
const express = require('express');
const { useServer, withServer, listen, close } = require('../helpers/server');

/** An app that reports which listener (local port) served the request. */
function portApp() {
    const app = express();
    app.get('/port', (req, res) => res.json({ port: req.socket.localPort, address: req.socket.localAddress }));
    app.get('/boom', () => { throw new Error('boom'); });
    return app;
}

/** Record every http.Server the helper creates while a test runs. */
function captureServers() {
    const created = [];
    const real = http.createServer;
    const spy = jest.spyOn(http, 'createServer').mockImplementation((...args) => {
        const server = real.apply(http, args);
        created.push(server);
        return server;
    });
    return { created, restore: () => spy.mockRestore() };
}

/**
 * Run useServer(app) with Jest's beforeAll/afterAll swapped for recorders so a
 * test can fire the file-level lifecycle by hand, in any order, on its own.
 */
function useServerWithManualHooks(app) {
    const hooks = {};
    const realBefore = global.beforeAll;
    const realAfter = global.afterAll;
    global.beforeAll = (fn) => { hooks.before = fn; };
    global.afterAll = (fn) => { hooks.after = fn; };
    try {
        hooks.request = useServer(app);
    } finally {
        global.beforeAll = realBefore;
        global.afterAll = realAfter;
    }
    return hooks;
}

describe('useServer', () => {
    it('serves every request from the same loopback listener, and closes it in afterAll', async () => {
        const cap = captureServers();
        try {
            const hooks = useServerWithManualHooks(portApp());
            expect(cap.created).toHaveLength(0); // nothing listens before beforeAll
            await hooks.before();
            expect(cap.created).toHaveLength(1);
            const [server] = cap.created;
            expect(server.listening).toBe(true);

            const ports = [];
            for (let i = 0; i < 5; i++) {
                const res = await hooks.request().get('/port');
                expect(res.status).toBe(200);
                expect(res.body.address).toBe('127.0.0.1');
                ports.push(res.body.port);
            }
            expect(new Set(ports).size).toBe(1);
            expect(cap.created).toHaveLength(1); // five requests, still one server

            await hooks.after();
            expect(server.listening).toBe(false);
            expect(() => hooks.request()).toThrow(/not listening/);
        } finally {
            cap.restore();
        }
    });

    it('refuses api() before beforeAll has run', () => {
        const hooks = useServerWithManualHooks(portApp());
        expect(() => hooks.request()).toThrow(/not listening/);
    });

    it('afterAll without a successful beforeAll is harmless', async () => {
        const hooks = useServerWithManualHooks(portApp());
        await expect(hooks.after()).resolves.toBeUndefined();
    });

    it('keeps the app behaviour: an error still reaches the default handler', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        const hooks = useServerWithManualHooks(portApp());
        await hooks.before();
        try {
            const res = await hooks.request().get('/boom');
            expect(res.status).toBe(500);
        } finally {
            errors.mockRestore();
            await hooks.after();
        }
    });
});

describe('withServer', () => {
    it('serves for the duration of fn only, and returns its result', async () => {
        const cap = captureServers();
        try {
            const body = await withServer(portApp(), async (request) => {
                const a = await request().get('/port');
                const b = await request().get('/port');
                expect(a.body.port).toBe(b.body.port);
                expect(cap.created[0].listening).toBe(true);
                return a.body;
            });
            expect(body.address).toBe('127.0.0.1');
            expect(cap.created).toHaveLength(1);
            expect(cap.created[0].listening).toBe(false);
        } finally {
            cap.restore();
        }
    });

    it('closes the listener even when fn throws', async () => {
        const cap = captureServers();
        try {
            await expect(withServer(portApp(), async (request) => {
                await request().get('/port');
                throw new Error('test failed inside');
            })).rejects.toThrow('test failed inside');
            expect(cap.created).toHaveLength(1);
            expect(cap.created[0].listening).toBe(false);
        } finally {
            cap.restore();
        }
    });
});

describe('close', () => {
    it('does not hang on a connection that is still open', async () => {
        const server = await listen(portApp());
        const { port } = server.address();
        const idle = net.connect(port, '127.0.0.1');
        await new Promise((resolve) => idle.once('connect', resolve));
        await close(server);
        expect(server.listening).toBe(false);
        idle.destroy();
    });

    it('is a no-op on a server that is already closed (double teardown)', async () => {
        const server = await listen(portApp());
        await close(server);
        await expect(close(server)).resolves.toBeUndefined();
    });

    it('still closes when closeAllConnections is unavailable (Node < 18.2)', async () => {
        const server = await listen(portApp());
        server.closeAllConnections = undefined;
        await close(server);
        expect(server.listening).toBe(false);
    });
});
