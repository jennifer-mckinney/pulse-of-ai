// tests/integration/admission.counters.test.js
// Relevance-accuracy Stage 0, P1 (rejection counters, R1; Jennifer McKinney
// 2026-09-30, "Counters only (Recommended)"), against the real test DB:
//   - a collection run persists the collector's dropped counters on its
//     source_runs row and upserts per-rule counts into admission_rule_hits
//     (counts only — the CHECKs refuse free text);
//   - the counts are served as aggregates by GET /api/sources (per source)
//     and GET /api/health (all sources, per rule);
//   - the source_runs rollup carries the dropped counts into source_run_daily;
//   - admission_rule_hits keeps ADMISSION_RULE_HITS_DAYS (400) days, logged;
//   - a failing counter write is a run warning, never a lost post.

'use strict';

const request = require('supertest');
const app = require('../../src/server');
const db = require('../../src/db/connection');
const { dbAll, dbGet, dbRun } = db;
const health = require('../../src/routes/health');
const { runCollection } = require('../../src/collectors/runner');
const counters = require('../../src/collectors/admission-counters');
const { rollupSourceRuns } = require('../../src/collectors/run-retention');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');
const { admissionFeedXml, EXPECTED_FILTER, EXPECTED_DROPPED_FILTER } = require('../helpers/admissionFeed');

// storeRawPost fails for the next `mockFailStores` calls, then stores.
let mockFailStores = 0;
jest.mock('../../src/pipeline/ingest', () => {
    const real = jest.requireActual('../../src/pipeline/ingest');
    return {
        ...real,
        storeRawPost: async (...a) => {
            if (mockFailStores > 0) { mockFailStores--; throw new Error('db blip'); }
            return real.storeRawPost(...a);
        },
    };
});

const NOW = () => Date.parse(RECORDED_AT);
const BBC = 'https://feeds.bbci.co.uk/news/technology/rss.xml';
const DAY = 86400000;

function queuesMock() {
    return { enqueueEmbeds: jest.fn().mockResolvedValue(), enqueueIngestRetry: jest.fn().mockResolvedValue() };
}

async function collectBbc() {
    return runCollection({
        slugs: ['bbc_news'], triggeredBy: 'test', env: TEST_ENV, now: NOW, queues: queuesMock(),
        transport: fixtureTransport([[BBC, { body: admissionFeedXml() }]]),
        collectorCtx: { sleep: () => Promise.resolve() },
    });
}

/** Lets the same source run again at once (the claim honours the poll interval). */
const releaseClaim = () => dbRun('UPDATE source_collection_state SET last_attempt_at = NULL');

const bbcId = async () => (await dbGet(`SELECT id FROM data_sources WHERE name = 'bbc_news'`)).id;
const admissionMvId = async () => (await dbGet(
    `SELECT id FROM methodology_versions WHERE component = 'admission_filter' AND version = '1.0.0'`)).id;

async function hitsByRule() {
    const rows = await dbAll(
        `SELECT rule_id, admitted_count::int AS admitted, rejected_count::int AS rejected FROM admission_rule_hits ORDER BY rule_id`);
    return Object.fromEntries(rows.map(r => [r.rule_id, { admitted: r.admitted, rejected: r.rejected }]));
}

const double = (o) => Object.fromEntries(Object.entries(o).map(([k, c]) => [k, { admitted: 2 * c.admitted, rejected: 2 * c.rejected }]));

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

describe('collection run → counters', () => {
    it('writes the dropped counters on the run row and the rule counts for today (UTC), keyed by route and version', async () => {
        const summary = await collectBbc();
        expect(summary.sources[0]).toMatchObject({ outcome: 'ok', fetched: 7, kept: 3, new: 3 });

        const run = await dbGet(
            `SELECT items_fetched, posts_new, dropped_invalid, dropped_old, dropped_out_of_scope, dropped_duplicate
             FROM source_runs WHERE source_id = $1`, [await bbcId()]);
        expect(run).toEqual({
            items_fetched: 7, posts_new: 3,
            dropped_invalid: EXPECTED_DROPPED_FILTER.invalid, dropped_old: EXPECTED_DROPPED_FILTER.old,
            dropped_out_of_scope: EXPECTED_DROPPED_FILTER.outOfScope, dropped_duplicate: EXPECTED_DROPPED_FILTER.duplicate,
        });

        expect(await hitsByRule()).toEqual(EXPECTED_FILTER);
        const keys = await dbAll(
            `SELECT DISTINCT day = (NOW() AT TIME ZONE 'UTC')::date AS today, source_id, route, admission_mv_id FROM admission_rule_hits`);
        expect(keys).toEqual([{ today: true, source_id: await bbcId(), route: 'technology-rss', admission_mv_id: await admissionMvId() }]);
    });

    it('a second run on the same day adds to the same rows (evaluations are counted again)', async () => {
        await collectBbc();
        await releaseClaim();
        const second = await collectBbc();
        expect(second.sources[0]).toMatchObject({ outcome: 'ok', fetched: 7, kept: 3, new: 0 });
        expect(await hitsByRule()).toEqual(double(EXPECTED_FILTER));
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM admission_rule_hits')).n).toBe(Object.keys(EXPECTED_FILTER).length);
        const runs = await dbAll('SELECT dropped_out_of_scope FROM source_runs ORDER BY started_at');
        expect(runs).toEqual([{ dropped_out_of_scope: 1 }, { dropped_out_of_scope: 1 }]);
    });

    it('a failed counter write is a run warning: the posts are stored and the run row still records dropped', async () => {
        const spy = jest.spyOn(counters, 'recordRuleHits').mockRejectedValueOnce(new Error('counters down'));
        try {
            const summary = await collectBbc();
            expect(summary.sources[0]).toMatchObject({ outcome: 'ok', new: 3 });
            expect(summary.sources[0].error).toMatch(/technology-rss: admission counters not recorded: counters down/);
            expect((await dbGet('SELECT COUNT(*)::int AS n FROM raw_posts')).n).toBe(3);
            expect(await dbGet('SELECT dropped_out_of_scope FROM source_runs')).toEqual({ dropped_out_of_scope: 1 });
            expect(await hitsByRule()).toEqual({});
        } finally {
            spy.mockRestore();
        }
    });
});

describe('what is counted, and when', () => {
    it('a route whose store failed is not counted; the run that completes it is (no double count)', async () => {
        mockFailStores = 1;
        try {
            const failed = await collectBbc();
            expect(failed.sources[0].outcome).toBe('error');
            expect(await hitsByRule()).toEqual({});
        } finally {
            mockFailStores = 0;
        }
        await releaseClaim();
        const retry = await collectBbc();
        expect(retry.sources[0]).toMatchObject({ outcome: 'ok' });
        expect(await hitsByRule()).toEqual(EXPECTED_FILTER);
    });

    it('a run that evaluated no route records NULL dropped counts, not a fake 0; an object records its counts', async () => {
        const { recordRun } = require('../../src/collectors/state');
        const base = { sourceId: await bbcId(), jobId: null, gateStatus: 'collecting', itemsFetched: 0, postsNew: 0 };
        await recordRun({ ...base, outcome: 'skipped' });
        await recordRun({ ...base, outcome: 'ok', dropped: { invalid: 0, old: 2 } });
        const rows = await dbAll('SELECT dropped_invalid, dropped_old, dropped_out_of_scope, dropped_duplicate FROM source_runs ORDER BY started_at, outcome DESC');
        const byOld = Object.fromEntries(rows.map(r => [String(r.dropped_old), r]));
        expect(byOld.null).toEqual({ dropped_invalid: null, dropped_old: null, dropped_out_of_scope: null, dropped_duplicate: null });
        expect(byOld['2']).toEqual({ dropped_invalid: 0, dropped_old: 2, dropped_out_of_scope: 0, dropped_duplicate: 0 });
    });
});

describe('a malformed retention window is visible', () => {
    it('admissionTotals flags retention_invalid and reports no window', async () => {
        const t = await counters.admissionTotals({ env: { ADMISSION_RULE_HITS_DAYS: 'abc' } });
        expect(t).toMatchObject({ retention_days: null, retention_invalid: true });
    });
});

describe('an optional metric never takes the status endpoints down', () => {
    it('GET /api/health answers 200 with admission null when the admission query fails', async () => {
        const spy = jest.spyOn(counters, 'admissionTotals').mockRejectedValue(new Error('relation does not exist'));
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const res = await request(app).get('/api/health');
            expect(res.status).toBe(200);
            expect(res.body.admission).toBeNull();
        } finally { spy.mockRestore(); err.mockRestore(); }
    });
    it('GET /api/sources answers 200 with admission null when the admission query fails', async () => {
        const spy = jest.spyOn(counters, 'admissionBySource').mockRejectedValue(new Error('timeout'));
        try {
            const res = await request(app).get('/api/sources');
            expect(res.status).toBe(200);
            expect(res.body.find(r => r.slug === 'bbc_news').admission).toBeNull();
        } finally { spy.mockRestore(); }
    });
});

describe('admission_rule_hits refuses anything but counts', () => {
    const insert = async (route, ruleId) => dbRun(
        `INSERT INTO admission_rule_hits (day, source_id, route, admission_mv_id, rule_id, admitted_count, rejected_count)
         VALUES (CURRENT_DATE, $1, $2, $3, $4, 1, 0)`, [await bbcId(), route, await admissionMvId(), ruleId]);

    it('accepts closed-vocabulary rule ids and registry-shaped routes only', async () => {
        await insert('technology-rss', 'pattern:07');
        await expect(insert('technology-rss', 'OpenAI releases a large language model')).rejects.toThrow(/check constraint/);
        await expect(insert('technology-rss', 'pattern:7')).rejects.toThrow(/check constraint/);
        await expect(insert('Some Title Here', 'old')).rejects.toThrow(/check constraint/);
        await expect(dbRun(`UPDATE admission_rule_hits SET admitted_count = -1`)).rejects.toThrow(/check constraint/);
    });

    it('recordRuleHits refuses a route id that is not registry-shaped before touching the database', async () => {
        await expect(counters.recordRuleHits({
            sourceId: await bbcId(), route: 'https://example.org/feed', admissionMvId: await admissionMvId(),
            tally: { old: { admitted: 0, rejected: 1 } },
        })).rejects.toThrow(/not a registry route id/);
        expect(await counters.recordRuleHits({
            sourceId: await bbcId(), route: 'technology-rss', admissionMvId: await admissionMvId(), tally: {},
        })).toBe(0);
    });
});

describe('the API serves aggregates only', () => {
    it('GET /api/sources: the 7-day admission summary per source; null for a source with no counts', async () => {
        await collectBbc();
        const res = await request(app).get('/api/sources');
        expect(res.status).toBe(200);
        const bbc = res.body.find(r => r.slug === 'bbc_news');
        expect(bbc.admission).toEqual({
            window_days: 7, evaluated: 7, admitted: 3, admitted_without_pattern: 0,
            rejected: { total: 4, out_of_scope: 1, old: 1, invalid: 1, duplicate: 1 },
        });
        expect(res.body.find(r => r.slug === 'hacker_news').admission).toBeNull();
    });

    it('GET /api/health: totals over all sources, the per-pattern admissions by version, the retention window', async () => {
        health._setQueueCountsForTests(async () => ({}));
        try {
            await collectBbc();
            const res = await request(app).get('/api/health');
            expect(res.status).toBe(200);
            expect(res.body.admission).toEqual({
                window_days: 7, day_basis: 'UTC', counted_as: expect.stringMatching(/^evaluations/),
                sources_reporting: 1, evaluated: 7, admitted: 3, admitted_without_pattern: 0,
                rejected: { total: 4, out_of_scope: 1, old: 1, invalid: 1, duplicate: 1 },
                patterns: ['pattern:00', 'pattern:06', 'pattern:09', 'pattern:10', 'pattern:14', 'pattern:19']
                    .map(rule_id => ({ admission_filter: '1.0.0', rule_id, admitted: 1, rejected: 0 })),
                retention_days: 400, retention_invalid: false,
            });
            // Aggregates only: no source id, route, title or text.
            const json = JSON.stringify(res.body.admission);
            expect(json).not.toMatch(/technology-rss|OpenAI|Football|[0-9a-f]{8}-[0-9a-f]{4}-/);
        } finally {
            health._setQueueCountsForTests(null);
        }
    });

    it('counts older than the 7-day window are not served (but are kept until retention)', async () => {
        await collectBbc();
        await dbRun(`UPDATE admission_rule_hits SET day = day - 7`);
        const res = await request(app).get('/api/sources');
        expect(res.body.find(r => r.slug === 'bbc_news').admission).toBeNull();
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM admission_rule_hits')).n).toBeGreaterThan(0);
    });
});

describe('retention', () => {
    async function seedHits(daysAgo, ruleId = 'old') {
        await dbRun(
            `INSERT INTO admission_rule_hits (day, source_id, route, admission_mv_id, rule_id, admitted_count, rejected_count)
             VALUES ((NOW() AT TIME ZONE 'UTC')::date - $1::int, $2, 'technology-rss', $3, $4, 0, 5)`,
            [daysAgo, await bbcId(), await admissionMvId(), ruleId]);
    }

    it('removes rows older than 400 days in batches, logs the true count, keeps the rest', async () => {
        await seedHits(401);
        await seedHits(401, 'invalid');
        await seedHits(500);
        await seedHits(400);
        await seedHits(3);
        const r = await counters.expireRuleHits({ env: {}, batch: 2 });
        expect(r).toEqual({ removed: 3, batches: 2, keepDays: 400 });
        const left = await dbAll(`SELECT (NOW() AT TIME ZONE 'UTC')::date - day AS age FROM admission_rule_hits ORDER BY day`);
        expect(left).toEqual([{ age: 400 }, { age: 3 }]);
        const log = await dbAll(`SELECT action, reason, raw_post_id FROM data_retention_log ORDER BY performed_at`);
        expect(log.map(l => [l.action, l.raw_post_id, JSON.parse(l.reason).rows])).toEqual([
            ['expired_admission_rule_hits', null, 2], ['expired_admission_rule_hits', null, 1]]);
    });

    it('ADMISSION_RULE_HITS_DAYS overrides the window; a bad value removes nothing', async () => {
        await seedHits(100);
        await expect(counters.expireRuleHits({ env: { ADMISSION_RULE_HITS_DAYS: '7' } })).rejects.toThrow(/ADMISSION_RULE_HITS_DAYS/);
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM admission_rule_hits')).n).toBe(1);
        expect(await counters.expireRuleHits({ env: { ADMISSION_RULE_HITS_DAYS: '90' } })).toMatchObject({ removed: 1 });
    });

    it('is a step of the daily maintenance task', () => {
        const { defaultSteps } = require('../../src/workers/maintenance.worker');
        expect(defaultSteps({ log: () => {}, task: 'daily' }).map(([n]) => n)).toContain('admission_rule_hits');
    });
});

describe('source_runs rollup carries the dropped counts (spec §19 Tier 3)', () => {
    it('sums them per day and source; rows from before migration 068 stay NULL (not recorded), never 0', async () => {
        const src = await bbcId();
        const old = new Date(Date.now() - 40 * DAY);
        const ins = (dropped) => dbRun(
            `INSERT INTO source_runs (source_id, gate_status, outcome, items_fetched, posts_new, requests, started_at, finished_at,
                                      dropped_invalid, dropped_old, dropped_out_of_scope, dropped_duplicate)
             VALUES ($1, 'collecting', 'ok', 5, 1, 1, $2, $2, $3, $4, $5, $6)`, [src, old, ...dropped]);
        await ins([1, 2, 3, 4]);
        await ins([0, 1, 1, 0]);
        await rollupSourceRuns({ env: {} });
        expect(await dbGet('SELECT dropped_invalid, dropped_old, dropped_out_of_scope, dropped_duplicate FROM source_run_daily'))
            .toEqual({ dropped_invalid: '1', dropped_old: '3', dropped_out_of_scope: '4', dropped_duplicate: '4' });

        // A late pre-068 row (NULL counters) for the same day leaves the sums as they are.
        await ins([null, null, null, null]);
        await rollupSourceRuns({ env: {} });
        expect(await dbGet('SELECT runs, dropped_old FROM source_run_daily')).toEqual({ runs: 3, dropped_old: '3' });

        // A day with only pre-068 rows reports NULL.
        await dbRun(`INSERT INTO source_runs (source_id, gate_status, outcome, started_at, finished_at)
                     VALUES ($1, 'collecting', 'ok', $2, $2)`, [src, new Date(Date.now() - 50 * DAY)]);
        await rollupSourceRuns({ env: {} });
        const rows = await dbAll('SELECT dropped_old FROM source_run_daily ORDER BY day');
        expect(rows).toEqual([{ dropped_old: null }, { dropped_old: '3' }]);
    });
});
