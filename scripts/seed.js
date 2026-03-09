#!/usr/bin/env node
// scripts/seed.js
// Seeds the database with:
//   1. All 50 data_sources (7 categories) — config includes poll_interval_sec, URL/subreddit
//   2. Initial methodology_versions for sentiment v1.0.0, relevance v1.0.0, discourse v1.0.0-DQI
// Safe to re-run: uses INSERT ... ON CONFLICT DO NOTHING

'use strict';

require('dotenv').config();
const { dbRun, closePool } = require('../src/db/connection');

// ─── Data Sources ─────────────────────────────────────────────────────────────
// Each entry maps to one data_sources row.
// config.poll_interval_sec: how often the collector runs for this source.
// active: false = seeded but not yet enabled (P2 sources, pending API access decisions).

const DATA_SOURCES = [
    // ── Social (8) ──────────────────────────────────────────────────────────
    {
        name: 'reddit_artificial',
        display_name: 'Reddit r/artificial',
        source_type: 'reddit',
        category: 'social',
        config: { subreddit: 'artificial', poll_interval_sec: 120, limit: 100 },
        active: true,
    },
    {
        name: 'reddit_machinelearning',
        display_name: 'Reddit r/MachineLearning',
        source_type: 'reddit',
        category: 'social',
        config: { subreddit: 'MachineLearning', poll_interval_sec: 120, limit: 100 },
        active: true,
    },
    {
        name: 'reddit_aiethics',
        display_name: 'Reddit r/AIethics',
        source_type: 'reddit',
        category: 'social',
        config: { subreddit: 'AIethics', poll_interval_sec: 180, limit: 50 },
        active: true,
    },
    {
        name: 'mastodon_social',
        display_name: 'Mastodon (mastodon.social AI tags)',
        source_type: 'api',
        category: 'social',
        config: { base_url: 'https://mastodon.social', hashtags: ['ArtificialIntelligence', 'AI', 'MachineLearning'], poll_interval_sec: 120 },
        active: true,
    },
    {
        name: 'bluesky_ai',
        display_name: 'Bluesky (AI hashtags)',
        source_type: 'api',
        category: 'social',
        config: { hashtags: ['AI', 'artificialintelligence', 'MachineLearning'], poll_interval_sec: 120 },
        active: true,
    },
    {
        name: 'hackernews_ai',
        display_name: 'Hacker News (AI submissions)',
        source_type: 'api',
        category: 'social',
        config: { base_url: 'https://hn.algolia.com/api/v1', tags: ['story'], query: 'artificial intelligence', poll_interval_sec: 180 },
        active: true,
    },
    {
        name: 'twitter_x_ai',
        display_name: 'Twitter/X (AI discourse)',
        source_type: 'api',
        category: 'social',
        config: { query: '(artificial intelligence OR machine learning OR AI safety) -is:retweet lang:en', poll_interval_sec: 120 },
        active: false, // requires TWITTER_BEARER_TOKEN — enable when key available
    },
    {
        name: 'linkedin_ai',
        display_name: 'LinkedIn (AI public posts)',
        source_type: 'scrape',
        category: 'social',
        config: { hashtag: 'artificialintelligence', poll_interval_sec: 600 },
        active: false, // P2 — Playwright scraping, requires additional auth review
    },

    // ── News (10) ────────────────────────────────────────────────────────────
    {
        name: 'techcrunch_ai',
        display_name: 'TechCrunch (AI section)',
        source_type: 'rss',
        category: 'news',
        config: { feed_url: 'https://techcrunch.com/category/artificial-intelligence/feed/', poll_interval_sec: 300 },
        active: true,
    },
    {
        name: 'wired_ai',
        display_name: 'Wired (AI section)',
        source_type: 'rss',
        category: 'news',
        config: { feed_url: 'https://www.wired.com/feed/tag/ai/latest/rss', poll_interval_sec: 600 },
        active: true,
    },
    {
        name: 'mit_tech_review',
        display_name: 'MIT Technology Review',
        source_type: 'rss',
        category: 'news',
        config: { feed_url: 'https://www.technologyreview.com/feed/', poll_interval_sec: 600 },
        active: true,
    },
    {
        name: 'ars_technica_ai',
        display_name: 'Ars Technica (AI)',
        source_type: 'rss',
        category: 'news',
        config: { feed_url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', poll_interval_sec: 600 },
        active: true,
    },
    {
        name: 'the_verge_ai',
        display_name: 'The Verge (AI section)',
        source_type: 'rss',
        category: 'news',
        config: { feed_url: 'https://www.theverge.com/ai-artificial-intelligence/rss/index.xml', poll_interval_sec: 600 },
        active: true,
    },
    {
        name: 'venturebeat_ai',
        display_name: 'VentureBeat (AI section)',
        source_type: 'rss',
        category: 'news',
        config: { feed_url: 'https://venturebeat.com/ai/feed/', poll_interval_sec: 600 },
        active: true,
    },
    {
        name: 'ieee_spectrum',
        display_name: 'IEEE Spectrum',
        source_type: 'rss',
        category: 'news',
        config: { feed_url: 'https://spectrum.ieee.org/feeds/feed.rss', poll_interval_sec: 900 },
        active: true,
    },
    {
        name: 'nature_news_ai',
        display_name: 'Nature News (AI)',
        source_type: 'rss',
        category: 'news',
        config: { feed_url: 'https://www.nature.com/subjects/machine-learning.rss', poll_interval_sec: 900 },
        active: true,
    },
    {
        name: 'science_magazine',
        display_name: 'Science Magazine (AI)',
        source_type: 'rss',
        category: 'news',
        config: { feed_url: 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=science', poll_interval_sec: 900 },
        active: true,
    },
    {
        name: 'reuters_technology',
        display_name: 'Reuters Technology',
        source_type: 'rss',
        category: 'news',
        config: { feed_url: 'https://feeds.reuters.com/reuters/technologyNews', poll_interval_sec: 300 },
        active: true,
    },

    // ── Academic (6) ─────────────────────────────────────────────────────────
    {
        name: 'arxiv_cs_ai',
        display_name: 'arXiv cs.AI',
        source_type: 'api',
        category: 'academic',
        config: { base_url: 'https://export.arxiv.org/api/query', categories: ['cs.AI', 'cs.CL', 'cs.LG', 'cs.CV', 'cs.RO'], max_results: 50, poll_interval_sec: 120 },
        active: true,
    },
    {
        name: 'semantic_scholar',
        display_name: 'Semantic Scholar (AI papers)',
        source_type: 'api',
        category: 'academic',
        config: { base_url: 'https://api.semanticscholar.org/graph/v1', query: 'artificial intelligence', fields: 'title,abstract,year,authors', poll_interval_sec: 900 },
        active: true,
    },
    {
        name: 'acm_dl',
        display_name: 'ACM Digital Library (AI)',
        source_type: 'rss',
        category: 'academic',
        config: { feed_url: 'https://dl.acm.org/action/showFeed?ui-theme=light&type=etoc&feed=rss&jc=todatem', poll_interval_sec: 3600 },
        active: true,
    },
    {
        name: 'openreview_neurips',
        display_name: 'OpenReview (NeurIPS/ICML/ICLR)',
        source_type: 'api',
        category: 'academic',
        config: { base_url: 'https://api2.openreview.net', venues: ['NeurIPS', 'ICML', 'ICLR'], poll_interval_sec: 3600 },
        active: true,
    },
    {
        name: 'pubmed_ai',
        display_name: 'PubMed (AI in medicine)',
        source_type: 'api',
        category: 'academic',
        config: { base_url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils', query: 'artificial intelligence[MeSH]', retmax: 20, poll_interval_sec: 3600 },
        active: true,
    },
    {
        name: 'ssrn_ai',
        display_name: 'SSRN (AI policy preprints)',
        source_type: 'rss',
        category: 'academic',
        config: { feed_url: 'https://papers.ssrn.com/sol3/Jeljour_results.cfm?form_name=journalBrowse&journal_id=3526&Network=no&SortOrder=ab_approve_date&startRec=1&PageSize=40&ftype=2&forthcoming=0&link=rss', poll_interval_sec: 3600 },
        active: false, // SSRN RSS availability varies — verify before enabling
    },

    // ── Policy & Political (8) ───────────────────────────────────────────────
    {
        name: 'eff_ai',
        display_name: 'Electronic Frontier Foundation (AI)',
        source_type: 'rss',
        category: 'policy',
        config: { feed_url: 'https://www.eff.org/rss/updates.xml', poll_interval_sec: 1800 },
        active: true,
    },
    {
        name: 'ai_now_institute',
        display_name: 'AI Now Institute',
        source_type: 'rss',
        category: 'policy',
        config: { feed_url: 'https://ainowinstitute.org/feed', poll_interval_sec: 1800 },
        active: true,
    },
    {
        name: 'rand_ai',
        display_name: 'RAND Corporation (AI)',
        source_type: 'rss',
        category: 'policy',
        config: { feed_url: 'https://www.rand.org/topics/artificial-intelligence.xml', poll_interval_sec: 1800 },
        active: true,
    },
    {
        name: 'brookings_ai',
        display_name: 'Brookings Institution (AI)',
        source_type: 'rss',
        category: 'policy',
        config: { feed_url: 'https://www.brookings.edu/topic/artificial-intelligence/feed/', poll_interval_sec: 1800 },
        active: true,
    },
    {
        name: 'center_ai_safety',
        display_name: 'Center for AI Safety',
        source_type: 'rss',
        category: 'policy',
        config: { feed_url: 'https://www.safe.ai/feed', poll_interval_sec: 1800 },
        active: true,
    },
    {
        name: 'eu_ai_office',
        display_name: 'EU AI Office',
        source_type: 'rss',
        category: 'policy',
        config: { feed_url: 'https://digital-strategy.ec.europa.eu/en/rss.xml', poll_interval_sec: 3600 },
        active: true,
    },
    {
        name: 'nist_ai',
        display_name: 'US NIST AI Resources',
        source_type: 'rss',
        category: 'policy',
        config: { feed_url: 'https://www.nist.gov/topics/artificial-intelligence/rss.xml', poll_interval_sec: 3600 },
        active: true,
    },
    {
        name: 'georgetown_cset',
        display_name: 'Georgetown CSET',
        source_type: 'rss',
        category: 'policy',
        config: { feed_url: 'https://cset.georgetown.edu/feed/', poll_interval_sec: 3600 },
        active: true,
    },

    // ── Non-Profit & Think Tanks (7) ─────────────────────────────────────────
    {
        name: 'future_of_life',
        display_name: 'Future of Life Institute',
        source_type: 'rss',
        category: 'nonprofit',
        config: { feed_url: 'https://futureoflife.org/feed/', poll_interval_sec: 1800 },
        active: true,
    },
    {
        name: 'partnership_on_ai',
        display_name: 'Partnership on AI',
        source_type: 'rss',
        category: 'nonprofit',
        config: { feed_url: 'https://partnershiponai.org/feed/', poll_interval_sec: 1800 },
        active: true,
    },
    {
        name: 'mozilla_ai',
        display_name: 'Mozilla Foundation (AI)',
        source_type: 'rss',
        category: 'nonprofit',
        config: { feed_url: 'https://foundation.mozilla.org/en/blog/rss/', poll_interval_sec: 1800 },
        active: true,
    },
    {
        name: 'openmind_ai',
        display_name: 'OpenMind',
        source_type: 'rss',
        category: 'nonprofit',
        config: { feed_url: 'https://www.openmindplatform.org/feed/', poll_interval_sec: 1800 },
        active: false, // verify RSS availability
    },
    {
        name: 'algorithm_watch',
        display_name: 'Algorithm Watch',
        source_type: 'rss',
        category: 'nonprofit',
        config: { feed_url: 'https://algorithmwatch.org/en/feed/', poll_interval_sec: 1800 },
        active: true,
    },
    {
        name: 'access_now',
        display_name: 'Access Now',
        source_type: 'rss',
        category: 'nonprofit',
        config: { feed_url: 'https://www.accessnow.org/feed/', poll_interval_sec: 1800 },
        active: true,
    },
    {
        name: 'ai4people',
        display_name: 'AI4People',
        source_type: 'rss',
        category: 'nonprofit',
        config: { feed_url: 'https://www.ai4people.eu/feed/', poll_interval_sec: 3600 },
        active: true,
    },

    // ── Developer & Research Communities (6) ─────────────────────────────────
    {
        name: 'github_discussions_ai',
        display_name: 'GitHub Discussions (major AI repos)',
        source_type: 'api',
        category: 'developer',
        config: { repos: ['huggingface/transformers', 'ggerganov/llama.cpp', 'AUTOMATIC1111/stable-diffusion-webui'], poll_interval_sec: 600 },
        active: true,
    },
    {
        name: 'stackoverflow_ai',
        display_name: 'Stack Overflow (AI/ML tags)',
        source_type: 'api',
        category: 'developer',
        config: { base_url: 'https://api.stackexchange.com/2.3', tags: ['machine-learning', 'artificial-intelligence', 'deep-learning'], poll_interval_sec: 300 },
        active: true,
    },
    {
        name: 'huggingface_community',
        display_name: 'Hugging Face Community',
        source_type: 'api',
        category: 'developer',
        config: { base_url: 'https://huggingface.co/api', poll_interval_sec: 600 },
        active: true,
    },
    {
        name: 'papers_with_code',
        display_name: 'Papers With Code (trending)',
        source_type: 'scrape',
        category: 'developer',
        config: { base_url: 'https://paperswithcode.com', poll_interval_sec: 900 },
        active: false, // P2 — Playwright scraping
    },
    {
        name: 'kaggle_forums',
        display_name: 'Kaggle Forums (AI discussions)',
        source_type: 'scrape',
        category: 'developer',
        config: { base_url: 'https://www.kaggle.com/discussions', poll_interval_sec: 900 },
        active: false, // P2 — Playwright scraping
    },
    {
        name: 'fastai_forums',
        display_name: 'fast.ai Forums',
        source_type: 'api',
        category: 'developer',
        config: { base_url: 'https://forums.fast.ai', poll_interval_sec: 900 },
        active: true,
    },

    // ── Blogs & Newsletters (5) ───────────────────────────────────────────────
    {
        name: 'lesswrong',
        display_name: 'LessWrong (AI topics)',
        source_type: 'api',
        category: 'blog',
        config: { base_url: 'https://www.lesswrong.com/graphql', tags: ['AI', 'machine-learning', 'AI-safety'], poll_interval_sec: 600 },
        active: true,
    },
    {
        name: 'alignment_forum',
        display_name: 'AI Alignment Forum',
        source_type: 'api',
        category: 'blog',
        config: { base_url: 'https://www.alignmentforum.org/graphql', poll_interval_sec: 600 },
        active: true,
    },
    {
        name: 'substack_ai',
        display_name: 'Substack (AI newsletters)',
        source_type: 'rss',
        category: 'blog',
        config: { feeds: ['https://newsletter.therundown.ai/feed', 'https://www.exponentialview.co/feed', 'https://importai.substack.com/feed'], poll_interval_sec: 1800 },
        active: true,
    },
    {
        name: 'medium_ai',
        display_name: 'Medium (AI tag, top posts)',
        source_type: 'rss',
        category: 'blog',
        config: { feed_url: 'https://medium.com/feed/tag/artificial-intelligence', poll_interval_sec: 900 },
        active: true,
    },
    {
        name: 'stratechery',
        display_name: 'Stratechery (public AI analysis)',
        source_type: 'rss',
        category: 'blog',
        config: { feed_url: 'https://stratechery.com/feed/', poll_interval_sec: 1800 },
        active: true,
    },
];

// ─── Methodology Versions ─────────────────────────────────────────────────────
// Registered BEFORE any inference runs. Plain-English justification required.

const METHODOLOGY_VERSIONS = [
    {
        component: 'sentiment',
        version: '1.0.0',
        model_name: 'afinn-sentiment-npm-v5.0.2',
        config: {
            positive_threshold: 0.05,
            negative_threshold: -0.05,
            accuracy_target: 0.99,
            accuracy_note: 'Phase 1 baseline — validates audit pattern. RoBERTa v2.0.0 targets 99% on benchmark.',
        },
        justification: 'AFINN-165 English word list (Nielsen 2011). Comparative score = raw_score / token_count (normalizes for post length). Thresholds ±0.05 separate meaningful sentiment from noise, derived from distribution analysis of AI discourse corpus (pulse-of-ai-evidence-based-thresholds.pdf §3). Phase 1 establishes the audit trail pattern; Phase 2 upgrades to RoBERTa for the 99% accuracy target.',
    },
    {
        component: 'relevance',
        version: '1.0.0',
        model_name: 'keyword-relevance-v1.0',
        config: {
            keywords: ['artificial intelligence', 'machine learning', 'deep learning', 'neural network', 'chatgpt', 'gpt', 'llm', 'ai', 'automation', 'algorithm', 'robot', 'autonomous', 'computer vision', 'natural language processing', 'generative ai', 'openai', 'anthropic', 'foundation model'],
            score_per_match: 0.1,
            max_score: 1.0,
            ai_relevance_threshold: 0.99,
        },
        justification: 'Domain keyword taxonomy from AI academic literature and conference proceedings. Each matched keyword contributes 0.1 to relevance score, capped at 1.0. Threshold 0.99 ensures near-perfect AI-relevance filtering. Phase 2 upgrades to embedding-based hybrid scoring for improved recall on implicit AI discourse.',
    },
    {
        component: 'discourse',
        version: '1.0.0-DQI',
        model_name: 'deliberative-quality-index-v1.0',
        config: {
            dimensions: {
                participation:          { weight: 0.15 },
                justification_level:    { weight: 0.30 },
                justification_content:  { weight: 0.15 },
                counterargument_respect: { weight: 0.20 },
                constructiveness:       { weight: 0.10 },
                respect_for_groups:     { weight: 0.10 },
            },
            source_category_weights: {
                academic: 1.5, policy: 1.3, news: 1.2, developer: 1.1, nonprofit: 1.0, blog: 0.9, social: 0.8,
            },
            accuracy_target: 0.99,
            novelty_cosine_threshold: 0.4,
            echo_chamber_cosine_threshold: 0.15,
        },
        justification: 'Deliberative Quality Index (DQI) — Steenbergen et al. (2003), operationalizing Habermas deliberative democracy theory. Applied to AI discourse with four improvements: (1) semantic argument deduplication via embeddings (cosine > 0.4 = novel), (2) echo chamber detection via cross-platform spread, (3) source authority weighting by category credibility, (4) NLP claim-evidence linkage detection. See TECHNICAL_SPEC.md §18.',
    },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    let sourcesInserted = 0;
    let methodsInserted = 0;

    for (const s of DATA_SOURCES) {
        const result = await dbRun(
            `INSERT INTO data_sources (name, display_name, source_type, category, config, active)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (name) DO NOTHING
             RETURNING id`,
            [s.name, s.display_name, s.source_type, s.category, JSON.stringify(s.config), s.active]
        );
        if (result) sourcesInserted++;
    }

    for (const m of METHODOLOGY_VERSIONS) {
        const result = await dbRun(
            `INSERT INTO methodology_versions (component, version, model_name, config, justification)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (component, version) DO NOTHING
             RETURNING id`,
            [m.component, m.version, m.model_name, JSON.stringify(m.config), m.justification]
        );
        if (result) methodsInserted++;
    }

    console.log(`✓ Seed complete: ${sourcesInserted} data_sources, ${methodsInserted} methodology_versions inserted.`);
    await closePool();
}

main().catch(err => {
    console.error('✗ Seed failed:', err.message);
    process.exit(1);
});
