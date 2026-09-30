#!/usr/bin/env node
// scripts/populate.js
// Data population for the one-command standup (scripts/standup.sh).
//
//   node scripts/populate.js --once [--size N] [--no-embed] [--wait-embeddings S] [--force]
//   node scripts/populate.js --loop            (compose service `populate`, profile "demo")
//
// ─── Collect first, demo only as the fallback (ADR 0001) ─────────────────────
// --once runs ONE real collection job over the source registry
// (src/collectors/runner.js: every collecting source, gated, rate-limited,
// scored through the real pipeline with audit rows) and then checks the
// trailing hour: when it holds LIVE posts (from real sources), no demo post
// is written and the page reads LIVE. Only when collection yields nothing in
// the trailing hour (offline, every source failing, collection switched off)
// does the demo path below run — labelled DEMO end to end.
// --loop (compose service `populate`) never collects itself — the worker's
// scheduler does — it only keeps the demo fallback alive: each cycle writes
// a demo batch ONLY while the trailing hour has no live posts, so the page
// turns LIVE on its own once real posts arrive (and demo posts age out).
//
// The demo path never inserts made-up scores. Each batch:
//   1. writes FICTIONAL posts (no people, no handles, no personal data; every
//      text starts with "[Demo]") through the ingest normaliser
//      (src/pipeline/ingest.normalisePost — PII strip + SHA-256 content hash);
//   2. scores them with the REAL pipeline — saveSentiment / saveRelevance /
//      saveDQI — so every score has a genuine decision_audit_log row and
//      `npm run replay -- --post <id>` re-runs it to PASS;
//   3. runs the REAL job-level bias checks (src/pipeline/bias.runBiasChecks);
//   4. queues one `embed` job per post on the BullMQ embed queue, so the
//      worker container calls the embeddings container and fills
//      post_embeddings (skipped, and said so, when embeddings is unavailable).
//
// Labelling — in the data, and from there on the page (the API derives
// data_mode from the source type, src/config/data-mode.js; the page then
// shows the DEMO kicker, "— Demo data" markers and the demo receipt text):
//   - posts belong to dedicated data_sources rows `demo_<category>`,
//     source_type 'demo', display name "Demo feed — <Category> (fictional)",
//     active = FALSE (never collected from, not counted as an active source).
//     The ribbon's top-site label shows that display name;
//   - content starts with "[Demo]" (city drill-down, receipt snippet);
//   - raw_payload carries { demo: true, fictional: true };
//   - processing_jobs.triggered_by = 'demo'.
//
// Freshness: the frontend shows the trailing hour. Demo posts are stamped with
// their REAL ingestion time (collected_at = NOW(); nothing is backdated or
// re-stamped). --loop keeps the hour populated by ingesting a new small batch
// every DEMO_FEED_INTERVAL_MS (default 150 s, the frontend's poll cadence).
// Stop the `populate` service and the demo posts age out of the window
// naturally; no stale demo row is ever refreshed to look current.
//
// Idempotent: --once skips when the trailing hour already holds at least
// --size demo posts (a re-run of standup does not pile on another batch)
// unless --force is given. Either way, when embeddings are enabled and the
// service is ready, --once BACKFILLS every trailing-hour demo post that has
// no embedding yet (e.g. from a first run while the model could not be
// downloaded) and waits up to --wait-embeddings seconds for them, so the
// standup's `smoke-check --expect-embeddings` does not race the demo feed.
// Exit code 0 on success, 1 on failure.

'use strict';

require('dotenv').config();

const crypto = require('crypto');
const db = require('../src/db/connection');
const { normalisePost } = require('../src/pipeline/ingest');
const { saveSentiment } = require('../src/pipeline/sentiment');
const { saveRelevance } = require('../src/pipeline/relevance');
const { saveDQI } = require('../src/pipeline/discourse');
const { runBiasChecks } = require('../src/pipeline/bias');
const { resolveCurrentMethodology } = require('../src/pipeline/methodology');
const { SOURCES, sourceStatus } = require('../src/config/source-registry');
const { CAT_LABELS, CATEGORY_SLUGS } = require('../src/config/categories');
const { launchCities } = require('../public/js/config/cities.config.js');

const DEMO_SOURCE_TYPE = 'demo';
const DEMO_PREFIX = '[Demo] ';
// Initial fill: 8 posts per launch city (30 cities). The story's share-based
// chapters (divide / negativity / positivity) only consider cities with at
// least 5 posts in the trailing hour (public/js/insights.js MIN_TOTAL), so a
// thinner first batch would leave those chapters empty until the feed caught up.
const DEFAULT_ONCE_SIZE = 240;
const LOOP_INTERVAL_MS = positiveInt(process.env.DEMO_FEED_INTERVAL_MS, 150000);
// One demo feed per canonical category the registry covers (G10-18: all 8,
// Forums included — the list comes from the registry, not from whatever
// rows happen to be in the database).
const DEMO_CATEGORIES = Object.freeze(CATEGORY_SLUGS.filter(c => SOURCES.some(s => s.category === c)));
// Two posts per demo feed: the category cursor below walks the feeds with a
// stride of 3, coprime to 8, so a 16-post batch gives every category exactly
// two posts. Balanced batches keep the job-level parity check (which
// compares per-category sentiment means) from being decided by a single
// post; its verdicts are still the real ones.
const LOOP_BATCH = positiveInt(process.env.DEMO_FEED_BATCH, 2 * DEMO_CATEGORIES.length);
const EMBEDDINGS_URL = process.env.EMBEDDINGS_SERVICE_URL || 'http://localhost:8000';

// ─── Fictional corpus ────────────────────────────────────────────────────────
// Invented posts about AI in general terms: no names, handles, employers or
// anything that could identify a person. Several texts carry terms from the
// relevance lexicon (src/pipeline/relevance.js KEYWORD_LIST) so the themes
// chapter has keywords to aggregate; sentiment/relevance/DQI values are
// whatever the real pipeline computes for them.
const CORPUS = [
    'Open-source large language model releases keep closing the gap with closed systems, which helps university researchers working on small budgets.',
    'Our team finally moved inference for the machine learning service onto commodity hardware. Costs dropped and latency improved.',
    'Concerned that generative AI tools are being deployed in hiring without any audit trail. Who checks the outcomes?',
    'A new benchmark suggests deep learning models still fail badly on rare languages, so progress across the field remains real but uneven for now.',
    'Regulators are asking for clearer AI safety evaluations before large deployments. Reasonable, if the rules stay practical.',
    'Computer vision screening in the pilot clinic flagged early cases the manual review missed. Encouraging results.',
    'Fine-tuning a small foundation model on our own documents beat the giant general model for our use case.',
    'The energy cost of training ever larger neural network systems is a serious problem that deserves more attention.',
    'An autonomous agent booked the wrong venue and nobody noticed for a week. Human review still matters.',
    'Embeddings based search replaced the old keyword index on the internal wiki, and staff now find the documents they need far more often than before.',
    'Misinformation generated with AI tools is spreading faster than moderation teams on the larger platforms can review and respond to it this year.',
    'Reinforcement learning from human feedback is useful, but the labeling work behind it is often underpaid.',
    'Transformer models for translation made the community meeting accessible to everyone in the room today.',
    'Debate continues over copyright and training data. Courts in several jurisdictions are examining the question.',
    'NLP tooling for local languages keeps improving thanks to volunteer data projects that collect and document speech and text from many regions.',
    'Skeptical of claims that LLM assistants double productivity: internal measurements on the team show modest gains on some tasks and none on others.',
    'Teachers report mixed experiences with generative AI in classrooms: helpful for drafts, harmful for learning when overused.',
    'A diffusion model helped the design team explore ideas quickly, though the final work still needed human craft.',
    'Machine learning forecasts improved the regional flood warnings this season. Practical and welcome.',
    'Job displacement fears are rising as automation reaches customer support roles, and transition programs in most regions are nowhere near ready yet.',
    'Artificial intelligence literacy courses at community colleges are filling up fast, a sign that people want to understand the tools they use at work.',
    'Bias in automated credit scoring keeps resurfacing. Independent audits should be mandatory, not optional.',
    'Smaller language models that run on an ordinary laptop now handle most everyday writing and summarising tasks without sending data to a server.',
    'Governance frameworks still lag behind enterprise adoption of AI, and risk teams in many sectors say they are struggling to keep up with new tools.',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function positiveInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function log(msg) {
    process.stdout.write(`populate: ${msg}\n`);
}

/** Parse CLI flags. @returns {object} */
// G10-9: the live collection of `--once` (standup) stops starting sources
// after this many seconds; in-flight requests are aborted.
const DEFAULT_COLLECT_DEADLINE_SEC = 240;

function parseArgs(argv) {
    const opts = { mode: 'once', size: null, embed: true, waitEmbeddings: 180, force: false, deadlineSec: DEFAULT_COLLECT_DEADLINE_SEC };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--once') opts.mode = 'once';
        else if (a === '--loop') opts.mode = 'loop';
        else if (a === '--no-embed') opts.embed = false;
        else if (a === '--force') opts.force = true;
        else if (a === '--size') opts.size = positiveInt(argv[++i], null);
        else if (a === '--wait-embeddings') opts.waitEmbeddings = Math.max(0, parseInt(argv[++i], 10) || 0);
        else if (a === '--collect-deadline') opts.deadlineSec = positiveInt(argv[++i], DEFAULT_COLLECT_DEADLINE_SEC);
        else if (a === '--help' || a === '-h') opts.help = true;
        else throw new Error(`unknown argument '${a}'`);
    }
    if (opts.size === null) opts.size = opts.mode === 'loop' ? LOOP_BATCH : DEFAULT_ONCE_SIZE;
    return opts;
}

/**
 * Whether real collection can run under this env: at least one registry
 * source is 'collecting' (gate open, not killed, contact URL set).
 * @returns {{ available: boolean, collecting: number, reason: string|null }}
 */
function liveCollectionStatus(env = process.env) {
    const collecting = SOURCES.filter(s => sourceStatus(s, env).status === 'collecting').length;
    if (collecting > 0) return { available: true, collecting, reason: null };
    // D1: a fresh clone has no contact URL — collection is off by design.
    if (!(env.COLLECTOR_CONTACT_URL || '').trim()) {
        return {
            available: false,
            collecting: 0,
            reason: 'live collection is OFF: COLLECTOR_CONTACT_URL is not set, so every source is disabled '
                + '(ADR 0001 D1: a clone collects nothing until its operator sets their own contact URL) — DEMO data only',
        };
    }
    const sample = sourceStatus(SOURCES.find(s => s.slug === 'npr'), env);
    return {
        available: false,
        collecting: 0,
        reason: sample.status === 'disabled' ? sample.reason : 'no registry source is collecting under this environment',
    };
}

/**
 * Methodology ids for the demo path: the versions the CODE implements
 * (src/pipeline/methodology.js), exactly as live collection records them.
 */
async function currentMethodology() {
    const mv = await resolveCurrentMethodology();
    return { sentiment: mv.sentimentMvId, relevance: mv.relevanceMvId, discourse: mv.discourseMvId, bias: mv.biasMvId, ingest: mv.ingestMvId };
}

/**
 * Ensure one inactive demo source per category that the real registry covers
 * (never invents a category the registry has no source for). Idempotent.
 * @returns {Promise<Array<{id, category}>>}
 */
async function ensureDemoSources() {
    const seeded = await db.dbGet(
        `SELECT COUNT(*)::int AS n FROM data_sources WHERE source_type <> $1`,
        [DEMO_SOURCE_TYPE],
    );
    if (seeded.n === 0) throw new Error('no data_sources registered — run `npm run seed` first');
    for (const category of DEMO_CATEGORIES) {
        const label = CAT_LABELS[category] || category;
        await db.dbRun(
            `INSERT INTO data_sources (name, display_name, source_type, category, config, active)
             VALUES ($1, $2, $3, $4, $5::jsonb, FALSE)
             ON CONFLICT (name) DO NOTHING`,
            [
                `demo_${category}`,
                `Demo feed — ${label} (fictional)`,
                DEMO_SOURCE_TYPE,
                category,
                JSON.stringify({
                    fictional: true,
                    note: 'Fictional demo posts fed through the real pipeline by scripts/populate.js. '
                        + 'Never collected from; not a real source.',
                }),
            ],
        );
    }
    return db.dbAll(
        `SELECT id, category FROM data_sources WHERE source_type = $1 AND category = ANY($2::text[]) ORDER BY category`,
        [DEMO_SOURCE_TYPE, [...DEMO_CATEGORIES]],
    );
}

/**
 * LIVE posts (real registry sources, not demo feeds) in the trailing hour
 * that the GLOBE can render (G10-8): the
 * same rule as GET /api/posts/aggregated-by-location — scored (a
 * sentiment_results row) and located (location non-empty; a publisher-city
 * location counts). A live post the globe cannot show must not stop the
 * demo fallback, or standup ends with an empty globe.
 */
async function livePostsInLastHour() {
    const row = await db.dbGet(
        `SELECT COUNT(DISTINCT rp.id)::int AS n
         FROM raw_posts rp
         JOIN data_sources ds      ON ds.id = rp.source_id
         JOIN sentiment_results sr ON sr.raw_post_id = rp.id
         WHERE ds.source_type <> $1
           AND rp.location IS NOT NULL AND rp.location <> ''
           AND rp.collected_at >= NOW() - INTERVAL '1 hour'`,
        [DEMO_SOURCE_TYPE],
    );
    return row.n;
}

/** Trailing-hour posts per category, split live / demo (the population summary). */
async function populationByCategory() {
    return db.dbAll(
        `SELECT ds.category,
                COUNT(*) FILTER (WHERE ds.source_type <> $1)::int AS live,
                COUNT(*) FILTER (WHERE ds.source_type = $1)::int  AS demo
         FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id
         WHERE rp.collected_at >= NOW() - INTERVAL '1 hour'
         GROUP BY ds.category ORDER BY ds.category`,
        [DEMO_SOURCE_TYPE],
    );
}

/** Demo posts already inside the frontend's trailing-hour window. */
async function demoPostsInLastHour() {
    const row = await db.dbGet(
        `SELECT COUNT(*)::int AS n
         FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id
         WHERE ds.source_type = $1 AND rp.collected_at >= NOW() - INTERVAL '1 hour'`,
        [DEMO_SOURCE_TYPE],
    );
    return row.n;
}

/**
 * Trailing-hour demo posts that have no post_embeddings row yet, oldest
 * first. Copilot 4129574047: the idempotent --once path must still embed
 * what an earlier offline run left unembedded.
 * @returns {Promise<string[]>} raw_posts ids
 */
async function unembeddedDemoPostsInLastHour() {
    const rows = await db.dbAll(
        `SELECT rp.id
         FROM raw_posts rp
         JOIN data_sources ds ON ds.id = rp.source_id
         LEFT JOIN post_embeddings pe ON pe.raw_post_id = rp.id
         WHERE ds.source_type = $1
           AND rp.collected_at >= NOW() - INTERVAL '1 hour'
           AND pe.raw_post_id IS NULL
         ORDER BY rp.collected_at, rp.id`,
        [DEMO_SOURCE_TYPE],
    );
    return rows.map(r => r.id);
}

/** GET <embeddings>/health → true only when the model is loaded. */
async function embeddingsReady() {
    try {
        const res = await fetch(`${EMBEDDINGS_URL}/health`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return false;
        const body = await res.json();
        return body.model_loaded === true;
    } catch {
        return false;
    }
}

// Queues are required lazily: importing src/queues opens Redis connections,
// which a --no-embed run does not need.
let queues = null;
function getQueues() {
    if (!queues) queues = require('../src/queues/index');
    return queues;
}

async function closeQueues() {
    if (!queues) return;
    const all = Object.values(queues).filter(q => q && typeof q.close === 'function');
    await Promise.allSettled(all.map(q => q.close()));
}

/** Enqueue one embed job per post — the worker container does the embedding. */
async function enqueueEmbeddings(postIds) {
    const { embedQueue } = getQueues();
    // PR #22 P1-5: one embed job per post (deterministic id).
    await embedQueue.addBulk(require('../src/queues/pending').embedJobs(postIds));
}

/** Poll post_embeddings until every post is embedded or the timeout passes. */
async function waitForEmbeddings(postIds, timeoutSec) {
    const deadline = Date.now() + timeoutSec * 1000;
    let done = 0;
    for (;;) {
        const row = await db.dbGet(
            'SELECT COUNT(*)::int AS n FROM post_embeddings WHERE raw_post_id = ANY($1::uuid[])',
            [postIds],
        );
        done = row.n;
        if (done >= postIds.length || Date.now() >= deadline) return done;
        await new Promise(r => setTimeout(r, 2000));
    }
}

// ─── One demo batch through the real pipeline ────────────────────────────────

/**
 * @param {{ size: number, embed: boolean, seed: number, enqueue?: Function }} opts
 *   `enqueue` (default enqueueEmbeddings) queues the embed jobs; injectable for tests.
 * @returns {Promise<{ jobId, postIds, violations, embedQueued }>}
 */
async function runDemoBatch({ size, embed, seed, enqueue = enqueueEmbeddings }) {
    const mv = await currentMethodology();
    const sources = await ensureDemoSources();
    const cities = launchCities();
    const stamp = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

    const job = await db.dbGet(
        `INSERT INTO processing_jobs (triggered_by, status, sources_queried, last_progress_at)
         VALUES ('demo', 'running', $1, NOW())
         RETURNING id`,
        [sources.length],
    );

    const postIds = [];
    try {
        for (let k = 0; k < size; k++) {
            // Deterministic spread: cities round-robin, categories and texts on
            // different strides so each city gets a varied mix over time.
            // `seed * size` advances the city cursor by a whole batch per
            // cycle, so consecutive loop cycles cover every launch city evenly.
            const city = cities[(seed * size + k) % cities.length];
            const source = sources[(seed * size + k * 3) % sources.length];
            const text = CORPUS[(seed * 7 + k * 5) % CORPUS.length];

            // Real ingest normaliser: PII strip + SHA-256 content hash.
            const normalised = normalisePost({
                id: `demo-${stamp}-${k}`,
                text: DEMO_PREFIX + text,
                demo: true,
                fictional: true,
            }, DEMO_SOURCE_TYPE);

            const post = await db.dbGet(
                `INSERT INTO raw_posts
                    (source_id, external_id, content, content_hash, raw_payload, location, ingest_mv_id)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
                 ON CONFLICT (source_id, external_id) DO NOTHING
                 RETURNING id`,
                [
                    source.id,
                    normalised.externalId,
                    normalised.content,
                    normalised.contentHash,
                    JSON.stringify(normalised.rawPayload),
                    city.name,
                    mv.ingest,   // G10-11: the ingest version this demo post was stored under
                ],
            );
            if (!post) continue;

            // Real scorers: each writes its decision_audit_log row + result row.
            await Promise.all([
                saveSentiment(post.id, job.id, mv.sentiment),
                saveRelevance(post.id, job.id, mv.relevance),
                saveDQI(post.id, job.id, mv.discourse),
            ]);
            postIds.push(post.id);
        }

        // Real job-level fairness checks (writes bias_assessments with lineage).
        const bias = await runBiasChecks(job.id, mv.bias);

        await db.dbRun(
            `UPDATE processing_jobs
             SET status = 'completed', posts_collected = $1, posts_processed = $1,
                 completed_at = NOW()
             WHERE id = $2 AND status = 'running'`,
            [postIds.length, job.id],
        );

        let embedQueued = 0;
        if (embed && postIds.length > 0) {
            await enqueue(postIds);
            embedQueued = postIds.length;
        }
        return { jobId: job.id, postIds, violations: bias.violationsFound, embedQueued };
    } catch (err) {
        await db.dbRun(
            `UPDATE processing_jobs SET status = 'failed', error_details = $1, completed_at = NOW()
             WHERE id = $2 AND status = 'running'`,
            [err.message, job.id],
        ).catch(() => {});
        throw err;
    }
}

// The side-effecting collaborators of runOnce / runLoop. Tests replace them
// (embeddings service, BullMQ, the loop interval) through the `deps` argument.
const DEFAULT_DEPS = Object.freeze({
    embeddingsReady: () => embeddingsReady(),
    enqueueEmbeddings: ids => enqueueEmbeddings(ids),
    waitForEmbeddings: (ids, secs) => waitForEmbeddings(ids, secs),
});

/**
 * One real collection job (the runner), with the embed queue only when
 * embeddings are available. Injectable for tests via opts.collect.
 */
async function collectLive(opts, embed) {
    if (opts.collect) return opts.collect({ embed });
    const { runCollection, defaultQueues } = require('../src/collectors/runner');
    const q = defaultQueues();
    // G10-9: every source's progress is logged (the old verbose-only path
    // was never switched on), and the collection has a deadline.
    return runCollection({
        triggeredBy: 'standup',
        queues: { enqueueEmbeds: embed ? q.enqueueEmbeds : async () => {}, enqueueIngestRetry: q.enqueueIngestRetry },
        log,
        deadlineMs: (opts.deadlineSec || DEFAULT_COLLECT_DEADLINE_SEC) * 1000,
    });
}

/** Demo batch with the standard progress line. */
async function demoPass(opts, seed, embed, why, deps = DEFAULT_DEPS) {
    log(`data source: DEMO — ${why}`);
    const r = await runDemoBatch({ size: opts.size, embed, seed, enqueue: deps.enqueueEmbeddings });
    log(`job ${r.jobId}: ${r.postIds.length} fictional posts scored by the real pipeline `
        + `(sentiment, relevance, discourse), bias checks run (${r.violations} violation(s)), `
        + `${r.embedQueued} embed job(s) queued`);
    return { ...r, embed, mode: 'demo' };
}

/**
 * --once: collect first; demo only when the trailing hour has no live posts.
 * @returns {Promise<{ mode: 'live'|'demo', embed: boolean, postIds: string[], ... }>}
 */
async function populateOnce(opts, seed, deps = DEFAULT_DEPS) {
    let embed = opts.embed;
    if (embed && !(await deps.embeddingsReady())) {
        log(`embeddings service not ready at ${EMBEDDINGS_URL} — scoring without embeddings this pass`);
        embed = false;
    }

    const live = liveCollectionStatus(opts.env || process.env);
    let collected = null;
    if (live.available) {
        log(`collecting: ${live.collecting} of ${SOURCES.length} registry sources are collecting — running one real collection job`);
        try {
            collected = await collectLive(opts, embed);
            log(`${collected.jobId ? `job ${collected.jobId}` : 'no job row (nothing new to score)'}: ${collected.sourcesQueried} sources queried, ${collected.postsCollected} items collected, `
                + `${collected.postsProcessed} new posts scored (sentiment, relevance, discourse), `
                + `bias ${collected.bias ? `${collected.bias.violationsFound} violation(s)` : 'not run'}, `
                + `${collected.embedQueued} embed job(s) queued`);
        } catch (err) {
            log(`collection failed: ${require('../src/collectors/redact').scrub(err.message)}`);
        }
    } else {
        log(`collection unavailable: ${live.reason}`);
    }

    const livePosts = await livePostsInLastHour();
    if (livePosts > 0 && !opts.force) {
        log(`data source: LIVE — ${livePosts} real posts in the trailing hour; no demo batch written`);
        return { mode: 'live', livePosts, collected, embed, postIds: [] };
    }
    const why = livePosts > 0 ? '--force: a fictional batch added beside the live posts'
        : live.available ? 'collection yielded no posts in the trailing hour — falling back to fictional demo posts'
            : `live collection unavailable (${live.reason})`;
    return { ...(await demoPass(opts, seed, embed, why, deps)), collected };
}

// ─── Entry points ────────────────────────────────────────────────────────────

async function runOnce(opts, deps = {}) {
    const d = { ...DEFAULT_DEPS, ...deps };
    let batch = null;
    let skip = false;
    if (!opts.force) {
        const existing = await demoPostsInLastHour();
        const livePosts = await livePostsInLastHour();
        if (existing >= opts.size && livePosts === 0 && !liveCollectionStatus(opts.env || process.env).available) {
            log(`trailing hour already holds ${existing} demo posts (>= ${opts.size}) and collection is unavailable — `
                + 'skipping the initial batch (use --force to add another)');
            skip = true;
        }
    }
    if (!skip) {
        const seed = Math.floor(Date.now() / LOOP_INTERVAL_MS);
        batch = await populateOnce(opts, seed, d);
    }

    // Copilot 4129574047 (#9): embeddings are decided per run, not per
    // batch. A skipped batch (idempotent re-run) still backfills the
    // trailing hour's demo posts that have no embedding.
    let embed;
    if (batch) {
        embed = batch.embed;
    } else if (!opts.embed) {
        embed = false;
    } else {
        embed = await d.embeddingsReady();
        if (!embed) log(`embeddings service not ready at ${EMBEDDINGS_URL} — no embedding backfill this run`);
    }
    if (embed) {
        const queued = new Set(batch && batch.mode === 'demo' ? batch.postIds : []);
        const backfill = (await unembeddedDemoPostsInLastHour()).filter(id => !queued.has(id));
        if (backfill.length > 0) {
            await d.enqueueEmbeddings(backfill);
            log(`backfill: ${backfill.length} trailing-hour demo post(s) had no embedding — embed job(s) queued`);
        }
        const all = [...queued, ...backfill];
        if (all.length > 0 && opts.waitEmbeddings > 0) {
            log(`waiting up to ${opts.waitEmbeddings}s for the worker to embed ${all.length} posts...`);
            const done = await d.waitForEmbeddings(all, opts.waitEmbeddings);
            log(`embeddings stored: ${done}/${all.length}`
                + (done < all.length ? ' (timed out — the worker keeps embedding the rest)' : ''));
        }
    }
    await printSummary();
    return 0;
}

/** Population summary: trailing-hour posts per category, LIVE / DEMO / MIXED. */
async function printSummary() {
    const rows = await populationByCategory();
    const live = rows.reduce((n, r) => n + r.live, 0);
    const demo = rows.reduce((n, r) => n + r.demo, 0);
    const mode = live + demo === 0 ? 'NONE' : demo === 0 ? 'LIVE' : live === 0 ? 'DEMO' : 'MIXED';
    log(`population (trailing hour): ${mode} — ${live} live post(s), ${demo} demo post(s)`);
    for (const r of rows) log(`  ${r.category.padEnd(10)} live ${String(r.live).padStart(4)}  demo ${String(r.demo).padStart(4)}`);
    return { mode, live, demo, rows };
}

/**
 * One cycle of the demo fallback: a fictional batch ONLY while the trailing
 * hour holds no live posts (the worker collects live data).
 */
async function loopCycle(opts, seed, deps = DEFAULT_DEPS) {
    const livePosts = await livePostsInLastHour();
    if (livePosts > 0) {
        log(`data source: LIVE — ${livePosts} real posts in the trailing hour; demo feed idle`);
        return { mode: 'live', livePosts, postIds: [] };
    }
    const embed = opts.embed && await deps.embeddingsReady();
    return demoPass(opts, seed, embed, 'no live posts in the trailing hour', deps);
}

/**
 * The demo fallback: one cycle every intervalMs until SIGTERM / SIGINT.
 *
 * Copilot 4129574059 (#9): a signal that arrives WHILE a cycle is running
 * must not be followed by a full interval sleep (compose would SIGKILL the
 * container before cleanup). The in-flight cycle is finished (its job row
 * is completed, never left 'running'), then `stopping` is re-checked before
 * sleeping, and a signal during the sleep cancels the timer at once.
 *
 * @param {object} opts   parsed flags
 * @param {object} [deps] test seams: populateOnce (the per-cycle step,
 *                        default loopCycle), intervalMs, plus the
 *                        DEFAULT_DEPS collaborators
 */
async function runLoop(opts, deps = {}) {
    const d = { ...DEFAULT_DEPS, populateOnce: loopCycle, intervalMs: LOOP_INTERVAL_MS, ...deps };
    let stopping = false;
    let timer = null;
    let wake = null;
    const stop = (signal) => {
        if (stopping) return;
        stopping = true;
        log(`${signal || 'stop'} received — finishing the current step, then exiting`);
        if (timer) clearTimeout(timer);
        timer = null;
        if (wake) wake();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);

    try {
        log(`demo fallback started: every ${Math.round(d.intervalMs / 1000)}s, ${opts.size} fictional posts `
            + 'ONLY while the trailing hour holds no live posts (the worker collects live data)');
        while (!stopping) {
            const seed = Math.floor(Date.now() / d.intervalMs);
            try {
                await d.populateOnce(opts, seed, d);
            } catch (err) {
                // One failed cycle must not kill the feed; the next cycle retries.
                log(`cycle failed: ${err.message}`);
            }
            if (stopping) break;              // signalled during the cycle: no sleep
            await new Promise((resolve) => {
                wake = resolve;
                timer = setTimeout(resolve, d.intervalMs);
            });
            wake = null;
            timer = null;
        }
    } finally {
        if (timer) clearTimeout(timer);
        process.removeListener('SIGTERM', stop);
        process.removeListener('SIGINT', stop);
    }
    log('demo feed stopped');
    return 0;
}

/**
 * Close what population opened: the BullMQ queues (Redis connections) if
 * they were loaded, then the PostgreSQL pool. Safe to call more than once.
 */
async function shutdown() {
    const hadQueues = queues !== null;
    await closeQueues();
    queues = null;
    await db.closePool().catch(() => {});
    log(`connections closed (${hadQueues ? 'queues, ' : ''}database pool)`);
}

async function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        process.stderr.write(`populate: ${err.message}\n`);
        return 2;
    }
    if (opts.help) {
        process.stdout.write('usage: node scripts/populate.js [--once|--loop] [--size N] '
            + '[--no-embed] [--wait-embeddings SECONDS] [--force]\n');
        return 0;
    }
    return opts.mode === 'loop' ? runLoop(opts) : runOnce(opts);
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    main(process.argv.slice(2))
        .catch((err) => {
            process.stderr.write(`populate: FAILED — ${err.message}\n`);
            return 1;
        })
        .then(async (code) => {
            await shutdown();
            process.exit(code);
        });
}

module.exports = {
    DEFAULT_COLLECT_DEADLINE_SEC,
    DEMO_CATEGORIES,
    LOOP_BATCH,
    parseArgs,
    liveCollectionStatus,
    currentMethodology,
    populateOnce,
    loopCycle,
    livePostsInLastHour,
    populationByCategory,
    printSummary,
    ensureDemoSources,
    runDemoBatch,
    unembeddedDemoPostsInLastHour,
    runOnce,
    runLoop,
    shutdown,
    // The real enqueue seam (loads the BullMQ registry); exported for the
    // shutdown test in tests/unit/populate.loop.test.js.
    enqueueEmbeddingsForTest: enqueueEmbeddings,
    main,
    CORPUS,
    DEMO_PREFIX,
    DEMO_SOURCE_TYPE,
};
