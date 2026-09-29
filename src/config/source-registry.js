// src/config/source-registry.js
// THE source registry of record, in code (ADR 0001).
//
// Exactly the 51 sources of the workbook
// (docs/requirements/Top_50_Global_Online_Sources.xlsx, Rev. 3 — Jennifer's
// ruling: "use the 51 sources exactly. no exceptions."). No additions, no
// substitutes, no silent drops: tests/unit/pure/sourceRegistry.test.js
// parses the workbook itself and asserts a 1:1 match on rank, name and
// category (Hacker News and Stack Overflow in Forums per Rev. 3).
//
// Consumers:
//   - scripts/seed.js upserts one data_sources row per entry (name = slug,
//     display_name = workbook name, source_type, category);
//   - src/collectors builds the collector(s) for each OPEN route;
//   - src/workers/collector.scheduler.js schedules every collecting source;
//   - GET /api/sources and the health drawer serve per-source gate status.
//
// Routes and endpoints come from docs/research/2026-09-29-source-access.md
// (every "verified" endpoint was fetched live on 2026-09-29). Each source is
// collected through its own AI or technology feed or endpoint; site-wide or
// technology feeds carry scope 'filter' (items must pass the local AI filter,
// src/collectors/ai-filter.js), AI-specific ones scope 'ai'.
//
// Entry shape:
//   rank, slug, name (verbatim workbook name), category (8-canon slug),
//   region        where the source is based / what it covers (ISO-3166 code
//                 or 'global')
//   homeCity      publisher city for EDITORIAL sources (their own articles):
//                 used as the post location when an item has no
//                 content-level location (location_basis 'publisher').
//                 null for platforms/repositories of third-party content —
//                 a user's or author's location is never inferred.
//   sourceType    data_sources.source_type: 'rss' | 'api' | 'bulk'
//                 (the collect.<type> queue that runs it)
//   auth          { kind, program, signup } — kind is one of AUTH_KINDS
//   closedStatus  gate status when no route is open (awaiting_key |
//                 awaiting_approval | awaiting_licence | blocked)
//   routes        [{ id, adapter, requires[], optional[], params, scope,
//                    replaces[], note }] — a route is OPEN when every env var
//                 in `requires` is set; an open route listed in another's
//                 `replaces` supersedes it (paid tier over the free feed)
//   recordEnv     env vars recorded (not required) — e.g. the permission
//                 reference once a publisher grants it
//   termsUrl / termsNote   the governing terms and why the gate is what it is
//   attribution   text that must be shown next to the source's content
//   license       content licence when the source publishes one
//   rateLimit     { minIntervalMs, note } — spacing between requests to the
//                 same host within a run
//   pollIntervalSec  minimum seconds between two runs of the source (the
//                 2–3 minute default, longer where a documented limit needs it)
//   blocked       for the 4 BLOCKED sources: why, the evidence, the remedy
//   ruling        set when Jennifer's 2026-09-29 ruling decides the gate

'use strict';

const AUTH_KINDS = Object.freeze(['none', 'key', 'approval', 'paid', 'permission', 'blocked']);

const GATE_STATUSES = Object.freeze([
    'collecting', 'awaiting_key', 'awaiting_approval', 'awaiting_licence', 'blocked', 'disabled',
]);

const SOURCE_TYPES = Object.freeze(['rss', 'api', 'bulk']);

// Default cadence: one run per source every 150 s (the 2–3 minute cycle).
const DEFAULT_POLL_SEC = 150;

// Ruling text reused by the permission-gated news feeds (ADR 0001 ruling 4).
const LEGAL_RISK_RULING = 'Enabled by Jennifer\'s 2026-09-29 ruling ("Build all, free feeds on now"): '
    + 'the public RSS is collected although the terms require permission for automated analysis; '
    + 'Jennifer explicitly accepted that legal risk (ADR 0001).';

const AI_QUERY = 'artificial intelligence';

const SOURCES = [
    // ── 1. Social (8) ─────────────────────────────────────────────────────────
    {
        rank: 1, slug: 'whatsapp', name: 'WhatsApp (Meta)', category: 'social', region: 'global', homeCity: null,
        sourceType: 'bulk',
        auth: { kind: 'approval', program: 'Meta Content Library (researcher access, reviewed by CASD)', signup: 'https://transparency.meta.com/researchtools/meta-content-library' },
        closedStatus: 'awaiting_approval',
        routes: [{
            id: 'mcl-export', adapter: 'meta-content-library',
            requires: ['META_CONTENT_LIBRARY_APPROVAL_REF', 'META_CONTENT_LIBRARY_EXPORT_DIR'],
            params: { product: 'whatsapp_channels' }, scope: 'filter',
            note: 'WhatsApp Channels updates exported from the approved Meta Content Library workspace',
        }],
        termsUrl: 'https://www.whatsapp.com/legal/terms-of-service',
        termsNote: 'Web collection needs Meta\'s express written permission (Automated Data Collection Terms); the only compliant route is the Meta Content Library researcher program.',
        rateLimit: { minIntervalMs: 0, note: 'local export files; no network' },
        pollIntervalSec: 3600,
    },
    {
        rank: 2, slug: 'instagram', name: 'Instagram (Meta)', category: 'social', region: 'global', homeCity: null,
        sourceType: 'bulk',
        auth: { kind: 'approval', program: 'Meta Content Library (researcher access, reviewed by CASD)', signup: 'https://transparency.meta.com/researchtools/meta-content-library' },
        closedStatus: 'awaiting_approval',
        routes: [{
            id: 'mcl-export', adapter: 'meta-content-library',
            requires: ['META_CONTENT_LIBRARY_APPROVAL_REF', 'META_CONTENT_LIBRARY_EXPORT_DIR'],
            params: { product: 'instagram' }, scope: 'filter',
            note: 'Instagram posts exported from the approved Meta Content Library workspace',
        }],
        termsUrl: 'https://help.instagram.com/581066165581870',
        termsNote: 'Instagram Terms forbid automated collection without express permission; researcher access through the Meta Content Library.',
        rateLimit: { minIntervalMs: 0, note: 'local export files; no network' },
        pollIntervalSec: 3600,
    },
    {
        rank: 3, slug: 'youtube', name: 'YouTube (Alphabet)', category: 'social', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'key', program: 'YouTube Data API v3 (free key)', signup: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com' },
        closedStatus: 'awaiting_key',
        routes: [{
            id: 'data-api', adapter: 'youtube', requires: ['YOUTUBE_API_KEY'],
            params: { query: AI_QUERY, maxResults: 25 }, scope: 'ai',
            note: 'search.list (type=video, order=date) then videos.list for full descriptions; the keyless Atom feed is NOT used (robots.txt + Terms)',
        }],
        termsUrl: 'https://developers.google.com/youtube/terms/developer-policies',
        termsNote: 'Stored API data must be refreshed or deleted within 30 days; derived-metrics clause to be confirmed in the API compliance audit.',
        rateLimit: { minIntervalMs: 1000, note: 'search.list quota 100 calls/day; 10,000 units/day for other endpoints' },
        pollIntervalSec: 900,
    },
    {
        rank: 4, slug: 'facebook', name: 'Facebook (Meta)', category: 'social', region: 'global', homeCity: null,
        sourceType: 'bulk',
        auth: { kind: 'approval', program: 'Meta Content Library (researcher access, reviewed by CASD)', signup: 'https://transparency.meta.com/researchtools/meta-content-library' },
        closedStatus: 'awaiting_approval',
        routes: [{
            id: 'mcl-export', adapter: 'meta-content-library',
            requires: ['META_CONTENT_LIBRARY_APPROVAL_REF', 'META_CONTENT_LIBRARY_EXPORT_DIR'],
            params: { product: 'facebook' }, scope: 'filter',
            note: 'Facebook Page / group / public-profile posts exported from the approved Meta Content Library workspace',
        }],
        termsUrl: 'https://www.facebook.com/terms.php',
        termsNote: 'Facebook Terms §3.2 bar automated collection without prior permission; researcher access through the Meta Content Library.',
        rateLimit: { minIntervalMs: 0, note: 'local export files; no network' },
        pollIntervalSec: 3600,
    },
    {
        rank: 5, slug: 'tiktok', name: 'TikTok (ByteDance)', category: 'social', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'approval', program: 'TikTok Research API (academic / not-for-profit)', signup: 'https://developers.tiktok.com/products/research-api/' },
        closedStatus: 'awaiting_approval',
        routes: [{
            id: 'research-api', adapter: 'tiktok-research',
            requires: ['TIKTOK_RESEARCH_CLIENT_KEY', 'TIKTOK_RESEARCH_CLIENT_SECRET'],
            params: { keywords: ['artificial intelligence', 'AI'], maxCount: 50 }, scope: 'ai',
            note: 'POST /v2/research/video/query/ with a client-credentials token',
        }],
        termsUrl: 'https://www.tiktok.com/legal/page/global/terms-of-service-research-api/en',
        termsNote: 'Refresh data at least every 30 days; outputs must not be linkable to a user; public-dashboard use to be confirmed in the application.',
        rateLimit: { minIntervalMs: 1000, note: '1,000 requests/day, up to 100,000 records/day' },
        pollIntervalSec: 900,
    },
    {
        rank: 6, slug: 'wechat', name: 'WeChat / Weixin (Tencent)', category: 'social', region: 'CN', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'blocked', program: 'Written authorization from Tencent (no published program)', signup: 'https://weixin.qq.com/agreement?lang=en_US' },
        closedStatus: 'blocked',
        routes: [{
            id: 'tencent-authorized-feed', adapter: 'blocked-wechat',
            requires: ['WECHAT_TENCENT_AUTHORIZATION_REF', 'WECHAT_AUTHORIZED_FEED_URL'],
            params: {}, scope: 'filter',
            note: 'Runs ONLY against a feed Tencent authorizes in writing; never mp.weixin.qq.com pages or Sogou search',
        }],
        termsUrl: 'https://weixin.qq.com/agreement?lang=en_US',
        termsNote: 'Weixin Service Agreement §8.2.1.6 / §8.2.1.8 bar automated operations not authorized by Tencent; robots.txt disallows article pages and Sogou WeChat search.',
        blocked: {
            reason: 'No compliant access: the terms bar unauthorized automated operations and there is no public read API or feed.',
            evidence: 'Weixin Service Agreement §8.2.1.6 and §8.2.1.8; mp.weixin.qq.com/robots.txt; weixin.sogou.com/robots.txt Disallow: /',
            remedy: 'Written authorization from Tencent naming Pulse of AI and the feed it may read.',
        },
        rateLimit: { minIntervalMs: 2000, note: 'per the authorization, when granted' },
        pollIntervalSec: 900,
    },
    {
        rank: 7, slug: 'telegram', name: 'Telegram', category: 'social', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'blocked', program: 'Explicit written permission from Telegram (API Terms §1.5)', signup: 'https://core.telegram.org/api/terms' },
        closedStatus: 'blocked',
        routes: [{
            id: 'bot-api-with-permission', adapter: 'blocked-telegram',
            requires: ['TELEGRAM_WRITTEN_PERMISSION_REF', 'TELEGRAM_BOT_TOKEN'],
            params: {}, scope: 'filter',
            note: 'Official Bot API getUpdates (channel_post) for channels that added the bot — only under Telegram\'s written permission',
        }],
        termsUrl: 'https://telegram.org/tos/content-licensing',
        termsNote: 'API Terms §1.5 and the Content Licensing and AI Scraping Terms prohibit aggregating platform data to deploy ML models.',
        blocked: {
            reason: 'No compliant access: the terms prohibit using or aggregating platform data to deploy AI or machine-learning models.',
            evidence: 'Telegram API Terms §1.5; Content Licensing and AI Scraping Terms',
            remedy: 'Explicit written permission from Telegram for this use.',
        },
        rateLimit: { minIntervalMs: 1000, note: 'Bot API limits' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 8, slug: 'x', name: 'X (formerly Twitter)', category: 'social', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'paid', program: 'X API v2 pay-per-use credits ($0.005 per post read)', signup: 'https://developer.x.com' },
        closedStatus: 'awaiting_licence',
        routes: [{
            id: 'recent-search', adapter: 'x-recent-search', requires: ['X_BEARER_TOKEN'],
            params: { query: '("artificial intelligence" OR AI) -is:retweet lang:en', maxResults: 20 }, scope: 'ai',
            note: 'GET /2/tweets/search/recent with since_id; 20 posts per run caps spend near 1,000 reads/day',
        }],
        termsUrl: 'https://docs.x.com/developer-terms/agreement',
        termsNote: 'Honour deletion requests within 24 hours; no redistribution; scraping outside the API is prohibited.',
        rateLimit: { minIntervalMs: 1000, note: 'pay-per-use; spend capped by maxResults and cadence' },
        pollIntervalSec: 1800,
    },

    // ── 2. News (11) ──────────────────────────────────────────────────────────
    {
        rank: 9, slug: 'bbc_news', name: 'BBC News', category: 'news', region: 'GB', homeCity: 'London',
        sourceType: 'rss',
        auth: { kind: 'permission', program: 'BBC permission (Terms of Use §15)', signup: 'https://www.bbc.co.uk/usingthebbc/terms-of-use' },
        closedStatus: 'awaiting_approval', ruling: LEGAL_RISK_RULING,
        routes: [{ id: 'technology-rss', adapter: 'rss', params: { urls: ['https://feeds.bbci.co.uk/news/technology/rss.xml'] }, scope: 'filter' }],
        recordEnv: ['BBC_LICENSE_REF'],
        termsUrl: 'https://www.bbc.co.uk/usingthebbc/terms-of-use',
        termsNote: '§8a: computer analysis needs permission; §15: RSS metadata and business use need permission.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 10, slug: 'nyt', name: 'The New York Times', category: 'news', region: 'US', homeCity: 'New York',
        sourceType: 'rss',
        auth: { kind: 'permission', program: 'NYT Licensing text-and-data-mining licence (paid tier: Article Search API)', signup: 'https://nytlicensing.com/data-solutions/' },
        closedStatus: 'awaiting_licence', ruling: LEGAL_RISK_RULING,
        routes: [
            { id: 'technology-rss', adapter: 'rss', params: { urls: ['https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml'] }, scope: 'filter' },
            {
                id: 'article-search', adapter: 'nyt-article-search', requires: ['NYT_API_KEY', 'NYT_LICENSE_REF'],
                params: { subject: 'Artificial Intelligence' }, scope: 'ai', replaces: ['technology-rss'],
                note: 'Paid tier: Article Search API under an NYT Licensing TDM licence (5 requests/min, 500/day)',
            },
        ],
        termsUrl: 'https://help.nytimes.com/hc/en-us/articles/115014893428-Terms-of-Service',
        termsNote: 'ToS §4.1 bans use with ML/AI systems and automated collection without consent.',
        rateLimit: { minIntervalMs: 12000, note: 'API: 5 requests/minute, 500/day' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 11, slug: 'cnn', name: 'CNN', category: 'news', region: 'US', homeCity: 'Atlanta',
        sourceType: 'api',
        auth: { kind: 'paid', program: 'CNN Wire Store / CNN International Syndication licence', signup: 'https://www.cnn.com/intlsyndication/' },
        closedStatus: 'awaiting_licence',
        routes: [{
            id: 'wire-store', adapter: 'licensed-feed', requires: ['CNN_LICENSE_REF', 'CNN_FEED_URL'], optional: ['CNN_API_KEY'],
            params: {}, scope: 'filter',
            note: 'Contract delivery feed (RSS/Atom or JSON); the public rss.cnn.com feeds are stale (2016–2017) and are not used',
        }],
        termsUrl: 'https://www.cnn.com/terms',
        termsNote: 'Downloads limited to personal use; copying or redistribution needs express permission.',
        rateLimit: { minIntervalMs: 1000, note: 'per the contract' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 12, slug: 'guardian', name: 'The Guardian', category: 'news', region: 'GB', homeCity: 'London',
        sourceType: 'rss',
        auth: { kind: 'permission', program: 'Guardian Open Platform commercial key (paid tier)', signup: 'https://bonobo.capi.gutools.co.uk/register/commercial' },
        closedStatus: 'awaiting_licence', ruling: LEGAL_RISK_RULING,
        routes: [
            { id: 'ai-tag-rss', adapter: 'rss', params: { urls: ['https://www.theguardian.com/technology/artificialintelligenceai/rss'] }, scope: 'ai' },
            {
                id: 'content-api', adapter: 'guardian-content-api', requires: ['GUARDIAN_API_KEY'],
                params: { tag: 'technology/artificialintelligenceai' }, scope: 'ai', replaces: ['ai-tag-rss'],
                note: 'Paid tier: Content API with a COMMERCIAL key ("sentiment analysis where content is not reproduced")',
            },
        ],
        termsUrl: 'https://www.theguardian.com/open-platform/terms-and-conditions',
        termsNote: 'Open Platform §6 bans analysis/mining and ML use on the free key; §5 requires deletion within 24 hours; site terms apply the same to RSS.',
        rateLimit: { minIntervalMs: 1000, note: 'free key 1 call/s, 500/day; commercial per contract' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 13, slug: 'al_jazeera', name: 'Al Jazeera', category: 'news', region: 'QA', homeCity: 'Doha',
        sourceType: 'rss',
        auth: { kind: 'permission', program: 'Al Jazeera Content Sales licence', signup: 'https://contentsales.aljazeera.net/' },
        closedStatus: 'awaiting_licence', ruling: LEGAL_RISK_RULING,
        routes: [{ id: 'all-news-rss', adapter: 'rss', params: { urls: ['https://www.aljazeera.com/xml/rss/all.xml'] }, scope: 'filter' }],
        recordEnv: ['ALJAZEERA_LICENSE_REF'],
        termsUrl: 'https://www.aljazeera.com/terms-and-conditions',
        termsNote: 'Terms §6 ban automated analysis "for the purpose of identifying trends, correlations or patterns".',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 14, slug: 'wsj', name: 'The Wall Street Journal', category: 'news', region: 'US', homeCity: 'New York',
        sourceType: 'rss',
        auth: { kind: 'permission', program: 'Dow Jones Factiva / feeds licence (paid tier)', signup: 'https://www.dowjones.com/' },
        closedStatus: 'awaiting_licence', ruling: LEGAL_RISK_RULING,
        routes: [
            { id: 'technology-rss', adapter: 'rss', params: { urls: ['https://feeds.content.dowjones.io/public/rss/RSSWSJD'] }, scope: 'filter' },
            {
                id: 'dow-jones-feed', adapter: 'licensed-feed', requires: ['DOWJONES_API_KEY', 'DOWJONES_FEED_URL'],
                params: {}, scope: 'filter', replaces: ['technology-rss'],
                note: 'Paid tier: the contract feed Dow Jones provisions (Factiva / feeds)',
            },
        ],
        termsUrl: 'https://www.dowjones.com/terms-of-use/',
        termsNote: '§9.1 no commercial use of content incl. RSS without consent; §9.3 no text/data mining; §9.4.2 no AI ingestion without permission.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET; the old feeds.a.dj.com host is stale and not used' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 15, slug: 'ap', name: 'Associated Press', category: 'news', region: 'US', homeCity: 'New York',
        sourceType: 'api',
        auth: { kind: 'paid', program: 'AP Media API (sales contract)', signup: 'https://developer.ap.org' },
        closedStatus: 'awaiting_licence',
        routes: [{
            id: 'media-api', adapter: 'ap-media', requires: ['AP_API_KEY'],
            params: { query: AI_QUERY, pageSize: 50 }, scope: 'filter',
            note: 'AP publishes no public RSS; apnews.com returns a Cloudflare challenge, which is never bypassed',
        }],
        termsUrl: 'https://developer.ap.org',
        termsNote: 'Licensed API is the only official route; the site terms sit behind a bot wall (unread).',
        rateLimit: { minIntervalMs: 1000, note: 'per the contract' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 16, slug: 'reuters', name: 'Reuters', category: 'news', region: 'GB', homeCity: 'London',
        sourceType: 'api',
        auth: { kind: 'paid', program: 'Reuters Connect / Reuters News API (enterprise contract)', signup: 'https://www.reutersagency.com' },
        closedStatus: 'awaiting_licence',
        routes: [{
            id: 'reuters-connect', adapter: 'reuters-connect',
            requires: ['REUTERS_CONNECT_CLIENT_ID', 'REUTERS_CONNECT_CLIENT_SECRET'],
            params: { query: AI_QUERY, limit: 50 }, scope: 'filter',
            note: 'OAuth client credentials + GraphQL search; feeds.reuters.com no longer resolves and is not used',
        }],
        termsUrl: 'https://www.reutersagency.com/en/terms-of-use/',
        termsNote: 'reuters.com is behind a DataDome challenge (never bypassed); the licensed API is the official route.',
        rateLimit: { minIntervalMs: 1000, note: 'per the contract' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 17, slug: 'nbc_news', name: 'NBC News', category: 'news', region: 'US', homeCity: 'New York',
        sourceType: 'rss',
        auth: { kind: 'permission', program: 'NBCUniversal permission (no published program)', signup: 'https://www.nbcnews.com/id/wbna5216556' },
        closedStatus: 'awaiting_approval', ruling: LEGAL_RISK_RULING,
        routes: [{ id: 'tech-rss', adapter: 'rss', params: { urls: ['https://feeds.nbcnews.com/nbcnews/public/tech'] }, scope: 'filter' }],
        recordEnv: ['NBC_LICENSE_REF'],
        attribution: 'NBCNews.com',
        termsUrl: 'https://www.nbcnews.com/id/wbna5216556',
        termsNote: 'RSS for personal, non-commercial use with "NBCNews.com" attribution; site terms ban tools that monitor, scrape or aggregate content.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 18, slug: 'washington_post', name: 'The Washington Post', category: 'news', region: 'US', homeCity: 'Washington, D.C.',
        sourceType: 'rss',
        auth: { kind: 'permission', program: 'WP Licensing & Syndication', signup: 'https://www.washingtonpost.com/licensing-syndication/' },
        closedStatus: 'awaiting_licence', ruling: LEGAL_RISK_RULING,
        routes: [{ id: 'technology-rss', adapter: 'rss', params: { urls: ['https://feeds.washingtonpost.com/rss/business/technology'] }, scope: 'filter' }],
        recordEnv: ['WAPO_LICENSE_REF'],
        termsUrl: 'https://www.washingtonpost.com/terms-of-service/',
        termsNote: 'Terms ban automated harvesting other than search indexing and use with ML/AI tools.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 19, slug: 'npr', name: 'NPR', category: 'news', region: 'US', homeCity: 'Washington, D.C.',
        sourceType: 'rss',
        auth: { kind: 'none', program: 'Public Technology feed; non-commercial personal site (ADR 0001 ruling 6)', signup: 'https://www.npr.org/about-npr/179876898/terms-of-use' },
        closedStatus: 'awaiting_approval',
        routes: [{ id: 'technology-rss', adapter: 'rss', params: { urls: ['https://feeds.npr.org/1019/rss.xml'] }, scope: 'filter' }],
        attribution: 'NPR',
        termsUrl: 'https://www.npr.org/about-npr/179876898/terms-of-use',
        termsNote: 'Feeds may be excerpted on a personal non-commercial site with "NPR" attribution adjacent; no ML training on the text.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },

    // ── 3. Academic (8) ───────────────────────────────────────────────────────
    {
        rank: 20, slug: 'springerlink', name: 'SpringerLink (Springer Nature)', category: 'academic', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'key', program: 'Springer Nature Meta API v2 (free key, non-commercial)', signup: 'https://dev.springernature.com' },
        closedStatus: 'awaiting_key',
        routes: [{
            id: 'meta-api', adapter: 'springer', requires: ['SPRINGER_API_KEY'],
            params: { query: 'keyword:"artificial intelligence" sort:date', pageSize: 25 }, scope: 'ai',
        }],
        termsUrl: 'https://dev.springernature.com/terms-conditions/',
        termsNote: 'TDM output may be shared "for noncommercial use only" — Pulse of AI is non-commercial (ADR 0001 ruling 6).',
        rateLimit: { minIntervalMs: 500, note: '150 requests/minute' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 21, slug: 'arxiv', name: 'arXiv', category: 'academic', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'none', program: 'arXiv API (no auth)', signup: 'https://info.arxiv.org/help/api/tou.html' },
        closedStatus: 'awaiting_key',
        routes: [{
            id: 'export-api', adapter: 'arxiv',
            params: { searchQuery: 'cat:cs.AI OR cat:cs.LG OR cat:cs.CL', maxResults: 50 }, scope: 'ai',
        }],
        license: 'CC0 (metadata)',
        termsUrl: 'https://info.arxiv.org/help/api/tou.html',
        termsNote: 'At most one request every three seconds on a single connection; metadata is CC0; PDFs are never served.',
        rateLimit: { minIntervalMs: 3000, note: '1 request / 3 s' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 22, slug: 'pubmed', name: 'PubMed / PMC (NCBI)', category: 'academic', region: 'US', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'none', program: 'NCBI E-utilities (optional free key)', signup: 'https://www.ncbi.nlm.nih.gov/account/settings/' },
        closedStatus: 'awaiting_key',
        routes: [{
            id: 'e-utilities', adapter: 'pubmed', optional: ['NCBI_API_KEY', 'NCBI_TOOL', 'NCBI_EMAIL'],
            params: { term: '"Artificial Intelligence"[MeSH]', relDays: 1, retMax: 40 }, scope: 'ai',
        }],
        termsUrl: 'https://support.nlm.nih.gov/kbArticle/?pn=KA-05317',
        termsNote: '3 requests/s without a key (10/s with one); register tool and email.',
        rateLimit: { minIntervalMs: 350, note: '3 requests/second without a key' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 23, slug: 'sciencedirect', name: 'ScienceDirect (Elsevier)', category: 'academic', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'approval', program: 'Elsevier API key + use-case approval', signup: 'https://dev.elsevier.com' },
        closedStatus: 'awaiting_approval',
        routes: [{
            id: 'search-api', adapter: 'elsevier', requires: ['ELSEVIER_API_KEY', 'ELSEVIER_APPROVAL_REF'],
            params: { query: AI_QUERY, show: 25 }, scope: 'ai',
            note: 'The key alone is self-service; the use-case approval reference is required too (ADR 0001)',
        }],
        termsUrl: 'https://dev.elsevier.com/policy.html',
        termsNote: 'Only listed use cases are permitted; a public dashboard needs Elsevier\'s approval.',
        rateLimit: { minIntervalMs: 500, note: '2 requests/s, 20,000/week' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 24, slug: 'google_scholar', name: 'Google Scholar', category: 'academic', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'key', program: 'Scholar email alerts read from a dedicated mailbox (IMAP credentials)', signup: 'https://scholar.google.com/intl/en/scholar/help.html' },
        closedStatus: 'awaiting_key',
        routes: [{
            id: 'alert-mailbox', adapter: 'scholar-imap',
            requires: ['SCHOLAR_ALERTS_IMAP_HOST', 'SCHOLAR_ALERTS_IMAP_USER', 'SCHOLAR_ALERTS_IMAP_PASSWORD'],
            optional: ['SCHOLAR_ALERTS_IMAP_PORT', 'SCHOLAR_ALERTS_MAILBOX'],
            params: {}, scope: 'ai',
            note: 'Reads alert emails only; never requests a Scholar page and never follows scholar_url links',
        }],
        termsUrl: 'https://policies.google.com/terms',
        termsNote: 'robots.txt disallows /scholar; the alert route never requests Scholar pages. Setting the mailbox credential is Jennifer\'s sign-off (research §3.24).',
        rateLimit: { minIntervalMs: 0, note: 'one IMAP session per run' },
        pollIntervalSec: 900,
    },
    {
        rank: 25, slug: 'researchgate', name: 'ResearchGate', category: 'academic', region: 'global', homeCity: null,
        sourceType: 'bulk',
        auth: { kind: 'blocked', program: 'Direct data-access grant from ResearchGate (no published program)', signup: 'https://www.researchgate.net/terms-of-service' },
        closedStatus: 'blocked',
        routes: [{
            id: 'granted-dataset', adapter: 'blocked-researchgate',
            requires: ['RESEARCHGATE_DATA_ACCESS_REF', 'RESEARCHGATE_DATASET_PATH'],
            params: {}, scope: 'filter',
            note: 'Loads ONLY a dataset ResearchGate delivers under a data-access grant; never the website',
        }],
        termsUrl: 'https://www.researchgate.net/terms-of-service',
        termsNote: 'Every page, the terms page included, returns 403 with a CAPTCHA to non-browser clients; the clause could not be read.',
        blocked: {
            reason: 'No compliant access: no API or feed, and the site is behind a CAPTCHA wall that is never bypassed.',
            evidence: 'CAPTCHA wall (403) on every page including the terms page; terms clause not verified',
            remedy: 'A data-access grant from ResearchGate.',
        },
        rateLimit: { minIntervalMs: 0, note: 'local dataset; no network' },
        pollIntervalSec: 3600,
    },
    {
        rank: 26, slug: 'ieee_xplore', name: 'IEEE Xplore', category: 'academic', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'paid', program: 'IEEE Xplore API key + IEEE alternative licensing', signup: 'https://developer.ieee.org' },
        closedStatus: 'awaiting_licence',
        routes: [{
            id: 'metadata-api', adapter: 'ieee', requires: ['IEEE_API_KEY', 'IEEE_LICENSE_REF'],
            params: { query: AI_QUERY, maxRecords: 25 }, scope: 'ai',
        }],
        termsUrl: 'https://developer.ieee.org/API_Terms_of_Use2',
        termsNote: 'Non-commercial licence; content per individual query, not bulk; no AI/ML training; limits set at registration.',
        rateLimit: { minIntervalMs: 1000, note: 'set at key registration' },
        pollIntervalSec: 900,
    },
    {
        rank: 27, slug: 'jstor', name: 'JSTOR (ITHAKA)', category: 'academic', region: 'global', homeCity: null,
        sourceType: 'bulk',
        auth: { kind: 'approval', program: 'JSTOR Text Analysis Support dataset request', signup: 'https://www.jstor.org/ta-support' },
        closedStatus: 'awaiting_approval',
        routes: [{
            id: 'tas-dataset', adapter: 'jstor-dataset', requires: ['JSTOR_DATASET_PATH'],
            params: {}, scope: 'filter',
            note: 'Loads the dataset JSTOR delivers (JSON lines); the website is never scraped',
        }],
        termsUrl: 'https://about.jstor.org/terms/',
        termsNote: 'Terms ban automatic downloading or export, including scraping; datasets come only through Text Analysis Support.',
        rateLimit: { minIntervalMs: 0, note: 'local dataset; no network' },
        pollIntervalSec: 3600,
    },

    // ── 4. Policy (7) ─────────────────────────────────────────────────────────
    {
        rank: 28, slug: 'govinfo', name: 'GovInfo (US GPO)', category: 'policy', region: 'US', homeCity: 'Washington, D.C.',
        sourceType: 'api',
        auth: { kind: 'key', program: 'api.data.gov key (search API); collection RSS is keyless', signup: 'https://api.data.gov/signup/' },
        closedStatus: 'awaiting_key',
        routes: [
            {
                id: 'collection-rss', adapter: 'rss', scope: 'filter',
                params: { urls: ['https://www.govinfo.gov/rss/bills.xml', 'https://www.govinfo.gov/rss/fr.xml', 'https://www.govinfo.gov/rss/crec.xml', 'https://www.govinfo.gov/rss/chrg.xml', 'https://www.govinfo.gov/rss/crpt.xml'] },
            },
            {
                id: 'search-api', adapter: 'govinfo-search', requires: ['GOVINFO_API_KEY'], scope: 'ai',
                params: { query: 'collection:(BILLS OR CREC OR FR OR CHRG OR CRPT) AND title:("artificial intelligence")', pageSize: 50 },
            },
        ],
        license: 'Public domain (US federal works)',
        termsUrl: 'https://api.data.gov/docs/developer-manual/',
        termsNote: '1,000 requests/hour per key; federal works are public domain.',
        rateLimit: { minIntervalMs: 500, note: '1,000 requests/hour' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 29, slug: 'congress_gov', name: 'Congress.gov (Library of Congress)', category: 'policy', region: 'US', homeCity: 'Washington, D.C.',
        sourceType: 'api',
        auth: { kind: 'key', program: 'Congress.gov API v3 (free key)', signup: 'https://api.congress.gov/sign-up/' },
        closedStatus: 'awaiting_key',
        routes: [{
            id: 'bill-api', adapter: 'congress', requires: ['CONGRESS_API_KEY'], params: { limit: 250 }, scope: 'filter',
            note: 'No keyword search exists (query= is ignored): recent bills are filtered for AI locally',
        }],
        license: 'Public domain',
        termsUrl: 'https://github.com/LibraryOfCongress/api.congress.gov',
        termsNote: '5,000 requests/hour; public domain.',
        rateLimit: { minIntervalMs: 800, note: '5,000 requests/hour' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 30, slug: 'cfr', name: 'Council on Foreign Relations', category: 'policy', region: 'US', homeCity: 'New York',
        sourceType: 'rss',
        auth: { kind: 'permission', program: 'CFR confirmation that /feed may be read (robots.txt ambiguity)', signup: 'https://www.cfr.org/robots.txt' },
        closedStatus: 'awaiting_approval',
        routes: [{
            id: 'site-feed', adapter: 'rss', requires: ['CFR_FEED_PERMISSION_REF'],
            params: { urls: ['https://www.cfr.org/feed'] }, scope: 'filter',
            note: 'robots.txt has "Disallow: /feed/"; read conservatively it also covers /feed, so the feed is held until CFR confirms',
        }],
        robots: { literalWhenEnv: 'CFR_FEED_PERMISSION_REF' },
        termsUrl: 'https://www.cfr.org/robots.txt',
        termsNote: 'No terms page found; robots.txt "Disallow: /feed/" is resolved conservatively (ADR 0001): the feed at /feed is not fetched until CFR confirms.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 31, slug: 'cato', name: 'Cato Institute', category: 'policy', region: 'US', homeCity: 'Washington, D.C.',
        sourceType: 'rss',
        auth: { kind: 'blocked', program: 'Cato allowlisting the named Pulse of AI collector User-Agent', signup: 'https://www.cato.org/' },
        closedStatus: 'blocked',
        routes: [{
            id: 'allowlisted-rss', adapter: 'blocked-cato', requires: ['CATO_ALLOWLIST_REF'],
            params: { urls: ['https://www.cato.org/rss/recent-opeds', 'https://www.cato.org/rss/topics/technology-privacy'] }, scope: 'filter',
            note: 'Runs ONLY after Cato allowlists the collector; any 403/bot challenge stops the run — never bypassed',
        }],
        termsUrl: 'https://www.cato.org/',
        termsNote: 'The whole site, including RSS, robots.txt and the terms page, returns an Incapsula 403; FeedBurner mirrors redirect into the wall.',
        blocked: {
            reason: 'No compliant access: the site (RSS and terms included) sits behind an Incapsula bot wall that is never bypassed.',
            evidence: 'Incapsula 403 on every URL tested, incl. /rss, /robots.txt and /terms-use; terms clause unread',
            remedy: 'Cato allowlisting the named Pulse of AI collector User-Agent.',
        },
        rateLimit: { minIntervalMs: 2000, note: 'once allowlisted' },
        pollIntervalSec: 900,
    },
    {
        rank: 32, slug: 'rand', name: 'RAND Corporation', category: 'policy', region: 'US', homeCity: 'Santa Monica',
        sourceType: 'rss',
        auth: { kind: 'none', program: 'Public publication feeds', signup: 'https://www.rand.org/' },
        closedStatus: 'awaiting_key',
        routes: [{
            id: 'publication-feeds', adapter: 'rss', scope: 'filter',
            params: { urls: ['https://www.rand.org/pubs/commentary.xml', 'https://www.rand.org/pubs/research_reports.xml', 'https://www.rand.org/pubs/perspectives.xml', 'https://www.rand.org/news/press.xml'] },
            note: 'The AI topic feed is empty (0 entries) and /pubs.xml is behind CloudFront 403 — neither is used',
        }],
        termsUrl: 'https://www.rand.org/about/terms.html',
        termsNote: 'Terms page returns 403 to automated fetches (unread); RAND\'s own public feeds are used.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 33, slug: 'urban_institute', name: 'Urban Institute', category: 'policy', region: 'US', homeCity: 'Washington, D.C.',
        sourceType: 'rss',
        auth: { kind: 'none', program: 'Public research feed', signup: 'https://www.urban.org/' },
        closedStatus: 'awaiting_key',
        routes: [{ id: 'research-rss', adapter: 'rss', params: { urls: ['https://www.urban.org/research/rss.xml'] }, scope: 'filter' }],
        termsUrl: 'https://www.urban.org/robots.txt',
        termsNote: 'No terms page found; robots.txt does not block the feed.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 34, slug: 'pew', name: 'Pew Research Center', category: 'policy', region: 'US', homeCity: 'Washington, D.C.',
        sourceType: 'api',
        auth: { kind: 'none', program: 'WordPress REST API (AI category 299)', signup: 'https://www.pewresearch.org/about/terms-and-conditions/' },
        closedStatus: 'awaiting_key',
        routes: [{ id: 'wp-rest-ai', adapter: 'pew', params: { category: 299, perPage: 50 }, scope: 'ai' }],
        attribution: 'Pew Research Center',
        termsUrl: 'https://www.pewresearch.org/about/terms-and-conditions/',
        termsNote: 'Content via "RSS feeds, APIs or other similar means" is licensed with attribution; no scraping or principal-part republishing.',
        rateLimit: { minIntervalMs: 1000, note: 'polite spacing' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },

    // ── 5. Non-profit (6) ─────────────────────────────────────────────────────
    {
        rank: 35, slug: 'wikipedia', name: 'Wikipedia / Wikimedia Foundation', category: 'nonprofit', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'none', program: 'MediaWiki Action API + DiscussionTools (User-Agent with contact required)', signup: 'https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy' },
        closedStatus: 'awaiting_key',
        routes: [{
            id: 'ai-talk-pages', adapter: 'wikipedia-talk',
            params: { category: 'Category:Artificial_intelligence', pagesPerRun: 6 }, scope: 'ai',
            note: 'Talk-page comments of the AI article set; recent talk-namespace changes pick which pages to read',
        }],
        license: 'CC BY-SA 4.0',
        attribution: 'Wikipedia (CC BY-SA 4.0)',
        termsUrl: 'https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits',
        termsNote: '200 requests/minute with a compliant User-Agent; at most 3 concurrent; honour Retry-After.',
        rateLimit: { minIntervalMs: 400, note: '200 requests/minute' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 36, slug: 'mozilla', name: 'Mozilla (Firefox)', category: 'nonprofit', region: 'US', homeCity: 'San Francisco',
        sourceType: 'rss',
        auth: { kind: 'none', program: 'Mozilla blog AI category feed', signup: 'https://blog.mozilla.org/' },
        closedStatus: 'awaiting_key',
        routes: [{ id: 'ai-category-rss', adapter: 'rss', params: { urls: ['https://blog.mozilla.org/en/category/ai/feed/'] }, scope: 'ai' }],
        termsUrl: 'https://www.mozilla.org/en-US/about/legal/terms/mozilla/',
        termsNote: 'Mozilla\'s own published feed (the stale foundation.mozilla.org feed is not used).',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 37, slug: 'khan_academy', name: 'Khan Academy', category: 'nonprofit', region: 'US', homeCity: 'Mountain View',
        sourceType: 'rss',
        auth: { kind: 'none', program: 'Khan Academy blog feed', signup: 'https://blog.khanacademy.org/' },
        closedStatus: 'awaiting_key',
        routes: [{ id: 'blog-rss', adapter: 'rss', params: { urls: ['https://blog.khanacademy.org/feed/'] }, scope: 'filter' }],
        termsUrl: 'https://www.khanacademy.org/about/tos',
        termsNote: 'ToS renders client-side; no automated-access clause found in the server text.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 38, slug: 'owid', name: 'Our World in Data', category: 'nonprofit', region: 'GB', homeCity: 'Oxford',
        sourceType: 'rss',
        auth: { kind: 'none', program: 'OWID Atom feeds', signup: 'https://ourworldindata.org/faqs' },
        closedStatus: 'awaiting_key',
        routes: [{ id: 'atom-feeds', adapter: 'rss', params: { urls: ['https://ourworldindata.org/atom.xml', 'https://ourworldindata.org/atom-data-insights.xml'] }, scope: 'filter' }],
        license: 'CC BY 4.0',
        attribution: 'Our World in Data (CC BY 4.0)',
        termsUrl: 'https://ourworldindata.org/faqs',
        termsNote: 'Content is CC BY; attribution required.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 39, slug: 'openstreetmap', name: 'OpenStreetMap', category: 'nonprofit', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'none', program: 'Diary RSS + community forum (Discourse) JSON + blog feed', signup: 'https://www.openstreetmap.org/' },
        closedStatus: 'awaiting_key',
        routes: [
            { id: 'diary-rss', adapter: 'rss', params: { urls: ['https://www.openstreetmap.org/diary/rss'], geo: true }, scope: 'filter' },
            { id: 'forum-ai-tag', adapter: 'discourse', params: { baseUrl: 'https://community.openstreetmap.org', tag: 'ai' }, scope: 'ai', note: 'Discourse /tag/ai.json (the /search path is not used)' },
            { id: 'blog-rss', adapter: 'rss', params: { urls: ['https://blog.openstreetmap.org/feed/'] }, scope: 'filter' },
        ],
        termsUrl: 'https://osmfoundation.org/wiki/Terms_of_Use',
        termsNote: 'Discourse JSON carries usernames and avatars, which are never kept.',
        rateLimit: { minIntervalMs: 1000, note: 'polite spacing' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 40, slug: 'internet_archive', name: 'Internet Archive', category: 'nonprofit', region: 'US', homeCity: 'San Francisco',
        sourceType: 'api',
        auth: { kind: 'none', program: 'advancedsearch.php + blog feed', signup: 'https://archive.org/about/terms.php' },
        closedStatus: 'awaiting_key',
        routes: [
            { id: 'advanced-search', adapter: 'internet-archive', params: { subject: AI_QUERY, rows: 50, days: 3 }, scope: 'ai', homeCity: null },
            { id: 'blog-rss', adapter: 'rss', params: { urls: ['https://blog.archive.org/feed/'] }, scope: 'filter' },
        ],
        termsUrl: 'https://archive.org/about/terms.php',
        termsNote: 'Documented public search API; no automated-access clause in the terms text.',
        rateLimit: { minIntervalMs: 1000, note: 'polite spacing' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },

    // ── 6. Developer (4) ──────────────────────────────────────────────────────
    {
        rank: 41, slug: 'github', name: 'GitHub', category: 'developer', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'none', program: 'GitHub REST search (token advised) + GitHub blog AI feed', signup: 'https://github.com/settings/tokens' },
        closedStatus: 'awaiting_key',
        routes: [
            { id: 'repo-search', adapter: 'github-search', optional: ['GITHUB_TOKEN'], params: { kind: 'repositories', q: 'topic:artificial-intelligence', sort: 'updated' }, scope: 'ai' },
            { id: 'issue-search', adapter: 'github-search', optional: ['GITHUB_TOKEN'], params: { kind: 'issues', q: 'AI in:title type:issue', sort: 'created', createdWithinHours: 24 }, scope: 'filter' },
            { id: 'ai-ml-blog-rss', adapter: 'rss', params: { urls: ['https://github.blog/ai-and-ml/feed/'] }, scope: 'ai', homeCity: 'San Francisco' },
        ],
        termsUrl: 'https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies',
        termsNote: 'Research use of public data only if resulting publications are open access; no excessive API use; profile location never read.',
        rateLimit: { minIntervalMs: 6500, note: 'search 10 requests/minute unauthenticated, 30 with a token' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 42, slug: 'gitlab', name: 'GitLab', category: 'developer', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'none', program: 'GitLab REST API (token optional) + forum (Discourse)', signup: 'https://gitlab.com/-/user_settings/personal_access_tokens' },
        closedStatus: 'awaiting_key',
        routes: [
            { id: 'topic-projects', adapter: 'gitlab-projects', optional: ['GITLAB_TOKEN'], params: { topic: 'artificial-intelligence', perPage: 20 }, scope: 'ai' },
            { id: 'forum-latest', adapter: 'discourse', params: { baseUrl: 'https://forum.gitlab.com' }, scope: 'filter' },
        ],
        termsUrl: 'https://docs.gitlab.com/user/gitlab_com/rate_limits/',
        termsNote: 'Unauthenticated 60 requests/hour, 5,000/hour with a token; the website terms ban scraping, the API is the sanctioned route.',
        rateLimit: { minIntervalMs: 2000, note: '60 requests/hour unauthenticated' },
        pollIntervalSec: 300,
    },
    {
        rank: 43, slug: 'docker_hub', name: 'Docker Hub', category: 'developer', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'none', program: 'Docker Hub API (documented) + docker.com feed + forum', signup: 'https://docs.docker.com/reference/api/hub/latest/' },
        closedStatus: 'awaiting_key',
        routes: [
            { id: 'ai-namespace', adapter: 'dockerhub-namespace', params: { namespace: 'ai', pageSize: 50 }, scope: 'ai' },
            { id: 'blog-rss', adapter: 'rss', params: { urls: ['https://www.docker.com/feed/'] }, scope: 'filter' },
            { id: 'forum-latest', adapter: 'discourse', params: { baseUrl: 'https://forums.docker.com' }, scope: 'filter' },
        ],
        termsUrl: 'https://www.docker.com/legal/docker-terms-service/',
        termsNote: 'Automated access only through documented APIs within published limits (the undocumented /v2/search is not used).',
        rateLimit: { minIntervalMs: 1000, note: 'polite spacing' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 44, slug: 'hugging_face', name: 'Hugging Face', category: 'developer', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'none', program: 'Hub API daily papers + blog + forum (token optional)', signup: 'https://huggingface.co/settings/tokens' },
        closedStatus: 'awaiting_key',
        routes: [
            { id: 'daily-papers', adapter: 'hf-daily-papers', optional: ['HF_TOKEN'], params: { limit: 30 }, scope: 'ai' },
            { id: 'blog-rss', adapter: 'rss', params: { urls: ['https://huggingface.co/blog/feed.xml'] }, scope: 'ai', homeCity: 'New York' },
            { id: 'forum-latest', adapter: 'discourse', params: { baseUrl: 'https://discuss.huggingface.co' }, scope: 'ai' },
        ],
        termsUrl: 'https://huggingface.co/docs/hub/rate-limits',
        termsNote: 'Anonymous 500 requests / 5 minutes; the undocumented /api/posts list is not used.',
        rateLimit: { minIntervalMs: 700, note: '500 requests / 5 minutes' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },

    // ── 7. Forums (2) — moved from Developer in Rev. 3 ──────────────────────
    {
        rank: 45, slug: 'stack_overflow', name: 'Stack Overflow', category: 'forums', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'none', program: 'Stack Exchange API 2.3 (free key raises the quota)', signup: 'https://stackapps.com/apps/oauth/register' },
        closedStatus: 'awaiting_key',
        routes: [{
            id: 'questions', adapter: 'stackexchange', optional: ['STACKEXCHANGE_KEY'],
            params: { sites: [{ site: 'stackoverflow', tagged: 'artificial-intelligence' }, { site: 'ai' }], pageSize: 30 }, scope: 'ai',
        }],
        pollIntervalSecWithEnv: { STACKEXCHANGE_KEY: DEFAULT_POLL_SEC },
        license: 'CC BY-SA 4.0',
        attribution: 'Stack Exchange (CC BY-SA 4.0)',
        termsUrl: 'https://stackexchange.com/legal/api-terms-of-use',
        termsNote: 'Name Stack Exchange as the source; honour backoff; the AUP bans gathering to train generative AI (aggregate sentiment is neither).',
        rateLimit: { minIntervalMs: 1000, note: '300 requests/day without a key, 10,000 with one; >30 requests/s bans the IP' },
        pollIntervalSec: 900,
    },
    {
        rank: 46, slug: 'hacker_news', name: 'Hacker News (Y Combinator)', category: 'forums', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'none', program: 'Algolia HN Search API + official Firebase API', signup: 'https://github.com/HackerNews/API' },
        closedStatus: 'awaiting_key',
        routes: [{ id: 'algolia-search', adapter: 'hn-algolia', params: { query: 'AI', tags: 'story', hitsPerPage: 50 }, scope: 'filter' }],
        termsUrl: 'https://github.com/HackerNews/API',
        termsNote: 'No documented rate limit on the Firebase API; Algolia about 10,000 requests/hour per IP.',
        rateLimit: { minIntervalMs: 1000, note: 'polite spacing' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },

    // ── 8. Blogs and newsletters (5) ──────────────────────────────────────────
    {
        rank: 47, slug: 'tldr', name: 'TLDR (13 newsletters)', category: 'blog', region: 'US', homeCity: null,
        sourceType: 'rss',
        auth: { kind: 'none', program: 'TLDR AI feed', signup: 'https://tldr.tech/terms' },
        closedStatus: 'awaiting_key',
        routes: [{ id: 'tldr-ai-rss', adapter: 'rss', params: { urls: ['https://tldr.tech/api/rss/ai'], maxAgeDays: 30 }, scope: 'ai' }],
        termsUrl: 'https://tldr.tech/terms',
        termsNote: 'No automated-access clause in the terms text; the 2018 placeholder item is dropped by age.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 48, slug: 'substack', name: 'Substack (platform-level)', category: 'blog', region: 'global', homeCity: null,
        sourceType: 'rss',
        auth: { kind: 'none', program: 'Per-publication Substack feeds (no platform-wide feed exists)', signup: 'https://substack.com/tos' },
        closedStatus: 'awaiting_key',
        routes: [{
            id: 'publication-feeds', adapter: 'rss', scope: 'ai',
            params: {
                // Substack-hosted AI publications (each verified live: <generator>Substack</generator>).
                // One Useful Thing is its own registry row (#50) and is not repeated here.
                // The list is for Jennifer's approval (research §3.48).
                urls: [
                    'https://importai.substack.com/feed',
                    'https://garymarcus.substack.com/feed',
                    'https://www.exponentialview.co/feed',
                    'https://www.interconnects.ai/feed',
                    'https://www.understandingai.org/feed',
                ],
                requireGenerator: 'Substack',
            },
            note: 'Items are accepted only from feeds whose generator is Substack',
        }],
        termsUrl: 'https://substack.com/tos',
        termsNote: 'Terms ban crawling/scraping pages; only the RSS feeds Substack publishes for readers are polled.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 49, slug: 'ars_technica', name: 'Ars Technica', category: 'blog', region: 'US', homeCity: 'New York',
        sourceType: 'rss',
        auth: { kind: 'permission', program: 'Condé Nast permission (no published program)', signup: 'https://www.condenast.com/user-agreement' },
        closedStatus: 'awaiting_approval', ruling: LEGAL_RISK_RULING,
        routes: [{ id: 'ai-rss', adapter: 'rss', params: { urls: ['https://arstechnica.com/ai/feed/'] }, scope: 'ai' }],
        recordEnv: ['ARSTECHNICA_LICENSE_REF'],
        termsUrl: 'https://www.condenast.com/user-agreement',
        termsNote: 'The User Agreement bans automated gathering or aggregation other than search indexing, including data mining.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 50, slug: 'one_useful_thing', name: 'One Useful Thing (Ethan Mollick)', category: 'blog', region: 'US', homeCity: null,
        sourceType: 'rss',
        auth: { kind: 'none', program: 'Substack publication feed', signup: 'https://substack.com/tos' },
        closedStatus: 'awaiting_key',
        routes: [{ id: 'feed', adapter: 'rss', params: { urls: ['https://www.oneusefulthing.org/feed'] }, scope: 'ai' }],
        termsUrl: 'https://substack.com/tos',
        termsNote: 'Substack Terms: only the published RSS feed is polled.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 51, slug: 'platformer', name: 'Platformer (Casey Newton)', category: 'blog', region: 'US', homeCity: null,
        sourceType: 'rss',
        auth: { kind: 'none', program: 'Publication feed (Ghost)', signup: 'https://www.platformer.news/' },
        closedStatus: 'awaiting_key',
        routes: [{ id: 'feed', adapter: 'rss', params: { urls: ['https://www.platformer.news/rss/'] }, scope: 'filter' }],
        termsUrl: 'https://www.platformer.news/',
        termsNote: 'The publication\'s own feed; paywalled posts appear as excerpts.',
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
];

// ─── Environment catalogue ───────────────────────────────────────────────────
// Every env var the collectors read, with where to get it. .env.example and
// docker-compose.yml must list each one (tests/unit/pure/sourceEnv.test.js).
// group: the heading .env.example files it under.
const ENV_DOCS = {
    COLLECTOR_CONTACT_URL: { group: 'collector', signup: 'https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy', description: 'Contact URL placed in the collector User-Agent (required: collection is disabled without it)' },
    COLLECTORS_ENABLED: { group: 'kill-switch', signup: null, description: 'Global kill switch: false stops every collector' },
    COLLECTORS_DISABLED: { group: 'kill-switch', signup: null, description: 'Comma-separated source slugs to turn off (per-source kill switch)' },
    COLLECT_WINDOW_MS: { group: 'collector', signup: null, description: 'Collection cycle length in ms (default 150000)' },
    YOUTUBE_API_KEY: { group: 'free-key', signup: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com', description: 'YouTube Data API v3 key' },
    SPRINGER_API_KEY: { group: 'free-key', signup: 'https://dev.springernature.com', description: 'Springer Nature Meta API key' },
    SCHOLAR_ALERTS_IMAP_HOST: { group: 'free-key', signup: 'https://scholar.google.com/intl/en/scholar/help.html', description: 'IMAP host of the dedicated Scholar-alert mailbox' },
    SCHOLAR_ALERTS_IMAP_USER: { group: 'free-key', signup: 'https://scholar.google.com/intl/en/scholar/help.html', description: 'Mailbox user' },
    SCHOLAR_ALERTS_IMAP_PASSWORD: { group: 'free-key', signup: 'https://scholar.google.com/intl/en/scholar/help.html', description: 'Mailbox app password (secret)' },
    SCHOLAR_ALERTS_IMAP_PORT: { group: 'free-key', signup: null, description: 'IMAP port (default 993, TLS)' },
    SCHOLAR_ALERTS_MAILBOX: { group: 'free-key', signup: null, description: 'Mailbox folder holding the alerts (default INBOX)' },
    GOVINFO_API_KEY: { group: 'free-key', signup: 'https://api.data.gov/signup/', description: 'api.data.gov key for the GovInfo search API (the collection RSS needs none)' },
    CONGRESS_API_KEY: { group: 'free-key', signup: 'https://api.congress.gov/sign-up/', description: 'Congress.gov API key' },
    GITHUB_TOKEN: { group: 'optional', signup: 'https://github.com/settings/tokens', description: 'Fine-grained token, no scopes (raises the search limit)' },
    GITLAB_TOKEN: { group: 'optional', signup: 'https://gitlab.com/-/user_settings/personal_access_tokens', description: 'read_api token (raises the limit to 5,000/hour)' },
    STACKEXCHANGE_KEY: { group: 'optional', signup: 'https://stackapps.com/apps/oauth/register', description: 'Stack Exchange app key (quota 300 → 10,000/day)' },
    HF_TOKEN: { group: 'optional', signup: 'https://huggingface.co/settings/tokens', description: 'Hugging Face read token' },
    NCBI_API_KEY: { group: 'optional', signup: 'https://www.ncbi.nlm.nih.gov/account/settings/', description: 'NCBI key (3 → 10 requests/s)' },
    NCBI_TOOL: { group: 'optional', signup: 'https://support.nlm.nih.gov/kbArticle/?pn=KA-05317', description: 'E-utilities tool name (default pulse-of-ai)' },
    NCBI_EMAIL: { group: 'optional', signup: 'https://support.nlm.nih.gov/kbArticle/?pn=KA-05317', description: 'E-utilities contact email' },
    META_CONTENT_LIBRARY_APPROVAL_REF: { group: 'approval', signup: 'https://transparency.meta.com/researchtools/meta-content-library', description: 'Meta Content Library approval reference (WhatsApp, Instagram, Facebook)' },
    META_CONTENT_LIBRARY_EXPORT_DIR: { group: 'approval', signup: 'https://transparency.meta.com/researchtools/meta-content-library', description: 'Directory holding approved MCL exports (JSON lines per product)' },
    TIKTOK_RESEARCH_CLIENT_KEY: { group: 'approval', signup: 'https://developers.tiktok.com/products/research-api/', description: 'TikTok Research API client key' },
    TIKTOK_RESEARCH_CLIENT_SECRET: { group: 'approval', signup: 'https://developers.tiktok.com/products/research-api/', description: 'TikTok Research API client secret' },
    ELSEVIER_API_KEY: { group: 'approval', signup: 'https://dev.elsevier.com', description: 'Elsevier API key' },
    ELSEVIER_APPROVAL_REF: { group: 'approval', signup: 'https://dev.elsevier.com/policy.html', description: 'Elsevier use-case approval reference' },
    JSTOR_DATASET_PATH: { group: 'approval', signup: 'https://www.jstor.org/ta-support', description: 'Path of the JSTOR Text Analysis Support dataset (JSON lines)' },
    X_BEARER_TOKEN: { group: 'paid', signup: 'https://developer.x.com', description: 'X API v2 bearer token (pay-per-use; replaces TWITTER_BEARER_TOKEN)' },
    AP_API_KEY: { group: 'paid', signup: 'https://developer.ap.org', description: 'AP Media API key' },
    REUTERS_CONNECT_CLIENT_ID: { group: 'paid', signup: 'https://www.reutersagency.com', description: 'Reuters Connect OAuth client id' },
    REUTERS_CONNECT_CLIENT_SECRET: { group: 'paid', signup: 'https://www.reutersagency.com', description: 'Reuters Connect OAuth client secret' },
    REUTERS_CONNECT_TOKEN_URL: { group: 'paid', signup: 'https://www.reutersagency.com', description: 'OAuth token endpoint from the contract (default provided)' },
    REUTERS_CONNECT_API_URL: { group: 'paid', signup: 'https://www.reutersagency.com', description: 'GraphQL endpoint from the contract (default provided)' },
    CNN_LICENSE_REF: { group: 'paid', signup: 'https://www.cnn.com/intlsyndication/', description: 'CNN Wire Store licence reference' },
    CNN_FEED_URL: { group: 'paid', signup: 'https://www.cnn.com/intlsyndication/', description: 'Contract delivery feed URL' },
    CNN_API_KEY: { group: 'paid', signup: 'https://www.cnn.com/intlsyndication/', description: 'Delivery credential, when the contract uses one' },
    NYT_API_KEY: { group: 'paid', signup: 'https://developer.nytimes.com', description: 'NYT developer key (paid tier; used only with NYT_LICENSE_REF)' },
    NYT_LICENSE_REF: { group: 'paid', signup: 'https://nytlicensing.com/data-solutions/', description: 'NYT Licensing TDM licence reference' },
    GUARDIAN_API_KEY: { group: 'paid', signup: 'https://bonobo.capi.gutools.co.uk/register/commercial', description: 'Guardian COMMERCIAL Content API key (paid tier)' },
    DOWJONES_API_KEY: { group: 'paid', signup: 'https://www.dowjones.com/', description: 'Dow Jones feed credential (paid tier)' },
    DOWJONES_FEED_URL: { group: 'paid', signup: 'https://www.dowjones.com/', description: 'Dow Jones contract feed URL' },
    IEEE_API_KEY: { group: 'paid', signup: 'https://developer.ieee.org', description: 'IEEE Xplore API key' },
    IEEE_LICENSE_REF: { group: 'paid', signup: 'https://developer.ieee.org/contact', description: 'IEEE alternative-licensing reference' },
    BBC_LICENSE_REF: { group: 'permission', signup: 'https://www.bbc.co.uk/usingthebbc/terms-of-use', description: 'BBC permission reference, recorded once granted (the feed runs now per ADR 0001)' },
    NBC_LICENSE_REF: { group: 'permission', signup: 'https://www.nbcnews.com/id/wbna5216556', description: 'NBCUniversal permission reference, recorded once granted' },
    WAPO_LICENSE_REF: { group: 'permission', signup: 'https://www.washingtonpost.com/licensing-syndication/', description: 'WP Licensing & Syndication reference, recorded once granted' },
    ALJAZEERA_LICENSE_REF: { group: 'permission', signup: 'https://contentsales.aljazeera.net/', description: 'Al Jazeera Content Sales reference, recorded once granted' },
    ARSTECHNICA_LICENSE_REF: { group: 'permission', signup: 'https://www.condenast.com/user-agreement', description: 'Condé Nast permission reference, recorded once granted' },
    CFR_FEED_PERMISSION_REF: { group: 'permission', signup: 'https://www.cfr.org/', description: 'CFR confirmation that /feed may be read despite "Disallow: /feed/"' },
    WECHAT_TENCENT_AUTHORIZATION_REF: { group: 'blocked', signup: 'https://weixin.qq.com/agreement?lang=en_US', description: 'Tencent written authorization reference' },
    WECHAT_AUTHORIZED_FEED_URL: { group: 'blocked', signup: 'https://weixin.qq.com/agreement?lang=en_US', description: 'Feed URL Tencent authorizes' },
    TELEGRAM_WRITTEN_PERMISSION_REF: { group: 'blocked', signup: 'https://core.telegram.org/api/terms', description: 'Telegram written permission reference (API Terms §1.5)' },
    TELEGRAM_BOT_TOKEN: { group: 'blocked', signup: 'https://core.telegram.org/bots#how-do-i-create-a-bot', description: 'Bot API token (used only with the permission reference)' },
    RESEARCHGATE_DATA_ACCESS_REF: { group: 'blocked', signup: 'https://www.researchgate.net/terms-of-service', description: 'ResearchGate data-access grant reference' },
    RESEARCHGATE_DATASET_PATH: { group: 'blocked', signup: 'https://www.researchgate.net/terms-of-service', description: 'Path of the dataset ResearchGate delivers (JSON lines)' },
    CATO_ALLOWLIST_REF: { group: 'blocked', signup: 'https://www.cato.org/', description: 'Reference of Cato allowlisting the collector User-Agent' },
};

// ─── Lookups ─────────────────────────────────────────────────────────────────

const BY_SLUG = new Map(SOURCES.map(s => [s.slug, s]));

/** @returns {object|null} registry entry for a slug */
function getSource(slug) {
    return BY_SLUG.get(slug) || null;
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Attribution the source's terms require next to its content (NPR,
 * NBCNews.com, Stack Exchange, Wikipedia, OWID, Pew), or null.
 * @param {string} slug  data_sources.name
 */
function attributionFor(slug) {
    const src = BY_SLUG.get(slug);
    return src && src.attribution ? src.attribution : null;
}

/** Env name of the per-source kill switch: SOURCE_<SLUG>_ENABLED. */
function killSwitchEnv(slug) {
    return `SOURCE_${slug.toUpperCase()}_ENABLED`;
}

const isFalse = (v) => typeof v === 'string' && /^(false|0|no|off)$/i.test(v.trim());

/**
 * Whether a source is switched off by a kill switch (global, list or per-source).
 * @returns {string|null} the reason, or null when not killed
 */
function killReason(src, env) {
    if (isFalse(env.COLLECTORS_ENABLED)) return 'kill switch COLLECTORS_ENABLED=false';
    const list = (env.COLLECTORS_DISABLED || '').split(',').map(s => s.trim()).filter(Boolean);
    if (list.includes(src.slug)) return 'kill switch COLLECTORS_DISABLED lists this source';
    if (isFalse(env[killSwitchEnv(src.slug)])) return `kill switch ${killSwitchEnv(src.slug)}=false`;
    return null;
}

/**
 * The routes that would run now: every route whose required env vars are all
 * set, minus routes superseded by another open route (`replaces`).
 */
function openRoutes(src, env = process.env) {
    const open = src.routes.filter(r => (r.requires || []).every(k => nonEmpty(env[k])));
    const replaced = new Set(open.flatMap(r => r.replaces || []));
    return open.filter(r => !replaced.has(r.id));
}

/**
 * Gate status of a source under an environment.
 * @returns {{ status: string, reason: string, openRoutes: string[],
 *             missing: string[], recorded: object }}
 *   missing: env vars the closed routes still need (for the UI and smoke).
 */
function sourceStatus(src, env = process.env) {
    const routes = openRoutes(src, env);
    const missing = [...new Set(src.routes
        .filter(r => !routes.includes(r))
        .flatMap(r => (r.requires || []).filter(k => !nonEmpty(env[k]))))];
    const recorded = {};
    for (const k of src.recordEnv || []) recorded[k] = nonEmpty(env[k]);
    const base = { openRoutes: routes.map(r => r.id), missing, recorded };

    const killed = killReason(src, env);
    if (killed) return { ...base, status: 'disabled', reason: killed };
    // Blocked is a property of the source's terms, not of this process's
    // config: it is reported as blocked whatever else is (un)set.
    if (src.auth.kind === 'blocked' && routes.length === 0) {
        return { ...base, status: 'blocked', reason: `blocked: no compliant access — ${src.blocked.reason}` };
    }
    if (!nonEmpty(env.COLLECTOR_CONTACT_URL)) {
        return { ...base, status: 'disabled', reason: 'COLLECTOR_CONTACT_URL is not set (the User-Agent must carry a contact URL)' };
    }
    if (routes.length > 0) {
        const reason = src.auth.kind === 'blocked'
            ? 'collecting under the official permission recorded in env'
            : src.ruling ? src.ruling : `collecting via ${routes.map(r => r.id).join(', ')}`;
        return { ...base, status: 'collecting', reason };
    }
    return { ...base, status: src.closedStatus, reason: `waiting for ${missing.join(', ')} (${src.auth.program})` };
}

/** Effective seconds between runs (a key can shorten a keyless cadence). */
function pollIntervalSec(src, env = process.env) {
    for (const [k, sec] of Object.entries(src.pollIntervalSecWithEnv || {})) {
        if (nonEmpty(env[k])) return sec;
    }
    return src.pollIntervalSec || DEFAULT_POLL_SEC;
}

/** Every env var referenced by the registry, with its docs entry. */
function registryEnvVars() {
    const names = new Set(['COLLECTOR_CONTACT_URL', 'COLLECTORS_ENABLED', 'COLLECTORS_DISABLED', 'COLLECT_WINDOW_MS']);
    for (const s of SOURCES) {
        for (const r of s.routes) for (const k of [...(r.requires || []), ...(r.optional || [])]) names.add(k);
        for (const k of s.recordEnv || []) names.add(k);
        for (const k of Object.keys(s.pollIntervalSecWithEnv || {})) names.add(k);
    }
    names.add('REUTERS_CONNECT_TOKEN_URL');
    names.add('REUTERS_CONNECT_API_URL');
    return [...names];
}

// ─── Env classes (F9-2) ──────────────────────────────────────────────────────
// Which process may hold which collector variable (docker-compose.yml):
//   setting     non-secret configuration and permission / licence REFERENCES
//               (names and dates, never credentials) — every app role;
//   credential  everything else the collectors read: keys, tokens, secrets,
//               client ids, mailbox logins, contract feed URLs, dataset
//               paths — the WORKER only. web receives a presence marker
//               instead (`${NAME:+set}`), so its gate status
//               (sourceStatus) is right without holding the secret.
// Unknown names default to credential: a new variable is worker-only until
// it is deliberately listed here.
const SETTING_ENV = Object.freeze([
    'COLLECTOR_CONTACT_URL', 'COLLECTORS_ENABLED', 'COLLECTORS_DISABLED', 'COLLECT_WINDOW_MS',
    'NCBI_TOOL', 'SCHOLAR_ALERTS_IMAP_PORT', 'SCHOLAR_ALERTS_MAILBOX',
]);

/** @returns {'setting'|'credential'} */
function envClass(name) {
    if (SETTING_ENV.includes(name) || /_REF$/.test(name) || /^SOURCE_[A-Z0-9_]+_ENABLED$/.test(name)) return 'setting';
    return 'credential';
}

module.exports = {
    SETTING_ENV,
    envClass,
    AUTH_KINDS,
    GATE_STATUSES,
    SOURCE_TYPES,
    DEFAULT_POLL_SEC,
    SOURCES,
    ENV_DOCS,
    getSource,
    attributionFor,
    killSwitchEnv,
    killReason,
    openRoutes,
    sourceStatus,
    pollIntervalSec,
    registryEnvVars,
};
