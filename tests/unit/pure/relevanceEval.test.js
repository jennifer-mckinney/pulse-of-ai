// tests/unit/pure/relevanceEval.test.js
// Relevance-accuracy Stage 0 (P5): the offline comparison behind
// scripts/relevance-eval.js (src/gold/eval.js) — the released scorers
// (relevance@current, admission_filter@1.0.0) versus the tiered library,
// aggregated per category. Pure: no database.

'use strict';

const e = require('../../../src/gold/eval');

describe('evaluateText', () => {
    it('runs the released relevance scorer, the admission filter and the tiered library', () => {
        const r = e.evaluateText('a transformer toy for kids');
        expect(r.current).toBe(true);          // relevance@1.2.0 counts "transformer"
        expect(r.admission).toBe(false);
        expect(r.tiered.ai).toBe(false);       // the tiered library needs a co-term
    });

    it('treats empty text as nothing everywhere', () => {
        expect(e.evaluateText('')).toMatchObject({ current: false, admission: false, tiered: { ai: false } });
    });
});

describe('aggregate', () => {
    const rows = [
        { category: 'news', storedRelevant: true, text: 'OpenAI ships a large language model' }, // both ("OpenAI" alone is not a relevance@1.2.0 term)
        { category: 'news', storedRelevant: true, text: 'a transformer toy for kids' },    // current only
        { category: 'news', storedRelevant: null, text: '人工智能正在改变医疗' },             // tiered only
        { category: 'forums', storedRelevant: false, text: 'Delta Airlines reservations number: change my flight with AI' }, // spam
        { category: 'forums', storedRelevant: false, text: 'robot vacuum on sale' },        // neither (robot unresolved)
    ];

    it('counts per category and in total, with the tiered-minus-current delta', () => {
        const r = e.aggregate(rows);
        const news = r.categories.find(c => c.category === 'news');
        expect(news).toMatchObject({
            n: 3, stored_relevant: 2, stored_unscored: 1, current_relevant: 2, tiered_ai: 2,
            both: 1, current_only: 1, tiered_only: 1, spam: 0, delta: 0,
        });
        const forums = r.categories.find(c => c.category === 'forums');
        expect(forums).toMatchObject({ n: 2, current_relevant: 1, tiered_ai: 1, tiered_ai_nonspam: 0, spam: 1, delta: 0, current_only: 0 });
        expect(forums.delta_rate).toBeCloseTo(0, 12);
        expect(forums.edge_cases.robotics_without_learning).toBe(1);
        expect(r.total).toMatchObject({ n: 5, current_relevant: 3, tiered_ai: 3, tiered_ai_nonspam: 2, delta: 0 });
    });

    it('lists categories in sorted order and is deterministic', () => {
        const a = e.aggregate(rows);
        expect(a.categories.map(c => c.category)).toEqual(['forums', 'news']);
        expect(e.aggregate([...rows].reverse())).toEqual(a);
    });

    it('an empty input gives zero totals and no categories', () => {
        expect(e.aggregate([])).toMatchObject({ categories: [], total: { n: 0, delta: 0, delta_rate: 0 } });
    });
});

describe('formatReport', () => {
    it('renders a header, one line per category and the total, without any post text', () => {
        const rows = [{ category: 'news', storedRelevant: true, text: 'OpenAI secret text 123' }];
        const lines = e.formatReport(e.aggregate(rows), { versions: { relevance: '1.2.0', admission: '1.0.0', tiers: '0.1.0-draft' } });
        const out = lines.join('\n');
        expect(out).toMatch(/relevance@1\.2\.0/);
        expect(out).toMatch(/admission_filter@1\.0\.0/);
        expect(out).toMatch(/tiers 0\.1\.0-draft/);
        expect(out).toMatch(/^news\s/m);
        expect(out).toMatch(/^TOTAL\s/m);
        expect(out).not.toMatch(/secret text/);
    });
});

describe('review fixes: tiered_ai_nonspam and per-edge-case tiered_ai', () => {
    it('counts AI-by-topic posts without a spam hit, and tiered_ai among each edge-case tag', () => {
        const r = e.aggregate([
            { category: 'forums', storedRelevant: true, text: 'Delta Airlines reservations number: change my flight with AI' },
            { category: 'forums', storedRelevant: true, text: 'a game AI opponent that uses machine learning' },
        ]);
        expect(r.total).toMatchObject({ tiered_ai: 2, tiered_ai_nonspam: 1, spam: 1 });
        expect(r.total.edge_cases_tiered_ai.game_ai).toBe(1);
        expect(e.formatReport(r).join('\n')).toMatch(/tiered_ai_nonspam/);
    });
});

describe('review fixes round 2: aligned report columns', () => {
    it('every report row has the same width as the header (the longest column name fits)', () => {
        const lines = e.formatReport(e.aggregate([{ category: 'news', storedRelevant: true, text: 'OpenAI model' }]));
        const head = lines.find(x => x.startsWith('category'));
        const rows = lines.filter(x => /^(news|TOTAL)\s/.test(x));
        expect(rows.length).toBe(2);
        for (const r of rows) expect(r.length).toBe(head.length);
    });
});
