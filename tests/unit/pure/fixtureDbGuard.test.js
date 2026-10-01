// tests/unit/pure/fixtureDbGuard.test.js
// Diagnosis 2026-10-01: the dev database held 306 FICTIONAL posts counted
// as live data, all under real (now retired) source rows:
//   - 240 `demo-<city>-<n>` posts from the removed scripts/seed-demo.js
//     (attached to "any active source": reddit_artificial);
//   - 66 `dev-seed-<c>-<p>` posts from the e2e fixture seed
//     (scripts/test/seed-e2e.js), which spreads its synthetic posts over the
//     ACTIVE REAL sources by design — and, run bare (`npm run seed:e2e`, a
//     CLAUDE.md Quick Start step), targets the dev database from .env.
// scripts/test/freshen-seed.sh, run bare, likewise shifted collected_at of
// EVERY post in the dev database.
//
// scripts/lib/fixture-db-guard.js closes that path: the fixture scripts
// refuse any database that is not an e2e database unless the operator names
// it in FIXTURE_DB_ALLOW (a disposable database, e.g. CI's service
// container). These tests pin the rule and its wiring, through the real
// scripts, BEFORE any database connection is attempted.

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { fixtureTarget, assertFixtureTarget, FIXTURE_DB_ALLOW_ENV } = require('../../../scripts/lib/fixture-db-guard');

const ROOT = path.join(__dirname, '..', '..', '..');

describe('fixtureTarget(env)', () => {
    test.each(['pulse_of_ai_e2e', 'pulse_of_ai_e2e_fresh', 'pulse_of_ai_e2e_gate_2'])(
        'allows the e2e database %s', (db) => {
            expect(fixtureTarget({ POSTGRES_DB: db })).toEqual({ ok: true, database: db, reason: expect.any(String) });
        });

    test.each([
        ['the dev database', { POSTGRES_DB: 'pulse_of_ai' }, 'pulse_of_ai'],
        ['the default (POSTGRES_DB unset → pulse_of_ai)', {}, 'pulse_of_ai'],
        ['an arbitrary database', { POSTGRES_DB: 'analytics' }, 'analytics'],
        ['a look-alike name', { POSTGRES_DB: 'pulse_of_ai_e2e;drop' }, 'pulse_of_ai_e2e;drop'],
        ['a prefix trick', { POSTGRES_DB: 'xpulse_of_ai_e2e' }, 'xpulse_of_ai_e2e'],
        ['the Jest test database (NODE_ENV=test)', { NODE_ENV: 'test', POSTGRES_DB: 'pulse_of_ai_e2e' }, 'pulse_of_ai_test'],
    ])('refuses %s', (_label, env, database) => {
        const v = fixtureTarget(env);
        expect(v).toMatchObject({ ok: false, database });
        expect(v.reason).toMatch(/REAL source rows/);
        expect(v.reason).toContain(FIXTURE_DB_ALLOW_ENV);
    });

    test('resolves the database exactly as src/db/connection.js does (NODE_ENV=test → POSTGRES_TEST_DB)', () => {
        expect(fixtureTarget({ NODE_ENV: 'test', POSTGRES_TEST_DB: 'pulse_of_ai_e2e_t' }))
            .toMatchObject({ ok: true, database: 'pulse_of_ai_e2e_t' });
    });

    test('FIXTURE_DB_ALLOW opts ONE named, disposable database in (CI\'s service container)', () => {
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai', [FIXTURE_DB_ALLOW_ENV]: 'pulse_of_ai' }))
            .toMatchObject({ ok: true, database: 'pulse_of_ai' });
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai', [FIXTURE_DB_ALLOW_ENV]: ' pulse_of_ai ' }))
            .toMatchObject({ ok: true });
        // Naming a different database opts nothing in.
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai', [FIXTURE_DB_ALLOW_ENV]: 'pulse_of_ai_ci' }))
            .toMatchObject({ ok: false });
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai', [FIXTURE_DB_ALLOW_ENV]: '' })).toMatchObject({ ok: false });
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai', [FIXTURE_DB_ALLOW_ENV]: '1' })).toMatchObject({ ok: false });
    });

    test('assertFixtureTarget throws the refusal, returns the database when allowed', () => {
        expect(() => assertFixtureTarget({ POSTGRES_DB: 'pulse_of_ai' })).toThrow(/refusing to write fixture data into database "pulse_of_ai"/);
        expect(assertFixtureTarget({ POSTGRES_DB: 'pulse_of_ai_e2e' })).toBe('pulse_of_ai_e2e');
    });
});

describe('wiring: the fixture scripts refuse the dev database before connecting', () => {
    // Port 9 (discard) on loopback: nothing listens, so a script that got
    // past the guard fails with a CONNECTION error instead — which is how the
    // positive case proves the guard let it through.
    const base = {
        PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development',
        POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: '9', POSTGRES_USER: 'nobody', POSTGRES_PASSWORD: 'x',
        PGCONNECT_TIMEOUT: '2',
    };
    const run = (cmd, args, env) => spawnSync(cmd, args, { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8', timeout: 60000 });

    test.each([
        ['seed-e2e.js', 'node', ['scripts/test/seed-e2e.js']],
        ['freshen-seed.sh', 'bash', ['scripts/test/freshen-seed.sh']],
    ])('%s refuses POSTGRES_DB=pulse_of_ai (exit 1, guard message, no connection attempt)', (_n, cmd, args) => {
        const r = run(cmd, args, { POSTGRES_DB: 'pulse_of_ai' });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/refusing to write fixture data into database "pulse_of_ai"/);
        expect(r.stderr + r.stdout).not.toMatch(/ECONNREFUSED|connect/i);
    });

    test.each([
        ['seed-e2e.js', 'node', ['scripts/test/seed-e2e.js']],
        ['freshen-seed.sh', 'bash', ['scripts/test/freshen-seed.sh']],
    ])('%s gets past the guard for the e2e database (then fails only on the unreachable port)', (_n, cmd, args) => {
        const r = run(cmd, args, { POSTGRES_DB: 'pulse_of_ai_e2e' });
        expect(r.status).toBe(1);
        expect(r.stderr).not.toMatch(/refusing to write fixture data/);
        expect(r.stderr + r.stdout).toMatch(/ECONNREFUSED|connect/i);
    });
});
