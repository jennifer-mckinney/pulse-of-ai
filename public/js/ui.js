// PulseUI — explore-mode chrome, drawers and source ribbon for the Pulse of
// AI page. Vanilla-JS port of the design handoff's ui.jsx (ZIP revision):
// explore filter panel + sorted city list, city-detail panel with live posts,
// hover tooltip, the audit drawer ("Why does it say that?" — the product
// differentiator), the model-health drawer, and the bottom marimekko source
// ribbon.
//
// Division of labor (C4 scope):
//   - PulseStory (C3) drives the scroll narrative and flips explore mode;
//     this module binds its integration surface (see story.js header):
//       'pulse:exploring-changed' → build/tear down the explore chrome
//       'pulse:drill' / consumePendingCity() → pre-select a drilled city
//       'pulse:trace' → openAudit replay for early trace clicks
//       'pulse:data' / getCities() → the normalized city snapshot
//       setExploreSelection(id) → next-steps card visibility handshake
//   - PulseGlobe renders; this module drives hover/selection/dimming through
//     setState (onHover/onCityClick/onDrag are bound once at init and only
//     fire while the globe is interactive, i.e. in explore mode).
//   - PulseMain.freezeInsightTimer() freezes the header timer at the FIRST
//     opened receipt (US-1 "first receipt ✓").
//
// Fidelity contract (FUn.zip ui.jsx/app.jsx/README + merged backend):
//   - City list ALWAYS sorted most-positive → most-negative.
//   - Sentiment filters use design.config SENTIMENT_BUCKETS — the config
//     deliberately FIXES the prototype's overlapping buckets (bug c); never
//     reintroduce the prototype's inline comparisons.
//   - Relevance pill renders in the NEUTRAL color (score-pill dim), never
//     the sentiment palette (prototype bug d).
//   - Numeric score always adjacent to any sentiment color (README guard).
//   - The ribbon "← 12h" axis label lives INSIDE the first segment (README
//     regression guard).
//   - Demo fallback (FR-22): when the story data is demo (or a post id is
//     not a live UUID) posts and audit receipts are synthesized locally and
//     deterministically per the prototype's data.js — demo ids are never
//     sent to /api/audit (the route 400s on non-UUIDs, audit G16).
//
// DOM discipline: createElement/createElementNS/textContent/classList/style
// ONLY — the repo Write hook blocks innerHTML in client JS, and every string
// here may echo API data. Values are rendered RAW via textContent (never
// pre-escaped — escaping before textContent double-encodes).
//
// Dual export guard with dependency injection (same pattern as story.js):
// CommonJS requires the siblings for jest (the pure namespace is what the
// tests exercise); browser script tags read the window globals (load
// config/*.js, utils.js, data.js, insights.js, chapters.js, globe.js and
// story.js BEFORE this file — the index.html script order is a contract).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(
            require('./utils'),
            require('./insights'),
            require('./globe'),
            require('./story'),
            require('./config/design.config'),
            require('./config/api.config'));
    } else {
        /* istanbul ignore next -- Browser UMD global; unreachable in Node tests */
        root.PulseUI = factory(
            root.PulseUtils, root.PulseInsights, root.PulseGlobe,
            root.PulseStory, root.PulseDesignConfig, root.PulseApiConfig);
    }
}(typeof self !== 'undefined' ? self : this, function (
    utils, insightsMod, globeMod, storyMod, designConfig, apiConfig) {
    'use strict';

    const { fmtNet, netSentiment, sentimentBucket } = utils;
    const { catBreakdown, allCategoryRows } = insightsMod;
    const gmath = globeMod.math;
    const CAT_COLORS = designConfig.CAT_COLORS;
    const SENTIMENT_PALETTE = designConfig.SENTIMENT_PALETTE;
    const SEVERITY_COLORS = designConfig.SEVERITY_COLORS;
    const ENDPOINTS = apiConfig.ENDPOINTS;
    const CITY_POSTS_LIMIT = apiConfig.CITY_POSTS_LIMIT;
    const TIMESERIES_HOURS = apiConfig.TIMESERIES_HOURS;
    const minutesAgoFrom = storyMod.pure.minutesAgoFrom;

    // Sentiment palette in the prototype's [neg, neu, pos] array form.
    const PALETTE = [
        SENTIMENT_PALETTE.negative,
        SENTIMENT_PALETTE.neutral,
        SENTIMENT_PALETTE.positive,
    ];

    const SVG_NS = 'http://www.w3.org/2000/svg';

    // ═══ Pure model layer (no DOM — unit-tested in tests/unit/pure/ui.test.js) ═

    // Prototype-verbatim UI constants (ui.jsx).
    const SENTIMENT_FILTERS = ['All', 'Positive', 'Neutral', 'Negative'];
    const AUDIENCES = ['Public', 'Journalist', 'Regulator', 'Researcher'];
    // Audience label → key into the audit payload's per-step `audiences`
    // object (the merged /api/audit serves public/plain/config/researcher;
    // Public and Journalist are distinct texts, G17 is closed backend-side).
    const AUDIENCE_KEYS = {
        Public: 'public',
        Journalist: 'plain',
        Regulator: 'config',
        Researcher: 'researcher',
    };

    const TIP_WIDTH = 230;          // tooltip box width (CSS .tip)
    const TIP_OFFSET_X = 18;        // cursor → tip offset (prototype CityTooltip)
    const TIP_OFFSET_Y = 14;
    const TIP_CLAMP_RIGHT = 250;    // right-edge clamp margin
    const TIP_CLAMP_BOTTOM = 190;   // bottom-edge clamp margin
    const EXPLORE_ZOOM = 1.15;      // prototype explore camera zoom
    const SELECT_ZOOM = 1.5;        // prototype selected-city zoom
    const DETAIL_CATS_MAX = 4;      // top-4 category share bars
    const SPARK_W = 100;            // ribbon sparkline viewBox (prototype)
    const SPARK_H = 30;
    // Minimum flex share for a ribbon segment: a zero-volume category still
    // gets ~6% of the strip so its dot, label and "0/hr · 0%" are readable.
    const RIBBON_MIN_FLEX_SHARE = 0.06;

    // catLabel: API slug → display label via the canonical registry
    // (PulseUtils.catLabel — 'blog' → 'Blogs', 'nonprofit' → 'Non-profit',
    // 'forums' → 'Forums'; capitalize-fallback only for non-canonical
    // strings). Re-exported through the pure namespace for tests.
    const catLabel = utils.catLabel;

    // cityTopSlug: a normalized city's dominant source category as the
    // CAT_COLORS slug (null when the city has no sources).
    function cityTopSlug(city) {
        return gmath.normalizeCategorySlug(
            gmath.topCategoryFromSources(city && city.sources));
    }

    // bucketOf: net score → 'positive' | 'neutral' | 'negative' via the
    // partitioned design buckets (bug c fix — NEVER inline comparisons).
    function bucketOf(net) {
        return sentimentBucket(net);
    }

    // filterCities: the explore panel's filter pass over NORMALIZED cities.
    // filters = { sent: 'All'|'Positive'|'Neutral'|'Negative', cat: 'All'|slug }.
    function filterCities(cities, filters) {
        const list = Array.isArray(cities) ? cities : [];
        const f = filters || { sent: 'All', cat: 'All' };
        return list.filter((c) => {
            if (!c || typeof c !== 'object') return false;
            if (f.cat !== 'All' && cityTopSlug(c) !== f.cat) return false;
            if (f.sent !== 'All'
                && bucketOf(netSentiment(c)) !== f.sent.toLowerCase()) return false;
            return true;
        });
    }

    // sortCitiesBySentiment: ALWAYS most-positive → most-negative (prototype
    // ExplorePanel contract). Ties break by higher total then name so the
    // list is deterministic across refreshes.
    function sortCitiesBySentiment(cities) {
        return (Array.isArray(cities) ? cities.slice() : []).sort((a, b) => {
            const d = netSentiment(b) - netSentiment(a);
            if (d !== 0) return d;
            const t = (Number(b.total) || 0) - (Number(a.total) || 0);
            if (t !== 0) return t;
            return String(a.city) < String(b.city) ? -1
                : String(a.city) > String(b.city) ? 1 : 0;
        });
    }

    function filterAndSortCities(cities, filters) {
        return sortCitiesBySentiment(filterCities(cities, filters));
    }

    // dimTestFor: globe dimTest over the globe's ADAPTED city shape
    // ({top: slug, sentiment: net}). Returns null when nothing filters
    // (null = no dimming, cheaper than an always-true test).
    function dimTestFor(filters) {
        const f = filters || { sent: 'All', cat: 'All' };
        if (f.cat === 'All' && f.sent === 'All') return null;
        return (c) => {
            if (f.cat !== 'All' && c.top !== f.cat) return false;
            if (f.sent !== 'All'
                && bucketOf(c.sentiment) !== f.sent.toLowerCase()) return false;
            return true;
        };
    }

    // composeDimTest: a hovered ribbon segment spotlights its category on
    // the globe, overriding the panel filters (prototype app.jsx stripCat).
    function composeDimTest(filters, stripCat) {
        if (stripCat) return (c) => c.top === stripCat;
        return dimTestFor(filters);
    }

    // tooltipPosition: near-cursor placement clamped to the viewport
    // (prototype CityTooltip math, verbatim).
    function tooltipPosition(x, y, winW, winH) {
        return {
            left: Math.min(x + TIP_OFFSET_X, winW - TIP_CLAMP_RIGHT),
            top: Math.min(y + TIP_OFFSET_Y, winH - TIP_CLAMP_BOTTOM),
        };
    }

    // tooltipBarWidth: tooltip share bars scale against the largest of the
    // shown rows (prototype: share / maxShare × 90%).
    function tooltipBarWidth(share, maxShare) {
        if (!Number.isFinite(share) || !Number.isFinite(maxShare) || maxShare <= 0) {
            return 0;
        }
        return (share / maxShare) * 90;
    }

    // detailBarWidth: detail-panel share bars (prototype: min(100, share×220)).
    function detailBarWidth(share) {
        if (!Number.isFinite(share) || share <= 0) return 0;
        return Math.min(100, Math.round(share * 220));
    }

    // sentBarGeometry: the ± sentiment bar around the zero tick (prototype
    // .sent-bar-fill left/width math, verbatim).
    function sentBarGeometry(net) {
        const n = Number.isFinite(net) ? Math.max(-1, Math.min(1, net)) : 0;
        return {
            leftPct: n < 0 ? 50 + n * 50 : 50,
            widthPct: Math.abs(n) * 50,
        };
    }

    // ── Audit receipt models ────────────────────────────────────────────────

    // Decision type → display stage label (prototype step stages; backend
    // decision types beyond the prototype get a readable title-case).
    const STAGE_LABELS = {
        ingestion: 'Ingestion',
        sentiment: 'Sentiment',
        relevance: 'Relevance',
        discourse: 'Discourse quality',
    };
    function stageLabel(decisionType) {
        const key = String(decisionType === null || decisionType === undefined
            ? '' : decisionType).toLowerCase();
        if (STAGE_LABELS[key]) return STAGE_LABELS[key];
        const words = key.split('_').join(' ');
        return words.charAt(0).toUpperCase() + words.slice(1);
    }

    // scoreKind per decision type: how the head pill formats + colors.
    //   'sentiment' → ±0.00 in the sentiment color
    //   'percent'   → NN% in the NEUTRAL color (bug d: relevance never uses
    //                 the sentiment palette)
    //   'plain'     → 0.00 in the neutral color
    function scoreKindFor(decisionType) {
        if (decisionType === 'sentiment') return 'sentiment';
        if (decisionType === 'relevance') return 'percent';
        return 'plain';
    }

    // stepScoreDisplay: head-pill text for a step, or null (no pill).
    function stepScoreDisplay(step) {
        if (!step || step.score === null || step.score === undefined
            || !Number.isFinite(Number(step.score))) return null;
        const score = Number(step.score);
        if (step.scoreKind === 'sentiment') {
            return { text: fmtNet(score), kind: 'sentiment', score };
        }
        if (step.scoreKind === 'percent') {
            return { text: Math.round(score * 100) + '%', kind: 'neutral', score };
        }
        return { text: score.toFixed(2), kind: 'neutral', score };
    }

    // fmtHashPrefix: long HMAC hex → first 16 chars + ellipsis (the
    // prototype showed a truncated fingerprint). Demo hashes arrive already
    // truncated with a trailing '…' and pass through unchanged.
    function fmtHashPrefix(hash) {
        const s = String(hash === null || hash === undefined ? '' : hash);
        if (s === '') return null;
        if (s.endsWith('…')) return s;
        return s.length > 18 ? s.slice(0, 16) + '…' : s;
    }

    // normalizeLayer: one fairness-layer row into the drawer's layer shape.
    // Accepts the served /api/audit bias.layers rows ({name, value,
    // threshold, citation, status pass|fail|n-a, note}) and the demo shape.
    function normalizeLayer(l) {
        const status = l.status === 'fail' ? 'fail'
            : l.status === 'n-a' ? 'n-a' : 'pass';
        return {
            name: l.name || stageLabel(l.assessment_type),
            value: Number.isFinite(Number(l.value)) && l.value !== null
                ? Number(l.value) : null,
            threshold: Number.isFinite(Number(l.threshold)) && l.threshold !== null
                ? Number(l.threshold) : null,
            citation: l.citation || null,
            status,
            note: l.note || null,
        };
    }

    // biasStepFrom: the drawer's "Bias assessment" step from the served
    // bias block. Audience texts are DERIVED from the stored layer facts —
    // nothing invented (the audit route serves no bias prose).
    function biasStepFrom(bias) {
        const layers = (bias && Array.isArray(bias.layers) ? bias.layers : [])
            .map(normalizeLayer);
        const passed = layers.filter((l) => l.status === 'pass').length;
        const failed = layers.filter((l) => l.status === 'fail').length;
        const planned = layers.filter((l) => l.status === 'n-a').length;
        const computed = passed + failed;

        const publicText = computed === 0
            ? 'No fairness checks are recorded for the processing job that scored this post.'
            : 'Fairness checks ran on the processing job that scored this post — '
                + 'not on request: ' + passed + ' passed'
                + (failed > 0 ? ', ' + failed + ' flagged a threshold' : '')
                + (planned > 0 ? '; ' + planned + ' planned check'
                    + (planned === 1 ? ' is' : 's are') + ' not yet enforced' : '')
                + '.';
        const plainText = computed === 0
            ? 'No bias assessments are stored for this processing job.'
            : computed + ' fairness check' + (computed === 1 ? '' : 's')
                + ' ran on this post’s processing job. Values, thresholds (τ) and'
                + ' literature citations are listed per layer below.';
        const configView = {
            job_id: (bias && bias.job_id) || null,
            assessed_at: (bias && bias.assessed_at) || null,
            layers_computed: computed,
            layers_planned: planned,
        };
        const researcherText = layers.length === 0
            ? 'No assessments stored for this job.'
            : layers.map((l) => l.name + ' '
                + (l.value !== null
                    ? l.value.toFixed(3) + '/τ ' + l.threshold
                    : 'n-a')
                + ' ' + l.status).join(' · ');

        return {
            stage: 'Bias assessment',
            // Versioned bias-monitor identity served in the bias block (from
            // the 'bias' methodology_versions row) — renders the same
            // model@version pill as the other steps. Absent → no pill,
            // never an invented name.
            model: (bias && bias.model_name) || null,
            version: (bias && bias.version) || null,
            status: failed > 0 ? 'fail' : (computed === 0 ? 'n-a' : 'pass'),
            score: null,
            scoreKind: null,
            audiences: {
                public: publicText,
                plain: plainText,
                config: configView,
                researcher: researcherText,
            },
            layers,
        };
    }

    // mapAuditResponse: GET /api/audit/:post_id payload → drawer model.
    //   { postId, inputHash|null, post, steps[], footer }
    // Steps: synthetic ingest (when registered) → decisions in stored order
    // → bias assessment. input_hash may be absent (AUDIT_HASH_KEY unset) —
    // the fingerprint line is omitted gracefully, never faked.
    function mapAuditResponse(payload) {
        if (!payload || typeof payload !== 'object' || !payload.post) return null;
        const steps = [];

        if (payload.ingest && payload.ingest.audiences) {
            steps.push({
                stage: stageLabel(payload.ingest.stage || 'ingestion'),
                model: payload.ingest.model_name || null,
                version: payload.ingest.methodology_version || null,
                status: payload.ingest.status || 'pass',
                score: null,
                scoreKind: null,
                audiences: payload.ingest.audiences,
                layers: null,
            });
        }

        let inputHash = null;
        for (const d of (Array.isArray(payload.decisions) ? payload.decisions : [])) {
            if (!d || typeof d !== 'object') continue;
            if (inputHash === null && typeof d.input_hash === 'string'
                && d.input_hash !== '') {
                inputHash = d.input_hash;
            }
            steps.push({
                stage: stageLabel(d.decision_type),
                model: d.model_name || null,
                version: d.methodology_version || null,
                status: d.status || 'pass',
                score: d.score !== undefined ? d.score : null,
                scoreKind: scoreKindFor(d.decision_type),
                audiences: d.audiences || null,
                layers: null,
            });
        }

        steps.push(biasStepFrom(payload.bias));

        return {
            postId: payload.post.id,
            inputHash,
            isDemo: false,
            post: {
                content_snippet: payload.post.content_snippet || '',
                source_name: payload.post.source_name || null,
                platform: payload.post.source_category || null,
                location: payload.post.location || null,
                collected_at: payload.post.collected_at || null,
            },
            steps,
            footer: 'immutable log · methodology versioned before it runs · '
                + 'reproducible by anyone (spec §10)',
        };
    }

    // ── Health drawer models ────────────────────────────────────────────────

    const VALID_SEVERITIES = { alert: true, watch: true, pass: true };

    // fmtAlertTime: ISO timestamp → 'HH:MM UTC' (prototype alert rows).
    function fmtAlertTime(iso) {
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return '';
        const d = new Date(t);
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        return hh + ':' + mm + ' UTC';
    }

    // mapBiasHistory: GET /api/bias/history payload → alert-feed rows.
    // Unknown severity strings degrade to 'watch' (visible, never hidden).
    function mapBiasHistory(payload) {
        const rows = payload && Array.isArray(payload.alerts) ? payload.alerts : [];
        return rows.map((a) => ({
            id: a.id,
            severity: VALID_SEVERITIES[a.severity] ? a.severity : 'watch',
            time: fmtAlertTime(a.time),
            layer: a.layer || stageLabel(a.assessment_type),
            detail: a.detail || '',
            citation: a.citation || null,
        }));
    }

    // healthBanner: GET /api/health payload → banner model. null payload =
    // unreachable backend (surface attention, never a fake "nominal").
    function healthBanner(health) {
        if (!health || typeof health !== 'object') {
            return {
                state: 'yellow',
                title: 'Model health unavailable',
                sub: 'The health endpoint could not be reached — showing the '
                    + 'outage rather than a fake nominal.',
            };
        }
        const alerts = Array.isArray(health.active_alerts)
            ? health.active_alerts.length : 0;
        if (alerts > 0) {
            return {
                state: 'yellow',
                title: 'Yellow — ' + alerts + ' active alert'
                    + (alerts === 1 ? '' : 's'),
                sub: 'Fairness checks run on every processing job — not on '
                    + 'request. When a threshold trips, it alerts and logs here.',
            };
        }
        return {
            state: 'green',
            title: 'Green — no active alerts',
            sub: 'Fairness checks run on every processing job — not on '
                + 'request. When a threshold trips, it alerts and logs here.',
        };
    }

    // sourcesStat: GET /api/sources?include_inactive=true rows →
    // {active, total}. This is REGISTRY-active (configured on/off flags),
    // not liveness — label it honestly (audit G20).
    function sourcesStat(rows) {
        const list = Array.isArray(rows) ? rows : [];
        return {
            active: list.filter((r) => r && r.active === true).length,
            total: list.length,
        };
    }

    // methodologyModel: GET /api/methodology rows → kv table rows
    // [{key: 'model@version', desc}] — latest (first-served) row per
    // component only; the route orders component ASC, effective_from DESC.
    function methodologyModel(rows) {
        const list = Array.isArray(rows) ? rows : [];
        const seen = new Set();
        const out = [];
        for (const r of list) {
            if (!r || typeof r !== 'object' || seen.has(r.component)) continue;
            seen.add(r.component);
            out.push({
                key: (r.model_name || r.component) + '@' + r.version,
                desc: r.justification || r.component,
            });
        }
        return out;
    }

    // ── Source ribbon models ────────────────────────────────────────────────

    // normalizeSeries: hourly totals → 0..1 heights for the sparkline.
    function normalizeSeries(totals) {
        const list = Array.isArray(totals) ? totals.map((t) => Number(t) || 0) : [];
        if (list.length === 0) return [];
        const max = Math.max.apply(null, list);
        return max > 0 ? list.map((t) => t / max) : list.map(() => 0);
    }

    // sparklinePoints: series (0..1) → SVG point strings for the ribbon's
    // area+line sparkline (prototype SourceStrip formula, verbatim).
    function sparklinePoints(series, w, h) {
        if (!Array.isArray(series) || series.length === 0) return null;
        const width = Number.isFinite(w) ? w : SPARK_W;
        const height = Number.isFinite(h) ? h : SPARK_H;
        const denom = series.length > 1 ? series.length - 1 : 1;
        const line = series
            .map((v, i) => ((i / denom) * width) + ','
                + (height - 2 - (Number(v) || 0) * (height - 8)))
            .join(' ');
        const area = '0,' + height + ' ' + line + ' ' + width + ',' + height;
        return { line, area };
    }

    // demoSeries: deterministic 12-point sparkline for demo mode (prototype
    // sourceStrip series walk, verbatim — seed 'strip-<category>').
    function demoSeries(category, points) {
        const r = seed('strip-' + category);
        const n = Number.isFinite(points) ? points : TIMESERIES_HOURS;
        const out = [];
        let v = 0.45 + r() * 0.4;
        for (let i = 0; i < n; i++) {
            v = Math.max(0.12, Math.min(1, v + (r() - 0.5) * 0.26));
            out.push(Math.round(v * 100) / 100);
        }
        return out;
    }

    // ribbonModel: marimekko segment rows. The base comes from the SNAPSHOT
    // aggregation padded to the CANONICAL taxonomy (insights.allCategoryRows
    // — one segment per spec-§17 category, ALWAYS, plus any extra category
    // present in the data), with the 12h series / top_site / cue words
    // attached from /api/sources/timeseries where available (the timeseries
    // omits zero-post categories, audit G23 — a missing series is
    // tolerated). Zero-volume categories stay honest: flat zero series
    // (never a synthesized walk), no cue words, no lead site.
    // opts.demo=true synthesizes deterministic series instead (FR-22).
    function ribbonModel(cities, timeseries, opts) {
        const demo = !!(opts && opts.demo);
        const base = allCategoryRows(cities);
        const tsByCat = {};
        for (const row of (Array.isArray(timeseries) ? timeseries : [])) {
            if (row && typeof row.category === 'string') tsByCat[row.category] = row;
        }
        return base.map((row) => {
            const slug = gmath.normalizeCategorySlug(row.category);
            const ts = tsByCat[row.category] || (slug && tsByCat[slug]) || null;
            const zero = !(row.volume > 0);
            let series = null;
            let words = [];
            if (zero) {
                // Flat baseline sparkline for a quiet category — visible,
                // and honest about the zero volume.
                series = new Array(TIMESERIES_HOURS).fill(0);
            } else {
                if (ts && Array.isArray(ts.series)) {
                    series = normalizeSeries(ts.series.map((b) => b && b.total));
                } else if (demo) {
                    series = demoSeries(row.category, TIMESERIES_HOURS);
                }
                words = ts && Array.isArray(ts.words) ? ts.words.slice(0, 2)
                    : (demo ? ['AI', 'models'] : []);
            }
            return {
                category: row.category,
                slug,
                label: catLabel(row.category),
                share: row.share,
                volume: row.volume,
                net: row.net,
                split: row.split,
                site: zero ? null
                    : ((ts && ts.top_site) || row.topSource || null),
                words,
                series,
            };
        });
    }

    // ribbonFlexPercents: flex-basis percentages for the marimekko
    // segments. Proportional to share, but zero/near-zero segments keep a
    // minimum sliver (RIBBON_MIN_FLEX_SHARE) so their dot + label + "0/hr ·
    // 0%" stay readable — the displayed percentage still reports the REAL
    // share. Percentages are renormalized to sum to 100.
    function ribbonFlexPercents(rows) {
        if (!Array.isArray(rows) || rows.length === 0) return [];
        const weights = rows.map((r) => {
            const share = Number(r && r.share);
            return Math.max(Number.isFinite(share) ? share : 0,
                RIBBON_MIN_FLEX_SHARE);
        });
        const total = weights.reduce((a, b) => a + b, 0);
        return weights.map((w) => (w / total) * 100);
    }

    // ── Demo fallback: deterministic posts + receipts (FR-22) ───────────────
    // Ported from the prototype's data.js (seed / pseudoHash / POST_POOL /
    // postsForCity / buildAudit), re-keyed by the REAL API category slugs
    // and emitted in the POST /api/query row shape so one renderer serves
    // both live and demo posts.

    // Deterministic pseudo-random from string (prototype-verbatim FNV walk).
    function seed(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return () => {
            h = Math.imul(h ^ (h >>> 15), 2246822507);
            h = Math.imul(h ^ (h >>> 13), 3266489909);
            return ((h ^= h >>> 16) >>> 0) / 4294967296;
        };
    }

    function pseudoHash(str) {
        const r = seed(str);
        let s = '';
        const hex = '0123456789abcdef';
        for (let i = 0; i < 16; i++) s += hex[Math.floor(r() * 16)];
        return s;
    }

    // Fictional post templates per CANONICAL category slug (design.config
    // CATEGORIES — one pool per taxonomy category), with sentiment cue
    // tokens (prototype POST_POOL, re-keyed onto the real API slugs).
    const DEMO_POST_POOL = {
        social: [
            { text: 'Tried the on-device assistant for a full week. Honestly can’t go back — though the battery cost is real.', cues: [['can’t go back', 0.42], ['battery cost', -0.18]] },
            { text: 'My mom used a translation model to talk to her doctor today. This stuff matters.', cues: [['this stuff matters', 0.51]] },
        ],
        news: [
            { text: 'Regulators signal an enforcement wave as AI Act transparency deadlines pass without extensions.', cues: [['enforcement wave', -0.34], ['without extensions', -0.12]] },
            { text: 'Hospitals report triage-assist rollout cut waiting-room misroutes by a third in pilot wards.', cues: [['cut', 0.22], ['misroutes', -0.10], ['pilot', 0.05]] },
        ],
        academic: [
            { text: 'Preprint: chain-of-thought monitoring reduces evaluation-gaming behavior by 34% across three model families.', cues: [['reduces', 0.28], ['gaming behavior', -0.14]] },
            { text: 'Replication study confirms sentiment classifiers drift measurably within 90 days without recalibration.', cues: [['confirms', 0.11], ['drift', -0.25]] },
        ],
        policy: [
            { text: 'Comment period opens on frontier-model reporting rules; industry groups call the timeline aggressive.', cues: [['opens', 0.08], ['aggressive', -0.31]] },
            { text: 'City council votes to require plain-language explanations for any automated benefits decision.', cues: [['plain-language', 0.30], ['require', -0.05]] },
        ],
        developer: [
            { text: 'Shipped an agent that files our compliance paperwork end-to-end. Two days of glue code. Wild.', cues: [['shipped', 0.35], ['wild', 0.29]] },
            { text: 'Latency on the new inference runtime is genuinely absurd (good absurd). Halved our serving bill.', cues: [['genuinely absurd (good absurd)', 0.44], ['halved our serving bill', 0.38]] },
        ],
        nonprofit: [
            { text: 'Our digital-rights clinic helped 40 people appeal automated benefit denials this month. Documentation wins cases.', cues: [['wins cases', 0.36], ['denials', -0.22]] },
            { text: 'New watchdog audit: only 12 of 60 public-sector chatbots disclose that users are talking to a machine.', cues: [['only 12 of 60', -0.30], ['disclose', 0.08]] },
        ],
        // Forums pool: prototype-verbatim (data.js POST_POOL.Forums) —
        // forums is a canonical category with zero LIVE sources, but the
        // demo world keeps the prototype's Forums presence (FR-22).
        forums: [
            { text: 'Is anyone else’s team quietly rolling back AI code review? Curious what changed for you.', cues: [['rolling back', -0.27], ['curious', 0.06]] },
            { text: 'Hot take: local models finally crossed the "good enough" line for 80% of my daily tasks.', cues: [['good enough', 0.33], ['finally', 0.15]] },
        ],
        blog: [
            { text: 'Six months of running a local LLM stack: the costs, the surprises, and the two things I regret.', cues: [['surprises', 0.09], ['regret', -0.29]] },
            { text: 'Why our newsroom now publishes the prompt alongside every AI-assisted chart.', cues: [['publishes', 0.21], ['alongside', 0.04]] },
        ],
    };
    // Rotation over the canonical taxonomy (design.config CATEGORY_SLUGS)
    // — demo posts draw from the same 8 categories every other surface
    // enumerates. A city whose dominant category has no pool (a legacy /
    // unknown slug) falls back to the canonical rotation.
    const DEMO_POOL_ORDER = designConfig.CATEGORY_SLUGS;
    // Demo source hostnames: prototype SOURCES verbatim (data.js), keyed by
    // API slug — forums keeps the prototype's boards.example; nonprofit has
    // no prototype source (the prototype never rendered the category) so it
    // keeps the fix-branch civicwatch.example.
    const DEMO_SOURCES = {
        social: 'firehose.social',
        news: 'wireservice.example',
        academic: 'openpreprints.example',
        policy: 'policytracker.example',
        nonprofit: 'civicwatch.example',
        developer: 'devlog.example',
        forums: 'boards.example',
        blog: 'longform.example',
    };

    // demoPostsForCity: 3 deterministic sample posts for a NORMALIZED city,
    // in the /api/query row shape. Ids carry a 'demo-' prefix and are never
    // fetched from /api/audit (they are not UUIDs — audit G16).
    function demoPostsForCity(city, nowMs) {
        if (!city || typeof city !== 'object') return [];
        const r = seed(String(city.city));
        const now = Number.isFinite(nowMs) ? nowMs : 0;
        const top = cityTopSlug(city);
        const order = top && DEMO_POST_POOL[top]
            ? [top].concat(DEMO_POOL_ORDER.filter((s) => s !== top))
            : DEMO_POOL_ORDER;
        const net = netSentiment(city);
        const out = [];
        for (let i = 0; i < 3; i++) {
            const cat = order[i % order.length];
            const pool = DEMO_POST_POOL[cat] || DEMO_POST_POOL.social;
            const tpl = pool[Math.floor(r() * pool.length)];
            const jitter = (r() - 0.5) * 0.3;
            const cueSum = tpl.cues.reduce((a, c) => a + c[1], 0);
            const s = Math.max(-0.95, Math.min(0.95, net + jitter + cueSum * 0.3));
            const minutes = 2 + Math.floor(r() * 110);
            const relevance = Math.round((0.78 + r() * 0.2) * 100) / 100;
            const comparative = Math.round(s * 100) / 100;
            out.push({
                id: 'demo-' + city.city + '-p' + i,
                content_snippet: tpl.text,
                indicator: bucketOf(comparative),
                comparative,
                positive_words: tpl.cues.filter((c) => c[1] >= 0).map((c) => c[0]),
                negative_words: tpl.cues.filter((c) => c[1] < 0).map((c) => c[0]),
                relevance,
                location: city.city,
                source_name: DEMO_SOURCES[cat] || 'source.example',
                platform: cat,
                collected_at: new Date(now - minutes * 60000).toISOString(),
                cues: tpl.cues,
                isDemo: true,
            });
        }
        return out;
    }

    // isDemoPostId: demo ids must never hit /api/audit (route 400s on
    // non-UUIDs). Anything that is not a UUID is treated as demo.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    function isDemoPostId(id) {
        return !UUID_RE.test(String(id === null || id === undefined ? '' : id));
    }

    // demoAuditModel: locally synthesized receipt in the SAME drawer-model
    // shape mapAuditResponse produces (prototype buildAudit, verbatim texts).
    function demoAuditModel(post) {
        if (!post || typeof post !== 'object') return null;
        const cues = Array.isArray(post.cues) ? post.cues : [];
        const sentiment = Number(post.comparative) || 0;
        const relevance = Number.isFinite(Number(post.relevance))
            ? Number(post.relevance) : 0.8;
        const cueLines = cues.map((c) => '“' + c[0] + '” '
            + (c[1] >= 0 ? '+' : '') + c[1].toFixed(2));
        const firstCue = cues.length > 0 ? cues[0][0] : 'its wording';
        const tone = sentiment >= 0 ? 'positive' : 'negative';

        const steps = [
            {
                stage: 'Ingestion', model: 'pulse-ingest', version: '2.4.1',
                status: 'pass', score: null, scoreKind: null,
                audiences: {
                    public: 'This post came from a public source. Before we saved it, we removed anything that could identify who wrote it. We only keep the city it came from.',
                    plain: 'Collected via the source’s public API. 2 identifying fields (handle, user ID) were stripped before anything was stored. Location was kept at city level only.',
                    config: {
                        pii_fields_removed: 2,
                        location_granularity: 'city',
                        dedupe: 'simhash-64',
                        legal_basis: 'legitimate_interest § 6(1)(f)',
                    },
                    researcher: 'Raw content hashed at ingest; hash is the immutable join key across the audit log.',
                },
                layers: null,
            },
            {
                stage: 'Sentiment', model: 'pulse-sentiment-lexicon',
                version: '1.3.0', status: 'pass',
                score: sentiment, scoreKind: 'sentiment',
                audiences: {
                    public: 'The tone reads ' + tone + ' mostly because of the phrase “' + firstCue + '”. A computer read it — no human judged it.',
                    plain: 'Scored ' + tone + ' (' + sentiment.toFixed(2) + ') because of these phrases: ' + cueLines.join(', ') + '. Lexicon-based v1 — accuracy status is published on the methodology page; a transformer upgrade is the Phase 2 accuracy vehicle.',
                    config: {
                        lexicon: 'PULSE-LEX 2026.05',
                        negation_window: 3,
                        intensifier_cap: 1.6,
                        benchmark_accuracy: '87.4% (labeled set n=4,120)',
                    },
                    researcher: 'Cue weights: ' + cueLines.join(' · ')
                        + '. Reproduce: pulse replay --post ' + post.id
                        + ' --methodology sentiment@1.3.0',
                },
                layers: null,
            },
            {
                stage: 'Relevance', model: 'pulse-relevance-kw',
                version: '1.1.2', status: 'pass',
                score: relevance, scoreKind: 'percent',
                audiences: {
                    public: 'It counts toward the map because it’s clearly talking about AI.',
                    plain: 'Rated ' + Math.round(relevance * 100) + '% relevant to AI discourse via keyword and phrase matching.',
                    config: {
                        matched_terms: ['AI', 'model', 'automated'],
                        min_threshold: 0.6,
                    },
                    researcher: 'TF-weighted keyword match against versioned term list kw@2026.06.',
                },
                layers: null,
            },
            {
                stage: 'Bias assessment', model: 'pulse-bias-monitor',
                version: '1.2.0', status: 'pass',
                score: null, scoreKind: null,
                audiences: {
                    public: 'We double-checked that our system treated this post the same way it treats every other post. All fairness checks passed.',
                    plain: 'Three fairness checks ran on this post’s processing job. All within evidence-based thresholds.',
                    config: {
                        job: 'job-' + pseudoHash(String(post.id)).slice(0, 8),
                        thresholds_version: 'fairness@2026.04',
                    },
                    researcher: 'Thresholds stored as versioned config; adjustable without code change (spec §3, §9).',
                },
                layers: [
                    { name: 'Demographic parity', value: 0.031, threshold: 0.10, citation: 'Barocas & Selbst (2016)', status: 'pass', note: null },
                    { name: 'Equalized odds', value: 0.048, threshold: 0.08, citation: 'Hardt et al. (2016)', status: 'pass', note: null },
                    { name: 'Counterfactual fairness', value: null, threshold: null, citation: 'Kusner et al. (2017)', status: 'n-a', note: 'Phase 3 — not yet enforced' },
                ],
            },
        ];

        return {
            postId: post.id,
            inputHash: 'sha256:' + pseudoHash(String(post.id)) + '…',
            isDemo: true,
            post: {
                content_snippet: post.content_snippet || '',
                source_name: post.source_name || null,
                platform: post.platform || null,
                location: post.location || null,
                collected_at: post.collected_at || null,
            },
            steps,
            footer: 'immutable log · methodology versioned before it runs · '
                + 'reproducible by anyone (spec §10) · fictional demo data',
        };
    }

    // Demo health-drawer content (FR-22): rendered ONLY when the live
    // endpoints are unreachable, always labeled as demo data.
    const DEMO_BIAS_ALERTS = [
        { id: 'demo-a1', severity: 'alert', time: '07:42 UTC', layer: 'Source concentration', detail: 'News category reached 41.2% of global volume (τ = 35%). Auto-mitigation: sampling reweighted; alert posted to bias history.', citation: 'fairness@2026.04' },
        { id: 'demo-a2', severity: 'watch', time: '06:15 UTC', layer: 'Location concentration', detail: 'Inferred-location share for posts without metadata rose to 18% in South America (τ = 25%). Within threshold; trending up.', citation: 'spec §9 · R4' },
        { id: 'demo-a3', severity: 'pass', time: '03:08 UTC', layer: 'Demographic parity', detail: 'Overnight batch: parity gap 0.031 (τ = 0.10) across source categories. No action.', citation: 'Barocas & Selbst (2016)' },
    ];
    const DEMO_METHODOLOGY = [
        { key: 'pulse-ingest@2.4.1', desc: 'collection, PII strip, dedupe' },
        { key: 'pulse-sentiment-lexicon@1.3.0', desc: 'lexicon scoring · 87.4% on labeled set' },
        { key: 'pulse-relevance-kw@1.1.2', desc: 'keyword relevance · kw@2026.06' },
        { key: 'pulse-bias-monitor@1.2.0', desc: 'fairness checks · fairness@2026.04' },
    ];

    const pure = {
        SENTIMENT_FILTERS,
        AUDIENCES,
        AUDIENCE_KEYS,
        catLabel,
        cityTopSlug,
        bucketOf,
        filterCities,
        sortCitiesBySentiment,
        filterAndSortCities,
        dimTestFor,
        composeDimTest,
        tooltipPosition,
        tooltipBarWidth,
        detailBarWidth,
        sentBarGeometry,
        stageLabel,
        scoreKindFor,
        stepScoreDisplay,
        fmtHashPrefix,
        biasStepFrom,
        mapAuditResponse,
        fmtAlertTime,
        mapBiasHistory,
        healthBanner,
        sourcesStat,
        methodologyModel,
        normalizeSeries,
        sparklinePoints,
        demoSeries,
        ribbonModel,
        ribbonFlexPercents,
        seed,
        pseudoHash,
        demoPostsForCity,
        isDemoPostId,
        demoAuditModel,
    };

    // ═══ DOM layer (browser only — everything below needs the page) ═════════

    const state = {
        initialized: false,
        cities: [],
        isDemo: false,
        exploring: false,
        filters: { sent: 'All', cat: 'All' },
        colorMode: 'sentiment',
        selectedId: null,
        stripCat: null,
        hover: null,            // {id, x, y}
        audience: 'Public',     // audit drawer segmented control
        auditModel: null,
        timeseries: null,       // cached /api/sources/timeseries rows
        timeseriesAt: 0,
    };

    let els = null;
    let globe = null;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function svgEl(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const key of Object.keys(attrs || {})) {
            node.setAttribute(key, attrs[key]);
        }
        return node;
    }

    function clear(node) {
        while (node && node.firstChild) node.removeChild(node.firstChild);
    }

    function story() { return window.PulseStory || storyMod; }

    function isDemoMode() {
        const s = story();
        try {
            return !!(s && s.getState && s.getState().isDemo);
        } catch (_) { return false; }
    }

    function getJson(url) {
        if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));
        return fetch(url).then((res) => {
            if (!res || !res.ok) throw new Error(url + ' ' + (res && res.status));
            return res.json();
        });
    }

    function findCity(id) {
        return state.cities.find((c) => c && c.city === id) || null;
    }

    // ── Globe filter application ────────────────────────────────────────────

    function applyGlobeFilters() {
        if (!globe || !state.exploring) return;
        globe.setState({
            dimTest: composeDimTest(state.filters, state.stripCat),
            colorMode: state.colorMode,
        });
    }

    // ── Explore panel (filters + sorted city list) ──────────────────────────

    function buildSeg(options, current, onPick) {
        const seg = el('div', 'seg');
        for (const opt of options) {
            const value = Array.isArray(opt) ? opt[0] : opt;
            const label = Array.isArray(opt) ? opt[1] : opt;
            const btn = el('button', 'seg-btn' + (current === value ? ' on' : ''), label);
            btn.type = 'button';
            btn.addEventListener('click', () => onPick(value));
            seg.appendChild(btn);
        }
        return seg;
    }

    function renderExplorePanel() {
        if (!els.expFilters) return;
        clear(els.expFilters);
        els.expFilters.appendChild(el('div', 'exp-title mono', 'EXPLORE · LAST HOUR'));

        // COLOR BY segmented (Sentiment / Source → globe color mode).
        const modeRow = el('div', 'mode-row');
        modeRow.appendChild(el('span', 'mode-lbl mono', 'COLOR BY'));
        modeRow.appendChild(buildSeg(
            [['sentiment', 'Sentiment'], ['category', 'Source']],
            state.colorMode,
            (v) => {
                state.colorMode = v;
                applyGlobeFilters();
                renderExplorePanel();
            }));
        els.expFilters.appendChild(modeRow);

        // Sentiment segmented (partitioned SENTIMENT_BUCKETS — bug c fix).
        els.expFilters.appendChild(buildSeg(
            SENTIMENT_FILTERS,
            state.filters.sent,
            (v) => {
                state.filters = { sent: v, cat: state.filters.cat };
                applyGlobeFilters();
                renderExplorePanel();
            }));

        // Category chips with color dots — the FULL canonical taxonomy,
        // always, in REGISTRY order (prototype contract: ['All',
        // ...CATEGORIES] — fixed order, never the share ranking), so
        // Social / Non-profit / Academic / Forums never vanish when they
        // have no posts in the current window. Non-canonical categories
        // present in the data are appended after the canon (kept, never
        // hidden — allCategoryRows honesty).
        const chips = el('div', 'chips');
        const canonSlugs = designConfig.CATEGORY_SLUGS;
        const extras = [];
        for (const r of allCategoryRows(state.cities)) {
            const s = gmath.normalizeCategorySlug(r.category);
            if (s !== null && canonSlugs.indexOf(s) === -1
                && extras.indexOf(s) === -1) {
                extras.push(s);
            }
        }
        const cats = canonSlugs.concat(extras);
        for (const cat of ['All'].concat(cats)) {
            const on = state.filters.cat === cat;
            const chip = el('button', 'chip' + (on ? ' on' : ''));
            chip.type = 'button';
            if (cat !== 'All') {
                const dot = el('span', 'chip-dot');
                dot.style.background = CAT_COLORS[cat] || SENTIMENT_PALETTE.neutral;
                chip.appendChild(dot);
            }
            chip.appendChild(document.createTextNode(
                cat === 'All' ? 'All' : catLabel(cat)));
            chip.addEventListener('click', () => {
                state.filters = { sent: state.filters.sent, cat };
                applyGlobeFilters();
                renderExplorePanel();
            });
            chips.appendChild(chip);
        }
        els.expFilters.appendChild(chips);

        // City list — ALWAYS most-positive → most-negative.
        const list = el('div', 'exp-list');
        const rows = filterAndSortCities(state.cities, state.filters);
        for (const c of rows) {
            const net = netSentiment(c);
            const top = cityTopSlug(c);
            const row = el('button',
                'city-row' + (state.selectedId === c.city ? ' on' : ''));
            row.type = 'button';
            const dot = el('span', 'city-dot');
            dot.style.background = state.colorMode === 'category'
                ? (CAT_COLORS[top] || SENTIMENT_PALETTE.neutral)
                : gmath.sentColor(net, PALETTE);
            row.appendChild(dot);
            row.appendChild(el('span', 'city-name', c.city));
            row.appendChild(el('span', 'city-vol mono', c.total + '/hr'));
            const sent = el('span', 'city-sent mono', fmtNet(net));
            sent.style.color = gmath.sentColor(net, PALETTE);
            row.appendChild(sent);
            row.addEventListener('click', () => {
                selectCity(state.selectedId === c.city ? null : c.city);
            });
            list.appendChild(row);
        }
        if (rows.length === 0) {
            list.appendChild(el('div', 'empty mono', 'no cities match'));
        }
        els.expFilters.appendChild(list);
    }

    // ── City detail panel ───────────────────────────────────────────────────

    function selectCity(id) {
        state.selectedId = id || null;
        const s = story();
        if (s && typeof s.setExploreSelection === 'function') {
            s.setExploreSelection(state.selectedId);
        }
        const sel = state.selectedId ? findCity(state.selectedId) : null;
        if (globe) {
            const shares = sel && sel.shares
                ? sel.shares : { positive: 0, neutral: 0, negative: 0 };
            globe.setState({
                selectedId: sel ? sel.city : null,
                splitFor: sel
                    ? (cid) => (cid === sel.city
                        ? { pos: shares.positive, neu: shares.neutral, neg: shares.negative }
                        : null)
                    : null,
                focus: sel ? { lat: sel.lat, lon: sel.lng } : null,
                zoom: sel ? SELECT_ZOOM : EXPLORE_ZOOM,
            });
        }
        renderExplorePanel();   // selection highlight in the list
        renderDetail(sel);
    }

    function renderDetail(sel) {
        if (!els.expDetail) return;
        clear(els.expDetail);
        if (!sel) {
            els.expDetail.hidden = true;
            return;
        }
        els.expDetail.hidden = false;

        const x = el('button', 'det-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Close city panel');
        x.addEventListener('click', () => selectCity(null));
        els.expDetail.appendChild(x);

        const net = netSentiment(sel);
        const top = cityTopSlug(sel);

        const head = el('div', 'det-head');
        const headL = el('div');
        const cityLine = el('div', 'det-city', sel.city + ' ');
        if (sel.country) {
            cityLine.appendChild(el('span', 'mono det-cc', sel.country));
        }
        headL.appendChild(cityLine);
        headL.appendChild(el('div', 'det-sub mono',
            sel.total + ' posts/hr'
            + (top ? ' · top: ' + catLabel(top).toLowerCase() : '')));
        head.appendChild(headL);
        const score = el('div', 'det-score mono', fmtNet(net));
        score.style.color = gmath.sentColor(net, PALETTE);
        head.appendChild(score);
        els.expDetail.appendChild(head);

        // ± sentiment bar around the zero tick.
        const bar = el('div', 'sent-bar');
        const fill = el('div', 'sent-bar-fill');
        const geo = sentBarGeometry(net);
        fill.style.left = geo.leftPct + '%';
        fill.style.width = geo.widthPct + '%';
        fill.style.background = gmath.sentColor(net, PALETTE);
        bar.appendChild(fill);
        bar.appendChild(el('div', 'sent-bar-zero'));
        els.expDetail.appendChild(bar);

        // Top-4 category share bars with per-category sentiment.
        const cats = el('div', 'det-cats');
        for (const r of catBreakdown(sel).slice(0, DETAIL_CATS_MAX)) {
            const slug = gmath.normalizeCategorySlug(r.category);
            const row = el('div', 'tip-bar-row');
            // Prototype casing contract: bar labels are the DISPLAY name
            // lowercased ('Blogs' → 'blogs', 'Non-profit' → 'non-profit'),
            // never the raw slug ('blog'/'nonprofit').
            row.appendChild(el('span', 'tip-bar-lbl mono',
                catLabel(r.category).toLowerCase()));
            const track = el('span', 'tip-bar-track');
            const barFill = el('span', 'tip-bar-fill');
            barFill.style.width = detailBarWidth(r.share) + '%';
            barFill.style.background = (slug && CAT_COLORS[slug])
                || SENTIMENT_PALETTE.neutral;
            track.appendChild(barFill);
            row.appendChild(track);
            const v = el('span', 'tip-bar-v mono', fmtNet(r.net));
            v.style.color = gmath.sentColor(r.net, PALETTE);
            row.appendChild(v);
            cats.appendChild(row);
        }
        els.expDetail.appendChild(cats);

        // Posts (live via POST /api/query; demo synthesized locally).
        const postsWrap = el('div', 'det-posts');
        els.expDetail.appendChild(postsWrap);

        const foot = el('div', 'det-foot mono',
            'no PII stored · location capped at city'
            + (state.isDemo ? ' · all posts fictional demo data' : ''));
        els.expDetail.appendChild(foot);

        loadCityPosts(sel, postsWrap);
    }

    function loadCityPosts(sel, wrap) {
        if (state.isDemo || typeof fetch !== 'function') {
            renderPosts(wrap, demoPostsForCity(sel, Date.now()));
            return;
        }
        fetch(ENDPOINTS.query, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: sel.city, limit: CITY_POSTS_LIMIT }),
        })
            .then((res) => {
                if (!res || !res.ok) throw new Error('query ' + (res && res.status));
                return res.json();
            })
            .then((payload) => {
                if (state.selectedId !== sel.city) return;   // stale response
                const rows = payload && Array.isArray(payload.results)
                    ? payload.results : [];
                if (rows.length > 0) {
                    renderPosts(wrap, rows);
                } else {
                    clear(wrap);
                    wrap.appendChild(el('div', 'empty mono',
                        'no scored posts for this city yet'));
                }
            })
            .catch(() => {
                if (state.selectedId !== sel.city) return;
                // Backend unreachable → demo posts, honestly labeled (FR-22).
                renderPosts(wrap, demoPostsForCity(sel, Date.now()));
                wrap.appendChild(el('div', 'empty mono',
                    'live posts unavailable — showing fictional demo posts'));
            });
    }

    function renderPosts(wrap, rows) {
        clear(wrap);
        for (const p of rows) {
            const post = el('div', 'post');
            const minutes = minutesAgoFrom(p.collected_at, Date.now());
            const metaParts = [];
            if (p.source_name) metaParts.push(String(p.source_name));
            // Category meta: display label lowercased (prototype post-meta
            // casing — 'blogs', 'non-profit'), never the raw slug.
            if (p.platform) metaParts.push(catLabel(p.platform).toLowerCase());
            if (minutes !== null) metaParts.push(minutes + 'm ago');
            post.appendChild(el('div', 'post-meta mono', metaParts.join(' · ')));
            post.appendChild(el('div', 'post-text', p.content_snippet || ''));
            const row = el('div', 'post-row');
            const score = Number(p.comparative);
            const pill = el('span', 'score-pill mono', fmtNet(score));
            pill.style.color = gmath.sentColor(score, PALETTE);
            row.appendChild(pill);
            // Relevance pill: NEUTRAL color (dim), NEVER the sentiment
            // palette (prototype bug d / audit G21). Omitted when the post
            // was never relevance-scored (LEFT JOIN null).
            if (Number.isFinite(Number(p.relevance)) && p.relevance !== null) {
                row.appendChild(el('span', 'score-pill mono dim',
                    'rel ' + Math.round(Number(p.relevance) * 100) + '%'));
            }
            const why = el('button', 'btn-why mono', 'why?');
            why.type = 'button';
            why.addEventListener('click', () => openAudit(p));
            row.appendChild(why);
            post.appendChild(row);
            wrap.appendChild(post);
        }
    }

    // ── Hover tooltip ───────────────────────────────────────────────────────

    function renderTooltip() {
        if (!els.tip) return;
        const hover = state.hover;
        if (!hover || !hover.id || !state.exploring) {
            els.tip.hidden = true;
            return;
        }
        const c = findCity(hover.id);
        if (!c) { els.tip.hidden = true; return; }
        clear(els.tip);

        const net = netSentiment(c);
        const head = el('div', 'tip-head');
        head.appendChild(el('span', 'tip-city', c.city));
        const sent = el('span', 'tip-sent mono', fmtNet(net));
        sent.style.color = gmath.sentColor(net, PALETTE);
        head.appendChild(sent);
        els.tip.appendChild(head);
        els.tip.appendChild(el('div', 'tip-sub mono', c.total + ' posts/hr'));

        const rows = catBreakdown(c).slice(0, DETAIL_CATS_MAX);
        const maxShare = rows.length > 0 ? rows[0].share : 0;
        const bars = el('div', 'tip-bars');
        for (const r of rows) {
            const slug = gmath.normalizeCategorySlug(r.category);
            const row = el('div', 'tip-bar-row');
            // Display name lowercased (prototype tooltip casing) — see the
            // city-detail bars.
            row.appendChild(el('span', 'tip-bar-lbl mono',
                catLabel(r.category).toLowerCase()));
            const track = el('span', 'tip-bar-track');
            const fill = el('span', 'tip-bar-fill');
            fill.style.width = tooltipBarWidth(r.share, maxShare) + '%';
            fill.style.background = state.colorMode === 'category'
                ? ((slug && CAT_COLORS[slug]) || SENTIMENT_PALETTE.neutral)
                : gmath.sentColor(r.net, PALETTE);
            track.appendChild(fill);
            row.appendChild(track);
            row.appendChild(el('span', 'tip-bar-v mono',
                Math.round(r.share * 100) + '%'));
            bars.appendChild(row);
        }
        els.tip.appendChild(bars);
        els.tip.appendChild(el('div', 'tip-foot mono', 'click for posts + receipts'));

        const pos = tooltipPosition(hover.x, hover.y,
            window.innerWidth, window.innerHeight);
        els.tip.style.left = pos.left + 'px';
        els.tip.style.top = pos.top + 'px';
        els.tip.hidden = false;
    }

    // ── Source ribbon (marimekko) ───────────────────────────────────────────

    function loadTimeseries() {
        if (state.isDemo || typeof fetch !== 'function') {
            state.timeseries = null;
            renderRibbon();
            return;
        }
        getJson(ENDPOINTS.timeseries + '?hours=' + TIMESERIES_HOURS)
            .then((rows) => {
                state.timeseries = Array.isArray(rows) ? rows : [];
                state.timeseriesAt = Date.now();
                renderRibbon();
            })
            .catch(() => {
                state.timeseries = null;
                renderRibbon();
            });
    }

    function setStripCat(slug) {
        state.stripCat = slug || null;
        applyGlobeFilters();
    }

    function renderRibbon() {
        if (!els.strip) return;
        clear(els.strip);
        const rows = ribbonModel(state.cities, state.timeseries,
            { demo: state.isDemo || state.timeseries === null });
        const totShare = rows.reduce((a, r) => a + r.share, 0) || 1;
        // Flex widths carry a minimum sliver for zero-volume segments; the
        // DISPLAYED percentage stays the real share (0% for a quiet
        // category — honest, but still visible).
        const flexPcts = ribbonFlexPercents(rows);
        rows.forEach((row, ri) => {
            const pct = (row.share / totShare) * 100;
            const color = (row.slug && CAT_COLORS[row.slug])
                || SENTIMENT_PALETTE.neutral;
            const seg = el('button', 'strip-seg');
            seg.type = 'button';
            seg.style.flexBasis = flexPcts[ri] + '%';
            seg.title = row.label + ' · ' + row.volume + '/hr ('
                + Math.round(pct) + '% of volume) · ' + fmtNet(row.net) + ' · '
                + Math.round(row.split.pos * 100) + '% pos / '
                + Math.round(row.split.neu * 100) + '% neu / '
                + Math.round(row.split.neg * 100) + '% neg'
                + (row.site ? ' · ' + row.site : '')
                + (row.words.length > 0 ? ' · ' + row.words.join(', ') : '')
                + ' — hover: spotlight on globe · click: explore';

            // 12h SVG area sparkline (category color, non-scaling stroke).
            const pts = sparklinePoints(row.series, SPARK_W, SPARK_H);
            if (pts) {
                const svg = svgEl('svg', {
                    class: 'seg-area',
                    viewBox: '0 0 ' + SPARK_W + ' ' + SPARK_H,
                    preserveAspectRatio: 'none',
                    'aria-hidden': 'true',
                });
                svg.appendChild(svgEl('polygon', {
                    points: pts.area, fill: color, opacity: '0.14',
                }));
                svg.appendChild(svgEl('polyline', {
                    points: pts.line, fill: 'none', stroke: color,
                    'stroke-width': '1.3', opacity: '0.75',
                    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
                    'vector-effect': 'non-scaling-stroke',
                }));
                seg.appendChild(svg);
            }

            const content = el('div', 'seg-content');
            const line1 = el('div', 'seg-line1');
            const dot = el('span', 'chip-dot');
            dot.style.background = color;
            line1.appendChild(dot);
            line1.appendChild(el('span', 'seg-cat', row.label));
            line1.appendChild(el('span', 'seg-vol mono',
                row.volume + '/hr · ' + Math.round(pct) + '%'));
            const sent = el('span', 'seg-sent mono', fmtNet(row.net));
            sent.style.color = gmath.sentColor(row.net, PALETTE);
            line1.appendChild(sent);
            content.appendChild(line1);

            const line2 = el('div', 'seg-line2 mono');
            const pos = el('span', null, String(Math.round(row.split.pos * 100)));
            pos.style.color = gmath.sentColor(0.6, PALETTE);
            line2.appendChild(pos);
            line2.appendChild(el('span', 'seg-sep', '/'));
            line2.appendChild(el('span', null,
                String(Math.round(row.split.neu * 100))));
            line2.appendChild(el('span', 'seg-sep', '/'));
            const neg = el('span', null, String(Math.round(row.split.neg * 100)));
            neg.style.color = gmath.sentColor(-0.6, PALETTE);
            line2.appendChild(neg);
            const wordsText = (row.site || '')
                + (row.words.length > 0
                    ? (row.site ? ' · ' : '')
                        + row.words.map((w) => '“' + w + '”').join(' ')
                    : '');
            if (wordsText !== '') {
                line2.appendChild(el('span', 'seg-words', wordsText));
            }
            content.appendChild(line2);
            seg.appendChild(content);

            // Bottom 4px pos/neu/neg mix bar.
            const mix = el('div', 'mix-bar seg-mix');
            const segs = [
                [row.split.pos, gmath.sentColor(0.6, PALETTE)],
                [row.split.neu, gmath.sentColor(0, PALETTE)],
                [row.split.neg, gmath.sentColor(-0.6, PALETTE)],
            ];
            for (const [w, c] of segs) {
                const span = el('span');
                span.style.width = (w * 100) + '%';
                span.style.background = c;
                mix.appendChild(span);
            }
            seg.appendChild(mix);

            // "← 12h" axis label INSIDE the first segment only (README
            // regression guard: inline in the segment, never on the strip).
            if (ri === 0) seg.appendChild(el('span', 'seg-axis mono', '← 12h'));

            // Hover → spotlight the category on the globe; click → filter
            // to it in category color mode.
            seg.addEventListener('pointerenter', () => setStripCat(row.slug));
            seg.addEventListener('pointerleave', () => setStripCat(null));
            seg.addEventListener('click', () => {
                state.filters = { sent: state.filters.sent, cat: row.slug };
                state.colorMode = 'category';
                setStripCat(null);
                applyGlobeFilters();
                renderExplorePanel();
            });
            els.strip.appendChild(seg);
        });
    }

    // ── Audit drawer ────────────────────────────────────────────────────────

    function setDrawerOpen(drawer, open) {
        if (!drawer) return;
        drawer.classList.toggle('open', open);
        drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    }

    // openAudit(post): the receipt. `post` is a raw /api/query result row
    // (live) or a demo row from demoPostsForCity. Called by the detail
    // panel's "why?" buttons and DIRECTLY by story.js's featured-post
    // button (C3 contract). Freezes the header timer on the FIRST receipt.
    function openAudit(post) {
        if (!post || typeof post !== 'object') return;
        if (window.PulseMain
            && typeof window.PulseMain.freezeInsightTimer === 'function') {
            window.PulseMain.freezeInsightTimer();   // idempotent (US-1)
        }
        state.auditModel = null;
        renderAuditLoading(post);
        setDrawerOpen(els.auditDrawer, true);

        if (state.isDemo || isDemoPostId(post.id) || typeof fetch !== 'function') {
            state.auditModel = demoAuditModel(post);
            renderAuditDrawer();
            return;
        }
        getJson(ENDPOINTS.audit + encodeURIComponent(post.id))
            .then((payload) => {
                const model = mapAuditResponse(payload);
                if (!model) throw new Error('unmappable audit payload');
                state.auditModel = model;
                renderAuditDrawer();
            })
            .catch(() => {
                // Never fabricate a live post's receipt — surface the outage.
                renderAuditError(post);
            });
    }

    function closeAudit() {
        setDrawerOpen(els.auditDrawer, false);
        // Closing restores the prior view by construction: the drawer is an
        // overlay and no explore/story state was touched to open it.
    }

    function buildDrawerHead(kicker, title, onClose) {
        const head = el('div', 'drawer-head');
        const left = el('div');
        left.appendChild(el('div', 'drawer-kicker mono', kicker));
        left.appendChild(el('div', 'drawer-title', title));
        head.appendChild(left);
        const x = el('button', 'drawer-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Close');
        x.addEventListener('click', onClose);
        head.appendChild(x);
        return head;
    }

    function renderAuditLoading(post) {
        const inner = els.auditInner;
        if (!inner) return;
        clear(inner);
        inner.appendChild(buildDrawerHead(
            'AUDIT TRAIL · ' + (post.id || ''),
            'Why does it say that?', closeAudit));
        inner.appendChild(el('div', 'empty mono', 'pulling the receipt…'));
    }

    function renderAuditError(post) {
        const inner = els.auditInner;
        if (!inner) return;
        clear(inner);
        inner.appendChild(buildDrawerHead(
            'AUDIT TRAIL · ' + (post.id || ''),
            'Why does it say that?', closeAudit));
        const block = el('div', 'drawer-post');
        block.appendChild(el('div', 'post-text', post.content_snippet || ''));
        inner.appendChild(block);
        inner.appendChild(el('div', 'empty mono',
            'audit trail unavailable — the audit service could not be reached. '
            + 'This is a live post, so no receipt is synthesized.'));
    }

    function renderAuditDrawer() {
        const inner = els.auditInner;
        const model = state.auditModel;
        if (!inner || !model) return;
        clear(inner);

        inner.appendChild(buildDrawerHead(
            'AUDIT TRAIL · ' + model.postId
            + (model.isDemo ? ' · DEMO DATA' : ''),
            'Why does it say that?', closeAudit));

        // Post block: source / minutes / input fingerprint (HMAC field may
        // be absent — omitted gracefully, never faked).
        const block = el('div', 'drawer-post');
        const minutes = minutesAgoFrom(model.post.collected_at, Date.now());
        const metaParts = [];
        if (model.post.source_name) metaParts.push(String(model.post.source_name));
        if (minutes !== null) metaParts.push(minutes + 'm ago');
        const hashText = fmtHashPrefix(model.inputHash);
        if (hashText) metaParts.push('input ' + hashText);
        block.appendChild(el('div', 'post-meta mono', metaParts.join(' · ')));
        block.appendChild(el('div', 'post-text', model.post.content_snippet));
        inner.appendChild(block);

        // Audience segmented control (default Public).
        const seg = buildSeg(AUDIENCES, state.audience, (v) => {
            state.audience = v;
            renderAuditDrawer();
        });
        seg.classList.add('drawer-seg');
        inner.appendChild(seg);

        // Vertical step timeline.
        const stepsWrap = el('div', 'steps');
        model.steps.forEach((step, i) => {
            stepsWrap.appendChild(
                buildAuditStep(step, i < model.steps.length - 1));
        });
        inner.appendChild(stepsWrap);

        inner.appendChild(el('div', 'drawer-foot mono', model.footer));
    }

    function buildAuditStep(step, hasNext) {
        const wrap = el('div', 'step');
        const rail = el('div', 'step-rail');
        rail.appendChild(el('span',
            'step-node' + (step.status === 'pass' ? ' ok' : '')));
        if (hasNext) rail.appendChild(el('span', 'step-line'));
        wrap.appendChild(rail);

        const body = el('div', 'step-body');
        const head = el('div', 'step-head');
        head.appendChild(el('span', 'step-stage', step.stage));
        if (step.model) {
            head.appendChild(el('span', 'step-model mono',
                step.model + (step.version ? '@' + step.version : '')));
        }
        const scoreDisp = stepScoreDisplay(step);
        if (scoreDisp) {
            const pill = el('span',
                'score-pill mono' + (scoreDisp.kind === 'neutral' ? ' dim' : ''),
                scoreDisp.text);
            if (scoreDisp.kind === 'sentiment') {
                pill.style.color = gmath.sentColor(scoreDisp.score, PALETTE);
            }
            head.appendChild(pill);
        }
        body.appendChild(head);

        // Audience body: Public/Journalist → prose, Regulator → kv table,
        // Researcher → mono repro text.
        const audiences = step.audiences || {};
        const key = AUDIENCE_KEYS[state.audience] || 'public';
        const value = audiences[key];
        if (key === 'config') {
            body.appendChild(buildKvTable(value));
        } else if (key === 'researcher') {
            body.appendChild(el('p', 'step-plain mono step-repro',
                value === undefined || value === null ? '' : String(value)));
        } else {
            body.appendChild(el('p', 'step-plain',
                value === undefined || value === null ? '' : String(value)));
        }

        // Bias fairness layers (PASS / FAIL / N-A + value vs τ + citation).
        if (Array.isArray(step.layers) && step.layers.length > 0) {
            const layersWrap = el('div', 'layers');
            for (const l of step.layers) {
                const layer = el('div', 'layer');
                const okClass = l.status === 'pass' ? 'ok'
                    : l.status === 'fail' ? 'bad' : 'na';
                layer.appendChild(el('span', 'layer-ok mono ' + okClass,
                    l.status === 'pass' ? 'PASS'
                        : l.status === 'fail' ? 'FAIL' : 'N/A'));
                layer.appendChild(el('span', 'layer-name', l.name));
                layer.appendChild(el('span', 'layer-val mono',
                    l.value !== null && l.value !== undefined
                        ? Number(l.value).toFixed(3) + ' / τ ' + l.threshold
                        : (l.note || '—')));
                layer.appendChild(el('span', 'layer-cite mono', l.citation || ''));
                layersWrap.appendChild(layer);
            }
            body.appendChild(layersWrap);
        }

        wrap.appendChild(body);
        return wrap;
    }

    function buildKvTable(configObj) {
        const kv = el('div', 'kv mono');
        const obj = configObj && typeof configObj === 'object' ? configObj : {};
        for (const [k, v] of Object.entries(obj)) {
            const row = el('div', 'kv-row');
            row.appendChild(el('span', 'kv-k', k));
            let text;
            if (Array.isArray(v)) text = v.join(', ');
            else if (v !== null && typeof v === 'object') text = JSON.stringify(v);
            else text = String(v);
            row.appendChild(el('span', 'kv-v', text));
            kv.appendChild(row);
        }
        return kv;
    }

    // ── Health drawer ───────────────────────────────────────────────────────

    function openHealth() {
        setDrawerOpen(els.healthDrawer, true);
        if (els.healthChip) els.healthChip.setAttribute('aria-expanded', 'true');
        renderHealthLoading();
        if (typeof fetch !== 'function') {
            renderHealthDrawer(null, null, null, null);
            return;
        }
        const settle = (p) => p.then((v) => v).catch(() => null);
        Promise.all([
            settle(getJson(ENDPOINTS.health)),
            settle(getJson(ENDPOINTS.biasHistory + '?hours=' + TIMESERIES_HOURS)),
            settle(getJson(ENDPOINTS.methodology)),
            settle(getJson(ENDPOINTS.sources + '?include_inactive=true')),
        ]).then(([health, history, methodology, sources]) => {
            renderHealthDrawer(health, history, methodology, sources);
            updateHealthChip(health);
        });
    }

    function closeHealth() {
        setDrawerOpen(els.healthDrawer, false);
        if (els.healthChip) els.healthChip.setAttribute('aria-expanded', 'false');
    }

    // Keep the header chip in sync when the drawer refetches health (the
    // chip is the LIVE entry point — same states main.js uses at load).
    function updateHealthChip(health) {
        if (!els.healthChip) return;
        const label = document.getElementById('health-label');
        const banner = healthBanner(health);
        els.healthChip.classList.remove('h-green', 'h-yellow');
        els.healthChip.classList.add(
            banner.state === 'green' ? 'h-green' : 'h-yellow');
        if (label) {
            if (!health) label.textContent = 'model health: unavailable';
            else {
                const n = Array.isArray(health.active_alerts)
                    ? health.active_alerts.length : 0;
                label.textContent = n === 0 ? 'model health: nominal'
                    : n === 1 ? '1 active alert' : n + ' active alerts';
            }
        }
    }

    function renderHealthLoading() {
        const inner = els.healthInner;
        if (!inner) return;
        clear(inner);
        inner.appendChild(buildDrawerHead('MODEL HEALTH · LIVE',
            'The watchdog watches itself.', closeHealth));
        inner.appendChild(el('div', 'empty mono', 'checking the watchdog…'));
    }

    function renderHealthDrawer(health, history, methodology, sources) {
        const inner = els.healthInner;
        if (!inner) return;
        clear(inner);

        const liveHealth = health !== null;
        inner.appendChild(buildDrawerHead(
            'MODEL HEALTH' + (liveHealth ? ' · LIVE' : ' · DEMO DATA'),
            'The watchdog watches itself.', closeHealth));

        // Status banner from /api/health.
        const banner = healthBanner(health);
        const bannerEl = el('div', 'health-banner');
        const light = el('span', 'health-light'
            + (banner.state === 'yellow' ? ' yellow' : ''));
        bannerEl.appendChild(light);
        const bannerBody = el('div');
        bannerBody.appendChild(el('div', 'hb-title', banner.title));
        bannerBody.appendChild(el('div', 'hb-sub', banner.sub));
        bannerEl.appendChild(bannerBody);
        inner.appendChild(bannerEl);

        // Sources online — REGISTRY-active flags, labeled honestly (G20).
        if (sources !== null) {
            const stat = sourcesStat(sources);
            inner.appendChild(el('div', 'sec-lbl mono',
                'SOURCES · REGISTRY-ACTIVE'));
            const kv = el('div', 'kv mono');
            const row = el('div', 'kv-row');
            row.appendChild(el('span', 'kv-k', 'sources registry-active'));
            row.appendChild(el('span', 'kv-v',
                stat.active + ' / ' + stat.total
                + ' (configured active, not liveness)'));
            kv.appendChild(row);
            inner.appendChild(kv);
        }

        // ALERT HISTORY · LAST 12H from /api/bias/history.
        inner.appendChild(el('div', 'sec-lbl mono', 'ALERT HISTORY · LAST 12H'));
        const rows = history !== null
            ? mapBiasHistory(history)
            : DEMO_BIAS_ALERTS;
        const feed = el('div', 'alert-feed');
        if (rows.length === 0) {
            feed.appendChild(el('div', 'empty mono',
                'no assessments in the last 12 hours'));
        }
        for (const a of rows) {
            const row = el('div', 'alert-row sev-' + a.severity);
            row.appendChild(el('span', 'alert-sev mono',
                String(a.severity).toUpperCase()));
            const main = el('div', 'alert-main');
            const layerLine = el('div', 'alert-layer', a.layer + ' ');
            layerLine.appendChild(el('span', 'alert-time mono', a.time));
            main.appendChild(layerLine);
            main.appendChild(el('div', 'alert-detail', a.detail));
            if (a.citation) {
                main.appendChild(el('div', 'alert-cite mono', a.citation));
            }
            row.appendChild(main);
            feed.appendChild(row);
        }
        if (history === null) {
            feed.appendChild(el('div', 'empty mono',
                'live history unavailable — fictional demo alerts shown'));
        }
        inner.appendChild(feed);

        // VERSIONED METHODOLOGY table, framed as the endpoint it comes from.
        inner.appendChild(el('div', 'sec-lbl mono',
            'VERSIONED METHODOLOGY · GET /api/methodology'));
        const table = methodology !== null
            ? methodologyModel(methodology)
            : DEMO_METHODOLOGY;
        const kv = el('div', 'kv mono');
        for (const m of table) {
            const row = el('div', 'kv-row');
            row.appendChild(el('span', 'kv-k', m.key));
            row.appendChild(el('span', 'kv-v', m.desc));
            kv.appendChild(row);
        }
        inner.appendChild(kv);
        if (methodology === null) {
            inner.appendChild(el('div', 'empty mono',
                'live methodology unavailable — demo table shown'));
        }

        inner.appendChild(el('div', 'drawer-foot mono',
            'thresholds are versioned config, adjustable without code change '
            + '(spec §9) · full history via GET /api/bias/history'));
    }

    // ── Explore mode lifecycle ──────────────────────────────────────────────

    function enterExplore() {
        state.exploring = true;
        renderExplorePanel();
        applyGlobeFilters();
        renderRibbon();
        loadTimeseries();
        // Drill-chip hand-off (one-shot; also covers a drill that fired
        // before this module was listening).
        const s = story();
        const pending = s && typeof s.consumePendingCity === 'function'
            ? s.consumePendingCity() : null;
        if (pending && findCity(pending)) {
            selectCity(pending);
        } else if (state.selectedId) {
            selectCity(state.selectedId);   // re-sync globe with a kept selection
        }
    }

    function exitExplore() {
        state.exploring = false;
        state.stripCat = null;
        state.hover = null;
        renderTooltip();
        if (state.selectedId) {
            state.selectedId = null;
            const s = story();
            if (s && typeof s.setExploreSelection === 'function') {
                s.setExploreSelection(null);
            }
            renderDetail(null);
        }
        // The story re-applies the full beat state (focus/zoom/dimTest) on
        // exit; only the explore-owned selection props need clearing.
        if (globe) globe.setState({ selectedId: null, hoveredId: null });
    }

    // ── Init ────────────────────────────────────────────────────────────────

    function onCitiesData(cities, isDemo) {
        state.cities = Array.isArray(cities) ? cities : [];
        state.isDemo = !!isDemo;
        if (state.selectedId && !findCity(state.selectedId)) {
            state.selectedId = null;
            renderDetail(null);
        }
        if (state.exploring) {
            renderExplorePanel();
            renderRibbon();
            if (state.selectedId) renderDetail(findCity(state.selectedId));
        }
    }

    function init() {
        if (state.initialized) return;
        if (typeof document === 'undefined') return;
        state.initialized = true;

        els = {
            expFilters: document.getElementById('exp-filters'),
            expDetail: document.getElementById('exp-detail'),
            tip: document.getElementById('tip'),
            strip: document.getElementById('strip'),
            auditDrawer: document.getElementById('audit-drawer'),
            auditInner: document.getElementById('audit-drawer-inner'),
            healthDrawer: document.getElementById('health-drawer'),
            healthInner: document.getElementById('health-drawer-inner'),
            healthChip: document.getElementById('health-chip'),
        };

        globe = globeMod.getInstance && globeMod.getInstance();
        if (globe) {
            // Bound once; the globe only fires these while interactive
            // (explore mode), matching the prototype's explore-only wiring.
            globe.setState({
                onHover: (id, x, y) => {
                    state.hover = id ? { id, x, y } : null;
                    globe.setState({ hoveredId: id || null });
                    renderTooltip();
                },
                onCityClick: (id) => {
                    selectCity(id === state.selectedId ? null : id);
                },
                onDrag: () => {
                    if (state.selectedId) selectCity(null);
                },
            });
        }

        document.addEventListener('pulse:exploring-changed', (e) => {
            const exploring = !!(e.detail && e.detail.exploring);
            if (exploring === state.exploring) return;
            if (exploring) enterExplore();
            else exitExplore();
        });
        document.addEventListener('pulse:drill', (e) => {
            const cityId = e.detail && e.detail.cityId;
            if (cityId && state.exploring && findCity(cityId)) {
                const s = story();
                if (s && typeof s.consumePendingCity === 'function') {
                    s.consumePendingCity();   // consume so it is not replayed
                }
                selectCity(cityId);
            }
            // Not exploring yet: the pending id is picked up one-shot in
            // enterExplore via consumePendingCity().
        });
        document.addEventListener('pulse:trace', (e) => {
            if (e.detail && e.detail.post) openAudit(e.detail.post);
        });
        document.addEventListener('pulse:data', (e) => {
            if (e.detail) onCitiesData(e.detail.cities, e.detail.isDemo);
        });

        if (els.healthChip) {
            els.healthChip.setAttribute('aria-expanded', 'false');
            els.healthChip.addEventListener('click', () => {
                if (els.healthDrawer
                    && els.healthDrawer.classList.contains('open')) {
                    closeHealth();
                } else {
                    openHealth();
                }
            });
        }

        // Pull whatever the story has already loaded (covers a ui.init that
        // runs after the first pulse:data fired).
        const s = story();
        if (s && typeof s.getCities === 'function') {
            const st = typeof s.getState === 'function' ? s.getState() : {};
            onCitiesData(s.getCities(), st.isDemo);
            if (st.exploring) enterExplore();
        }
    }

    return {
        pure,
        init,
        openAudit,
        openHealth,
    };
}));
