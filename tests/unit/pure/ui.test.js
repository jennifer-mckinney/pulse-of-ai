// Pure unit tests for public/js/ui.js (PulseUI.pure) — the C4 model layer:
// explore filters/sort, globe dim tests, tooltip clamp math, audit-shape →
// drawer-model mapping, bias-history severity mapping, health/methodology/
// sources models, timeseries → ribbon rows, sparkline math, and the FR-22
// demo synthesis (deterministic posts + receipts).
'use strict';

const ui = require('../../../public/js/ui');
const design = require('../../../public/js/config/design.config');

const P = ui.pure;

// ── Fixtures ────────────────────────────────────────────────────────────────

// Minimal normalized city (public/js/data.js normalizeCities shape).
function city(name, positive, neutral, negative, sources, extra) {
    const total = positive + neutral + negative;
    return Object.assign({
        city: name,
        lat: 10,
        lng: 20,
        country: 'US',
        positive,
        neutral,
        negative,
        total,
        dominant: 'positive',
        shares: total > 0
            ? { positive: positive / total, neutral: neutral / total, negative: negative / total }
            : { positive: 0, neutral: 0, negative: 0 },
        sources: sources || [
            { source_name: 'reddit', source_category: 'social', positive, neutral, negative, total },
        ],
    }, extra || {});
}

// net = (pos − neg) / total helpers:
const posCity = () => city('Posville', 60, 30, 10);      // net 0.5  → positive
const neuCity = () => city('Neutralia', 40, 30, 30);     // net 0.1  → neutral (boundary)
const negCity = () => city('Negton', 10, 30, 60);        // net −0.5 → negative
const techCity = () => city('Techton', 30, 10, 10, [
    { source_name: 'hacker_news', source_category: 'tech', positive: 30, neutral: 10, negative: 10, total: 50 },
]);

// ── Filters + sort (bucket fix, bug c) ──────────────────────────────────────

describe('filterCities — partitioned sentiment buckets (bug c fix)', () => {
    test('Positive keeps only net > positiveMin', () => {
        const out = P.filterCities([posCity(), neuCity(), negCity()],
            { sent: 'Positive', cat: 'All' });
        expect(out.map(c => c.city)).toEqual(['Posville']);
    });

    test('boundary net === positiveMin (0.1) is NEUTRAL, not positive — the prototype overlap is gone', () => {
        const boundary = neuCity(); // net exactly 0.1
        expect(P.bucketOf((boundary.positive - boundary.negative) / boundary.total))
            .toBe('neutral');
        expect(P.filterCities([boundary], { sent: 'Positive', cat: 'All' }))
            .toHaveLength(0);
        expect(P.filterCities([boundary], { sent: 'Negative', cat: 'All' }))
            .toHaveLength(0);
        expect(P.filterCities([boundary], { sent: 'Neutral', cat: 'All' }))
            .toHaveLength(1);
    });

    test('the three buckets partition the axis (no city matches two filters)', () => {
        const cities = [posCity(), neuCity(), negCity()];
        const matched = [];
        for (const f of ['Positive', 'Neutral', 'Negative']) {
            for (const c of P.filterCities(cities, { sent: f, cat: 'All' })) {
                matched.push(c.city);
            }
        }
        expect(matched.sort()).toEqual(['Negton', 'Neutralia', 'Posville']);
        expect(new Set(matched).size).toBe(3);
    });

    test('category filter matches the dominant-source slug', () => {
        const out = P.filterCities([posCity(), techCity()],
            { sent: 'All', cat: 'tech' });
        expect(out.map(c => c.city)).toEqual(['Techton']);
    });

    test('All/All passes everything; junk rows are dropped', () => {
        const out = P.filterCities([posCity(), null, 'junk', negCity()],
            { sent: 'All', cat: 'All' });
        expect(out).toHaveLength(2);
    });
});

describe('sortCitiesBySentiment — always most-positive → most-negative', () => {
    test('sorts by net descending', () => {
        const out = P.sortCitiesBySentiment([negCity(), posCity(), neuCity()]);
        expect(out.map(c => c.city)).toEqual(['Posville', 'Neutralia', 'Negton']);
    });

    test('ties break by total then name (deterministic)', () => {
        const a = city('Alpha', 10, 0, 0);   // net 1, total 10
        const b = city('Beta', 20, 0, 0);    // net 1, total 20
        const c = city('Aardvark', 10, 0, 0); // net 1, total 10
        const out = P.sortCitiesBySentiment([a, b, c]);
        expect(out.map(x => x.city)).toEqual(['Beta', 'Aardvark', 'Alpha']);
    });

    test('does not mutate the input array', () => {
        const input = [negCity(), posCity()];
        P.sortCitiesBySentiment(input);
        expect(input[0].city).toBe('Negton');
    });
});

describe('dimTestFor / composeDimTest — globe spotlight over adapted cities', () => {
    test('null when nothing filters (no dimming)', () => {
        expect(P.dimTestFor({ sent: 'All', cat: 'All' })).toBeNull();
    });

    test('category + sentiment filters over the ADAPTED shape', () => {
        const t = P.dimTestFor({ sent: 'Positive', cat: 'social' });
        expect(t({ top: 'social', sentiment: 0.5 })).toBe(true);
        expect(t({ top: 'social', sentiment: 0.1 })).toBe(false); // boundary → neutral
        expect(t({ top: 'tech', sentiment: 0.5 })).toBe(false);
    });

    test('stripCat overrides the panel filters (ribbon hover spotlight)', () => {
        const t = P.composeDimTest({ sent: 'Positive', cat: 'social' }, 'news');
        expect(t({ top: 'news', sentiment: -0.9 })).toBe(true);
        expect(t({ top: 'social', sentiment: 0.9 })).toBe(false);
    });
});

// ── Tooltip / detail geometry ───────────────────────────────────────────────

describe('tooltipPosition — near-cursor, viewport-clamped (prototype math)', () => {
    test('offsets by +18/+14 when there is room', () => {
        expect(P.tooltipPosition(100, 200, 1920, 1080))
            .toEqual({ left: 118, top: 214 });
    });

    test('clamps to the right edge (winW − 250)', () => {
        expect(P.tooltipPosition(1900, 200, 1920, 1080).left).toBe(1920 - 250);
    });

    test('clamps to the bottom edge (winH − 190)', () => {
        expect(P.tooltipPosition(100, 1070, 1920, 1080).top).toBe(1080 - 190);
    });
});

describe('bar geometry', () => {
    test('sentBarGeometry: positive grows right of the zero tick', () => {
        expect(P.sentBarGeometry(0.4)).toEqual({ leftPct: 50, widthPct: 20 });
    });
    test('sentBarGeometry: negative grows left of the zero tick', () => {
        expect(P.sentBarGeometry(-0.4)).toEqual({ leftPct: 30, widthPct: 20 });
    });
    test('sentBarGeometry: non-finite → empty bar at center', () => {
        expect(P.sentBarGeometry(NaN)).toEqual({ leftPct: 50, widthPct: 0 });
    });
    test('detailBarWidth: min(100, share×220), 0-floor', () => {
        expect(P.detailBarWidth(0.25)).toBe(55);
        expect(P.detailBarWidth(0.9)).toBe(100);
        expect(P.detailBarWidth(NaN)).toBe(0);
    });
    test('tooltipBarWidth: share/max × 90, 0 on bad max', () => {
        expect(P.tooltipBarWidth(0.2, 0.4)).toBeCloseTo(45);
        expect(P.tooltipBarWidth(0.2, 0)).toBe(0);
    });
});

// ── Audit mapping ───────────────────────────────────────────────────────────

function auditPayload(overrides) {
    return Object.assign({
        post: {
            id: '3d0f8f6a-1111-4222-8333-444455556666',
            content_snippet: 'A post about AI.',
            location: 'London',
            source_category: 'news',
            source_name: 'guardian_tech',
            collected_at: '2026-09-28T10:00:00.000Z',
        },
        narration: { component: 'audit_narration', version: '1.0.0' },
        ingest: {
            stage: 'ingestion',
            model_name: 'pulse-ingest-pipeline',
            methodology_version: '1.0.0',
            status: 'pass',
            audiences: {
                public: 'ingest public', plain: 'ingest plain',
                config: { location_granularity: 'city' },
                researcher: 'ingest researcher',
            },
        },
        decisions: [
            {
                decision_type: 'sentiment', model_name: 'sentiment-lib',
                methodology_version: '1.0.0', status: 'pass', score: -0.42,
                input_hash: 'a'.repeat(64),
                audiences: {
                    public: 's public', plain: 's plain',
                    config: { lexicon: 'AFINN' }, researcher: 's researcher',
                },
            },
            {
                decision_type: 'relevance', model_name: 'keyword-matcher',
                methodology_version: '1.1.0', status: 'pass', score: 0.83,
                input_hash: 'a'.repeat(64),
                audiences: {
                    public: 'r public', plain: 'r plain',
                    config: { min_threshold: 0.6 }, researcher: 'r researcher',
                },
            },
        ],
        bias: {
            job_id: 'job-1',
            assessed_at: '2026-09-28T10:05:00.000Z',
            model_name: 'pulse-bias-monitor-v1',
            version: '1.0.0',
            layers: [
                { name: 'Source concentration', assessment_type: 'source_concentration', value: 0.41, threshold: 0.35, citation: 'fairness@2026.04', status: 'fail', severity: 'alert', note: null },
                { name: 'Location concentration', assessment_type: 'location_concentration', value: 0.18, threshold: 0.25, citation: 'spec §9', status: 'pass', severity: 'pass', note: null },
                { name: 'Counterfactual fairness', assessment_type: 'counterfactual', value: null, threshold: null, citation: 'Kusner et al. (2017)', status: 'n-a', severity: null, note: 'not yet enforced' },
            ],
        },
    }, overrides || {});
}

describe('mapAuditResponse — served audit shape → drawer model', () => {
    test('builds ingest + decisions + bias steps in order', () => {
        const m = P.mapAuditResponse(auditPayload());
        expect(m.steps.map(s => s.stage)).toEqual([
            'Ingestion', 'Sentiment', 'Relevance', 'Bias assessment',
        ]);
        expect(m.postId).toBe('3d0f8f6a-1111-4222-8333-444455556666');
        expect(m.isDemo).toBe(false);
    });

    test('carries all four audience representations per decision step', () => {
        const m = P.mapAuditResponse(auditPayload());
        const s = m.steps[1];
        expect(s.audiences.public).toBe('s public');
        expect(s.audiences.plain).toBe('s plain');
        expect(s.audiences.config).toEqual({ lexicon: 'AFINN' });
        expect(s.audiences.researcher).toBe('s researcher');
    });

    test('score kinds: sentiment → sentiment pill, relevance → NEUTRAL percent pill (bug d)', () => {
        const m = P.mapAuditResponse(auditPayload());
        expect(m.steps[1].scoreKind).toBe('sentiment');
        expect(P.stepScoreDisplay(m.steps[1]))
            .toEqual({ text: '−0.42', kind: 'sentiment', score: -0.42 });
        expect(m.steps[2].scoreKind).toBe('percent');
        expect(P.stepScoreDisplay(m.steps[2]))
            .toEqual({ text: '83%', kind: 'neutral', score: 0.83 });
    });

    test('input_hash: taken from the first decision when served', () => {
        const m = P.mapAuditResponse(auditPayload());
        expect(m.inputHash).toBe('a'.repeat(64));
        expect(P.fmtHashPrefix(m.inputHash)).toBe('a'.repeat(16) + '…');
    });

    test('fmtHashPrefix passes pre-truncated demo hashes through unchanged', () => {
        expect(P.fmtHashPrefix('sha256:0123456789abcdef…'))
            .toBe('sha256:0123456789abcdef…');
    });

    test('input_hash omitted (AUDIT_HASH_KEY unset) → null, no fake fingerprint', () => {
        const payload = auditPayload();
        for (const d of payload.decisions) delete d.input_hash;
        const m = P.mapAuditResponse(payload);
        expect(m.inputHash).toBeNull();
        expect(P.fmtHashPrefix(m.inputHash)).toBeNull();
    });

    test('missing ingest block is tolerated (step simply absent)', () => {
        const m = P.mapAuditResponse(auditPayload({ ingest: null }));
        expect(m.steps.map(s => s.stage)).toEqual([
            'Sentiment', 'Relevance', 'Bias assessment',
        ]);
    });

    test('bias step: fail status when any layer fails; layers normalized', () => {
        const m = P.mapAuditResponse(auditPayload());
        const bias = m.steps[m.steps.length - 1];
        expect(bias.status).toBe('fail');
        // Model pill from the served bias-block identity (versioned
        // methodology), rendered like every other step's model@version.
        expect(bias.model).toBe('pulse-bias-monitor-v1');
        expect(bias.version).toBe('1.0.0');
        expect(bias.layers).toHaveLength(3);
        expect(bias.layers[0].status).toBe('fail');
        expect(bias.layers[2].status).toBe('n-a');
        expect(bias.layers[2].value).toBeNull();
        expect(bias.layers[2].note).toBe('not yet enforced');
        // Derived audience prose is factual about the counts.
        expect(bias.audiences.public).toContain('1 passed');
        expect(bias.audiences.public).toContain('1 flagged');
        expect(bias.audiences.config.job_id).toBe('job-1');
    });

    test('empty bias layers → n-a status, honest empty texts', () => {
        const m = P.mapAuditResponse(auditPayload({
            bias: { job_id: null, assessed_at: null, model_name: null,
                version: null, layers: [] },
        }));
        const bias = m.steps[m.steps.length - 1];
        expect(bias.status).toBe('n-a');
        expect(bias.audiences.researcher).toBe('No assessments stored for this job.');
        // No served identity → no pill, never an invented model name.
        expect(bias.model).toBeNull();
        expect(bias.version).toBeNull();
    });

    test('null / shapeless payloads map to null (drawer shows the outage)', () => {
        expect(P.mapAuditResponse(null)).toBeNull();
        expect(P.mapAuditResponse({})).toBeNull();
    });
});

describe('stageLabel', () => {
    test('known decision types get the prototype stage names', () => {
        expect(P.stageLabel('sentiment')).toBe('Sentiment');
        expect(P.stageLabel('relevance')).toBe('Relevance');
        expect(P.stageLabel('discourse')).toBe('Discourse quality');
        expect(P.stageLabel('ingestion')).toBe('Ingestion');
    });
    test('unknown types title-case gracefully', () => {
        expect(P.stageLabel('topic_extraction')).toBe('Topic extraction');
    });
});

// ── Bias history / health models ────────────────────────────────────────────

describe('mapBiasHistory — severity mapping', () => {
    test('maps served rows and formats UTC times', () => {
        const rows = P.mapBiasHistory({
            window_hours: 12,
            alerts: [
                { id: 1, time: '2026-09-28T07:42:00.000Z', severity: 'alert', layer: 'Source concentration', detail: 'd1', citation: 'c1' },
                { id: 2, time: '2026-09-28T06:15:00.000Z', severity: 'watch', layer: 'Location concentration', detail: 'd2', citation: null },
                { id: 3, time: '2026-09-28T03:08:00.000Z', severity: 'pass', layer: 'Demographic parity', detail: 'd3', citation: 'c3' },
            ],
        });
        expect(rows.map(r => r.severity)).toEqual(['alert', 'watch', 'pass']);
        expect(rows[0].time).toBe('07:42 UTC');
        expect(rows[1].citation).toBeNull();
    });

    test('unknown severity degrades to watch (visible, never hidden)', () => {
        const rows = P.mapBiasHistory({
            alerts: [{ id: 1, time: '2026-09-28T00:00:00Z', severity: 'catastrophic', layer: 'X', detail: '' }],
        });
        expect(rows[0].severity).toBe('watch');
    });

    test('missing layer falls back to the assessment type label', () => {
        const rows = P.mapBiasHistory({
            alerts: [{ id: 1, time: '2026-09-28T00:00:00Z', severity: 'pass', assessment_type: 'source_concentration', detail: '' }],
        });
        expect(rows[0].layer).toBe('Source concentration');
    });

    test('null payload → empty list', () => {
        expect(P.mapBiasHistory(null)).toEqual([]);
    });

    test('severity vocabulary matches the design severity color table', () => {
        for (const sev of ['alert', 'watch', 'pass']) {
            expect(design.SEVERITY_COLORS[sev]).toMatch(/^#/);
        }
    });
});

describe('healthBanner / sourcesStat / methodologyModel', () => {
    test('no alerts → green', () => {
        const b = P.healthBanner({ status: 'healthy', active_alerts: [] });
        expect(b.state).toBe('green');
        expect(b.title).toBe('Green — no active alerts');
    });
    test('alerts → yellow with the count', () => {
        const b = P.healthBanner({ active_alerts: [{}, {}] });
        expect(b.state).toBe('yellow');
        expect(b.title).toBe('Yellow — 2 active alerts');
    });
    test('unreachable health → yellow outage banner, never fake nominal', () => {
        const b = P.healthBanner(null);
        expect(b.state).toBe('yellow');
        expect(b.title).toBe('Model health unavailable');
    });
    test('sourcesStat counts registry-active flags', () => {
        expect(P.sourcesStat([
            { active: true }, { active: true }, { active: false }, null,
        ])).toEqual({ active: 2, total: 4 });
        expect(P.sourcesStat(null)).toEqual({ active: 0, total: 0 });
    });
    test('methodologyModel: latest row per component, model@version keys', () => {
        const rows = P.methodologyModel([
            { component: 'sentiment', version: '2.0.0', model_name: 'sentiment-lib', justification: 'newer' },
            { component: 'sentiment', version: '1.0.0', model_name: 'sentiment-lib', justification: 'older' },
            { component: 'bias', version: '1.0.0', model_name: 'bias-monitor', justification: 'fairness checks' },
        ]);
        expect(rows).toEqual([
            { key: 'sentiment-lib@2.0.0', desc: 'newer' },
            { key: 'bias-monitor@1.0.0', desc: 'fairness checks' },
        ]);
    });
});

// ── Ribbon model ────────────────────────────────────────────────────────────

describe('ribbonModel — timeseries → marimekko rows (audit G23)', () => {
    const cities = () => [
        city('A', 60, 30, 10, [
            { source_name: 'reddit', source_category: 'social', positive: 40, neutral: 20, negative: 5, total: 65 },
            { source_name: 'bbc', source_category: 'news', positive: 20, neutral: 10, negative: 5, total: 35 },
        ]),
        city('B', 10, 10, 10, [
            { source_name: 'reddit', source_category: 'social', positive: 10, neutral: 10, negative: 10, total: 30 },
        ]),
    ];
    const timeseries = () => [
        {
            category: 'social', top_site: 'Reddit', words: ['agents', 'shipped'],
            series: [
                { hour: 'h1', total: 10 }, { hour: 'h2', total: 20 }, { hour: 'h3', total: 5 },
            ],
        },
        // note: 'news' omitted — zero posts in the window
    ];

    test('base segments come from the snapshot; shares sum to 1', () => {
        const rows = P.ribbonModel(cities(), timeseries(), {});
        expect(rows.map(r => r.category)).toEqual(['social', 'news']);
        expect(rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1);
    });

    test('series is normalized 0..1 against the window max', () => {
        const rows = P.ribbonModel(cities(), timeseries(), {});
        expect(rows[0].series).toEqual([0.5, 1, 0.25]);
    });

    test('a category missing from the timeseries still renders (no series, no words)', () => {
        const rows = P.ribbonModel(cities(), timeseries(), {});
        const news = rows.find(r => r.category === 'news');
        expect(news).toBeDefined();
        expect(news.series).toBeNull();
        expect(news.words).toEqual([]);
        expect(news.site).toBe('bbc'); // falls back to the snapshot top source
    });

    test('top_site and cue words attach from the timeseries', () => {
        const rows = P.ribbonModel(cities(), timeseries(), {});
        const social = rows.find(r => r.category === 'social');
        expect(social.site).toBe('Reddit');
        expect(social.words).toEqual(['agents', 'shipped']);
    });

    test('demo mode synthesizes a deterministic 12-point series', () => {
        const a = P.ribbonModel(cities(), null, { demo: true });
        const b = P.ribbonModel(cities(), null, { demo: true });
        expect(a[0].series).toHaveLength(12);
        expect(a[0].series).toEqual(b[0].series);
        for (const v of a[0].series) {
            expect(v).toBeGreaterThanOrEqual(0.12);
            expect(v).toBeLessThanOrEqual(1);
        }
    });
});

describe('sparklinePoints', () => {
    test('prototype formula over the 100×30 viewBox', () => {
        const pts = P.sparklinePoints([0, 1], 100, 30);
        expect(pts.line).toBe('0,28 100,6');
        expect(pts.area).toBe('0,30 0,28 100,6 100,30');
    });
    test('single point does not divide by zero', () => {
        const pts = P.sparklinePoints([0.5], 100, 30);
        expect(pts.line).toBe('0,17');
    });
    test('empty / non-array → null', () => {
        expect(P.sparklinePoints([], 100, 30)).toBeNull();
        expect(P.sparklinePoints(null, 100, 30)).toBeNull();
    });
});

// ── Demo synthesis (FR-22) ──────────────────────────────────────────────────

describe('demoPostsForCity — deterministic prototype-style posts', () => {
    const NOW = Date.parse('2026-09-28T12:00:00.000Z');

    test('three posts, deterministic across calls', () => {
        const a = P.demoPostsForCity(posCity(), NOW);
        const b = P.demoPostsForCity(posCity(), NOW);
        expect(a).toHaveLength(3);
        expect(a).toEqual(b);
    });

    test('rows carry the /api/query row shape (one renderer for live + demo)', () => {
        const [p] = P.demoPostsForCity(techCity(), NOW);
        expect(p.id).toBe('demo-Techton-p0');
        expect(typeof p.content_snippet).toBe('string');
        expect(p.comparative).toBeGreaterThanOrEqual(-0.95);
        expect(p.comparative).toBeLessThanOrEqual(0.95);
        expect(p.relevance).toBeGreaterThanOrEqual(0.78);
        expect(p.relevance).toBeLessThanOrEqual(0.98);
        expect(Array.isArray(p.positive_words)).toBe(true);
        expect(Array.isArray(p.negative_words)).toBe(true);
        expect(typeof p.source_name).toBe('string');
        expect(typeof p.platform).toBe('string');
        expect(Date.parse(p.collected_at)).toBeLessThan(NOW);
        expect(p.isDemo).toBe(true);
    });

    test('first post uses the city dominant category pool', () => {
        const [p] = P.demoPostsForCity(techCity(), NOW);
        expect(p.platform).toBe('tech');
    });

    test('demo ids are never UUIDs (must not hit /api/audit — G16)', () => {
        for (const p of P.demoPostsForCity(posCity(), NOW)) {
            expect(P.isDemoPostId(p.id)).toBe(true);
        }
        expect(P.isDemoPostId('3d0f8f6a-1111-4222-8333-444455556666')).toBe(false);
    });
});

describe('demoAuditModel — prototype buildAudit receipt', () => {
    const NOW = Date.parse('2026-09-28T12:00:00.000Z');

    test('four steps with all four audience views each', () => {
        const post = P.demoPostsForCity(posCity(), NOW)[0];
        const m = P.demoAuditModel(post);
        expect(m.steps.map(s => s.stage)).toEqual([
            'Ingestion', 'Sentiment', 'Relevance', 'Bias assessment',
        ]);
        for (const s of m.steps) {
            expect(typeof s.audiences.public).toBe('string');
            expect(typeof s.audiences.plain).toBe('string');
            expect(typeof s.audiences.config).toBe('object');
            expect(typeof s.audiences.researcher).toBe('string');
        }
        expect(m.isDemo).toBe(true);
        expect(m.footer).toContain('fictional demo data');
    });

    test('deterministic input hash + bias layers incl. the N/A planned layer', () => {
        const post = P.demoPostsForCity(posCity(), NOW)[0];
        const m1 = P.demoAuditModel(post);
        const m2 = P.demoAuditModel(post);
        expect(m1.inputHash).toBe(m2.inputHash);
        expect(m1.inputHash).toMatch(/^sha256:[0-9a-f]{16}…$/);
        const bias = m1.steps[3];
        expect(bias.layers).toHaveLength(3);
        expect(bias.layers[2].status).toBe('n-a');
    });

    test('sentiment/relevance pills mirror the post scores', () => {
        const post = P.demoPostsForCity(posCity(), NOW)[0];
        const m = P.demoAuditModel(post);
        expect(m.steps[1].score).toBe(post.comparative);
        expect(m.steps[1].scoreKind).toBe('sentiment');
        expect(m.steps[2].score).toBe(post.relevance);
        expect(m.steps[2].scoreKind).toBe('percent');
    });
});

// ── Misc ────────────────────────────────────────────────────────────────────

describe('catLabel / cityTopSlug / fmtAlertTime', () => {
    test('catLabel title-cases slugs', () => {
        expect(P.catLabel('social')).toBe('Social');
        expect(P.catLabel('')).toBe('');
        expect(P.catLabel(null)).toBe('');
    });
    test('cityTopSlug reads the dominant source category', () => {
        expect(P.cityTopSlug(techCity())).toBe('tech');
        expect(P.cityTopSlug({ sources: [] })).toBeNull();
    });
    test('fmtAlertTime renders HH:MM UTC and tolerates junk', () => {
        expect(P.fmtAlertTime('2026-09-28T07:42:11.000Z')).toBe('07:42 UTC');
        expect(P.fmtAlertTime('not a date')).toBe('');
    });
});

describe('module surface', () => {
    test('AUDIENCES are the four prototype views in order', () => {
        expect(P.AUDIENCES).toEqual(['Public', 'Journalist', 'Regulator', 'Researcher']);
        expect(P.AUDIENCE_KEYS).toEqual({
            Public: 'public', Journalist: 'plain',
            Regulator: 'config', Researcher: 'researcher',
        });
    });
    test('sentiment filters are the prototype set', () => {
        expect(P.SENTIMENT_FILTERS).toEqual(['All', 'Positive', 'Neutral', 'Negative']);
    });
    test('public API: pure + init + the two drawer entry points', () => {
        expect(typeof ui.init).toBe('function');
        expect(typeof ui.openAudit).toBe('function');
        expect(typeof ui.openHealth).toBe('function');
    });
});
