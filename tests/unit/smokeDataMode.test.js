// tests/unit/smokeDataMode.test.js
// G9-2: the smoke check derives the EXPECTED data mode from what the globe
// renders — /api/posts/aggregated-by-location (placed rows, demo_posts /
// total) — never by re-running /api/health's SQL, and it tolerates the demo
// feed landing a batch (or posts ageing out) between its reads.

'use strict';

const { modeOfAggregatedRows, checkDataMode } = require('../../scripts/smoke-check');

describe('modeOfAggregatedRows', () => {
    test('sums placed rows only (the globe drops rows without coordinates)', () => {
        expect(modeOfAggregatedRows([
            { city: 'London', lat: 51.5, total: 3, demo_posts: 3 },
            { city: 'Atlantis', lat: null, total: 5, demo_posts: 0 },
        ])).toEqual({ posts: 3, demo: 3, mode: 'demo' });
        expect(modeOfAggregatedRows([])).toEqual({ posts: 0, demo: 0, mode: 'none' });
        expect(modeOfAggregatedRows([{ lat: 1, total: 4, demo_posts: 1 }]).mode).toBe('mixed');
    });
});

describe('checkDataMode (race-tolerant)', () => {
    const agg = (mode) => ({ demo: { posts: 5, demo: 5, mode: 'demo' }, live: { posts: 5, demo: 0, mode: 'live' },
        mixed: { posts: 6, demo: 5, mode: 'mixed' }, none: { posts: 0, demo: 0, mode: 'none' } })[mode];
    const seq = (items) => { let i = 0; return jest.fn(async () => items[Math.min(i++, items.length - 1)]); };

    test('passes when health matches the globe', async () => {
        const r = await checkDataMode({
            readAggregated: seq([agg('demo'), agg('demo')]),
            readHealthMode: seq(['demo']),
            attempts: 3, delayMs: 0,
        });
        expect(r).toMatchObject({ ok: true, health: 'demo', expected: 'demo' });
    });

    test('a batch landing between the reads is not a failure (health matches either snapshot)', async () => {
        const r = await checkDataMode({
            readAggregated: seq([agg('live'), agg('mixed')]),
            readHealthMode: seq(['mixed']),
            attempts: 3, delayMs: 0,
        });
        expect(r).toMatchObject({ ok: true, health: 'mixed' });
    });

    test('retries when both snapshots moved, then passes on a stable read', async () => {
        const readAggregated = seq([agg('live'), agg('demo'), agg('mixed'), agg('mixed')]);
        const readHealthMode = seq(['none', 'mixed']);
        const r = await checkDataMode({ readAggregated, readHealthMode, attempts: 3, delayMs: 0 });
        expect(r.ok).toBe(true);
        expect(readHealthMode).toHaveBeenCalledTimes(2);
    });

    test('a persistent disagreement fails after every attempt', async () => {
        const readHealthMode = seq(['live']);
        const r = await checkDataMode({
            readAggregated: seq([agg('demo')]), readHealthMode, attempts: 3, delayMs: 0,
        });
        expect(r).toMatchObject({ ok: false, health: 'live', expected: 'demo' });
        expect(readHealthMode).toHaveBeenCalledTimes(3);
    });
});
