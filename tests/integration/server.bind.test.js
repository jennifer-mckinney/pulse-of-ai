// tests/integration/server.bind.test.js
// Dev bind gap: bare `npm run dev` listened on every interface but was
// treated as loopback, so POST /api/refresh never required REFRESH_TOKEN.
// The server binds 127.0.0.1 by default (HOST / PULSE_BIND_ADDR override)
// and the refresh guard reads the ACTUAL bound address.

'use strict';

const app = require('../../src/server');
const { listenHost, start } = require('../../src/server');
const { boundBeyondLoopback, refreshTokenCheck } = require('../../src/routes/refresh');

describe('listening address', () => {
    it('defaults to 127.0.0.1; HOST, then PULSE_BIND_ADDR, override', () => {
        expect(listenHost({})).toBe('127.0.0.1');
        expect(listenHost({ PULSE_BIND_ADDR: '0.0.0.0' })).toBe('0.0.0.0');
        expect(listenHost({ HOST: '::', PULSE_BIND_ADDR: '127.0.0.1' })).toBe('::');
    });

    it('start() binds loopback by default and records the bound address', async () => {
        const server = await start({ port: 0, host: listenHost({}), log: () => {} });
        try {
            expect(server.address().address).toBe('127.0.0.1');
            expect(app.locals.boundAddress).toBe('127.0.0.1');
            expect(refreshTokenCheck({ app, get: () => '' }, {})).toBeNull();
        } finally {
            await new Promise(r => server.close(r));
            delete app.locals.boundAddress;
        }
    });

    it('bound to every interface, refresh without REFRESH_TOKEN is refused (the actual address decides)', async () => {
        const server = await start({ port: 0, host: '0.0.0.0', log: () => {} });
        try {
            expect(app.locals.boundAddress).toBe('0.0.0.0');
            expect(refreshTokenCheck({ app, get: () => '' }, {})).toEqual(expect.objectContaining({ status: 403 }));
        } finally {
            await new Promise(r => server.close(r));
            delete app.locals.boundAddress;
        }
    });
});

describe('boundBeyondLoopback', () => {
    it('reads the published address in the container, then env, then the bound address', () => {
        expect(boundBeyondLoopback({ PULSE_CONTAINER_PUBLISHED_ADDR: '127.0.0.1', HOST: '0.0.0.0' }, '0.0.0.0')).toBe(false);
        expect(boundBeyondLoopback({ PULSE_CONTAINER_PUBLISHED_ADDR: '0.0.0.0' }, '0.0.0.0')).toBe(true);
        expect(boundBeyondLoopback({ PULSE_BIND_ADDR: '192.168.1.5' }, '127.0.0.1')).toBe(true);
        expect(boundBeyondLoopback({}, '::')).toBe(true);
        expect(boundBeyondLoopback({}, '::1')).toBe(false);
        expect(boundBeyondLoopback({}, '::ffff:127.0.0.1')).toBe(false);
        expect(boundBeyondLoopback({}, null)).toBe(false);
    });
});
