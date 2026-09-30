#!/usr/bin/env node
// scripts/test/seed-e2e.js
// The Playwright e2e fixture dataset ("dev seed"): 66 synthetic posts over 15
// launch cities with sentiment + relevance audit rows, four job-level bias
// assessments (one alert, one watch, two passes) and one unresolved alert
// (the yellow header chip). The e2e suite (tests/e2e/) asserts against
// exactly this shape, so it is committed and fully deterministic: no
// randomness, fixed external_ids, fixed texts, fixed offsets.
//
//   npm run migrate && npm run seed && npm run seed:e2e
//
// Targets the database named by POSTGRES_DB on POSTGRES_PORT. The e2e
// globalSetup runs it against the suite's isolated database
// (pulse_of_ai_e2e — tests/e2e/e2e-env.js); run bare, it loads the fixture
// into the dev database from .env. Idempotent: when the first fixture post
// already exists the whole seed is skipped, so the job, bias rows and alert
// are never duplicated. collected_at offsets are relative to NOW(); the
// Playwright globalSetup (scripts/test/freshen-seed.sh) re-shifts them into
// the trailing hour before every run.
//
// Scores are FIXTURE values, not pipeline output: `npm run replay` on these
// posts reports DIVERGENCE, which is the honest answer for synthetic rows.
// The bias parity row is written under the pipeline vocabulary
// (platform_sentiment_parity), as migration 008 left the original data.

'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { dbGet, dbAll, dbRun, closePool } = require('../../src/db/connection');

const CITIES = [
    'San Francisco', 'New York', 'London', 'Berlin', 'Tokyo', 'Beijing',
    'Singapore', 'Seoul', 'Bangalore', 'Toronto', 'Paris', 'Brussels',
    'Dubai', 'Melbourne', 'Lagos',
];

// [text, AFINN-style score, positive cue words, negative cue words]
const TEXTS = [
    ['Shipped an agent that files our compliance paperwork end-to-end. Two days of glue code. Wild.', 4, ['shipped', 'wild'], []],
    ['Regulators signal an enforcement wave as AI Act transparency deadlines pass without extensions.', -3, [], ['enforcement', 'deadlines']],
    ['Hospitals report triage-assist rollout cut waiting-room misroutes by a third in pilot wards.', 2, ['cut'], ['misroutes']],
    ['Replication study confirms sentiment classifiers drift measurably within 90 days without recalibration.', -1, ['confirms'], ['drift']],
    ['Latency on the new inference runtime is genuinely absurd (good absurd). Halved our serving bill.', 5, ['absurd', 'halved'], []],
    ['Is anyone else’s team quietly rolling back AI code review? Curious what changed for you.', -2, ['curious'], ['rolling back']],
    ['My mom used a translation model to talk to her doctor today. This stuff matters.', 3, ['matters'], []],
    ['Comment period opens on frontier-model reporting rules; industry groups call the timeline aggressive.', -2, ['opens'], ['aggressive']],
    ['Six months of running a local LLM stack: the costs, the surprises, and the two things I regret.', -1, ['surprises'], ['regret']],
    ['Hot take: local models finally crossed the "good enough" line for 80% of my daily tasks.', 3, ['good', 'finally'], []],
];

// [type, group_field, group_value, metric, value, threshold, violation, severity, minutes ago]
const BIAS = [
    ['source_concentration', 'source_category', 'news', 'share_of_total_posts', 0.412, 0.35, true, 'critical', 15],
    ['location_concentration', 'location', 'San Francisco', 'share_of_total_posts', 0.29, 0.25, true, 'warning', 105],
    ['platform_sentiment_parity', 'source_category', 'all', 'sentiment_parity_diff', 0.031, 0.10, false, null, 320],
    ['negative_dominance', 'location', 'all', 'negative_share', 0.21, 0.60, false, null, 540],
];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function main() {
    const already = await dbGet(`SELECT 1 FROM raw_posts WHERE external_id = 'dev-seed-0-0'`);
    if (already) {
        console.log('seed-e2e: fixture dataset already present — skipped.');
        return;
    }

    const sources = await dbAll(
        'SELECT id, name, category FROM data_sources WHERE active = TRUE ORDER BY name');
    if (sources.length === 0) throw new Error('no data_sources — run `npm run seed` first');
    const mv = {};
    for (const row of await dbAll(
        `SELECT id, component, model_name FROM methodology_versions
         WHERE deprecated_at IS NULL ORDER BY effective_from ASC`)) {
        mv[row.component] = row;   // latest effective_from wins
    }
    if (!mv.sentiment || !mv.relevance) throw new Error('methodology not registered — run `npm run seed` first');

    // One completed processing job owns every fixture post + bias row.
    const job = await dbGet(
        `INSERT INTO processing_jobs (triggered_by, status, posts_collected, posts_processed,
                                      sources_queried, started_at, completed_at)
         VALUES ('manual', 'completed', 90, 90, 50,
                 NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '5 minutes')
         RETURNING id`);

    let n = 0;
    for (let ci = 0; ci < CITIES.length; ci++) {
        const cityName = CITIES[ci];
        const postCount = 3 + (ci % 4);   // 3..6 posts per city
        for (let pi = 0; pi < postCount; pi++) {
            const src = sources[(ci * 7 + pi * 3) % sources.length];
            const [text, score, posWords, negWords] = TEXTS[(ci + pi * 2) % TEXTS.length];
            // Spread over the last 11 hours, the first post of each city recent.
            const minutesAgo = pi === 0 ? (5 + ci * 3) % 55 : (ci * 37 + pi * 91) % 660;
            const content = `${text} [${cityName}]`;

            const post = await dbGet(
                `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location, collected_at)
                 VALUES ($1, $2, $3, $4, $5, NOW() - ($6::int * INTERVAL '1 minute'))
                 ON CONFLICT (source_id, external_id) DO NOTHING
                 RETURNING id`,
                [src.id, `dev-seed-${ci}-${pi}`, content, sha256(content), cityName, minutesAgo]);
            if (!post) continue;
            n++;

            const tokenCount = content.split(/\s+/).length;
            const comparative = Math.max(-1, Math.min(1, score / Math.max(6, tokenCount / 3)));
            const indicator = comparative > 0.05 ? 'positive' : comparative < -0.05 ? 'negative' : 'neutral';

            const sentAudit = await dbGet(
                `INSERT INTO decision_audit_log (raw_post_id, job_id, methodology_version_id,
                                                 decision_type, model_name, input_hash, output, confidence)
                 VALUES ($1, $2, $3, 'sentiment', $4, $5, $6, 0.9)
                 RETURNING id`,
                [post.id, job.id, mv.sentiment.id, mv.sentiment.model_name, sha256(content),
                    JSON.stringify({ score, comparative, indicator, positiveWords: posWords, negativeWords: negWords, tokenCount })]);
            await dbRun(
                `INSERT INTO sentiment_results (raw_post_id, audit_id, score, comparative, indicator,
                                                positive_words, negative_words, token_count)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [post.id, sentAudit.id, score, comparative, indicator, posWords, negWords, tokenCount]);

            const relScore = 0.62 + ((ci + pi) % 5) * 0.07;
            const matched = ['AI', 'model'].concat(pi % 2 === 0 ? ['agents'] : ['regulation']);
            const relAudit = await dbGet(
                `INSERT INTO decision_audit_log (raw_post_id, job_id, methodology_version_id,
                                                 decision_type, model_name, input_hash, output, confidence)
                 VALUES ($1, $2, $3, 'relevance', $4, $5, $6, 0.85)
                 RETURNING id`,
                [post.id, job.id, mv.relevance.id, mv.relevance.model_name, sha256(content),
                    JSON.stringify({ score: relScore, matchedKeywords: matched, isRelevant: relScore >= 0.6 })]);
            await dbRun(
                `INSERT INTO relevance_results (raw_post_id, audit_id, score, matched_keywords, is_relevant)
                 VALUES ($1, $2, $3, $4, $5)`,
                [post.id, relAudit.id, relScore, matched, relScore >= 0.6]);
        }
    }

    for (const [type, gf, gv, metric, value, threshold, viol, sev, minAgo] of BIAS) {
        await dbRun(
            `INSERT INTO bias_assessments (job_id, assessment_type, group_field, group_value, metric_name,
                                           metric_value, threshold, is_violation, severity, evidence, created_at,
                                           methodology_version_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() - ($11::int * INTERVAL '1 minute'), $12)`,
            // Lineage recorded like the pipeline does (migration 010).
            [job.id, type, gf, gv, metric, value, threshold, viol, sev,
                JSON.stringify({ note: 'e2e fixture: synthetic assessment' }), minAgo,
                mv.bias ? mv.bias.id : null]);
    }

    // One unresolved alert → the yellow header chip / health banner.
    await dbRun(
        `INSERT INTO alert_events (alert_type, severity, source_table, source_id, details)
         VALUES ('bias_violation', 'warning', 'bias_assessments', $1, $2)`,
        [job.id, JSON.stringify({ note: 'e2e fixture: source concentration above threshold' })]);

    console.log(`seed-e2e: ${n} posts across ${CITIES.length} cities, `
        + `${BIAS.length} bias assessments, 1 unresolved alert (job ${job.id}).`);
}

main()
    .then(() => closePool())
    .catch(async (err) => {
        console.error(require('../../src/collectors/redact').scrub(`seed-e2e: FAILED — ${err.message}`));
        await closePool();
        process.exit(1);
    });
