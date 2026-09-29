// src/config/audit-narration.js
// Versioned read-time audience templates for GET /api/audit/:post_id.
//
// The audit endpoint must serve FOUR representations of every decision step
// (BRD/PRD differentiator — "4 audience views"):
//   public     — jargon-free sentence for general users
//   plain      — journalist explanation with the cue phrases and scores
//   config     — regulator key/value table (thresholds, versions, legal basis)
//   researcher — cue weights + a reproduce command
//
// Rendering happens at READ TIME from data that is ALREADY stored in
// decision_audit_log.output + methodology_versions.config. No per-post prose
// is generated or persisted; the templates below are deterministic string
// builders over stored facts. Because the wording itself is part of the
// auditable surface, this module is registered in methodology_versions
// (component 'audit_narration') via src/config/methodology-registry.js
// (seed.js + migrations 009 / 011) — changes to the wording
// MUST bump NARRATION_VERSION and add a new methodology row, never edit the
// registered version in place.

'use strict';

// Registered in methodology_versions — must equal the audit_narration row in
// src/config/methodology-registry.js (enforced by methodologyRegistry.test.js)
const NARRATION_COMPONENT = 'audit_narration';
// 1.1.0: the researcher view's reproduce command is now REAL — it names the
// shipped `npm run replay` script (scripts/replay.js) instead of the
// never-implemented `pulse replay` CLI of 1.0.0.
// 1.2.0: the ingestion step has a DEMO branch — posts from demo feeds
// (data_sources.source_type 'demo', written by scripts/populate.js) are
// described as fictional demo content generated for this installation, never
// as "came from a public source". Live-source wording is unchanged.
const NARRATION_VERSION   = '1.2.0';
const NARRATION_MODEL     = 'pulse-narration-templates-v1';

// Reproduce-command template surfaced in every researcher view. It runs
// scripts/replay.js, which re-scores EVERY stored decision of the post with
// the deterministic src/pipeline modules against the methodology version
// each decision references, and prints PASS / DIVERGENCE per stage.
const REPRODUCE_COMMAND = 'npm run replay -- --post {post_id}';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Clamp a numeric value into [-1, 1]; passes null/undefined through. */
function clamp1(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
    return Math.max(-1, Math.min(1, Number(value)));
}

/** Format a signed sentiment number as the UI does: +0.42 / −0.13. */
function fmtSigned(value) {
    const n = Number(value) || 0;
    return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2);
}

/** Build the researcher reproduce command for one post. */
function reproduceCommand(postId) {
    return REPRODUCE_COMMAND.replace('{post_id}', postId);
}

/** Quote a list of cue words for prose: “a”, “b”, “c”. */
function quoteList(words) {
    return (words || []).map(w => `“${w}”`).join(', ');
}

// ─── Per-decision-type audience renderers ─────────────────────────────────────
// Each receives the decision row exactly as the audit route selects it:
//   { decision_type, model_name, methodology_version, config, output, confidence }
// plus the post id, and returns { public, plain, config, researcher }.
// output and config are the stored JSONB values — nothing here invents data.

function renderSentiment(decision, postId) {
    const out  = decision.output || {};
    const mvC  = decision.config || {};
    const indicator = out.indicator || 'neutral';
    const comparative = clamp1(out.comparative);
    const posWords = out.positiveWords || [];
    const negWords = out.negativeWords || [];
    const cueWords = [...posWords, ...negWords];

    const publicText = `The tone of this post reads ${indicator}`
        + (cueWords.length
            ? ` mostly because of words like ${quoteList(cueWords.slice(0, 3))}.`
            : '.')
        + ' A computer scored it against a public word list — no human judged it.';

    const plainText = `Scored ${indicator} (comparative ${comparative === null ? 'n/a' : comparative.toFixed(2)},`
        + ` raw ${out.score ?? 'n/a'}) by ${decision.model_name}.`
        + (posWords.length ? ` Positive cues: ${quoteList(posWords)}.` : '')
        + (negWords.length ? ` Negative cues: ${quoteList(negWords)}.` : '')
        + (mvC.positive_threshold !== undefined
            ? ` Thresholds: above ${mvC.positive_threshold} reads positive, below ${mvC.negative_threshold} reads negative.`
            : '');

    // Regulator view: flat key/value merge of the versioned methodology config
    // with the observed (stored) outputs for THIS post.
    const configView = {
        model:                `${decision.model_name}@${decision.methodology_version}`,
        methodology_version:  decision.methodology_version,
        ...mvC,
        observed_comparative: out.comparative ?? null,
        observed_raw_score:   out.score ?? null,
        observed_indicator:   indicator,
        cue_words_positive:   posWords,
        cue_words_negative:   negWords,
    };

    // AFINN per-word valences are recomputable from the versioned lexicon;
    // the audit log stores which words fired, signed by their list.
    const cueSummary = [
        ...posWords.map(w => `+“${w}”`),
        ...negWords.map(w => `−“${w}”`),
    ].join(' · ');
    const researcherText = (cueSummary ? `Cue words (signed by lexicon list): ${cueSummary}. ` : 'No lexicon cues matched. ')
        + `Comparative = raw_score / token_count = ${comparative === null ? 'n/a' : fmtSigned(comparative)}. `
        + `Reproduce: ${reproduceCommand(postId)}`;

    return { public: publicText, plain: plainText, config: configView, researcher: researcherText };
}

function renderRelevance(decision, postId) {
    const out = decision.output || {};
    const mvC = decision.config || {};
    const matched = out.matchedKeywords || [];
    const score = out.score ?? null;
    const pct = score === null ? 'n/a' : `${Math.round(score * 100)}%`;

    const publicText = matched.length
        ? 'It counts toward the map because it’s clearly talking about AI.'
        : 'This post did not match the AI topic list, so it does not count toward AI-discourse totals.';

    const plainText = `Rated ${pct} relevant to AI discourse via keyword matching`
        + (matched.length ? ` — matched terms: ${quoteList(matched)}.` : '.');

    const configView = {
        model:               `${decision.model_name}@${decision.methodology_version}`,
        methodology_version: decision.methodology_version,
        ...mvC,
        observed_score:      score,
        matched_terms:       matched,
    };

    const researcherText = `Keyword-overlap score against the versioned term list `
        + `(${matched.length} matched). `
        + `Reproduce: ${reproduceCommand(postId)}`;

    return { public: publicText, plain: plainText, config: configView, researcher: researcherText };
}

function renderDiscourse(decision, postId) {
    const out = decision.output || {};
    const mvC = decision.config || {};
    const total = out.total ?? out.dqi_total ?? null;
    const dims = out.dimensions || {};
    const dimSummary = Object.entries(dims)
        .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
        .join(', ');

    const publicText = 'We also measured how constructive the conversation is — '
        + 'whether it gives reasons, engages other views, and stays respectful.';

    const plainText = `Deliberative quality scored ${total === null ? 'n/a' : Number(total).toFixed(2)} of 1.00`
        + (dimSummary ? ` across the dimensions: ${dimSummary}.` : '.');

    const configView = {
        model:               `${decision.model_name}@${decision.methodology_version}`,
        methodology_version: decision.methodology_version,
        ...mvC,
        observed_dqi_total:  total,
        observed_dimensions: dims,
    };

    const researcherText = `DQI dimension vector: ${dimSummary || 'none stored'}. `
        + `Reproduce: ${reproduceCommand(postId)}`;

    return { public: publicText, plain: plainText, config: configView, researcher: researcherText };
}

/** Fallback for decision types without a dedicated template (topic, demographic …). */
function renderGeneric(decision, postId) {
    const configView = {
        model:               `${decision.model_name}@${decision.methodology_version}`,
        methodology_version: decision.methodology_version,
        ...(decision.config || {}),
    };
    return {
        public:     'An automated step processed this post. Its exact model, version, and settings are recorded below.',
        plain:      decision.justification || 'Automated inference step; see the registered methodology for details.',
        config:     configView,
        researcher: `Stored output: ${JSON.stringify(decision.output || {})}. `
            + `Reproduce: ${reproduceCommand(postId)}`,
    };
}

const RENDERERS = {
    sentiment: renderSentiment,
    relevance: renderRelevance,
    discourse: renderDiscourse,
};

/**
 * Render the four audience representations for one decision row.
 * @param {object} decision  Row from the audit route query (see above)
 * @param {string} postId    UUID of the audited post
 * @returns {{ public: string, plain: string, config: object, researcher: string }}
 */
function renderAudiences(decision, postId) {
    const renderer = RENDERERS[decision.decision_type] || renderGeneric;
    return renderer(decision, postId);
}

/**
 * Derive the headline score for a decision step (what the UI shows in the pill).
 * sentiment → bounded comparative; relevance → 0..1 score; discourse → dqi total.
 * @returns {number|null}
 */
function deriveScore(decision) {
    const out = decision.output || {};
    switch (decision.decision_type) {
        case 'sentiment': return clamp1(out.comparative);
        case 'relevance': return out.score ?? null;
        case 'discourse': return out.total ?? out.dqi_total ?? null;
        default:          return typeof out.score === 'number' ? out.score : null;
    }
}

/**
 * Derive the step status. A decision_audit_log row only exists for inferences
 * that COMPLETED, so every stored step is 'pass' — failures never reach the log.
 * Kept as a function so a failure state can be derived later without changing
 * the route.
 * @returns {'pass'}
 */
function deriveStatus() {
    return 'pass';
}

/**
 * Render the synthetic Ingestion step from the versioned 'ingest' methodology
 * row. Ingestion is not an inference, so it has no decision_audit_log rows —
 * its facts (PII fields stripped, location granularity, legal basis) live in
 * the registered methodology config, which is exactly what regulators need.
 *
 * @param {object|null} ingestMv  methodology_versions row (component='ingest') or null
 * @returns {object|null}  step object, or null when no ingest methodology is registered
 */
function renderIngestStep(ingestMv, opts) {
    if (!ingestMv) return null;
    const cfg = ingestMv.config || {};
    const piiFields = cfg.pii_fields_removed || [];
    const granularity = cfg.location_granularity || 'city';
    // opts.demo: the post's source is a demo feed (source_type 'demo').
    const demo = Boolean(opts && opts.demo);

    const researcher = 'Raw content is SHA-256 hashed at ingest; the hash is the immutable join key '
        + 'across the decision audit log (exposed keyed via AUDIT_HASH_KEY).';
    const config = {
        model:                `${ingestMv.model_name}@${ingestMv.version}`,
        methodology_version:  ingestMv.version,
        ...cfg,
    };

    const audiences = demo
        ? {
            // 1.2.0 demo branch: fictional content, stated plainly. The
            // scoring steps that follow are still the real pipeline.
            public: 'This is a fictional demo post generated for this installation — no real '
                + 'person wrote it and it was not collected from any public source. It was scored '
                + 'by the same pipeline as real posts, so every step below is genuine.',
            plain: 'Demo content: written for this installation by its demo feed (scripts/populate.js), '
                + 'not collected from a source’s public API. It passed through the same ingest '
                + `normaliser (${piiFields.length} identifying field(s) checked: ${piiFields.join(', ')}) `
                + `and the location is a demo ${granularity}.`,
            config: { ...config, content_origin: 'demo_feed', fictional: true },
            researcher: `${researcher} Content origin: demo feed (data_sources.source_type = 'demo'); `
                + 'the text is fictional and was never collected.',
        }
        : {
            public: 'This post came from a public source. Before it was saved, anything that could '
                + `identify who wrote it was removed. Only the ${granularity} it came from is kept.`,
            plain: `Collected via the source’s public API. ${piiFields.length} identifying field(s)`
                + ` (${piiFields.join(', ')}) were stripped before anything was stored.`
                + ` Location was kept at ${granularity} level only.`,
            config,
            researcher,
        };

    return {
        stage:               'ingestion',
        model_name:          ingestMv.model_name,
        methodology_version: ingestMv.version,
        status:              'pass',
        audiences,
    };
}

module.exports = {
    NARRATION_COMPONENT,
    NARRATION_VERSION,
    NARRATION_MODEL,
    REPRODUCE_COMMAND,
    renderAudiences,
    deriveScore,
    deriveStatus,
    renderIngestStep,
};
