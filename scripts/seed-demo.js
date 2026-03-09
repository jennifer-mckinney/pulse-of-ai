#!/usr/bin/env node
// scripts/seed-demo.js
// Seeds realistic demo posts + sentiment results so the globe shows markers
// before the live collectors (Phase E) are running.
//
// Inserts for each of the 20 known CITY_COORDS cities:
//   processing_job → raw_posts → decision_audit_log → sentiment_results
//
// Safe to re-run: external_ids are deterministic, INSERT ON CONFLICT DO NOTHING.

'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { dbRun, dbGet, dbAll, closePool } = require('../src/db/connection');

// Cities from CITY_COORDS in posts.js — must match exactly for geocoding to work
const CITIES = [
    { city: 'San Francisco', sentiment: 'positive' },
    { city: 'New York',      sentiment: 'positive' },
    { city: 'London',        sentiment: 'neutral'  },
    { city: 'Tokyo',         sentiment: 'positive' },
    { city: 'Berlin',        sentiment: 'neutral'  },
    { city: 'Paris',         sentiment: 'positive' },
    { city: 'Seoul',         sentiment: 'positive' },
    { city: 'Beijing',       sentiment: 'neutral'  },
    { city: 'Shanghai',      sentiment: 'neutral'  },
    { city: 'Bangalore',     sentiment: 'positive' },
    { city: 'Mumbai',        sentiment: 'positive' },
    { city: 'Sydney',        sentiment: 'positive' },
    { city: 'Toronto',       sentiment: 'positive' },
    { city: 'Vancouver',     sentiment: 'neutral'  },
    { city: 'Amsterdam',     sentiment: 'positive' },
    { city: 'Stockholm',     sentiment: 'positive' },
    { city: 'Singapore',     sentiment: 'positive' },
    { city: 'Tel Aviv',      sentiment: 'positive' },
    { city: 'Dublin',        sentiment: 'neutral'  },
    { city: 'Austin',        sentiment: 'positive' },
    { city: 'Seattle',       sentiment: 'positive' },
    { city: 'Boston',        sentiment: 'positive' },
    { city: 'Chicago',       sentiment: 'neutral'  },
    { city: 'Los Angeles',   sentiment: 'positive' },
    { city: 'São Paulo',     sentiment: 'neutral'  },
    { city: 'Buenos Aires',  sentiment: 'neutral'  },
    { city: 'Lagos',         sentiment: 'neutral'  },
    { city: 'Cairo',         sentiment: 'negative' },
    { city: 'Moscow',        sentiment: 'negative' },
    { city: 'Jakarta',       sentiment: 'neutral'  },
];

// Sample post content by sentiment bucket
const CONTENT = {
    positive: [
        'AI is transforming how we approach scientific discovery — the pace of progress is incredible.',
        'Just used an AI tool to debug a weeks-long issue in 20 minutes. The productivity gain is real.',
        'LLMs are opening up programming to people who never thought they could write code. Democratisation at work.',
        'The medical imaging results from this AI model are genuinely impressive. Early detection rates are up significantly.',
        'AI-assisted drug discovery just moved a compound from hypothesis to clinical trial candidate in 18 months. Remarkable.',
    ],
    neutral: [
        'AI regulation frameworks are evolving quickly. Organizations need clear policies before deploying these systems.',
        'The debate around AI and copyright continues. Courts in several jurisdictions are examining training data questions.',
        'AI adoption in enterprise is accelerating but governance frameworks lag behind. Risk management teams are scrambling.',
        'Open-source LLMs now approach closed-model performance on many benchmarks. The competitive landscape is shifting.',
        'AI literacy in the workforce is becoming a prerequisite. Training programmes are scaling up.',
    ],
    negative: [
        'Concerned about AI systems making consequential decisions without adequate human oversight or explainability.',
        'The energy footprint of large-scale AI training runs is a genuine environmental concern that needs addressing.',
        'AI-generated misinformation is outpacing detection and moderation capabilities on major platforms.',
        'Job displacement in content-related roles is accelerating. The transition support systems are nowhere near ready.',
        'Bias in AI hiring tools continues to surface. The audit trail for these decisions is often insufficient.',
    ],
};

// Posts per city (mix of sentiments for variety)
const POSTS_PER_CITY = 8;

async function main() {
    console.log('🌱  Seeding demo posts...');

    // Get any active source_id to attach posts to
    const source = await dbGet(`SELECT id FROM data_sources WHERE active = true LIMIT 1`);
    if (!source) {
        console.error('❌  No active data sources found. Run: npm run seed');
        process.exit(1);
    }

    // Get methodology version for sentiment
    const methodology = await dbGet(
        `SELECT id FROM methodology_versions WHERE component = 'sentiment' LIMIT 1`
    );
    if (!methodology) {
        console.error('❌  No methodology_versions found. Run: npm run seed');
        process.exit(1);
    }

    // Create one processing job for all demo posts
    const job = await dbGet(
        `INSERT INTO processing_jobs (triggered_by, status, posts_collected, posts_processed)
         VALUES ('seed-demo', 'completed', $1, $1)
         RETURNING id`,
        [CITIES.length * POSTS_PER_CITY]
    );

    let inserted = 0;

    for (const { city, sentiment: dominantSentiment } of CITIES) {
        for (let i = 0; i < POSTS_PER_CITY; i++) {
            // Distribute sentiment: 60% dominant, 25% neutral, 15% other
            let indicator;
            const r = Math.random();
            if (r < 0.60) {
                indicator = dominantSentiment;
            } else if (r < 0.85) {
                indicator = 'neutral';
            } else {
                indicator = dominantSentiment === 'negative' ? 'positive' : 'negative';
            }

            const contentList = CONTENT[indicator];
            const content = contentList[i % contentList.length] + ` [${city} #${i}]`;
            const externalId = `demo-${city.replace(/\s/g, '-').toLowerCase()}-${i}`;
            const contentHash = crypto.createHash('sha256').update(content).digest('hex');

            // Insert raw post (skip if already exists)
            const post = await dbGet(
                `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location, collected_at)
                 VALUES ($1, $2, $3, $4, $5, NOW() - ($6 * interval '1 minute'))
                 ON CONFLICT (source_id, external_id) DO NOTHING
                 RETURNING id`,
                [source.id, externalId, content, contentHash, city, i * 3]
            );

            if (!post) continue;  // already seeded

            // Score values by indicator
            const scoreMap    = { positive: 4,    neutral: 0,    negative: -4    };
            const compMap     = { positive: 0.28, neutral: 0.01, negative: -0.28 };
            const confMap     = { positive: 0.88, neutral: 0.75, negative: 0.84  };
            const score       = scoreMap[indicator];
            const comparative = compMap[indicator];
            const confidence  = confMap[indicator];

            // Audit log entry
            const inputHash = crypto.createHash('sha256').update(content).digest('hex');
            const audit = await dbGet(
                `INSERT INTO decision_audit_log
                   (raw_post_id, job_id, methodology_version_id, decision_type,
                    model_name, input_hash, output, confidence)
                 VALUES ($1, $2, $3, 'sentiment', 'afinn-sentiment-v5.0.2', $4,
                         $5::jsonb, $6)
                 RETURNING id`,
                [
                    post.id, job.id, methodology.id, inputHash,
                    JSON.stringify({ score, comparative, indicator }),
                    confidence,
                ]
            );

            // Sentiment result
            await dbRun(
                `INSERT INTO sentiment_results
                   (raw_post_id, audit_id, score, comparative, indicator, token_count)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT DO NOTHING`,
                [post.id, audit.id, score, comparative, indicator, content.split(' ').length]
            );

            inserted++;
        }
    }

    // Mark job complete
    await dbRun(
        `UPDATE processing_jobs SET completed_at = NOW(), posts_processed = $1 WHERE id = $2`,
        [inserted, job.id]
    );

    console.log(`✅  Demo seed complete: ${inserted} posts across ${CITIES.length} cities`);
    await closePool();
}

main().catch(err => { console.error(err); process.exit(1); });
