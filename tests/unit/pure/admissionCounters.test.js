// tests/unit/pure/admissionCounters.test.js
// Relevance-accuracy Stage 0, P1 (rejection counters, R1): the collector
// counts, per route, why each fetched item was admitted or rejected, and
// which admission_filter rules matched it. Counts only: the tally carries no
// text and no id, and rule ids are a closed vocabulary (the database CHECK in
// migration 068 enforces the same). No DB here.

'use strict';

const fs = require('fs');
const path = require('path');
const filter = require('../../../src/collectors/ai-filter');
const counters = require('../../../src/collectors/admission-counters');
const { HttpClient } = require('../../../src/collectors/http');
const { ADAPTERS } = require('../../../src/collectors');
const { getSource } = require('../../../src/config/source-registry');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../../helpers/fixtureTransport');
const { admissionFeedXml, EXPECTED_FILTER, EXPECTED_AI, EXPECTED_DROPPED_FILTER } = require('../../helpers/admissionFeed');

const NOW = Date.parse(RECORDED_AT);

function run(slug, routeId) {
    const source = getSource(slug);
    const route = source.routes.find(r => r.id === routeId);
    const transport = fixtureTransport([[route.params.urls[0], { body: admissionFeedXml() }]]);
    const http = new HttpClient({ transport, env: TEST_ENV, sleep: () => Promise.resolve() });
    const c = new ADAPTERS[route.adapter]({ source, route, env: TEST_ENV, http, cursor: {}, httpCache: {}, now: () => NOW });
    return c.collect();
}

describe('ai-filter matchingRules (no behaviour change to admission)', () => {
    const texts = [
        'OpenAI releases a large language model', 'Machine learning helps farmers', 'Football results',
        'Robots and AI at the expo', 'said the Thai chef', 'GPT-4o and Claude', 'algorithmic trading desk', '',
    ];

    test('returns the indices of every pattern that matches, in PATTERNS order', () => {
        expect(filter.matchingRules('OpenAI releases a large language model')).toEqual([9, 10, 14]);
        expect(filter.matchingRules('Robots and AI at the expo')).toEqual([0, 19]);
        expect(filter.matchingRules('Football results')).toEqual([]);
        expect(filter.matchingRules(undefined)).toEqual([]);
    });

    test.each(texts)('isAiRelated(%j) is exactly "at least one rule matched"', (t) => {
        expect(filter.isAiRelated(t)).toBe(filter.matchingRules(t).length > 0);
    });

    test('is stateless across calls (no global-flag regex)', () => {
        for (const re of filter.PATTERNS) expect(re.flags).not.toMatch(/[gy]/);
        expect(filter.matchingRules('AI and AI')).toEqual(filter.matchingRules('AI and AI'));
    });
});

describe('rule ids are a closed vocabulary', () => {
    test('pattern ids are zero-padded indices into admission_filter PATTERNS', () => {
        expect(counters.patternRuleId(0)).toBe('pattern:00');
        expect(counters.patternRuleId(19)).toBe('pattern:19');
        expect(() => counters.patternRuleId(-1)).toThrow();
        expect(() => counters.patternRuleId(100)).toThrow();
        expect(() => counters.patternRuleId('3')).toThrow();
    });

    test('RULE_ID_RE accepts exactly the outcome ids and pattern ids', () => {
        for (const id of ['invalid', 'old', 'duplicate', 'no_pattern', 'any_pattern', 'pattern:00', 'pattern:19']) {
            expect(counters.RULE_ID_RE.test(id)).toBe(true);
        }
        for (const id of ['', 'pattern:1', 'pattern:001', 'Football results', 'a1', 'pattern:00 ', 'OLD']) {
            expect(counters.RULE_ID_RE.test(id)).toBe(false);
        }
    });

    test('the SQL CHECK in migration 068 is the same expression', () => {
        const sql = fs.readFileSync(path.join(__dirname, '../../../src/db/migrations/068_admission_counters.sql'), 'utf8');
        expect(sql).toContain(`CHECK (rule_id ~ '${counters.RULE_ID_RE.source}')`);
        expect(sql).toContain(`CHECK (route ~ '${counters.ROUTE_ID_RE.source}')`);
    });

    test('every registry route id fits ROUTE_ID_RE (so every route can be counted)', () => {
        const { SOURCES } = require('../../../src/config/source-registry');
        for (const s of SOURCES) for (const r of s.routes || []) expect([s.slug, r.id, counters.ROUTE_ID_RE.test(r.id)]).toEqual([s.slug, r.id, true]);
    });
});

describe('Collector.collect ruleHits', () => {
    test('filter route: each outcome and each matched pattern is counted, consistent with dropped', async () => {
        const r = await run('bbc_news', 'technology-rss');
        expect(r.fetched).toBe(7);
        expect(r.payloads).toHaveLength(3);
        expect(r.dropped).toEqual(EXPECTED_DROPPED_FILTER);
        expect(r.ruleHits).toEqual(EXPECTED_FILTER);
        // The tally agrees with the run counters, item for item.
        expect(r.ruleHits.no_pattern.rejected).toBe(r.dropped.outOfScope);
        expect(r.ruleHits.old.rejected).toBe(r.dropped.old);
        expect(r.ruleHits.invalid.rejected).toBe(r.dropped.invalid);
        expect(r.ruleHits.duplicate.rejected).toBe(r.dropped.duplicate);
        expect(r.ruleHits.any_pattern.admitted + r.ruleHits.no_pattern.admitted).toBe(r.payloads.length);
        expect(counters.totals(r.ruleHits)).toEqual({ evaluated: 7, admitted: 3, rejected: 4 });
    });

    test('ai route: nothing is out of scope; items no pattern matches are admitted and counted', async () => {
        const r = await run('guardian', 'ai-tag-rss');
        expect(r.dropped.outOfScope).toBe(0);
        expect(r.payloads).toHaveLength(4);
        expect(r.ruleHits).toEqual(EXPECTED_AI);
        expect(counters.totals(r.ruleHits)).toEqual({ evaluated: 7, admitted: 4, rejected: 3 });
    });

    test('the tally holds counts only: no text, no id, only closed-vocabulary keys', async () => {
        const r = await run('bbc_news', 'technology-rss');
        for (const [id, c] of Object.entries(r.ruleHits)) {
            expect(counters.RULE_ID_RE.test(id)).toBe(true);
            expect(Object.keys(c).sort()).toEqual(['admitted', 'rejected']);
            expect(Number.isInteger(c.admitted) && Number.isInteger(c.rejected)).toBe(true);
        }
        expect(JSON.stringify(r.ruleHits)).not.toMatch(/OpenAI|Football|a1|a3|farmers/);
    });
});

describe('counter helpers', () => {
    test('tally/count build { rule: { admitted, rejected } } and reject unknown rule ids', () => {
        const t = counters.newTally();
        counters.count(t, 'old', false);
        counters.count(t, 'pattern:03', true);
        counters.count(t, 'pattern:03', true);
        expect(t).toEqual({ old: { admitted: 0, rejected: 1 }, 'pattern:03': { admitted: 2, rejected: 0 } });
        expect(() => counters.count(t, 'Some headline', true)).toThrow(/rule id/);
    });

    test('rows() flattens a tally into upsert rows, skipping zero rows', () => {
        const rows = counters.rows({ old: { admitted: 0, rejected: 2 }, 'pattern:01': { admitted: 0, rejected: 0 } });
        expect(rows).toEqual([{ rule_id: 'old', admitted_count: 0, rejected_count: 2 }]);
    });

    test('mergeDropped sums the per-route dropped counters of a source run', () => {
        const total = counters.mergeDropped([
            { invalid: 1, old: 2, outOfScope: 3, duplicate: 4 },
            { invalid: 0, old: 1, outOfScope: 0, duplicate: 1 },
            undefined,
        ]);
        expect(total).toEqual({ invalid: 1, old: 3, outOfScope: 3, duplicate: 5 });
    });

    test('retention window: ADMISSION_RULE_HITS_DAYS, default 400 days, strict', () => {
        expect(counters.ruleHitsRetentionDays({})).toBe(400);
        expect(counters.DEFAULT_RULE_HITS_DAYS).toBe(400);
        expect(counters.ruleHitsRetentionDays({ ADMISSION_RULE_HITS_DAYS: '730' })).toBe(730);
        expect(() => counters.ruleHitsRetentionDays({ ADMISSION_RULE_HITS_DAYS: '10' })).toThrow(/ADMISSION_RULE_HITS_DAYS/);
        expect(() => counters.ruleHitsRetentionDays({ ADMISSION_RULE_HITS_DAYS: 'forever' })).toThrow(/not a valid retention window/);
    });
});

describe('migration 068 is additive', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../../src/db/migrations/068_admission_counters.sql'), 'utf8');
    const body = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

    test('adds columns and one table; never drops, deletes or rewrites', () => {
        expect(body).not.toMatch(/DROP |DELETE FROM|TRUNCATE|UPDATE [a-z_]+ SET|ALTER COLUMN/i);
        for (const col of ['dropped_invalid', 'dropped_old', 'dropped_out_of_scope', 'dropped_duplicate']) {
            expect(body).toMatch(new RegExp(`ALTER TABLE source_runs\\s+ADD COLUMN IF NOT EXISTS ${col} INTEGER`));
            expect(body).toMatch(new RegExp(`ALTER TABLE source_run_daily\\s+ADD COLUMN IF NOT EXISTS ${col} BIGINT`));
        }
        expect(body).toMatch(/CREATE TABLE IF NOT EXISTS admission_rule_hits/);
    });

    test('admission_rule_hits has the counts-only columns, nothing else', () => {
        const table = body.match(/CREATE TABLE IF NOT EXISTS admission_rule_hits \(([\s\S]*?)\n\);/)[1];
        const cols = table.split('\n').map(l => l.trim()).filter(l => /^[a-z_]+\s/.test(l) && !/^(PRIMARY|CHECK)/i.test(l))
            .map(l => l.split(/\s+/)[0]);
        expect(cols).toEqual(['day', 'source_id', 'route', 'admission_mv_id', 'rule_id', 'admitted_count', 'rejected_count', 'updated_at']);
    });
});
