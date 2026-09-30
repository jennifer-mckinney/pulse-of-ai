// tests/unit/pure/collectorRefusal.test.js — F10-5 rules (src/collectors/refusal.js).

'use strict';

const R = require('../../../src/collectors/refusal');
const { registryFields } = require('../../../src/collectors/status');
const { TEST_ENV } = require('../../helpers/fixtureTransport');

const H = 3600 * 1000;

describe('refusal rules', () => {
    test('cooldown doubles from 1 h and caps at 24 h', () => {
        expect([1, 2, 3, 4, 5, 6, 7, 50].map(n => R.cooldownMs(n) / H)).toEqual([1, 2, 4, 8, 16, 24, 24, 24]);
        expect(R.cooldownMs(0)).toBe(H);
    });

    test('refusalOf picks access_denied / robots only', () => {
        expect(R.refusalOf([{ error_kind: 'http_5xx', http_status: 500 }])).toBeNull();
        expect(R.refusalOf([{ error_kind: 'http_5xx' }, { error_kind: 'access_denied', http_status: 451 }]))
            .toEqual({ kind: 'access_denied', status: 451 });
        expect(R.refusalOf([{ error_kind: 'robots', http_status: null }])).toEqual({ kind: 'robots', status: null });
        expect(R.refusalOf(null)).toBeNull();
    });

    test('gate: none, cooldown, probe, env reset (only when newer than the refusal)', () => {
        const now = Date.parse('2026-09-29T12:00:00Z');
        const row = { access_denied_at: '2026-09-29T11:30:00Z', refused_until: '2026-09-29T12:30:00Z', access_denied_status: 403, refusal_count: 1 };
        expect(R.refusalGate(null, 'x', {}, now)).toEqual({ state: 'none' });
        expect(R.refusalGate({ access_denied_at: null }, 'x', {}, now)).toEqual({ state: 'none' });
        const c = R.refusalGate(row, 'cato', {}, now);
        expect(c.state).toBe('cooldown');
        expect(c.reason).toMatch(/HTTP 403.*SOURCE_CATO_RESET=<date> or npm run source:reset -- cato; cooldown until 2026-09-29T12:30:00.000Z/);
        expect(R.refusalGate(row, 'cato', {}, Date.parse('2026-09-29T12:31:00Z')).state).toBe('probe');
        expect(R.refusalGate(row, 'cato', { SOURCE_CATO_RESET: '2026-09-29T11:00:00Z' }, now).state).toBe('cooldown');
        const APPROVED = { GATE_APPROVED_BY: 'Ada Lovelace 2026-09-29' };
        expect(R.refusalGate(row, 'cato', { ...APPROVED, SOURCE_CATO_RESET: '2026-09-29T11:45:00Z' }, now).state).toBe('reset');
        expect(R.refusalGate(row, 'cato', { ...APPROVED, SOURCE_CATO_RESET: 'not a date' }, now).state).toBe('cooldown');
        // PR #22 decision G5 / security L6: an env reset re-opens a refused
        // source, so it needs a named approval; without one the refusal
        // stands and the reason says why.
        for (const bad of [{}, { GATE_APPROVED_BY: '' }, { GATE_APPROVED_BY: 'Name 2026-09-29' }, { GATE_APPROVED_BY: 'Ada 2026-02-30' }]) {
            const held = R.refusalGate(row, 'cato', { ...bad, SOURCE_CATO_RESET: '2026-09-29T11:45:00Z' }, now);
            expect(held.state).toBe('cooldown');
            expect(held.reason).toMatch(/SOURCE_CATO_RESET is set but awaiting named approval \(GATE_APPROVED_BY "Name YYYY-MM-DD"\)/);
        }
        expect(R.refusalGate(row, 'cato', {}, now).reason).not.toMatch(/awaiting named approval/);
        expect(R.refusalGate({ ...row, access_denied_status: null, access_denied_kind: 'robots' }, 'cato', {}, now).reason).toMatch(/robots\.txt/);
    });

    test('status: a refused collecting source is blocked_by_source and never online', () => {
        const now = Date.now();
        const base = { name: 'hacker_news', source_type: 'api', last_success_at: new Date(now - 1000).toISOString() };
        expect(registryFields(base, TEST_ENV, now)).toMatchObject({ status: 'collecting', online: true });
        const refused = registryFields({ ...base, access_denied_at: new Date(now - 1000).toISOString(),
            refused_until: new Date(now + H).toISOString(), access_denied_status: 403, refusal_count: 1 }, TEST_ENV, now);
        expect(refused).toMatchObject({ status: 'blocked_by_source', online: false, refusal_count: 1 });
    });
});

test('G10-19: online requires the last success to be no older than the last error', () => {
    const { isOnline } = require('../../../src/collectors/status');
    const now = Date.parse('2026-09-29T12:00:00Z');
    const t = m => new Date(now - m * 60000).toISOString();
    expect(isOnline('collecting', t(50), now)).toBe(true);
    expect(isOnline('collecting', t(50), now, t(10))).toBe(false);       // failed since
    expect(isOnline('collecting', t(10), now, t(50))).toBe(true);        // recovered
    expect(isOnline('collecting', t(5), now, t(5))).toBe(true);          // one run: partial failure
    expect(isOnline('collecting', t(61), now)).toBe(false);              // too old
    expect(isOnline('blocked_by_source', t(1), now)).toBe(false);        // refused
    expect(isOnline('collecting', null, now)).toBe(false);
    const base = { name: 'hacker_news', source_type: 'api', last_success_at: t(30), last_error_at: t(2) };
    expect(registryFields(base, TEST_ENV, now).online).toBe(false);
});
