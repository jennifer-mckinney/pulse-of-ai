// src/routes/query.js
// POST /api/query
//
// Filtered, paginated query over scored posts.
// Designed for non-real-time research queries (journalists, researchers, policy makers).
//
// Request body:
//   { platform?: string, location?: string, from?: ISO8601, to?: ISO8601, limit?: number (max 100) }
//
// Returns:
//   200 { results: [...], total: number, query: { platform, location, from, to, limit } }
//     each result carries `attribution` (string|null): the credit the source's
//     terms require next to its content (NPR, NBCNews.com, Stack Exchange …),
//     and (K1, src/config/attribution.js) `credit` (object|null: the credit
//     every real excerpt carries), `source_url` (string|null: the validated
//     link back to the original), `published_at` and `data_origin`
//     ('live' | 'demo'; a demo post has no credit and no link)
//     total = the number of rows MATCHING the filters (COUNT(*) OVER() in
//     the query), not the page size — results.length can be smaller when
//     limit truncates. Callers page honestly against total.
//   400 on validation errors (limit > 100, invalid dates, non-string location)

'use strict';

const { logRouteError } = require('../middleware/log-error');

const { Router } = require('express');
const { dbAll }  = require('../db/connection');
const { CATEGORY_SLUGS, isCanonicalCategory } = require('../config/categories');
const { postAttribution } = require('../config/attribution');

const router = Router();

router.post('/query', async (req, res) => {
    try {
        const {
            platform = null,
            location = null,
            from     = null,
            to       = null,
            limit    = 20,
        } = req.body || {};

        // ─── Validation ───────────────────────────────────────────────────────

        // location is an exact-match filter on raw_posts.location (city-level).
        // Reject non-string values early; null/undefined means "no filter".
        if (location !== null && location !== undefined && typeof location !== 'string') {
            return res.status(400).json({ error: 'location must be a string' });
        }
        // Empty / whitespace-only strings are caller errors: '' is falsy, so
        // it would silently skip the filter below and return ALL posts
        // instead of the (impossible) exact match the caller asked for.
        if (typeof location === 'string' && location.trim() === '') {
            return res.status(400).json({ error: 'location must be a non-empty string' });
        }

        // platform filters on data_sources.category — validate against the
        // canonical taxonomy (src/config/categories): a non-canon value is a
        // caller error, not an empty result set. null/undefined = no filter.
        if (platform !== null && platform !== undefined
            && !isCanonicalCategory(platform)) {
            return res.status(400).json({
                error: 'platform must be a canonical source category: '
                    + CATEGORY_SLUGS.join(', '),
            });
        }

        // F4: strict integer check BEFORE the range checks — the same pattern
        // as bias.js/sources.js hours validation. parseInt silently accepted
        // 1.5 (as 1) and '20abc' (as 20); a non-integer limit is a caller
        // error, not something to round.
        if (!Number.isInteger(limit)) {
            return res.status(400).json({ error: 'limit must be a positive integer' });
        }
        if (limit < 1) {
            return res.status(400).json({ error: 'limit must be a positive integer' });
        }
        if (limit > 100) {
            return res.status(400).json({ error: 'limit must be <= 100' });
        }
        const parsedLimit = limit;

        let fromDate = null;
        if (from !== null && from !== undefined) {
            fromDate = new Date(from);
            if (isNaN(fromDate.getTime())) {
                return res.status(400).json({ error: 'Invalid from date' });
            }
        }

        let toDate = null;
        if (to !== null && to !== undefined) {
            toDate = new Date(to);
            if (isNaN(toDate.getTime())) {
                return res.status(400).json({ error: 'Invalid to date' });
            }
        }

        // ─── Build parameterised query ────────────────────────────────────────

        const conditions = [];
        const params     = [];

        if (platform) {
            params.push(platform);
            conditions.push(`ds.category = $${params.length}`);
        }

        // Exact match by design: raw_posts.location stores normalized city names,
        // so pattern matching would only invite false positives.
        if (location) {
            params.push(location);
            conditions.push(`rp.location = $${params.length}`);
        }

        if (fromDate) {
            params.push(fromDate.toISOString());
            conditions.push(`rp.collected_at >= $${params.length}`);
        }

        if (toDate) {
            params.push(toDate.toISOString());
            conditions.push(`rp.collected_at <= $${params.length}`);
        }

        const whereClause = conditions.length > 0
            ? `WHERE ${conditions.join(' AND ')}`
            : '';

        params.push(parsedLimit);
        const limitClause = `LIMIT $${params.length}`;

        // comparative is CLAMPED to [-1, 1] at the API boundary: the raw
        // sentiment-lib value is score/token_count and is unbounded for very
        // short posts, but every frontend consumer renders it on a −1…+1 scale.
        // relevance comes from relevance_results via LEFT JOIN (one row per
        // post — saveRelevance is idempotent) and is null for posts that were
        // never relevance-scored. positive_words / negative_words are the
        // stored sentiment cue words (city drill-down cue phrases, gap G21).
        // full_count: COUNT(*) OVER() = total rows matching the filters,
        // window-computed on every returned row (stripped before serving) —
        // so `total` is the true match count, not the truncated page size.
        const rows = await dbAll(
            `SELECT
                COUNT(*) OVER()::int    AS full_count,
                rp.id,
                LEFT(rp.content, 120)   AS content_snippet,
                sr.indicator,
                sr.score,
                GREATEST(-1, LEAST(1, sr.comparative))::real AS comparative,
                sr.positive_words,
                sr.negative_words,
                rr.score                AS relevance,
                rp.location,
                ds.name                 AS source_name,
                ds.category             AS platform,
                rp.collected_at,
                rp.raw_payload->>'url'          AS stored_url,
                rp.raw_payload->>'published_at' AS stored_published_at,
                ds.source_type                  AS stored_source_type
             FROM sentiment_results sr
             JOIN raw_posts rp    ON rp.id = sr.raw_post_id
             JOIN data_sources ds ON ds.id = rp.source_id
             LEFT JOIN relevance_results rr ON rr.raw_post_id = rp.id
             ${whereClause}
             ORDER BY rp.collected_at DESC
             ${limitClause}`,
            params,
        );

        const total = rows.length > 0 ? rows[0].full_count : 0;
        // K1: attribution (the text a source's terms require, null when none),
        // credit, validated link back, date and data origin — one mechanism
        // for every route (src/config/attribution.js). The stored_* columns
        // are inputs only and are not served.
        const results = rows.map(({ full_count, stored_url, stored_published_at, stored_source_type, ...row }) => ({
            ...row,
            ...postAttribution({
                sourceName: row.source_name, sourceType: stored_source_type,
                url: stored_url, publishedAt: stored_published_at,
            }),
        }));

        return res.json({
            results,
            total,
            query: {
                platform: platform ?? null,
                location: location ?? null,
                from:     from     ?? null,
                to:       to       ?? null,
                limit:    parsedLimit,
            },
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        logRouteError('query', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
