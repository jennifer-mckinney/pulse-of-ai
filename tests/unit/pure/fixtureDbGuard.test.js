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
//
// PR #42 / PR #44 reconciliation: the same module also holds the DROP rule
// in front of the e2e globalSetup's DROP + CREATE (pinned in
// e2eDbGuard.test.js). The two rules share one definition of an e2e
// database (name pattern, 63-character cap, the Jest test database and
// Postgres port refused); the blocks below pin that agreement and the CI e2e
// job's settings against both rules.

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');
const yaml = require('js-yaml');
const {
    fixtureTarget, assertFixtureTarget, FIXTURE_DB_ALLOW_ENV,
    assertDisposableE2eDatabase, isE2eDatabaseName, E2E_DB_PATTERN, MAX_IDENTIFIER_LENGTH,
} = require('../../../scripts/lib/fixture-db-guard');

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

    test('resolves the database exactly as src/db/connection.js does (NODE_ENV=test → POSTGRES_TEST_DB), '
        + 'and NODE_ENV=test is always refused: it targets the Jest test Postgres (PR #42/#44 reconciliation)', () => {
        // Even an e2e-shaped name, even named in FIXTURE_DB_ALLOW: under
        // NODE_ENV=test src/db/connection.js connects to POSTGRES_TEST_PORT.
        const env = { NODE_ENV: 'test', POSTGRES_TEST_DB: 'pulse_of_ai_e2e_t', [FIXTURE_DB_ALLOW_ENV]: 'pulse_of_ai_e2e_t' };
        const v = fixtureTarget(env);
        expect(v).toMatchObject({ ok: false, database: 'pulse_of_ai_e2e_t' });
        expect(v.reason).toMatch(/NODE_ENV=test targets the Jest test Postgres/);
    });

    test.each([
        ['the default test port 5433', { POSTGRES_PORT: '5433' }, /port 5433 is the Jest test Postgres/],
        ['the configured POSTGRES_TEST_PORT', { POSTGRES_PORT: '45433', POSTGRES_TEST_PORT: '45433' }, /port 45433 is the Jest test Postgres/],
        ['5433 even when POSTGRES_TEST_PORT moved', { POSTGRES_PORT: '5433', POSTGRES_TEST_PORT: '45433' }, /port 5433/],
        ['a malformed POSTGRES_PORT (parseInt would read 5433oops as 5433)', { POSTGRES_PORT: '5433oops' }, /invalid Postgres port "5433oops"/],
        ['a malformed POSTGRES_PORT (parseInt would read abc as the default)', { POSTGRES_PORT: 'abc' }, /invalid Postgres port "abc"/],
        ['a malformed POSTGRES_TEST_PORT (fails closed)', { POSTGRES_PORT: '5434', POSTGRES_TEST_PORT: '45433oops' }, /invalid POSTGRES_TEST_PORT/],
    ])('refuses an e2e database on %s', (_label, env, why) => {
        const v = fixtureTarget({ POSTGRES_DB: 'pulse_of_ai_e2e', ...env });
        expect(v).toMatchObject({ ok: false, database: 'pulse_of_ai_e2e' });
        expect(v.reason).toMatch(why);
    });

    test('an unset or empty POSTGRES_PORT resolves to 5432, as src/db/connection.js does', () => {
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai_e2e' })).toMatchObject({ ok: true });
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai_e2e', POSTGRES_PORT: '' })).toMatchObject({ ok: true });
    });

    test('refuses an e2e-shaped name that IS the configured Jest test database (POSTGRES_TEST_DB)', () => {
        const v = fixtureTarget({ POSTGRES_DB: 'pulse_of_ai_e2e_t', POSTGRES_TEST_DB: 'pulse_of_ai_e2e_t', POSTGRES_PORT: '5434' });
        expect(v).toMatchObject({ ok: false });
        expect(v.reason).toMatch(/Jest test database/);
    });

    test('refuses an e2e-shaped name Postgres would truncate (> 63 characters)', () => {
        const long = `pulse_of_ai_e2e_${'a'.repeat(48)}`;
        expect(long).toHaveLength(64);
        expect(fixtureTarget({ POSTGRES_DB: long, POSTGRES_PORT: '5434' })).toMatchObject({ ok: false });
        const max = `pulse_of_ai_e2e_${'a'.repeat(47)}`;
        expect(fixtureTarget({ POSTGRES_DB: max, POSTGRES_PORT: '5434' })).toMatchObject({ ok: true });
    });

    test.each([
        ['the dev database', { POSTGRES_DB: 'pulse_of_ai', [FIXTURE_DB_ALLOW_ENV]: 'pulse_of_ai' }],
        ['the Jest test database', { POSTGRES_DB: 'pulse_of_ai_test', [FIXTURE_DB_ALLOW_ENV]: 'pulse_of_ai_test' }],
        ['a configured Jest test database', { POSTGRES_DB: 'jest_db', POSTGRES_TEST_DB: 'jest_db', [FIXTURE_DB_ALLOW_ENV]: 'jest_db' }],
        ['the postgres maintenance database', { POSTGRES_DB: 'postgres', [FIXTURE_DB_ALLOW_ENV]: 'postgres' }],
        ['template1', { POSTGRES_DB: 'template1', [FIXTURE_DB_ALLOW_ENV]: 'template1' }],
        ['the dev database on the test port', { POSTGRES_DB: 'pulse_of_ai', POSTGRES_PORT: '5433', [FIXTURE_DB_ALLOW_ENV]: 'pulse_of_ai' }],
    ])('FIXTURE_DB_ALLOW can never opt in %s', (_label, env) => {
        expect(fixtureTarget({ POSTGRES_PORT: '5434', ...env })).toMatchObject({ ok: false });
    });

    // 2026-10-02 security review (F1): FIXTURE_DB_ALLOW naming the literal dev
    // database would let an operator who copies CI's FIXTURE_DB_ALLOW=<service
    // DB> pattern onto their own dev stack ("to match what CI does") write
    // fixture rows straight into the real dev database — the exact incident
    // this module exists to prevent. CI's disposable service database is
    // therefore never named the same as the dev database (pulse_of_ai_ci, not
    // pulse_of_ai — see ci.yml and the test below).
    test('FIXTURE_DB_ALLOW opts ONE named, disposable database in (CI\'s service container) — '
        + 'but never the dev database itself', () => {
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai_ci', [FIXTURE_DB_ALLOW_ENV]: 'pulse_of_ai_ci' }))
            .toMatchObject({ ok: true, database: 'pulse_of_ai_ci' });
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai_ci', [FIXTURE_DB_ALLOW_ENV]: ' pulse_of_ai_ci ' }))
            .toMatchObject({ ok: true });
        // Naming a different database opts nothing in.
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai_ci', [FIXTURE_DB_ALLOW_ENV]: 'pulse_of_ai' }))
            .toMatchObject({ ok: false });
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai_ci', [FIXTURE_DB_ALLOW_ENV]: '' })).toMatchObject({ ok: false });
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai_ci', [FIXTURE_DB_ALLOW_ENV]: '1' })).toMatchObject({ ok: false });
        // The dev database's own name can never be the FIXTURE_DB_ALLOW match,
        // however it is spelled in the env — closing the F1 bypass.
        expect(fixtureTarget({ POSTGRES_DB: 'pulse_of_ai', [FIXTURE_DB_ALLOW_ENV]: 'pulse_of_ai' }))
            .toMatchObject({ ok: false });
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

describe('one definition of an e2e database, two rules (PR #42 / PR #44 reconciliation)', () => {
    const DEV = { POSTGRES_DB: 'pulse_of_ai', POSTGRES_PORT: '5434', POSTGRES_TEST_DB: 'pulse_of_ai_test', POSTGRES_TEST_PORT: '5433' };
    const NAMES = [
        'pulse_of_ai_e2e', 'pulse_of_ai_e2e_fresh', 'pulse_of_ai_e2e_gate_2', 'pulse_of_ai', 'pulse_of_ai_test',
        'postgres', 'pulse_of_ai_e2e_', 'pulse_of_ai_e2ex', 'xpulse_of_ai_e2e', 'PULSE_OF_AI_E2E',
        `pulse_of_ai_e2e_${'a'.repeat(47)}`, `pulse_of_ai_e2e_${'a'.repeat(48)}`,
    ];
    const PORTS = ['5434', '5432', '5433', '45433', '', '5434oops'];
    const TEST_PORTS = ['5433', '45433', '', 'abc'];

    // The globalSetup drops E2E_DB on POSTGRES_PORT (unset/empty → 5432),
    // then hands the fixture scripts POSTGRES_DB=E2E_DB, NODE_ENV=development
    // and the same port. For every such combination, a database the drop
    // rule accepts must be one the write rule accepts too (no
    // FIXTURE_DB_ALLOW involved) — a run can never get past the DROP and then
    // be refused mid-provisioning — and without FIXTURE_DB_ALLOW the write
    // rule accepts nothing outside the shared e2e definition.
    test('every database the DROP rule accepts, the WRITE rule accepts for the globalSetup step env', () => {
        let accepted = 0;
        for (const database of NAMES) {
            for (const port of PORTS) {
                for (const testPort of TEST_PORTS) {
                    const env = { ...DEV, POSTGRES_PORT: port, POSTGRES_TEST_PORT: testPort };
                    let dropOk = true;
                    try {
                        assertDisposableE2eDatabase({ database, port: port === '' ? 5432 : port, env });
                    } catch {
                        dropOk = false;
                    }
                    const write = fixtureTarget({ ...env, POSTGRES_DB: database, NODE_ENV: 'development' });
                    if (dropOk) {
                        accepted += 1;
                        expect({ database, port, testPort, write: write.ok }).toEqual({ database, port, testPort, write: true });
                    }
                    if (write.ok) expect(isE2eDatabaseName(database)).toBe(true);
                }
            }
        }
        expect(accepted).toBeGreaterThan(0);
    });

    test('FIXTURE_DB_ALLOW widens the WRITE rule only — it never opts a database into the DROP', () => {
        // pulse_of_ai itself can never be the FIXTURE_DB_ALLOW match (F1,
        // above), so this uses the disposable CI service DB name instead —
        // which the write rule accepts and the drop rule still refuses,
        // because it is not an e2e-shaped name.
        const env = { ...DEV, POSTGRES_DB: 'pulse_of_ai_ci', [FIXTURE_DB_ALLOW_ENV]: 'pulse_of_ai_ci' };
        expect(fixtureTarget(env)).toMatchObject({ ok: true, database: 'pulse_of_ai_ci' });
        expect(() => assertDisposableE2eDatabase({ database: 'pulse_of_ai_ci', port: 5434, env }))
            .toThrow(/\[fixture-db-guard\] refusing/);
    });

    test('isE2eDatabaseName is the pattern plus the identifier cap', () => {
        expect(E2E_DB_PATTERN.test(`pulse_of_ai_e2e_${'a'.repeat(48)}`)).toBe(true);
        expect(isE2eDatabaseName(`pulse_of_ai_e2e_${'a'.repeat(48)}`)).toBe(false);
        expect(isE2eDatabaseName(`pulse_of_ai_e2e_${'a'.repeat(47)}`)).toBe(true);
        expect(MAX_IDENTIFIER_LENGTH).toBe(63);
        expect(isE2eDatabaseName(undefined)).toBe(false);
    });
});

describe('the CI e2e job satisfies both rules (.github/workflows/ci.yml)', () => {
    const ci = yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));
    const job = ci.jobs.e2e;
    const asStrings = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, String(v)]));
    const jobEnv = asStrings(job.env);
    const stepEnv = (name) => {
        const s = job.steps.find((x) => x.name === name);
        if (!s) throw new Error(`ci.yml e2e job has no step "${name}"`);
        return { ...jobEnv, ...asStrings(s.env) };
    };

    test('the job env targets the disposable service container on the dev port, never the test port, '
        + 'and never under the dev database\'s own name (F1)', () => {
        expect(jobEnv).toMatchObject({ POSTGRES_DB: 'pulse_of_ai_ci', POSTGRES_PORT: '5434', NODE_ENV: 'development' });
        expect(jobEnv.POSTGRES_DB).not.toBe('pulse_of_ai');
        expect(job.services.postgres.ports).toEqual(['5434:5432']);
        // FIXTURE_DB_ALLOW is step-scoped, never job-wide.
        expect(jobEnv[FIXTURE_DB_ALLOW_ENV]).toBeUndefined();
    });

    test.each(['Seed dev DB', 'Freshen seed timestamps'])(
        'the "%s" step passes the WRITE rule only because FIXTURE_DB_ALLOW names the service DB', (name) => {
            const env = stepEnv(name);
            expect(env[FIXTURE_DB_ALLOW_ENV]).toBe('pulse_of_ai_ci');
            expect(assertFixtureTarget(env)).toBe('pulse_of_ai_ci');
            const without = { ...env };
            delete without[FIXTURE_DB_ALLOW_ENV];
            expect(fixtureTarget(without)).toMatchObject({ ok: false });
        });

    test('the "Run Playwright" step passes the DROP rule (default E2E_DB), and its fixture steps pass the '
        + 'WRITE rule without FIXTURE_DB_ALLOW', () => {
        const env = stepEnv('Run Playwright');
        expect(env[FIXTURE_DB_ALLOW_ENV]).toBeUndefined();
        expect(env.E2E_DB).toBeUndefined();   // the default, pulse_of_ai_e2e
        expect(assertDisposableE2eDatabase({ database: 'pulse_of_ai_e2e', port: env.POSTGRES_PORT, env }))
            .toBe('pulse_of_ai_e2e');
        expect(assertFixtureTarget({ ...env, POSTGRES_DB: 'pulse_of_ai_e2e', NODE_ENV: 'development' }))
            .toBe('pulse_of_ai_e2e');
        // ...and the service DB itself can never be dropped by that step.
        expect(() => assertDisposableE2eDatabase({ database: 'pulse_of_ai_ci', port: env.POSTGRES_PORT, env }))
            .toThrow(/refusing/);
    });
});
