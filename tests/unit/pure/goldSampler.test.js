// tests/unit/pure/goldSampler.test.js
// Relevance-accuracy Stage 0 (P3): the stratified gold-set sampler's pure
// parts (src/gold/sampler.js) — strata (category × scope × current decision
// × script), stratum weights, allocation, deterministic draw, design weights.

'use strict';

const s = require('../../../src/gold/sampler');

describe('scriptOf — dominant writing script of the text', () => {
    it.each([
        ['latin', 'OpenAI ships a new model'],
        ['latin', 'La inteligencia artificial avanza rápidamente'],
        ['cjk', '人工智能正在改变世界'],
        ['cjk', '人工知能の規制について議論'],
        ['cjk', '인공지능 규제 법안 통과'],
        ['cyrillic', 'Искусственный интеллект в медицине'],
        ['arabic', 'الذكاء الاصطناعي في التعليم'],
        ['other', 'कृत्रिम बुद्धिमत्ता'],
        ['other', '12345 !!! ---'],
        ['other', ''],
    ])('%s: %s', (script, text) => {
        expect(s.scriptOf(text)).toBe(script);
    });

    it('counts letters, so a few English words in Chinese text stay cjk', () => {
        expect(s.scriptOf('OpenAI 发布了新的人工智能模型和工具链')).toBe('cjk');
    });

    it('non-strings are other', () => {
        expect(s.scriptOf(null)).toBe('other');
    });
});

describe('scopeOf — registry route scope of a stored post', () => {
    it('reads the scope of the route that collected the post', () => {
        expect(s.scopeOf('bbc_news', 'technology-rss')).toBe('filter');
        expect(s.scopeOf('guardian', 'ai-tag-rss')).toBe('ai');
    });

    it('is unknown for an unregistered source or route', () => {
        expect(s.scopeOf('no-such-source', 'x')).toBe('unknown');
        expect(s.scopeOf('bbc_news', 'no-such-route')).toBe('unknown');
        expect(s.scopeOf('bbc_news', null)).toBe('unknown');
    });
});

describe('decisionOf — the current relevance decision', () => {
    it('maps is_relevant to the decision stratum', () => {
        expect(s.decisionOf(true)).toBe('relevant');
        expect(s.decisionOf(false)).toBe('not_relevant');
        expect(s.decisionOf(null)).toBe('unscored');
        expect(s.decisionOf(undefined)).toBe('unscored');
    });
});

describe('stratumKey / parseStratumKey', () => {
    it('joins the four dimensions with "|" and round-trips', () => {
        const d = { category: 'news', scope: 'filter', decision: 'relevant', script: 'latin' };
        expect(s.stratumKey(d)).toBe('news|filter|relevant|latin');
        expect(s.parseStratumKey('news|filter|relevant|latin')).toEqual(d);
    });
});

describe('parseWeightSpecs / stratumWeight', () => {
    it('parses dim:value=x specs; weights multiply across dimensions', () => {
        const w = s.parseWeightSpecs(['script:cjk=4', 'decision:not_relevant=2']);
        expect(s.stratumWeight(w, { category: 'news', scope: 'ai', decision: 'not_relevant', script: 'cjk' })).toBe(8);
        expect(s.stratumWeight(w, { category: 'news', scope: 'ai', decision: 'relevant', script: 'latin' })).toBe(1);
    });

    it.each([
        ['lang:cjk=2'],         // unknown dimension
        ['script:cjk'],         // no value
        ['script:cjk=0'],       // not positive
        ['script:cjk=-1'],
        ['script:cjk=abc'],
        ['script:cjk=Infinity'],
        ['script:klingon=2'],   // unknown script
        ['scope:other=2'],      // unknown scope
        ['decision:maybe=2'],   // unknown decision
    ])('rejects %s', (spec) => {
        expect(() => s.parseWeightSpecs([spec])).toThrow(/weight/i);
    });

    it('rejects a dimension:value given twice', () => {
        expect(() => s.parseWeightSpecs(['script:cjk=2', 'script:cjk=3'])).toThrow(/twice/);
    });
});

describe('allocate — sample sizes per stratum', () => {
    const strata = (rows) => rows.map(([key, population, weight = 1]) => ({ key, population, weight }));

    it('sums exactly to the requested total and never exceeds a stratum population', () => {
        const plan = s.allocate(strata([['a', 1000], ['b', 300], ['c', 7], ['d', 2]]), 100, { minPerStratum: 5 });
        const total = [...plan.values()].reduce((x, y) => x + y, 0);
        expect(total).toBe(100);
        expect(plan.get('c')).toBeLessThanOrEqual(7);
        expect(plan.get('d')).toBe(2);       // capped at its population
        expect(plan.get('a')).toBeGreaterThan(plan.get('b'));
    });

    it('guarantees the minimum per stratum (oversampling small strata)', () => {
        const plan = s.allocate(strata([['big', 10000], ['small', 50]]), 40, { minPerStratum: 10 });
        expect(plan.get('small')).toBeGreaterThanOrEqual(10);
        expect(plan.get('big') + plan.get('small')).toBe(40);
    });

    it('applies stratum weights to the proportional share', () => {
        const even = s.allocate(strata([['x', 500], ['y', 500]]), 100, { minPerStratum: 0 });
        const tilted = s.allocate(strata([['x', 500, 3], ['y', 500, 1]]), 100, { minPerStratum: 0 });
        expect(even.get('x')).toBe(50);
        expect(tilted.get('x')).toBe(75);
        expect(tilted.get('y')).toBe(25);
    });

    it('takes the whole population when the total is at least its size', () => {
        const plan = s.allocate(strata([['a', 3], ['b', 4]]), 50, { minPerStratum: 1 });
        expect(Object.fromEntries(plan)).toEqual({ a: 3, b: 4 });
    });

    it('is deterministic: ties are broken by key', () => {
        const a = s.allocate(strata([['b', 10], ['a', 10], ['c', 10]]), 10, { minPerStratum: 0 });
        const b = s.allocate(strata([['c', 10], ['a', 10], ['b', 10]]), 10, { minPerStratum: 0 });
        expect(Object.fromEntries(a)).toEqual(Object.fromEntries(b));
    });

    it('rejects a total smaller than the per-stratum minimum requires', () => {
        expect(() => s.allocate(strata([['a', 100], ['b', 100], ['c', 100]]), 5, { minPerStratum: 2 })).toThrow(/minimum/);
    });

    it('rejects a non-positive total', () => {
        expect(() => s.allocate(strata([['a', 1]]), 0)).toThrow(/total/);
    });

    it('an empty population allocates nothing', () => {
        expect(s.allocate([], 10).size).toBe(0);
    });
});

describe('drawRank / selectSample — deterministic, seeded draw', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
        rawPostId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        stratum: i < 40 ? 'news|filter|relevant|latin' : 'forums|ai|not_relevant|cjk',
    }));

    it('drawRank is sha256(seed:id), hex', () => {
        expect(s.drawRank('seed-1', 'abc')).toMatch(/^[0-9a-f]{64}$/);
        expect(s.drawRank('seed-1', 'abc')).toBe(s.drawRank('seed-1', 'abc'));
        expect(s.drawRank('seed-2', 'abc')).not.toBe(s.drawRank('seed-1', 'abc'));
    });

    it('selects n_h per stratum with design weight N_h / n_h, reproducibly', () => {
        const plan = new Map([['news|filter|relevant|latin', 4], ['forums|ai|not_relevant|cjk', 5]]);
        const a = s.selectSample(rows, plan, 'seed-1');
        const b = s.selectSample([...rows].reverse(), plan, 'seed-1');
        expect(a).toEqual(b);
        expect(a).toHaveLength(9);
        const news = a.filter(r => r.stratum.startsWith('news'));
        expect(news).toHaveLength(4);
        expect(news[0]).toMatchObject({ stratumPopulation: 40, stratumSampleSize: 4, designWeight: 10 });
        expect(a.filter(r => r.stratum.startsWith('forums'))[0].designWeight).toBe(4);
    });

    it('a different seed draws a different sample', () => {
        const plan = new Map([['news|filter|relevant|latin', 4]]);
        const ids = (seed) => s.selectSample(rows, plan, seed).map(r => r.rawPostId).join();
        expect(ids('seed-1')).not.toBe(ids('seed-2'));
    });

    it('the selected rows are ordered by draw rank (blind, interleaved labelling order)', () => {
        const plan = new Map([['news|filter|relevant|latin', 10], ['forums|ai|not_relevant|cjk', 10]]);
        const out = s.selectSample(rows, plan, 'seed-1');
        const ranks = out.map(r => r.drawRank);
        expect([...ranks].sort()).toEqual(ranks);
    });

    it('rejects an empty seed', () => {
        expect(() => s.selectSample(rows, new Map(), '')).toThrow(/seed/);
    });
});

describe('planSample — the whole pure pipeline from candidates to items', () => {
    it('summarises strata and returns the selected items', () => {
        const candidates = [];
        for (let i = 0; i < 30; i++) {
            candidates.push({ rawPostId: `p${i}`, category: i % 2 ? 'news' : 'forums', scope: 'filter',
                decision: i % 3 ? 'relevant' : 'not_relevant', script: 'latin', inputHash: 'a'.repeat(64), relevanceMvId: null });
        }
        const out = s.planSample(candidates, { total: 12, seed: 's', minPerStratum: 1, weights: s.parseWeightSpecs(['decision:not_relevant=2']) });
        expect(out.items).toHaveLength(12);
        expect(out.strata.reduce((n, x) => n + x.sampleSize, 0)).toBe(12);
        expect(out.strata.reduce((n, x) => n + x.population, 0)).toBe(30);
        for (const it of out.items) {
            expect(it.stratum).toBe(s.stratumKey(it));
            expect(it.stratumWeight).toBe(it.decision === 'not_relevant' ? 2 : 1);
        }
    });
});

describe('review fixes: mixed-script posts and the streaming two-pass sampler', () => {
    it('URLs, mentions and hashtags do not make a Chinese post Latin', () => {
        expect(s.scriptOf('人工智能 https://example.com/a/very/long/path/to/some/page #aitrends @someone')).toBe('cjk');
        expect(s.scriptOf('new model from OpenAI and 人工智能')).toBe('latin');
        expect(s.scriptOf('今日はAIについて話します and some english words')).toBe('cjk');
        expect(s.scriptOf('#AI @openai https://x.example/abc')).toBe('other');
        expect(s.scriptOf('Привет мир')).toBe('cyrillic');
    });

    const cands = (n) => Array.from({ length: n }, (_, i) => ({
        rawPostId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        category: i % 3 ? 'news' : 'forums', scope: i % 2 ? 'ai' : 'filter',
        decision: i % 5 ? 'relevant' : 'not_relevant', script: i % 7 ? 'latin' : 'cjk',
        inputHash: 'h'.repeat(64), relevanceMvId: null,
    }));

    it('planStrata + createSelector give exactly the planSample result', () => {
        const rows = cands(300);
        const opts = { total: 40, seed: 'seed-1', minPerStratum: 2, weights: s.parseWeightSpecs(['script:cjk=4']) };
        const whole = s.planSample(rows, opts);
        const pops = new Map();
        for (const r of rows) pops.set(s.stratumKey(r), (pops.get(s.stratumKey(r)) || 0) + 1);
        const { plan, weightOf, strata } = s.planStrata(pops, opts);
        const sel = s.createSelector(plan, 'seed-1');
        for (const r of rows) sel.push(r);
        const items = sel.items(weightOf);
        const shape = (i) => [i.rawPostId, i.stratum, i.drawRank, i.stratumPopulation, i.stratumSampleSize, i.designWeight, i.stratumWeight];
        expect(strata).toEqual(whole.strata);
        expect(items.map(shape)).toEqual(whole.items.map(shape));
        expect(sel.populations()).toEqual(pops);
    });

    it('the selector never holds more than n_h rows per stratum and needs a seed', () => {
        const plan = new Map([['news|ai|relevant|latin', 2]]);
        const sel = s.createSelector(plan, 'x');
        for (const r of cands(500).map(c => ({ ...c, category: 'news', scope: 'ai', decision: 'relevant', script: 'latin' }))) sel.push(r);
        expect(sel.items(new Map([['news|ai|relevant|latin', 1]]))).toHaveLength(2);
        expect(() => s.createSelector(plan, ' ')).toThrow(/seed/);
    });
});

describe('review fixes round 4: category weights are validated', () => {
    it('rejects a category that is not a canonical slug, accepts one that is', () => {
        expect(() => s.parseWeightSpecs(['category:newz=4'])).toThrow(/category must be one of/);
        expect(s.parseWeightSpecs(['category:news=4']).get('category:news')).toBe(4);
    });
});
