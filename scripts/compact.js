#!/usr/bin/env node
// scripts/compact.js
// Monthly compaction job: moves Tier 1 (post-level detail) to Tier 2 (monthly rollups).
// Run on the 1st of each month, or manually: node scripts/compact.js [YYYY-MM]
//
// What it does:
//   1. Identify all months older than RETENTION_DETAIL_DAYS that haven't been compacted
//   2. Aggregate raw_posts + sentiment_results + discourse_results into monthly_*_rollups
//   3. Null out raw_posts.content for those posts (privacy compliance)
//   4. Delete post_embeddings for those posts (large, re-computable)
//   5. Write data_retention_log: action='compacted' for each affected post
//   6. Write compaction_log row

'use strict';

require('dotenv').config();
const { dbAll, dbGet, dbRun, dbTransaction, closePool } = require('../src/db/connection');

const RETENTION_DAYS = parseInt(process.env.RETENTION_DETAIL_DAYS || '90', 10);

// Optional CLI argument: compact a specific month (YYYY-MM), else auto-detect
const targetMonth = process.argv[2] || null;

function getCutoffDate() {
    const d = new Date();
    d.setDate(d.getDate() - RETENTION_DAYS);
    return d;
}

function firstOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1).toISOString().split('T')[0];
}

async function getMonthsToCompact() {
    if (targetMonth) {
        // Validate format
        if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
            throw new Error(`Invalid month format: ${targetMonth}. Expected YYYY-MM.`);
        }
        return [targetMonth + '-01'];
    }

    // Find all months older than cutoff that have posts and haven't been compacted
    const cutoff = getCutoffDate();
    const rows = await dbAll(`
        SELECT DISTINCT TO_CHAR(DATE_TRUNC('month', collected_at), 'YYYY-MM-DD') AS rollup_month
        FROM raw_posts
        WHERE collected_at < $1
          AND content IS NOT NULL
          AND DATE_TRUNC('month', collected_at) NOT IN (
              SELECT compacted_month FROM compaction_log
          )
        ORDER BY rollup_month ASC
    `, [cutoff.toISOString()]);

    return rows.map(r => r.rollup_month);
}

async function compactMonth(client, rollupMonth) {
    console.log(`  Compacting ${rollupMonth}...`);
    const monthStart = rollupMonth;
    const monthEnd   = new Date(new Date(rollupMonth).setMonth(new Date(rollupMonth).getMonth() + 1))
                           .toISOString().split('T')[0];

    // Step 1: Aggregate topic rollups (keyword-based in Phase 1; BERTopic in Phase D)
    // Uses top keywords from matched_keywords array as topic proxy
    await client.query(`
        INSERT INTO monthly_topic_rollups
            (rollup_month, topic_label, source_category, location, language,
             post_count, positive_count, neutral_count, negative_count, avg_comparative)
        SELECT
            $1::DATE                         AS rollup_month,
            COALESCE(kw.keyword, 'general')  AS topic_label,
            ds.category                      AS source_category,
            NULLIF(rp.location, '')          AS location,
            rp.language                      AS language,
            COUNT(*)                         AS post_count,
            COUNT(*) FILTER (WHERE sr.indicator = 'positive') AS positive_count,
            COUNT(*) FILTER (WHERE sr.indicator = 'neutral')  AS neutral_count,
            COUNT(*) FILTER (WHERE sr.indicator = 'negative') AS negative_count,
            AVG(sr.comparative)              AS avg_comparative
        FROM raw_posts rp
        JOIN data_sources ds         ON ds.id = rp.source_id
        JOIN sentiment_results sr    ON sr.raw_post_id = rp.id
        -- Unnest first matched keyword as topic proxy (Phase 1; replaced by BERTopic in Phase D)
        LEFT JOIN LATERAL (
            SELECT rr.matched_keywords[1] AS keyword
            FROM relevance_results rr WHERE rr.raw_post_id = rp.id LIMIT 1
        ) kw ON TRUE
        WHERE rp.collected_at >= $2 AND rp.collected_at < $3
          AND rp.content IS NOT NULL
        GROUP BY rollup_month, topic_label, source_category, location, language
        -- Expression-based unique index; ON CONFLICT requires no target when index uses COALESCE
        ON CONFLICT DO NOTHING
    `, [monthStart, monthStart, monthEnd]);

    // Step 2: Aggregate source rollups
    await client.query(`
        INSERT INTO monthly_source_rollups
            (rollup_month, source_id, source_category, post_count,
             positive_count, neutral_count, negative_count, avg_comparative)
        SELECT
            $1::DATE          AS rollup_month,
            rp.source_id,
            ds.category       AS source_category,
            COUNT(*)          AS post_count,
            COUNT(*) FILTER (WHERE sr.indicator = 'positive') AS positive_count,
            COUNT(*) FILTER (WHERE sr.indicator = 'neutral')  AS neutral_count,
            COUNT(*) FILTER (WHERE sr.indicator = 'negative') AS negative_count,
            AVG(sr.comparative)                               AS avg_comparative
        FROM raw_posts rp
        JOIN data_sources ds       ON ds.id = rp.source_id
        JOIN sentiment_results sr  ON sr.raw_post_id = rp.id
        WHERE rp.collected_at >= $2 AND rp.collected_at < $3
          AND rp.content IS NOT NULL
        GROUP BY rollup_month, rp.source_id, source_category
        ON CONFLICT (rollup_month, source_id) DO NOTHING
    `, [monthStart, monthStart, monthEnd]);

    // Step 3: Count posts to compact (for log)
    const { count } = await client.query(`
        SELECT COUNT(*)::INTEGER AS count FROM raw_posts
        WHERE collected_at >= $1 AND collected_at < $2 AND content IS NOT NULL
    `, [monthStart, monthEnd]).then(r => r.rows[0]);

    // Step 4: Delete post_embeddings for these posts
    const embeddingResult = await client.query(`
        DELETE FROM post_embeddings
        WHERE raw_post_id IN (
            SELECT id FROM raw_posts
            WHERE collected_at >= $1 AND collected_at < $2
        )
    `, [monthStart, monthEnd]);
    const embeddingsDeleted = embeddingResult.rowCount;

    // Step 5: Null out raw_posts.content (privacy compliance — content no longer needed)
    const contentResult = await client.query(`
        UPDATE raw_posts SET content = NULL
        WHERE collected_at >= $1 AND collected_at < $2 AND content IS NOT NULL
    `, [monthStart, monthEnd]);
    const contentNulled = contentResult.rowCount;

    // Step 6: Write GDPR retention log for each affected post
    await client.query(`
        INSERT INTO data_retention_log (raw_post_id, action, reason, legal_basis)
        SELECT id, 'compacted',
               'Tier 1 detail window expired (' || $1 || ' days). Aggregated into monthly rollups.',
               'GDPR Article 5(1)(e) - Storage Limitation'
        FROM raw_posts
        WHERE collected_at >= $2 AND collected_at < $3
    `, [RETENTION_DAYS, monthStart, monthEnd]);

    // Step 7: Record compaction in compaction_log
    await client.query(`
        INSERT INTO compaction_log
            (compacted_month, posts_compacted, rollups_created, embeddings_deleted, content_nulled)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (compacted_month) DO NOTHING
    `, [monthStart, count, 1, embeddingsDeleted, contentNulled]);

    return { postsCompacted: count, embeddingsDeleted, contentNulled };
}

async function main() {
    const months = await getMonthsToCompact();

    if (months.length === 0) {
        console.log('✓ Nothing to compact — all months within detail window or already compacted.');
        await closePool();
        return;
    }

    console.log(`Compacting ${months.length} month(s): ${months.join(', ')}`);

    let total = { postsCompacted: 0, embeddingsDeleted: 0, contentNulled: 0 };

    for (const month of months) {
        const result = await dbTransaction(client => compactMonth(client, month));
        total.postsCompacted   += result.postsCompacted;
        total.embeddingsDeleted += result.embeddingsDeleted;
        total.contentNulled     += result.contentNulled;
    }

    console.log(`✓ Compaction complete:`);
    console.log(`  Months processed:   ${months.length}`);
    console.log(`  Posts compacted:    ${total.postsCompacted}`);
    console.log(`  Embeddings deleted: ${total.embeddingsDeleted}`);
    console.log(`  Content nulled:     ${total.contentNulled}`);

    await closePool();
}

main().catch(err => {
    console.error('✗ Compaction failed:', err.message);
    process.exit(1);
});
