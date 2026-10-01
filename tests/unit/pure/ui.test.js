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
        // Legacy 'tech'-sourced data folds onto the canonical 'developer'
        // slug (retired-slug residual mapping) — the chip that matches it
        // is Developer, and no 'tech' chip exists any more.
        const out = P.filterCities([posCity(), techCity()],
            { sent: 'All', cat: 'developer' });
        expect(out.map(c => c.city)).toEqual(['Techton']);
        expect(P.filterCities([posCity(), techCity()],
            { sent: 'All', cat: 'tech' })).toEqual([]);
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
    test('publisherTipText (D3): names the publisher-location layer, null without one', () => {
        expect(P.publisherTipText({ total: 5, publisher_posts: 0 })).toBeNull();
        expect(P.publisherTipText({ total: 5 })).toBeNull();
        expect(P.publisherTipText({ total: 5, publisher_posts: 2 })).toBe(
            'publisher location: 2 of 5 posts placed at the publisher\'s home city, '
            + 'not where the discussion happened (excluded from location bias)');
        expect(P.publisherTipText({ total: 3, publisher_posts: 3 })).toMatch(/^publisher location: all 3 posts placed/);
        expect(P.publisherTipText({ total: 1, publisher_posts: 1 })).toMatch(/^publisher location: the only post placed/);
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
    test('D2: carries the served provenance and renders it as one line; absent stays absent', () => {
        const fp = 'a'.repeat(64);
        const m = P.mapAuditResponse(auditPayload({ provenance: {
            source: 'Hacker News', published_at: '2026-09-29T10:00:00.000Z',
            permalink: 'https://news.ycombinator.com/item?id=1', external_id: 'hn:1',
            fingerprint: fp, verifiable: 'verifiable: provide the original URL or id to reproduce the fingerprint',
        } }));
        expect(m.provenance).toEqual({
            permalink: 'https://news.ycombinator.com/item?id=1', fingerprint: fp,
            published_at: '2026-09-29T10:00:00.000Z',
            verifiable: 'verifiable: provide the original URL or id to reproduce the fingerprint',
            retention: null,
        });
        expect(P.provenanceLine(m.provenance)).toBe(
            'source https://news.ycombinator.com/item?id=1 · provenance aaaaaaaaaaaa… · verifiable: provide the original URL or id to reproduce the fingerprint');
        expect(P.mapAuditResponse(auditPayload()).provenance).toBeNull();
        expect(P.provenanceFrom({ permalink: '', fingerprint: null })).toBeNull();
        expect(P.provenanceLine(null)).toBe('');
    });

    test('ruling 9: a Reddit receipt carries its retention notice (live or text removed)', () => {
        const removed = P.mapAuditResponse(auditPayload({ provenance: {
            source: 'reddit', permalink: 'https://www.reddit.com/r/OpenAI/comments/abc/',
            retention: { status: 'text_removed', notice: 'Text removed per the Reddit Data API Terms (48-hour retention window ended): after 48 hours or on deletion upstream. Scores and audit rows retained by owner decision.' },
        } }));
        expect(removed.provenance.retention).toMatch(/^Text removed per the Reddit Data API Terms/);
        expect(P.provenanceLine(removed.provenance)).toBe('source https://www.reddit.com/r/OpenAI/comments/abc/ · '
            + removed.provenance.retention);
        // A retention notice alone still yields a provenance line.
        expect(P.provenanceFrom({ retention: { notice: 'n' } })).toEqual(expect.objectContaining({ retention: 'n' }));
        expect(P.provenanceFrom({ retention: { notice: '' } })).toBeNull();
    });

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

    test('fmtHashPrefix passes pre-truncated hashes through unchanged', () => {
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

// PR #8 review: the history endpoint covers the WHOLE window — every flagged
// row listed, pass rows summarized per layer, truncation stated — and every
// row names the methodology version that produced it (lineage).
describe('bias history — lineage, pass summaries, truncation notice', () => {
    test('flagged rows carry model@version, marked when the lineage is inferred', () => {
        const rows = P.mapBiasHistory({ alerts: [
            { id: 1, time: '2026-09-28T07:42:00Z', severity: 'alert', layer: 'L', detail: 'd',
              citation: 'c', model_name: 'bias-m', version: '1.1.0', lineage: 'recorded' },
            { id: 2, time: '2026-09-28T07:40:00Z', severity: 'watch', layer: 'L', detail: 'd',
              citation: null, model_name: 'bias-m', version: '0.9.0', lineage: 'inferred' },
            { id: 3, time: '2026-09-28T07:30:00Z', severity: 'watch', layer: 'L', detail: 'd' },
        ] });
        expect(rows[0].methodology).toBe('bias-m@1.1.0');
        expect(rows[1].methodology).toBe('bias-m@0.9.0 · inferred');
        expect(rows[2].methodology).toBeNull();
    });

    test('mapPassSummary: one row per layer, last time + first-time detail', () => {
        const rows = P.mapPassSummary({ pass_summary: [{
            severity: 'pass', layer: 'Negative dominance', assessment_type: 'negative_dominance',
            count: 240, first_time: '2026-09-27T20:05:00Z', last_time: '2026-09-28T07:55:00Z',
            detail: '240 passing checks in the window · latest negative_share 0.210 (τ = 0.6).',
            citation: 'Suresh & Guttag (2021)', model_name: 'bias-m', version: '1.1.0', lineage: 'recorded',
        }] });
        expect(rows).toEqual([{
            id: 'pass-negative_dominance',
            severity: 'pass',
            summary: true,
            time: '07:55 UTC',
            layer: 'Negative dominance',
            detail: '240 passing checks in the window · latest negative_share 0.210 (τ = 0.6). '
                + 'First pass 20:05 UTC.',
            citation: 'Suresh & Guttag (2021)',
            methodology: 'bias-m@1.1.0',
        }]);
    });

    // Grumpy final #2: a summary whose LATEST row is an insufficient sample
    // (bias@1.6.0 states its value, e.g. a parity gap of 1.3 against τ 0.3)
    // is not shown as a green PASS: it is an N/A row, and its first time is
    // the first CHECK of the window (it may not have been a pass).
    test('mapPassSummary: a latest insufficient-sample row is N/A, never a plain pass', () => {
        const base = {
            severity: 'pass', layer: 'Demographic parity', assessment_type: 'platform_sentiment_parity',
            count: 1, insufficient: 1, first_time: '2026-09-28T07:55:00Z', last_time: '2026-09-28T07:55:00Z',
            detail: '0 passing checks and 1 with an insufficient sample in the window · '
                + 'latest max_comparative_diff 1.300 (insufficient sample, not compared with τ = 0.3).',
            citation: 'c', model_name: 'bias-m', version: '1.6.0', lineage: 'recorded',
        };
        const [na] = P.mapPassSummary({ pass_summary: [{ ...base, latest_insufficient: true }] });
        expect(na).toMatchObject({ severity: 'n-a', summary: true });
        expect(na.detail).toBe(base.detail + ' First check 07:55 UTC.');
        // Latest row passed, earlier ones insufficient: PASS, first CHECK.
        const [mixed] = P.mapPassSummary({ pass_summary: [{ ...base, count: 3, latest_insufficient: false }] });
        expect(mixed.severity).toBe('pass');
        expect(mixed.detail).toMatch(/ First check 07:55 UTC\.$/);
        // A legacy payload without the flag keeps its PASS.
        expect(P.mapPassSummary({ pass_summary: [{ ...base, insufficient: 0 }] })[0].severity).toBe('pass');
    });

    test('alertBadge: the feed badge text per severity', () => {
        expect(['alert', 'watch', 'pass', 'n-a'].map(P.alertBadge)).toEqual(['ALERT', 'WATCH', 'PASS', 'N/A']);
    });

    test('mapPassSummary tolerates a missing / legacy payload', () => {
        expect(P.mapPassSummary(null)).toEqual([]);
        expect(P.mapPassSummary({ alerts: [] })).toEqual([]);
    });

    test('historyNotice: null when complete, explicit notice when truncated', () => {
        expect(P.historyNotice({ truncated: false, alerts: [], alert_count: 0 })).toBeNull();
        expect(P.historyNotice(null)).toBeNull();
        expect(P.historyNotice({ truncated: true, alerts: new Array(500), alert_count: 612, alert_cap: 500 }))
            .toBe('showing the newest 500 of 612 flagged assessments — the list is truncated '
                + 'at the 500-row safety cap (full history via GET /api/bias/history)');
    });
});

describe('bias step lineage', () => {
    test('the regulator view names the methodology lineage; inferred is stated plainly', () => {
        const m = P.mapAuditResponse({
            post: { id: 'p1', content_snippet: 'x' },
            decisions: [],
            bias: { job_id: 'j', assessed_at: '2026-09-28T00:00:00Z', model_name: 'bias-m',
                version: '0.9.0', lineage: 'inferred', lineage_fallback: false,
                layers: [{ name: 'L', assessment_type: 'location_concentration', value: 0.1,
                    threshold: 0.35, status: 'pass' }] },
        });
        const bias = m.steps[m.steps.length - 1];
        expect(bias.audiences.config.methodology_lineage).toBe('inferred');
        expect(bias.audiences.plain).toContain('inferred from assessment timestamps');
    });

    test('recorded lineage adds no caveat', () => {
        const m = P.mapAuditResponse({
            post: { id: 'p1', content_snippet: 'x' },
            decisions: [],
            bias: { job_id: 'j', assessed_at: null, model_name: 'bias-m', version: '1.1.0',
                lineage: 'recorded', layers: [{ name: 'L', assessment_type: 'x', value: 0.1,
                    threshold: 0.35, status: 'pass' }] },
        });
        const bias = m.steps[m.steps.length - 1];
        expect(bias.audiences.config.methodology_lineage).toBe('recorded');
        expect(bias.audiences.plain).not.toContain('inferred');
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
    test('a critical alert → red banner (FR-24 red state, PR #8 review)', () => {
        const b = P.healthBanner({ active_alerts: [{ severity: 'warning' }, { severity: 'critical' }] });
        expect(b.state).toBe('red');
        expect(b.title).toBe('Red — 2 active alerts, 1 critical');
    });
    test('degraded backend with no alerts → yellow, never green', () => {
        const b = P.healthBanner({ status: 'degraded', active_alerts: [] });
        expect(b.state).toBe('yellow');
        expect(b.title).toBe('Yellow — backend degraded');
    });
    test('unreachable health → yellow outage banner, never fake nominal', () => {
        const b = P.healthBanner(null);
        expect(b.state).toBe('yellow');
        expect(b.title).toBe('Model health unavailable');
    });
    // PR #22 principal #12: the watchdog's alert leads the banner.
    test('a watchdog (system) alert → emphasized red banner naming it, with its summary', () => {
        const b = P.healthBanner({ active_alerts: [
            { severity: 'warning' },
            { severity: 'critical', system: true, title: 'Worker down (heartbeat stale)',
                summary: 'no worker heartbeat in Valkey', created_at: '2026-09-29T10:05:00Z' },
        ] });
        expect(b.state).toBe('red');
        expect(b.system).toBe(true);
        expect(b.title).toBe('Red — SYSTEM ALERT: Worker down (heartbeat stale)');
        expect(b.sub).toContain('Worker down (heartbeat stale): no worker heartbeat in Valkey (since 10:05 UTC)');
        expect(b.sub).toContain('plus 1 other active alert.');
    });
    test('watchdogModel: reporting, open conditions, e-mail status', () => {
        const m = P.watchdogModel({ watchdog: {
            reporting: true, last_poll_at: '2026-09-29T10:06:00Z', poll_interval_s: 120,
            open: [{ condition: 'worker_down', title: 'Worker down (heartbeat stale)' }],
            email: { configured: false, status: 'email alerting not configured', last_sent_at: null, last_error: null },
            config_errors: ['WATCHDOG_POLL_INTERVAL_S="x" is not a whole number from 15 to 3600; using 120'],
        } });
        expect(m.rows).toEqual([
            { k: 'watchdog', v: 'reporting · last poll 10:06 UTC · every 120 s', warn: false },
            { k: 'open conditions', v: 'Worker down (heartbeat stale)', warn: true },
            { k: 'e-mail alerts', v: 'email alerting not configured', warn: true },
            { k: 'config', v: 'WATCHDOG_POLL_INTERVAL_S="x" is not a whole number from 15 to 3600; using 120', warn: true },
        ]);
    });
    test('watchdogModel: a silent or never-run watchdog is flagged; no block → null', () => {
        expect(P.watchdogModel({ watchdog: { reporting: false, last_poll_at: null, open: [], email: {} } }).rows[0])
            .toEqual({ k: 'watchdog', v: 'has not reported — is the watchdog service running?', warn: true });
        const stale = P.watchdogModel({ watchdog: { reporting: false, last_poll_at: '2026-09-29T09:00:00Z', open: [],
            email: { configured: true, status: 'configured: 1 recipient(s) via smtp.example.org:587 (STARTTLS required)',
                last_sent_at: '2026-09-29T08:00:00Z', last_error: null } } });
        expect(stale.rows[0].v).toMatch(/^NOT REPORTING since 09:00 UTC/);
        expect(stale.rows[1]).toEqual({ k: 'open conditions', v: 'none', warn: false });
        expect(stale.rows[2].warn).toBe(false);
        expect(stale.rows[3]).toEqual({ k: 'last e-mail', v: '08:00 UTC', warn: false });
        const failing = P.watchdogModel({ watchdog: { reporting: true, last_poll_at: '2026-09-29T09:00:00Z',
            email: { configured: true, status: 'configured', last_error: 'connect ECONNREFUSED' } } });
        expect(failing.rows).toContainEqual({ k: 'last e-mail error', v: 'connect ECONNREFUSED', warn: true });
        expect(P.watchdogModel({ status: 'healthy' })).toBeNull();
        expect(P.watchdogModel(null)).toBeNull();
    });
    test('sourcesStat: online counts only registry sources that collected in the last hour', () => {
        expect(P.sourcesStat([
            { active: true, registry: true, status: 'collecting', online: true },
            { active: true, registry: true, status: 'collecting', online: false },
            { active: true, registry: true, status: 'blocked', online: false },
            { active: false, retired: true },           // retired pre-registry row: not a source
            null,
        ])).toEqual({ active: 3, total: 3, demoFeeds: 0, registry: 3, collecting: 2, online: 1 });
        expect(P.sourcesStat(null)).toEqual({ active: 0, total: 0, demoFeeds: 0, registry: 0, collecting: 0, online: 0 });
    });
    test('sourcesStat never counts demo feeds as sources — separate figure', () => {
        expect(P.sourcesStat([
            { active: true, source_type: 'rss', registry: true, status: 'collecting', online: true },
            { active: false, source_type: 'api' },
            { active: false, source_type: 'demo' },
            { active: true, source_type: 'demo', online: true },   // even if flagged active
        ])).toEqual({ active: 1, total: 2, demoFeeds: 2, registry: 1, collecting: 1, online: 1 });
    });
    test('sourceStatusLabel: blocked says "blocked: no compliant access"; online beats collecting', () => {
        expect(P.sourceStatusLabel({ status: 'blocked' })).toBe('blocked: no compliant access');
        expect(P.sourceStatusLabel({ status: 'awaiting_licence' })).toBe('awaiting licence');
        expect(P.sourceStatusLabel({ status: 'collecting', online: true })).toBe('online');
        expect(P.sourceStatusLabel({ status: 'collecting', online: false })).toBe('collecting');
        expect(P.sourceStatusLabel({ status: 'odd' })).toBe('odd');
        expect(P.sourceStatusLabel(null)).toBe('unknown');
    });
    test('sourceListModel: canon category order, rank order, terms cited for non-collecting sources', () => {
        const groups = P.sourceListModel([
            { registry: true, category: 'forums', rank: 46, display_name: 'Hacker News', status: 'collecting', online: true, terms_url: 'https://h' },
            { registry: true, category: 'forums', rank: 45, display_name: 'Stack Overflow', status: 'collecting', terms_url: 'https://s' },
            { registry: true, category: 'social', rank: 6, display_name: 'WeChat', status: 'blocked', terms_url: 'https://weixin.qq.com/agreement', status_reason: 'blocked: no compliant access — x' },
            { registry: true, category: 'social', rank: 8, display_name: 'X', status: 'awaiting_licence', terms_url: 'javascript:alert(1)' },
            { registry: false, category: 'news', source_type: 'demo', display_name: 'Demo feed' },
        ]);
        expect(groups.map(g => g.slug)).toEqual(['social', 'forums']);
        expect(groups[1].sources.map(s => s.name)).toEqual(['Stack Overflow', 'Hacker News']);
        expect(groups[0].sources[0]).toMatchObject({ statusLabel: 'blocked: no compliant access', termsUrl: 'https://weixin.qq.com/agreement' });
        expect(groups[0].sources[1].termsUrl).toBeNull();      // non-https never linked
        expect(groups[1].sources[1].termsUrl).toBeNull();      // collecting: no citation needed
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

    test('always one segment per canonical category — data rows first, zero rows padded', () => {
        const rows = P.ribbonModel(cities(), timeseries(), {});
        // social/news carry the snapshot volume; the other six canonical
        // categories render as explicit zero segments (prototype marimekko:
        // ALL categories, always) instead of vanishing.
        expect(rows.map(r => r.category)).toEqual([
            'social', 'news',
            'academic', 'blog', 'developer', 'forums', 'nonprofit', 'policy',
        ]);
        expect(rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1);
    });

    test('zero-volume segments are honest: 0 volume, 0 share, flat sparkline, no words/site', () => {
        for (const opts of [{}, { demo: true }]) {
            const rows = P.ribbonModel(cities(), opts.demo ? null : timeseries(), opts);
            const zero = rows.find(r => r.category === 'nonprofit');
            expect(zero.volume).toBe(0);
            expect(zero.share).toBe(0);
            expect(zero.net).toBe(0);
            expect(zero.split).toEqual({ pos: 0, neu: 0, neg: 0 });
            expect(zero.site).toBeNull();
            expect(zero.words).toEqual([]);
            // Flat zero series (never a synthesized demo walk) → the ribbon
            // draws a flat baseline sparkline, not fake activity.
            expect(zero.series).toHaveLength(12);
            expect(zero.series.every(v => v === 0)).toBe(true);
        }
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

    test('live mode with NO timeseries (fetch failed or in flight) never fabricates', () => {
        // Grumpy #1: synthesis is DEMO-ONLY. A live timeseries outage must
        // yield series null (no sparkline) and zero cue words — never the
        // deterministic demo walk or the ["AI","models"] filler.
        const rows = P.ribbonModel(cities(), null, { demo: false });
        const social = rows.find(r => r.category === 'social');
        expect(social.volume).toBeGreaterThan(0);
        expect(social.series).toBeNull();
        expect(social.words).toEqual([]);
        expect(social.site).toBe('reddit');   // snapshot top source only
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

describe('ribbonFlexPercents — zero-volume segments keep a readable sliver', () => {
    test('proportional to share for normal rows', () => {
        const pcts = P.ribbonFlexPercents([{ share: 0.75 }, { share: 0.25 }]);
        expect(pcts[0]).toBeCloseTo(75);
        expect(pcts[1]).toBeCloseTo(25);
    });

    test('zero-share rows get the minimum flex floor and totals stay 100', () => {
        const pcts = P.ribbonFlexPercents([
            { share: 0.9 }, { share: 0.1 }, { share: 0 }, { share: 0 },
        ]);
        expect(pcts).toHaveLength(4);
        expect(pcts.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
        // Zero rows are visible (label + dot fit) but clearly the smallest.
        expect(pcts[2]).toBeGreaterThan(0);
        expect(pcts[2]).toBeCloseTo(pcts[3]);
        expect(pcts[2]).toBeLessThan(pcts[1]);
    });

    test('all-zero input still splits evenly (no NaN / divide-by-zero)', () => {
        const pcts = P.ribbonFlexPercents([{ share: 0 }, { share: 0 }]);
        expect(pcts[0]).toBeCloseTo(50);
        expect(pcts[1]).toBeCloseTo(50);
    });

    test('empty / non-array → empty array', () => {
        expect(P.ribbonFlexPercents([])).toEqual([]);
        expect(P.ribbonFlexPercents(null)).toEqual([]);
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

    test('first post uses the city dominant category pool — every canonical category has one', () => {
        for (const slug of design.CATEGORY_SLUGS) {
            const c = city('Cat-' + slug, 30, 10, 10, [
                { source_name: 'src', source_category: slug,
                  positive: 30, neutral: 10, negative: 10, total: 50 },
            ]);
            const [p] = P.demoPostsForCity(c, NOW);
            expect(p.platform).toBe(slug);
            expect(typeof p.source_name).toBe('string');
        }
    });

    test('a legacy tech-dominant city draws from the developer pool (residual mapping)', () => {
        const [p] = P.demoPostsForCity(techCity(), NOW);
        expect(p.platform).toBe('developer');
    });

    test('a non-canonical dominant category falls back to the canonical rotation', () => {
        const zineCity = city('Zineton', 30, 10, 10, [
            { source_name: 'zine_press', source_category: 'zines',
              positive: 30, neutral: 10, negative: 10, total: 50 },
        ]);
        const [p] = P.demoPostsForCity(zineCity, NOW);
        expect(p.platform).toBe(design.CATEGORY_SLUGS[0]); // 'social'
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

    // A bundled demo post is never stored or hashed, so its receipt carries
    // no input fingerprint (spec §1: demo posts carry none); a fabricated
    // "input sha256:…" would contradict the Researcher text that says this
    // receipt has no hash (Copilot r4151336195).
    test('no input hash (never faked) + bias layers incl. the N/A planned layer', () => {
        const post = P.demoPostsForCity(posCity(), NOW)[0];
        const m1 = P.demoAuditModel(post);
        expect(m1.inputHash).toBeNull();
        expect(P.fmtHashPrefix(m1.inputHash)).toBeNull();
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

    // No demo step may hand out a replay command for its own fictional post
    // as if it would run: the replay rule is stated for live posts only.
    test('no demo step offers a runnable replay of the fictional post', () => {
        const post = P.demoPostsForCity(posCity(), NOW)[0];
        for (const s of P.demoAuditModel(post).steps) {
            const r = s.audiences.researcher;
            expect(r).not.toContain('npm run replay -- --post ' + post.id);
            expect(r).not.toMatch(/npm run replay -- --post \d+/);
        }
    });

    // The offline demo receipt must describe the real ingest system:
    // the content hash is an integrity check (audit_narration@1.4.0
    // INGEST_HASH_NOTE), not a join key, and duplicates are dropped by
    // UNIQUE(source_id, external_id) — there is no simhash anywhere.
    // The live-system rule is stated conditionally: a bundled demo post is
    // never stored, hashed or replayable, so this receipt serves no hash
    // and must not claim that it does (Copilot r4151336195 / audit R6-4).
    test('ingestion step matches the real system (hash wording + dedupe rule)', () => {
        const { INGEST_HASH_NOTE } = require('../../../src/config/audit-narration');
        const post = P.demoPostsForCity(posCity(), NOW)[0];
        const ingest = P.demoAuditModel(post).steps[0];
        const researcher = ingest.audiences.researcher;
        // Tie the shared wording to the registered narration: the closing
        // "integrity check, not a join key" sentence is INGEST_HASH_NOTE's.
        const closing = 'It is an integrity check, not a join key.';
        expect(INGEST_HASH_NOTE.endsWith(closing)).toBe(true);
        expect(researcher).toContain(closing);
        // The keyed-hash mechanics (HMAC-SHA256 with AUDIT_HASH_KEY) also
        // come from INGEST_HASH_NOTE and must stay in step with it.
        expect(INGEST_HASH_NOTE).toContain('HMAC-SHA256 with AUDIT_HASH_KEY');
        expect(researcher).toContain('HMAC-SHA256 with AUDIT_HASH_KEY');
        // Conditional framing: the live system, not this receipt.
        expect(researcher.startsWith('In the live system')).toBe(true);
        expect(researcher).not.toMatch(/this receipt serves/);
        expect(researcher).toMatch(/never stored, so this receipt has no hash/);
        expect(researcher).toMatch(/nothing to replay/);
        expect(ingest.audiences.researcher).not.toMatch(/immutable join key|join key across/);
        expect(ingest.audiences.config).not.toHaveProperty('dedupe');
        expect(ingest.audiences.config.dedup_strategy).toMatch(/UNIQUE\(source_id, external_id\)/);
        expect(JSON.stringify(ingest)).not.toMatch(/simhash/i);
    });
});

// ── Misc ────────────────────────────────────────────────────────────────────

describe('catLabel / cityTopSlug / fmtAlertTime', () => {
    test('catLabel maps slugs to registry display labels', () => {
        expect(P.catLabel('social')).toBe('Social');
        // Registry labels, never naive capitalization ('Blog'/'Nonprofit'
        // would be prototype violations):
        expect(P.catLabel('blog')).toBe('Blogs');
        expect(P.catLabel('nonprofit')).toBe('Non-profit');
        expect(P.catLabel('forums')).toBe('Forums');
        expect(P.catLabel('')).toBe('');
        expect(P.catLabel(null)).toBe('');
    });
    test('cityTopSlug reads the dominant source category', () => {
        expect(P.cityTopSlug(techCity())).toBe('developer'); // legacy tech → developer
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

// ── P0-3: the drawer renders a computed layer's methodology note ────────────
describe('layerRowView — fairness-layer display strings (P0-3)', () => {
    const NOTE = 'parity measured across source categories (platform), not user demographics';

    test('computed layer: value / τ in the value slot, note on its own line', () => {
        const v = P.layerRowView({
            name: 'Demographic parity', value: 0.031, threshold: 0.3,
            citation: 'Barocas & Selbst (2016)', status: 'pass', note: NOTE,
        });
        expect(v).toEqual({
            okClass: 'ok',
            okText: 'PASS',
            name: 'Demographic parity',
            valueText: '0.031 / τ 0.3',
            noteText: NOTE,
            citation: 'Barocas & Selbst (2016)',
        });
    });

    test('computed layer without a note renders no note line', () => {
        const v = P.layerRowView({ name: 'Location concentration', value: 0.41,
            threshold: 0.35, citation: null, status: 'fail', note: null });
        expect(v.okText).toBe('FAIL');
        expect(v.okClass).toBe('bad');
        expect(v.noteText).toBeNull();
        expect(v.citation).toBe('');
    });

    test('n-a layer: the note fills the value slot and is not repeated', () => {
        const v = P.layerRowView({ name: 'Equalized odds', value: null,
            threshold: null, citation: 'Hardt et al. (2016)', status: 'n-a',
            note: 'Phase 3 — not yet enforced' });
        expect(v.okText).toBe('N/A');
        expect(v.valueText).toBe('Phase 3 — not yet enforced');
        expect(v.noteText).toBeNull();
    });

    test('served audit payload → bias step keeps the parity note through mapping', () => {
        const m = P.mapAuditResponse({
            post: { id: 'p1', content_snippet: 'x', location: 'Paris',
                source_category: 'news', source_name: 's', collected_at: null },
            decisions: [],
            ingest: null,
            bias: { job_id: 'j', assessed_at: null, model_name: 'pulse-bias-monitor-v1',
                version: '1.1.0', layers: [
                    { name: 'Demographic parity', assessment_type: 'platform_sentiment_parity',
                        value: 0.031, threshold: 0.3, citation: 'Barocas & Selbst (2016)',
                        status: 'pass', note: NOTE },
                ] },
        });
        const bias = m.steps[m.steps.length - 1];
        expect(P.layerRowView(bias.layers[0]).noteText).toBe(NOTE);
    });
});
