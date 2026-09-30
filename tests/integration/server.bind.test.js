// tests/integration/server.bind.test.js
// Dev bind gap: bare `npm run dev` listened on every interface but was
// treated as loopback, so POST /api/refresh never required REFRESH_TOKEN.
// The server binds 127.0.0.1 by default (HOST / PULSE_BIND_ADDR override)
// and the refresh guard reads the ACTUAL bound address.

'use strict';

const app = require('../../src/server');
const { listenHost, start } = require('../../src/server');
const { boundBeyondLoopback, refreshTokenCheck, runningInContainer, viaProxy } = require('../../src/routes/refresh');

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
        // In the compose web container, a wildcard listen is judged by the published address.
        expect(boundBeyondLoopback({ PULSE_CONTAINER_PUBLISHED_ADDR: '127.0.0.1', HOST: '0.0.0.0' }, '0.0.0.0',
            { inContainer: true })).toBe(false);
        expect(boundBeyondLoopback({ PULSE_CONTAINER_PUBLISHED_ADDR: '0.0.0.0' }, '0.0.0.0')).toBe(true);
        expect(boundBeyondLoopback({ PULSE_BIND_ADDR: '192.168.1.5' }, '127.0.0.1')).toBe(true);
        expect(boundBeyondLoopback({}, '::')).toBe(true);
        expect(boundBeyondLoopback({}, '::1')).toBe(false);
        expect(boundBeyondLoopback({}, '::ffff:127.0.0.1')).toBe(false);
        expect(boundBeyondLoopback({}, null)).toBe(false);
    });

    // PR #22 security M4: the published address can only make the answer
    // stricter; it never turns off the token on a wildcard bind outside the
    // compose web container.
    describe('PULSE_CONTAINER_PUBLISHED_ADDR cannot disable the token (security M4)', () => {
        const POC = { PULSE_CONTAINER_PUBLISHED_ADDR: '127.0.0.1', HOST: '0.0.0.0' };

        it('the PoC tuple on a host (not the container) is beyond loopback', () => {
            expect(boundBeyondLoopback(POC, '0.0.0.0', { inContainer: false })).toBe(true);
            expect(boundBeyondLoopback({ PULSE_CONTAINER_PUBLISHED_ADDR: '127.0.0.1' }, '0.0.0.0', { inContainer: false })).toBe(true);
            expect(boundBeyondLoopback({ PULSE_CONTAINER_PUBLISHED_ADDR: '127.0.0.1' }, '::', { inContainer: false })).toBe(true);
        });

        it('even in the container, a specific non-loopback HOST or bind is beyond loopback', () => {
            expect(boundBeyondLoopback({ PULSE_CONTAINER_PUBLISHED_ADDR: '127.0.0.1', HOST: '192.168.1.5' }, '192.168.1.5',
                { inContainer: true })).toBe(true);
            expect(boundBeyondLoopback({ PULSE_CONTAINER_PUBLISHED_ADDR: '0.0.0.0', HOST: '0.0.0.0' }, '0.0.0.0',
                { inContainer: true })).toBe(true);
            // In the container with NO published address: the wildcard counts.
            expect(boundBeyondLoopback({ HOST: '0.0.0.0' }, '0.0.0.0', { inContainer: true })).toBe(true);
        });

        it('the container needs BOTH the compose marker and /.dockerenv', () => {
            expect(runningInContainer({ PULSE_IN_CONTAINER: '1' }, () => true)).toBe(true);
            expect(runningInContainer({ PULSE_IN_CONTAINER: '1' }, () => false)).toBe(false);
            expect(runningInContainer({}, () => true)).toBe(false);
            expect(runningInContainer({ PULSE_IN_CONTAINER: 'true' }, () => true)).toBe(false);
            // Default detection on this host: the marker alone never counts.
            expect(boundBeyondLoopback({ ...POC, PULSE_IN_CONTAINER: '1' }, '0.0.0.0',
                { inContainer: runningInContainer({ PULSE_IN_CONTAINER: '1' }, () => false) })).toBe(true);
        });

        it('refreshTokenCheck refuses the PoC tuple without a token (host process)', () => {
            const req = { app: { locals: { boundAddress: '0.0.0.0' } }, get: () => undefined };
            expect(refreshTokenCheck(req, { ...POC, PULSE_IN_CONTAINER: '1' })).toMatchObject({ status: 403 });
        });

        it('a request through a reverse proxy needs the token even on loopback', () => {
            const via = h => ({ app: { locals: { boundAddress: '127.0.0.1' } }, get: n => (n.toLowerCase() === h ? '203.0.113.9' : undefined) });
            for (const h of ['x-forwarded-for', 'forwarded', 'x-forwarded-host', 'x-real-ip']) {
                expect(viaProxy(via(h))).toBe(true);
                expect(refreshTokenCheck(via(h), {})).toEqual({
                    status: 403, error: 'Refresh is disabled: the request came through a proxy and no REFRESH_TOKEN is set',
                });
            }
            const direct = { app: { locals: { boundAddress: '127.0.0.1' } }, get: () => undefined };
            expect(viaProxy(direct)).toBe(false);
            expect(refreshTokenCheck(direct, {})).toBeNull();
        });
    });
});
