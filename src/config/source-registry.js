// src/config/source-registry.js
// THE source registry of record, in code (ADR 0001).
//
// Exactly the 52 sources of the workbook
// (docs/requirements/Top_50_Global_Online_Sources.xlsx, Rev. 4). Jennifer's
// ruling "use the 51 sources exactly. no exceptions." was superseded on
// 2026-09-29 by "can we add reddit to the source lis. Update the excel file
// to capture as well": Reddit is #52 in Forums (ADR 0001, ruling 8). No other
// additions, no substitutes, no silent drops:
// tests/unit/pure/sourceRegistry.test.js parses the workbook itself and
// asserts a 1:1 match on rank, name and category (Hacker News, Stack Overflow
// and Reddit in Forums). Counts are SOURCES.length, never a literal.
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
//   licenseUrl    https URL of that licence (K1: rendered as the licence link)
//   linkHosts     K1: domains the source's PERMALINKS live on, where the route's
//                 own URLs (params.urls / params.baseUrl: feeds, Discourse forums)
//                 do not name them: API-only routes (api.github.com -> github.com)
//                 and feeds that link elsewhere (feeds.bbci.co.uk -> bbc.co.uk).
//                 A link back is published only when its host is on, or under,
//                 the registrable domain of a route URL or one of these. API
//                 hosts (googleapis.com, guardianapis.com, ...) are never added
//   linkOnly      true: linkHosts is the COMPLETE list (the route's feed host is
//                 not a permalink host: feeds.content.dowjones.io)
//   creditText    overrides the credit shown next to an excerpt (default:
//                 `attribution`, else the name without a trailing "(...)")
//   citeDate      true: the credit also shows the item's publication date (Pew)
//   notice / noticeUrl   a notice the terms require on the product (arXiv
//                 acknowledgement, NCBI disclaimer); src/config/attribution.js
//                 turns all of the above into the per-post credit (K1)
//   rateLimit     { minIntervalMs, note } — spacing between requests to the
//                 same host within a run
//   pollIntervalSec  minimum seconds between two runs of the source (the
//                 2–3 minute default, longer where a documented limit needs it)
//   blocked       for the 4 BLOCKED sources: why, the evidence, the remedy
//   ruling        set when Jennifer's 2026-09-29 ruling decides the gate
//   retention     platform-terms retention (Reddit): { maxAgeHours,
//                 recheckHours, legalBasis, notice } — the post TEXT is
//                 blanked when the window ends or the post is removed
//                 upstream; scores and audit rows are kept (ADR 0001 ruling
//                 9; src/collectors/retention.js), and receipts say so

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

// D1 (Jennifer, 2026-09-29: "Off for others, on for you"): the 8 ruling-4
// feeds above are collected only once the OPERATOR records that they accept
// the same legal risk — PERMISSION_GATED_FEEDS_ACCEPTED_BY = "<name> <date>".
// A fresh clone ships it empty, so those routes stay closed; a licensed or
// paid route of the same source is not affected. Every such route requires
// it and is marked permissionGated (tests/unit/pure/sourceRegistry.test.js).
const PERMISSION_GATED_ACK_ENV = 'PERMISSION_GATED_FEEDS_ACCEPTED_BY';

// PR #22 decision G5 (Jennifer, 2026-09-29): opening ANY gated route — one
// that needs a key, an approval, a licence or a permission, i.e. every
// route with a non-empty `requires` — also needs a NAMED approval in
// GATE_APPROVED_BY, "Name YYYY-MM-DD". Without a valid one the route stays
// closed and the status reason says "awaiting named approval". The value is
// the actor of the source_gate_events rows that record the opening
// (src/collectors/governance.js) and of every database kill-switch change
// (scripts/source-admin.js). Keyless routes are not gated.
const GATE_APPROVAL_ENV = 'GATE_APPROVED_BY';
const AWAITING_NAMED_APPROVAL = 'awaiting named approval';

// Per-ROUTE kill switch (migration 073; Jennifer 2026-09-30, "Stop all HF
// now + per-route switch"): one route of a source can be turned off while its
// other routes keep collecting — e.g. hugging_face/forum-latest, whose forum
// terms ban automated access, while the papers and blog routes resume.
//   env       COLLECTORS_DISABLED_ROUTES=slug/route,... (applies on container
//             RECREATE, like COLLECTORS_DISABLED)
//   database  npm run source:disable -- <slug> --route <id> --reason "<why>"
//             (source_route_state; applies before the next run in every
//             process, like the source-level switch, F10-10)
// A route kill switch only ever REMOVES a route: `replaces` is resolved
// before it, so killing a replacing route never reopens the route it
// replaced. Route ids are validated against the registry, never trusted
// from input.
const ROUTE_KILL_ENV = 'COLLECTORS_DISABLED_ROUTES';

const AI_QUERY = 'artificial intelligence';

// ADR 0001 ruling 8 (Jennifer, 2026-09-29) on how Reddit posts are shown.
const REDDIT_RULING = 'Added by Jennifer\'s 2026-09-29 ruling ("can we add reddit to the source lis"), through the approved '
    + 'Reddit Data API only. Display: "need to stay consistent along with all the other sources. dashboard needs to show '
    + 'text." Reddit posts show redacted text like every other source; Jennifer explicitly accepted the risk against the '
    + 'Data API Terms\' content-modification clause (ADR 0001 ruling 8). Retention: "Blank text, keep audit rows" (ruling 9). '
    + 'SOURCE_REDDIT_ENABLED=false turns it off.';

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
        linkHosts: ['whatsapp.com'],
        termsUrl: 'https://www.whatsapp.com/legal/terms-of-service',
        termsNote: 'Web collection needs Meta\'s express written permission (Automated Data Collection Terms); the only compliant route is the Meta Content Library researcher program.',
        rateLimit: { minIntervalMs: 0, note: 'local export files; no network' },
        pollIntervalSec: DEFAULT_POLL_SEC,
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
        linkHosts: ['instagram.com'],
        termsUrl: 'https://help.instagram.com/581066165581870',
        termsNote: 'Instagram Terms forbid automated collection without express permission; researcher access through the Meta Content Library.',
        rateLimit: { minIntervalMs: 0, note: 'local export files; no network' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 3, slug: 'youtube', name: 'YouTube (Alphabet)', category: 'social', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'key', program: 'YouTube Data API v3 (free key)', signup: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com' },
        closedStatus: 'awaiting_key',
        routes: [{
            id: 'data-api', adapter: 'youtube', requires: ['YOUTUBE_API_KEY'],
            params: { query: AI_QUERY, maxResults: 25 }, scope: 'ai',
            // D4 exception (reported): search.list is capped at 100 calls/day
            // and each run makes one, so no cadence under 864 s fits.
            pollIntervalSec: 900,
            quota: { perDay: 100, requestsPerRun: 1, basis: 'YouTube Data API: 100 search.list calls/day (plus 10,000 units/day for videos.list)', cannotFitBand: true },
            note: 'search.list (type=video, order=date) then videos.list for full descriptions; the keyless Atom feed is NOT used (robots.txt + Terms)',
        }],
        linkHosts: ['youtube.com', 'youtu.be'],
        termsUrl: 'https://developers.google.com/youtube/terms/developer-policies',
        termsNote: 'Stored API data must be refreshed or deleted within 30 days; derived-metrics clause to be confirmed in the API compliance audit.',
        // P10-2: YouTube API Services policies — stored data must be refreshed
        // or deleted within 30 days. Blanked at 30 days, audit rows kept
        // (ruling 9's mechanism, for consistency).
        retention: {
            maxAgeHours: 720,
            byAnalogy: 'ruling 9 ("Blank text, keep audit rows"), applied by analogy for consistency',
            removalNotice: '[removed: YouTube API terms retention]',
            legalBasis: 'YouTube API Services Developer Policies: stored API data must be refreshed or deleted within 30 days. Text '
                + 'removed at 30 days; score and audit rows retained (ADR 0001 ruling 9 mechanism, applied by analogy).',
            notice: 'YouTube text is removed 30 days after collection because of the YouTube API terms; its scores and audit rows '
                + 'are retained.',
        },
        rateLimit: { minIntervalMs: 1000, note: 'search.list quota 100 calls/day; 10,000 units/day for other endpoints' },
        pollIntervalSec: DEFAULT_POLL_SEC,
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
        linkHosts: ['facebook.com'],
        termsUrl: 'https://www.facebook.com/terms.php',
        termsNote: 'Facebook Terms §3.2 bar automated collection without prior permission; researcher access through the Meta Content Library.',
        rateLimit: { minIntervalMs: 0, note: 'local export files; no network' },
        pollIntervalSec: DEFAULT_POLL_SEC,
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
            // D4: 1,000 requests/day at 2 per run (token + query) → 180 s = 960.
            pollIntervalSec: 180,
            quota: { perDay: 1000, requestsPerRun: 2, basis: 'TikTok Research API FAQ: 1,000 requests/day, up to 100,000 records/day' },
            note: 'POST /v2/research/video/query/ with a client-credentials token',
        }],
        linkHosts: ['tiktok.com'],
        termsUrl: 'https://www.tiktok.com/legal/page/global/terms-of-service-research-api/en',
        termsNote: 'Refresh data at least every 30 days; outputs must not be linkable to a user; public-dashboard use to be confirmed in the application.',
        // P10-2: the Research API terms require refreshing data at least every
        // 30 days; blanked at 30 days, audit rows kept (ruling 9 mechanism).
        retention: {
            maxAgeHours: 720,
            byAnalogy: 'ruling 9 ("Blank text, keep audit rows"), applied by analogy for consistency',
            removalNotice: '[removed: TikTok Research API terms retention]',
            legalBasis: 'TikTok Research API terms: data must be refreshed at least every 30 days. Text removed at 30 days; score '
                + 'and audit rows retained (ADR 0001 ruling 9 mechanism, applied by analogy).',
            notice: 'TikTok text is removed 30 days after collection because of the Research API terms; its scores and audit rows '
                + 'are retained.',
        },
        rateLimit: { minIntervalMs: 1000, note: '1,000 requests/day, up to 100,000 records/day' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 6, slug: 'wechat', name: 'WeChat / Weixin (Tencent)', category: 'social', region: 'CN', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'blocked', program: 'Written authorization from Tencent (no published program)', signup: 'https://weixin.qq.com/agreement?lang=en_US' },
        closedStatus: 'blocked',
        routes: [{
            id: 'tencent-authorized-feed', adapter: 'blocked-wechat',
            requires: ['WECHAT_TENCENT_AUTHORIZATION_REF', 'WECHAT_AUTHORIZED_FEED_URL', 'WECHAT_AUTHORIZED_FEED_HOST'],
            params: {}, scope: 'filter',
            note: 'Runs ONLY against a feed Tencent authorizes in writing; never mp.weixin.qq.com pages or Sogou search',
        }],
        linkHosts: ['weixin.qq.com'],
        termsUrl: 'https://weixin.qq.com/agreement?lang=en_US',
        termsNote: 'Weixin Service Agreement §8.2.1.6 / §8.2.1.8 bar automated operations not authorized by Tencent; robots.txt disallows article pages and Sogou WeChat search.',
        blocked: {
            reason: 'No compliant access: the terms bar unauthorized automated operations and there is no public read API or feed.',
            evidence: 'Weixin Service Agreement §8.2.1.6 and §8.2.1.8; mp.weixin.qq.com/robots.txt; weixin.sogou.com/robots.txt Disallow: /',
            remedy: 'Written authorization from Tencent naming Pulse of AI and the feed it may read.',
        },
        rateLimit: { minIntervalMs: 2000, note: 'per the authorization, when granted' },
        pollIntervalSec: 180,
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
        linkHosts: ['t.me', 'telegram.org'],
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
            // D4: no request cap binds (3M reads/month; since_id reads each
            // post once). Spend is at most 20 reads per run: at 180 s that
            // is 9,600 reads/day ($48/day) in the worst case — reported.
            pollIntervalSec: 180,
            quota: { perMonthReads: 3000000, readsPerRunMax: 20, requestsPerRun: 1, basis: 'X pay-per-use: $0.005 per post read, up to 3M reads/month' },
            note: 'GET /2/tweets/search/recent with since_id; at most 20 posts read per run',
        }],
        linkHosts: ['x.com', 'twitter.com'],
        termsUrl: 'https://docs.x.com/developer-terms/agreement',
        termsNote: 'Honour deletion requests within 24 hours; no redistribution; scraping outside the API is prohibited.',
        rateLimit: { minIntervalMs: 1000, note: 'pay-per-use; spend capped by maxResults and cadence' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },

    // ── 2. News (11) ──────────────────────────────────────────────────────────
    {
        rank: 9, slug: 'bbc_news', name: 'BBC News', category: 'news', region: 'GB', homeCity: 'London',
        sourceType: 'rss',
        auth: { kind: 'permission', program: 'BBC permission (Terms of Use §15)', signup: 'https://www.bbc.co.uk/usingthebbc/terms-of-use' },
        closedStatus: 'awaiting_approval', ruling: LEGAL_RISK_RULING,
        routes: [{ id: 'technology-rss', adapter: 'rss', requires: [PERMISSION_GATED_ACK_ENV], permissionGated: true, params: { urls: ['https://feeds.bbci.co.uk/news/technology/rss.xml'] }, scope: 'filter' }],
        recordEnv: ['BBC_LICENSE_REF'],
        linkOnly: true, linkHosts: ['bbc.co.uk', 'bbc.com'],
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
            { id: 'technology-rss', adapter: 'rss', requires: [PERMISSION_GATED_ACK_ENV], permissionGated: true, params: { urls: ['https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml'] }, scope: 'filter' },
            {
                id: 'article-search', adapter: 'nyt-article-search', requires: ['NYT_API_KEY', 'NYT_LICENSE_REF'],
                params: { subject: 'Artificial Intelligence' }, scope: 'ai', replaces: ['technology-rss'],
                // D4: 500/day cannot sustain 150 s (576 runs/day); 180 s = 480.
                pollIntervalSec: 180,
                quota: { perDay: 500, perMinute: 5, requestsPerRun: 1, basis: 'developer.nytimes.com: 500 requests/day, 5/minute' },
                note: 'Paid tier: Article Search API under an NYT Licensing TDM licence (5 requests/min, 500/day)',
            },
        ],
        linkHosts: ['nytimes.com'],
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
        linkHosts: ['cnn.com'],
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
            { id: 'ai-tag-rss', adapter: 'rss', requires: [PERMISSION_GATED_ACK_ENV], permissionGated: true, params: { urls: ['https://www.theguardian.com/technology/artificialintelligenceai/rss'] }, scope: 'ai' },
            {
                // P10-7 / D4: the commercial key AND its licence reference,
                // consistent with Elsevier and IEEE (the key alone is issued
                // to anyone; the licence is the permission the terms need).
                id: 'content-api', adapter: 'guardian-content-api', requires: ['GUARDIAN_API_KEY', 'GUARDIAN_COMMERCIAL_LICENSE_REF'],
                params: { tag: 'technology/artificialintelligenceai' }, scope: 'ai', replaces: ['ai-tag-rss'],
                pollIntervalSec: 180,
                quota: { perDay: 500, requestsPerRun: 1, basis: 'commercial quota is per contract; clamped to the published free-key cap of 500/day as a ceiling' },
                note: 'Paid tier: Content API with a COMMERCIAL key ("sentiment analysis where content is not reproduced")',
            },
        ],
        linkHosts: ['theguardian.com'],
        termsUrl: 'https://www.theguardian.com/open-platform/terms-and-conditions',
        termsNote: 'Open Platform §6 bans analysis/mining and ML use on the free key; §5 requires deletion within 24 hours; site terms apply the same to RSS.',
        // GUARDIAN ruling (Jennifer McKinney, 2026-09-29), verbatim: "Use
        // normal retention". The 24-hour blanking applied by analogy with
        // ruling 9 (P10-2) is removed: the Guardian has no platform-terms
        // `retention` block, so its text follows the default §19 detail
        // window (RETENTION_DETAIL_DAYS). `retentionRuling` records the
        // ruling and the window it replaced, so receipts of posts already
        // blanked under that window stay truthful (retention.js).
        retentionRuling: {
            by: 'Jennifer McKinney',
            date: '2026-09-29',
            verbatim: 'Use normal retention',
            effect: 'The Guardian uses the default text retention (TECHNICAL_SPEC §19, RETENTION_DETAIL_DAYS); the 24-hour '
                + 'blanking applied by analogy with ADR 0001 ruling 9 is removed (ADR 0001, "Decisions of 2026-09-29 (PR #22 review)").',
            former: { maxAgeHours: 24, basis: 'Guardian Open Platform terms §5, applied by analogy with ADR 0001 ruling 9 (PR #10 P10-2)' },
        },
        rateLimit: { minIntervalMs: 1000, note: 'free key 1 call/s, 500/day; commercial per contract' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 13, slug: 'al_jazeera', name: 'Al Jazeera', category: 'news', region: 'QA', homeCity: 'Doha',
        sourceType: 'rss',
        auth: { kind: 'permission', program: 'Al Jazeera Content Sales licence', signup: 'https://contentsales.aljazeera.net/' },
        closedStatus: 'awaiting_licence', ruling: LEGAL_RISK_RULING,
        routes: [{ id: 'all-news-rss', adapter: 'rss', requires: [PERMISSION_GATED_ACK_ENV], permissionGated: true, params: { urls: ['https://www.aljazeera.com/xml/rss/all.xml'] }, scope: 'filter' }],
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
            { id: 'technology-rss', adapter: 'rss', requires: [PERMISSION_GATED_ACK_ENV], permissionGated: true, params: { urls: ['https://feeds.content.dowjones.io/public/rss/RSSWSJD'] }, scope: 'filter' },
            {
                id: 'dow-jones-feed', adapter: 'licensed-feed', requires: ['DOWJONES_API_KEY', 'DOWJONES_FEED_URL'],
                params: {}, scope: 'filter', replaces: ['technology-rss'],
                note: 'Paid tier: the contract feed Dow Jones provisions (Factiva / feeds)',
            },
        ],
        linkOnly: true, linkHosts: ['wsj.com', 'dowjones.com'],
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
        linkHosts: ['apnews.com'],
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
        linkHosts: ['reuters.com'],
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
        routes: [{ id: 'tech-rss', adapter: 'rss', requires: [PERMISSION_GATED_ACK_ENV], permissionGated: true, params: { urls: ['https://feeds.nbcnews.com/nbcnews/public/tech'] }, scope: 'filter' }],
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
        routes: [{ id: 'technology-rss', adapter: 'rss', requires: [PERMISSION_GATED_ACK_ENV], permissionGated: true, params: { urls: ['https://feeds.washingtonpost.com/rss/business/technology'] }, scope: 'filter' }],
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
            quota: { perMinute: 150, requestsPerRun: 1, basis: 'Springer Nature: 150 requests/minute for API users' },
            params: { query: 'keyword:"artificial intelligence" sort:date', pageSize: 25 }, scope: 'ai',
        }],
        linkHosts: ['springer.com', 'springernature.com'],
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
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        // K1: the acknowledgement arXiv's API page asks every product to show.
        notice: 'Thank you to arXiv for use of its open access interoperability.',
        linkHosts: ['arxiv.org'],
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
        // K1: NCBI's scripting guidelines require its disclaimer and copyright
        // notice to be evident to users of the service.
        notice: 'PubMed records are provided by the U.S. National Library of Medicine (NCBI); abstracts may be under publisher copyright. See the NCBI disclaimer and copyright notice.',
        noticeUrl: 'https://www.ncbi.nlm.nih.gov/home/about/policies/',
        linkHosts: ['ncbi.nlm.nih.gov'],
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
            quota: { perDay: 2857, requestsPerRun: 1, basis: 'Elsevier: 20,000 requests/week (2,857/day) at 2 requests/s' },
            params: { query: AI_QUERY, show: 25 }, scope: 'ai',
            note: 'The key alone is self-service; the use-case approval reference is required too (ADR 0001)',
        }],
        linkHosts: ['sciencedirect.com'],
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
        linkHosts: ['scholar.google.com'],
        termsUrl: 'https://policies.google.com/terms',
        termsNote: 'robots.txt disallows /scholar; the alert route never requests Scholar pages. Setting the mailbox credential is Jennifer\'s sign-off (research §3.24).',
        rateLimit: { minIntervalMs: 0, note: 'one IMAP session per run' },
        pollIntervalSec: DEFAULT_POLL_SEC,
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
        linkHosts: ['researchgate.net'],
        termsUrl: 'https://www.researchgate.net/terms-of-service',
        termsNote: 'Every page, the terms page included, returns 403 with a CAPTCHA to non-browser clients; the clause could not be read.',
        blocked: {
            reason: 'No compliant access: no API or feed, and the site is behind a CAPTCHA wall that is never bypassed.',
            evidence: 'CAPTCHA wall (403) on every page including the terms page; terms clause not verified',
            remedy: 'A data-access grant from ResearchGate.',
        },
        rateLimit: { minIntervalMs: 0, note: 'local dataset; no network' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    {
        rank: 26, slug: 'ieee_xplore', name: 'IEEE Xplore', category: 'academic', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'paid', program: 'IEEE Xplore API key + IEEE alternative licensing', signup: 'https://developer.ieee.org' },
        closedStatus: 'awaiting_licence',
        routes: [{
            id: 'metadata-api', adapter: 'ieee', requires: ['IEEE_API_KEY', 'IEEE_LICENSE_REF'],
            // D4 exception (reported): the quota is set at key registration
            // and not published, so the cadence stays conservative until the
            // issued quota is known.
            pollIntervalSec: 900,
            quota: { requestsPerRun: 1, basis: 'set at key registration; not published', unpublished: true },
            params: { query: AI_QUERY, maxRecords: 25 }, scope: 'ai',
        }],
        linkHosts: ['ieee.org'],
        termsUrl: 'https://developer.ieee.org/API_Terms_of_Use2',
        termsNote: 'Non-commercial licence; content per individual query, not bulk; no AI/ML training; limits set at registration.',
        rateLimit: { minIntervalMs: 1000, note: 'set at key registration' },
        pollIntervalSec: DEFAULT_POLL_SEC,
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
        linkHosts: ['jstor.org'],
        termsUrl: 'https://about.jstor.org/terms/',
        termsNote: 'Terms ban automatic downloading or export, including scraping; datasets come only through Text Analysis Support.',
        rateLimit: { minIntervalMs: 0, note: 'local dataset; no network' },
        pollIntervalSec: DEFAULT_POLL_SEC,
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
                quota: { perDay: 24000, requestsPerRun: 1, basis: 'api.data.gov: 1,000 requests/hour per key' },
                params: { query: 'collection:(BILLS OR CREC OR FR OR CHRG OR CRPT) AND title:("artificial intelligence")', pageSize: 50 },
            },
        ],
        license: 'Public domain (US federal works)',
        linkHosts: ['govinfo.gov'],
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
            quota: { perDay: 120000, requestsPerRun: 1, basis: 'Congress.gov API: 5,000 requests/hour' },
            note: 'No keyword search exists (query= is ignored): recent bills are filtered for AI locally',
        }],
        license: 'Public domain',
        linkHosts: ['congress.gov'],
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
        pollIntervalSec: 180,
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
        // K1: Pew's citation form is "Title." Pew Research Center, Washington,
        // D.C. (date) URL: the credit names the city and the date is shown.
        creditText: 'Pew Research Center, Washington, D.C.',
        citeDate: true,
        linkHosts: ['pewresearch.org'],
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
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        attribution: 'Wikipedia (CC BY-SA 4.0)',
        linkHosts: ['wikipedia.org'],
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
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
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
        linkHosts: ['archive.org'],
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
            { id: 'repo-search', adapter: 'github-search', optional: ['GITHUB_TOKEN'], quota: { perMinute: 10, requestsPerRun: 2, basis: 'GitHub search: 10 requests/minute unauthenticated, shared by the two search routes' }, params: { kind: 'repositories', q: 'topic:artificial-intelligence', sort: 'updated' }, scope: 'ai' },
            { id: 'issue-search', adapter: 'github-search', optional: ['GITHUB_TOKEN'], params: { kind: 'issues', q: 'AI in:title type:issue', sort: 'created', createdWithinHours: 24 }, scope: 'filter' },
            { id: 'ai-ml-blog-rss', adapter: 'rss', params: { urls: ['https://github.blog/ai-and-ml/feed/'] }, scope: 'ai', homeCity: 'San Francisco' },
        ],
        linkHosts: ['github.com'],
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
            { id: 'topic-projects', adapter: 'gitlab-projects', optional: ['GITLAB_TOKEN'], params: { topic: 'artificial-intelligence', perPage: 20 }, scope: 'ai', quota: { perDay: 1440, requestsPerRun: 1, basis: 'gitlab.com: 60 requests/hour unauthenticated (5,000 with a token)' } },
            { id: 'forum-latest', adapter: 'discourse', params: { baseUrl: 'https://forum.gitlab.com' }, scope: 'filter' },
        ],
        linkHosts: ['gitlab.com'],
        termsUrl: 'https://docs.gitlab.com/user/gitlab_com/rate_limits/',
        termsNote: 'Unauthenticated 60 requests/hour, 5,000/hour with a token; the website terms ban scraping, the API is the sanctioned route.',
        rateLimit: { minIntervalMs: 2000, note: '60 requests/hour unauthenticated' },
        // D4: one gitlab.com API request per run (the forum is another host):
        // 150 s = 24/hour, inside the 60/hour keyless quota.
        pollIntervalSec: DEFAULT_POLL_SEC,
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
        linkHosts: ['docker.com'],
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
        linkHosts: ['huggingface.co'],
        termsUrl: 'https://huggingface.co/docs/hub/rate-limits',
        termsNote: 'Anonymous 500 requests / 5 minutes; the undocumented /api/posts list is not used.',
        rateLimit: { minIntervalMs: 700, note: '500 requests / 5 minutes' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },

    // ── 7. Forums (3) — SO and HN moved from Developer in Rev. 3; Reddit #52 in Rev. 4
    {
        rank: 45, slug: 'stack_overflow', name: 'Stack Overflow', category: 'forums', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: { kind: 'none', program: 'Stack Exchange API 2.3 (free key raises the quota)', signup: 'https://stackapps.com/apps/oauth/register' },
        closedStatus: 'awaiting_key',
        routes: [{
            id: 'questions', adapter: 'stackexchange', optional: ['STACKEXCHANGE_KEY'],
            params: { sites: [{ site: 'stackoverflow', tagged: 'artificial-intelligence' }, { site: 'ai' }], pageSize: 30 }, scope: 'ai',
            // D4 exception (reported): keyless quota 300/day at 2 requests
            // per run needs >= 576 s; with STACKEXCHANGE_KEY (10,000/day)
            // the 150 s band fits.
            quota: { perDay: 300, perDayWithKey: 10000, requestsPerRun: 2, basis: 'Stack Exchange API: 300/day without a key, 10,000 with one', cannotFitBandWithoutKey: true },
        }],
        pollIntervalSecWithEnv: { STACKEXCHANGE_KEY: DEFAULT_POLL_SEC },
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        attribution: 'Stack Exchange (CC BY-SA 4.0)',
        linkHosts: ['stackoverflow.com', 'stackexchange.com'],
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
        linkHosts: ['ycombinator.com'],
        termsUrl: 'https://github.com/HackerNews/API',
        termsNote: 'No documented rate limit on the Firebase API; Algolia about 10,000 requests/hour per IP.',
        rateLimit: { minIntervalMs: 1000, note: 'polite spacing' },
        pollIntervalSec: DEFAULT_POLL_SEC,
    },
    // Rev. 4 (2026-09-29): Reddit is #52 but sits in the Forums block, so the
    // registry keeps the workbook's sheet order (…, 46, 52, 47, …).
    // Research: docs/research/2026-09-29-reddit-access.md. Rulings (ADR 0001
    // rulings 8 and 9): curated AI subreddits; the approved OAuth Data API
    // only (robots.txt governs crawling, and reddit.com pages are never
    // fetched); the top 7 subreddits mentioning AI, ranked by subscribers
    // (src/collectors/reddit/selection.js); redacted text shown like every
    // other source; built now, closed until Reddit approves; text blanked
    // at 48 h or on upstream deletion, audit rows kept.
    {
        rank: 52, slug: 'reddit', name: 'Reddit', category: 'forums', region: 'global', homeCity: null,
        sourceType: 'api',
        auth: {
            kind: 'approval',
            program: 'Reddit Data API, non-commercial developer access (approval required by the Responsible Builder Policy)',
            signup: 'https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164',
        },
        closedStatus: 'awaiting_approval', ruling: REDDIT_RULING,
        routes: [{
            id: 'data-api', adapter: 'reddit',
            quota: { perMinute: 100, requestsPerRun: 25, basis: 'Reddit: 100 queries/minute per OAuth client id, averaged over 10 minutes; shared budget src/collectors/reddit/budget.js' },
            requires: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT', 'REDDIT_API_APPROVAL_REF'],
            optional: ['REDDIT_MIN_AI_POSTS_7D'],
            // Submissions only; the 48 h retention window is also the age cap.
            params: { limit: 100, maxPagesPerSubreddit: 3, maxAgeDays: 2 }, scope: 'filter',
            note: 'Application-only OAuth (client_credentials) at www.reddit.com/api/v1/access_token, then '
                + '/r/{sub}/new on oauth.reddit.com for the 7 selected subreddits; the AI filter every site-wide feed uses',
        }],
        linkHosts: ['reddit.com'],
        termsUrl: 'https://redditinc.com/policies/data-api-terms',
        termsNote: 'Reddit Data API Terms and Developer Terms, Responsible Builder Policy: explicit approval before any API access; '
            + 'non-commercial, ad-free use; no model training; no inference of sensitive user traits; delete content removed '
            + 'from Reddit (Reddit recommends within 48 hours). robots.txt disallows all crawling, so reddit.com pages are never fetched.',
        attribution: 'Reddit',
        // ADR 0001 ruling 9 (Jennifer, 2026-09-29: "Blank text, keep audit
        // rows"): at 48 h, or when the 6-hourly re-check sees a post deleted
        // or removed upstream, its TEXT is replaced by the removal notice; the
        // row, scores and audit trail are kept (src/collectors/retention.js).
        retention: {
            maxAgeHours: 48,
            recheckHours: 6,
            removalNotice: '[removed: Reddit Data API Terms retention]',
            // The stored permalink's slug is made from the title: cut to the
            // slug-less form on removal (every other source's url is removed).
            keepUrlPrefix: '^https://www\\.reddit\\.com/r/[A-Za-z0-9_]+/comments/[a-z0-9]+/',
            legalBasis: 'Reddit Data API Terms and Developer Terms §3.3: user content deleted from Reddit must be deleted, '
                + 'and Reddit strongly recommends deleting stored user data and content within 48 hours '
                + '(Reddit Data API Wiki, Rules). Text removed; the score and audit rows are retained by owner decision '
                + '(ADR 0001 ruling 9, "Blank text, keep audit rows"), an accepted risk against the terms.',
            notice: 'Reddit post text is removed 48 hours after collection, or sooner when the post is deleted or removed '
                + 'on Reddit, because of the Reddit Data API Terms; its scores and audit rows are retained by owner decision.',
        },
        rateLimit: { minIntervalMs: 700, note: '100 queries per minute per OAuth client id, averaged over 10 minutes (shared budget: src/collectors/reddit/budget.js)' },
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
        rateLimit: { minIntervalMs: 1000, note: 'conditional GET; HTTP 429 Retry-After honoured as a hold (src/collectors/http.js)' },
        // Diagnosis 2026-10-01: tldr.tech rate-limits (HTTP 429, Retry-After
        // >= 60 s) a 150 s poll of this once-a-day newsletter feed. 180 s is
        // the top of the D4 band (2–3 minutes), never outside it.
        pollIntervalSec: 180,
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
        linkHosts: ['substack.com'],
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
        routes: [{ id: 'ai-rss', adapter: 'rss', requires: [PERMISSION_GATED_ACK_ENV], permissionGated: true, params: { urls: ['https://arstechnica.com/ai/feed/'] }, scope: 'ai' }],
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
        linkHosts: ['oneusefulthing.org'],
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

// ─── Freshness (P10-8) ───────────────────────────────────────────────────────
// expectedNewWithinHours: a collecting source that stored no NEW post for
// this long raises a 'source_stale' warning (src/collectors/source-health.js).
// Set per source from how often it publishes AI or technology items: wires
// and busy news feeds within hours, weekly research blogs within days, the
// delivered datasets within a week. Every entry carries the field.
const EXPECTED_NEW_WITHIN_HOURS = Object.freeze({
    whatsapp: 168, instagram: 168, youtube: 24, facebook: 168, tiktok: 24, wechat: 72, telegram: 72, x: 6,
    bbc_news: 24, nyt: 24, cnn: 24, guardian: 24, al_jazeera: 48, wsj: 24, ap: 12, reuters: 12, nbc_news: 48,
    washington_post: 24, npr: 48,
    springerlink: 48, arxiv: 24, pubmed: 48, sciencedirect: 72, google_scholar: 168, researchgate: 168, ieee_xplore: 72,
    jstor: 720,
    govinfo: 72, congress_gov: 72, cfr: 168, cato: 168, rand: 168, urban_institute: 336, pew: 336,
    wikipedia: 24, mozilla: 336, khan_academy: 720, owid: 336, openstreetmap: 168, internet_archive: 72,
    github: 12, gitlab: 24, docker_hub: 72, hugging_face: 24,
    stack_overflow: 48, hacker_news: 6, reddit: 12,
    tldr: 48, substack: 72, ars_technica: 48, one_useful_thing: 336, platformer: 168,
});
for (const s of SOURCES) s.expectedNewWithinHours = EXPECTED_NEW_WITHIN_HOURS[s.slug];

// ─── Environment catalogue ───────────────────────────────────────────────────
// Every env var the collectors read, with where to get it. .env.example and
// docker-compose.yml must list each one (tests/unit/pure/sourceEnv.test.js).
// group: the heading .env.example files it under.
const ENV_DOCS = {
    COLLECTOR_CONTACT_URL: { group: 'collector', signup: 'https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy', description: 'Contact URL placed in the collector User-Agent (required: collection is disabled without it)' },
    COLLECTORS_ENABLED: { group: 'kill-switch', signup: null, description: 'Global kill switch: false stops every collector' },
    COLLECTORS_DISABLED: { group: 'kill-switch', signup: null, description: 'Comma-separated source slugs to turn off (per-source kill switch)' },
    COLLECTORS_DISABLED_ROUTES: { group: 'kill-switch', signup: null, description: 'Comma-separated slug/route ids to turn off (per-route kill switch), e.g. hugging_face/forum-latest; the source\'s other routes keep collecting. Fails closed: an entry whose route is not a route of the source it names holds that whole source disabled, and an entry naming no registry source holds EVERY source disabled (Reddit\'s deletion re-checks pause too; its local 48 h text removal does not), until it is fixed' },
    COLLECT_WINDOW_MS: { group: 'collector', signup: null, description: 'Collection cycle length in ms (default 150000)' },
    GATE_APPROVED_BY: { group: 'collector', signup: null, description: 'Named approval ("<name> <YYYY-MM-DD>") required to open ANY gated source — one that needs a key, an approval, a licence or a permission (PR #22 decision G5). Without a valid value those sources stay closed ("awaiting named approval"); keyless sources are unaffected. It is recorded as the approver of every gate opening and of every database kill-switch change (source_gate_events). Empty keeps gated sources closed' },
    PERMISSION_GATED_FEEDS_ACCEPTED_BY: { group: 'collector', signup: null, description: 'Operator acknowledgement ("<name> <YYYY-MM-DD>") that opens the 8 permission-gated news feeds of ADR 0001 ruling 4 (BBC, NYT, Guardian, Al Jazeera, WSJ, NBC, Washington Post, Ars Technica): their terms require permission for automated analysis, and setting this records that you accept that legal risk. Empty keeps them closed' },
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
    REDDIT_CLIENT_ID: { group: 'approval', signup: 'https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164', description: 'Reddit Data API OAuth client id of the APPROVED app (register it at https://developers.reddit.com/app-registration once Reddit approves the request)' },
    REDDIT_CLIENT_SECRET: { group: 'approval', signup: 'https://developers.reddit.com/app-registration', description: 'Reddit OAuth client secret (secret; never logged or stored)' },
    REDDIT_USER_AGENT: { group: 'approval', signup: 'https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki', description: 'Reddit\'s required User-Agent, "<platform>:<app id>:<version> (by /u/<reddit username>)", e.g. server:pulse-of-ai:v1.0.0 (by /u/yourname); unique and truthful' },
    REDDIT_API_APPROVAL_REF: { group: 'approval', signup: 'https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy', description: 'Reddit\'s approval reference for the Data API request (the ticket or approval id)' },
    REDDIT_MIN_AI_POSTS_7D: { group: 'approval', signup: null, description: 'Subreddit selection: minimum AI-mentioning posts in the rolling 7 days for a subreddit to qualify (default 20)' },
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
    GUARDIAN_API_KEY: { group: 'paid', signup: 'https://bonobo.capi.gutools.co.uk/register/commercial', description: 'Guardian COMMERCIAL Content API key (paid tier; used only with GUARDIAN_COMMERCIAL_LICENSE_REF)' },
    GUARDIAN_COMMERCIAL_LICENSE_REF: { group: 'paid', signup: 'https://bonobo.capi.gutools.co.uk/register/commercial', description: 'Guardian commercial licence reference (the key alone is not the permission the Open Platform terms require)' },
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
    WECHAT_AUTHORIZED_FEED_HOST: { group: 'blocked', signup: 'https://weixin.qq.com/agreement?lang=en_US', description: 'Exact host named in Tencent\'s written authorization; the feed URL must be on this host (G10-17)' },
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
    // Fail closed: a COLLECTORS_DISABLED_ROUTES entry that names this source
    // with a route it does not have (a typo in a takedown) holds the whole
    // source off until the entry is fixed — never silently ignored. An entry
    // naming NO registry source cannot say which source it meant, so it holds
    // EVERY source off (security review F2: a slug typo must not fail open).
    const parsed = parseDisabledRoutes(env);
    if (parsed.invalid.length) {
        return `kill switch ${ROUTE_KILL_ENV} has ${parsed.invalid.length > 1 ? 'entries' : 'an entry'} naming no registry source `
            + `(${parsed.invalid.map(e => JSON.stringify(e)).join(', ')}); every source is held disabled until `
            + `${parsed.invalid.length > 1 ? 'they are' : 'it is'} fixed (entries are "slug/route")`;
    }
    const held = parsed.held.get(src.slug);
    if (held) {
        return `kill switch ${ROUTE_KILL_ENV} names ${held.map(e => JSON.stringify(e)).join(', ')}, which is not a route of ${src.slug} `
            + `(routes: ${src.routes.map(r => r.id).join(', ')}); the whole source is held disabled until the entry is fixed`;
    }
    return null;
}

// Registry route ids: lower-case letters, digits and hyphens (migration
// 073's source_route_state CHECK; tests/unit/pure/routeKillSwitch.test.js
// pins every registry route id to it).
const ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The registry route `routeId` of a source, or null — an exact id match only. */
function getRoute(src, routeId) {
    if (!src || typeof routeId !== 'string' || routeId === '') return null;
    return src.routes.find(r => r.id === routeId) || null;
}

// Invisible characters a copy-paste can carry into an env value: every Unicode format character (zero-width, bidi marks and overrides, isolates, word joiner, BOM, soft hyphen) plus the Mongolian vowel separator.
const INVISIBLE = /[\p{Cf}\u00AD\u180E]/gu;

/**
 * COLLECTORS_DISABLED_ROUTES parsed and validated against the registry
 * (never trusted from input): "slug/route" entries, comma-separated. Each
 * half is trimmed, stripped of invisible characters and lower-cased; in the
 * slug a hyphen reads as an underscore (hugging-face → hugging_face), in
 * the route an underscore as a hyphen — registry slugs never contain a
 * hyphen and route ids never an underscore, so this only ever resolves an
 * entry to the source and route it spells.
 * @returns {{ routes: Map<string, Set<string>>, held: Map<string, string[]>, invalid: string[] }}
 *   routes   slug → registry route ids switched off
 *   held     slug → entries naming a registry source with a route it does
 *            not have (killReason holds that source disabled — fail closed)
 *   invalid  entries naming no registry source (killReason holds EVERY
 *            source disabled — fail closed; the scheduler logs them too)
 */
function parseDisabledRoutes(env = process.env) {
    const out = { routes: new Map(), held: new Map(), invalid: [] };
    const raw = env ? env[ROUTE_KILL_ENV] : undefined;
    if (!nonEmpty(raw)) return out;
    for (const entry of raw.replace(INVISIBLE, '').split(',').map(s => s.trim()).filter(Boolean)) {
        const i = entry.indexOf('/');
        const slug = (i < 0 ? entry : entry.slice(0, i)).trim().toLowerCase().replace(/-/g, '_');
        const routeId = (i < 0 ? '' : entry.slice(i + 1)).trim().toLowerCase().replace(/_/g, '-');
        const src = BY_SLUG.get(slug);
        if (!src) { out.invalid.push(entry); continue; }
        if (!getRoute(src, routeId)) {
            if (!out.held.has(slug)) out.held.set(slug, []);
            out.held.get(slug).push(entry);
            continue;
        }
        if (!out.routes.has(slug)) out.routes.set(slug, new Set());
        out.routes.get(slug).add(routeId);
    }
    return out;
}

/**
 * Database route kill switches of a source whose route id is NOT a registry
 * route of it (a route renamed or removed since it was switched off). They
 * hold the whole source disabled (sourceStatus) until cleared with
 * `npm run source:enable -- <slug> --route <id>` — a recorded takedown never
 * fails open (security review F3).
 * @returns {string[]} the stale route ids, sorted
 */
function staleRouteKills(src, dbKills = []) {
    return [...new Set((dbKills || [])
        .filter(k => k && k.disabled_at && typeof k.route_id === 'string' && !getRoute(src, k.route_id))
        .map(k => k.route_id))].sort();
}

/** The date part (UTC) of a timestamp, or null. */
function utcDate(t) {
    const d = t ? new Date(t) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

/**
 * The route kill switches of a source: the database switch (rows of
 * source_route_state with collection_disabled_at set — `dbKills`) and the
 * env list (COLLECTORS_DISABLED_ROUTES). Only registry routes count here;
 * staleRouteKills() has the others.
 * @param {object} src
 * @param {object} [env]
 * @param {Array<{ route_id: string, disabled_at: *, reason?: string|null, by?: string|null }>} [dbKills]
 * @returns {Map<string, string>} route id → reason, in registry route order
 */
function routeKillReasons(src, env = process.env, dbKills = []) {
    const db = new Map();
    for (const k of dbKills || []) {
        if (k && k.disabled_at && getRoute(src, k.route_id)) db.set(k.route_id, k);
    }
    const listed = parseDisabledRoutes(env).routes.get(src.slug) || new Set();
    const out = new Map();
    for (const r of src.routes) {
        const k = db.get(r.id);
        if (k) {
            const since = utcDate(k.disabled_at);
            out.set(r.id, `kill switch (database): route disabled${since ? ` since ${since}` : ''}${k.by ? ` by ${k.by}` : ''}`
                + `${k.reason ? ` — ${k.reason}` : ''}`);
        } else if (listed.has(r.id)) {
            out.set(r.id, `kill switch ${ROUTE_KILL_ENV} lists ${src.slug}/${r.id}`);
        }
    }
    return out;
}

/** G5: a gated route needs a key, approval, licence or permission (any `requires`). */
function isGatedRoute(route) {
    return (route.requires || []).length > 0;
}

/**
 * G5: the named approval in GATE_APPROVED_BY — "Name YYYY-MM-DD": a name
 * (at least two characters, with a letter, not a placeholder such as "Name"
 * or "<your name>") then a real calendar date.
 * @returns {{ ok: true, value: string, name: string, date: string } | { ok: false, reason: string }}
 */
function namedApproval(env = process.env) {
    const raw = env ? env[GATE_APPROVAL_ENV] : undefined;
    if (!nonEmpty(raw)) return { ok: false, reason: `${GATE_APPROVAL_ENV} is not set` };
    const bad = { ok: false, reason: `${GATE_APPROVAL_ENV} is not "Name YYYY-MM-DD"` };
    // Re-review F10 / Copilot: control and format characters (newlines,
    // tabs, escapes, bidi overrides) inside the value would spoof the
    // recorded actor wherever it is shown — checked BEFORE spaces are
    // normalised, which would otherwise erase a newline or tab.
    if (/[\p{Cc}\p{Cf}]/u.test(raw.trim())) return bad;
    const v = raw.trim().replace(/ +/g, ' ');
    const m = v.match(/^(.+) (\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return bad;
    const name = m[1].trim();
    if (name.length < 2 || !/\p{L}/u.test(name) || /^(name|your name|approver|operator|todo|tbd|changeme|x+)$/i.test(name) || /[<>{}$]/.test(name)) return bad;
    const [y, mo, d] = [Number(m[2]), Number(m[3]), Number(m[4])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (y < 2000 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return bad;
    return { ok: true, value: v, name, date: `${m[2]}-${m[3]}-${m[4]}` };
}

/** Routes whose env vars are all set (before G5 approval and `replaces`). */
function configuredRoutes(src, env) {
    return src.routes.filter(r => (r.requires || []).every(k => nonEmpty(env[k])));
}

/**
 * The routes that would run now BEFORE the route kill switches: every route
 * whose required env vars are all set — and, for a gated route, with a valid
 * named approval (G5) — minus routes superseded by another such route
 * (`replaces`).
 */
function candidateRoutes(src, env) {
    const approved = namedApproval(env).ok;
    const open = configuredRoutes(src, env).filter(r => approved || !isGatedRoute(r));
    const replaced = new Set(open.flatMap(r => r.replaces || []));
    return open.filter(r => !replaced.has(r.id));
}

/**
 * The routes that would run now: candidateRoutes minus the routes switched
 * off by a route kill switch (env COLLECTORS_DISABLED_ROUTES, or the
 * database rows passed as `routeKills`). `replaces` is resolved first, so a
 * killed route never reopens the route it replaced.
 * @param {object} src
 * @param {object} [env]
 * Fails closed on its own (re-review N1/N3): a route-kill hold — an env
 * entry naming no registry source or an unknown route of this one, or a
 * database row naming a route the registry no longer has — leaves no open
 * route, so buildCollectors builds nothing even for a caller that skipped
 * sourceStatus.
 * @param {{ routeKills?: object[] }} [o]  source_route_state rows (src/collectors/state.js routeKillSwitches)
 */
function openRoutes(src, env = process.env, { routeKills = [] } = {}) {
    const parsed = parseDisabledRoutes(env);
    if (parsed.invalid.length || parsed.held.has(src.slug) || staleRouteKills(src, routeKills).length) return [];
    const killed = routeKillReasons(src, env, routeKills);
    return candidateRoutes(src, env).filter(r => !killed.has(r.id));
}

/** G5: routes fully configured but closed only for want of a named approval (killed routes excluded). */
function routesAwaitingApproval(src, env = process.env, { routeKills = [] } = {}) {
    if (namedApproval(env).ok) return [];
    const killed = routeKillReasons(src, env, routeKills);
    return configuredRoutes(src, env).filter(r => isGatedRoute(r) && !killed.has(r.id));
}

/**
 * Gate status of a source under an environment (and, when given, the
 * database route kill switches `routeKills`).
 * @returns {{ status: string, reason: string, openRoutes: string[],
 *             missing: string[], recorded: object, awaitingApproval: string[],
 *             approvedBy: string|null, disabledRoutes: string[],
 *             routes: Array<{ id: string, status: 'open'|'disabled'|'closed', reason: string }> }}
 *   missing: env vars the closed routes still need (for the UI and smoke).
 *   openRoutes: the routes that run now — empty unless the source is
 *     'collecting' (a disabled source has no open route).
 *   disabledRoutes / routes: the per-route kill switch state and each
 *     route's status and reason.
 */
function sourceStatus(src, env = process.env, { routeKills = [] } = {}) {
    const kills = routeKillReasons(src, env, routeKills);
    const candidates = candidateRoutes(src, env);
    const routes = candidates.filter(r => !kills.has(r.id));
    // A killed route's missing env vars do not matter: it would not run.
    const missing = [...new Set(src.routes
        .filter(r => !routes.includes(r) && !kills.has(r.id))
        .flatMap(r => (r.requires || []).filter(k => !nonEmpty(env[k]))))];
    const recorded = {};
    for (const k of src.recordEnv || []) recorded[k] = nonEmpty(env[k]);
    // G5: configured gated routes held back for want of a named approval.
    const pending = routesAwaitingApproval(src, env, { routeKills });
    if (pending.length && !missing.includes(GATE_APPROVAL_ENV)) missing.push(GATE_APPROVAL_ENV);
    const approval = namedApproval(env);
    const killNote = kills.size
        ? `; route${kills.size > 1 ? 's' : ''} disabled: ${[...kills].map(([id, why]) => `${id} (${why})`).join('; ')}`
        : '';

    const finish = (status, reason) => {
        const collecting = status === 'collecting';
        const open = collecting ? routes : [];
        return {
            openRoutes: open.map(r => r.id), missing, recorded,
            awaitingApproval: pending.map(r => r.id),
            // The approver of the open gated routes (governance records only;
            // never served by the API), or null.
            approvedBy: approval.ok && open.some(isGatedRoute) ? approval.value : null,
            disabledRoutes: [...kills.keys()],
            routes: src.routes.map(r => routeEntry(src, r, { env, kills, open, candidates, pending, status })),
            status,
            reason,
        };
    };

    const killed = killReason(src, env);
    if (killed) return finish('disabled', killed);
    // A database route kill naming a route the registry no longer has holds
    // the whole source (fail closed, security review F3).
    const stale = staleRouteKills(src, routeKills);
    if (stale.length) {
        return finish('disabled', `kill switch (database) names route${stale.length > 1 ? 's' : ''} ${stale.join(', ')}, which `
            + `${stale.length > 1 ? 'are' : 'is'} not a route of ${src.slug} (routes: ${src.routes.map(r => r.id).join(', ')}); the whole `
            + `source is held disabled until it is cleared with npm run source:enable -- ${src.slug} --route <id>`);
    }
    // Blocked is a property of the source's terms, not of this process's
    // config: it is reported as blocked whatever else is (un)set.
    if (src.auth.kind === 'blocked' && routes.length === 0 && pending.length === 0) {
        return finish('blocked', `blocked: no compliant access — ${src.blocked.reason}`);
    }
    if (!nonEmpty(env.COLLECTOR_CONTACT_URL)) {
        return finish('disabled', 'COLLECTOR_CONTACT_URL is not set (the User-Agent must carry a contact URL)');
    }
    if (routes.length > 0) {
        const gated = routes.some(r => r.permissionGated);
        const reason = src.auth.kind === 'blocked'
            ? 'collecting under the official permission recorded in env'
            : gated && src.ruling
                ? `${src.ruling} Opened on this installation by the operator's acknowledgement (${PERMISSION_GATED_ACK_ENV}).`
                : `collecting via ${routes.map(r => r.id).join(', ')}`;
        // A source with some routes switched off still collects; the
        // reason names the routes that are off and why.
        return finish('collecting', `${reason}${killNote}`);
    }
    // Every route that would run (or every route of the source) is switched
    // off by a route kill switch: the source is disabled, not "awaiting".
    if (kills.size && (candidates.length > 0 || src.routes.every(r => kills.has(r.id)))) {
        return finish('disabled', `every route that would run is switched off by a route kill switch — ${[...kills].map(([id, why]) => `${id} (${why})`).join('; ')}`);
    }
    if (pending.length) {
        return finish(src.closedStatus,
            `${AWAITING_NAMED_APPROVAL}: ${pending.map(r => r.id).join(', ')} ${pending.length > 1 ? 'are configured but stay' : 'is configured but stays'} `
                + `closed until a named person approves opening ${pending.length > 1 ? 'them' : 'it'} in ${GATE_APPROVAL_ENV} ("Name YYYY-MM-DD"; `
                + `${approval.reason}). PR #22 decision G5.${killNote}`);
    }
    if (src.routes.some(r => r.permissionGated)) {
        return finish(src.closedStatus,
            `permission-gated feed (ADR 0001 ruling 4): closed until the operator records acceptance of the legal risk in ${PERMISSION_GATED_ACK_ENV}`
                + `, or the licensed route is configured (waiting for ${missing.join(', ')}; ${src.auth.program})${killNote}`);
    }
    return finish(src.closedStatus, `waiting for ${missing.join(', ')} (${src.auth.program})${killNote}`);
}

/** One route's status and reason for sourceStatus().routes. */
function routeEntry(src, r, { env, kills, open, candidates, pending, status }) {
    if (kills.has(r.id)) return { id: r.id, status: 'disabled', reason: kills.get(r.id) };
    if (open.includes(r)) return { id: r.id, status: 'open', reason: 'collecting' };
    if (candidates.includes(r)) return { id: r.id, status: 'closed', reason: `the source is ${status.replace(/_/g, ' ')}` };
    if (pending.includes(r)) return { id: r.id, status: 'closed', reason: `${AWAITING_NAMED_APPROVAL} (${GATE_APPROVAL_ENV})` };
    const unset = (r.requires || []).filter(k => !nonEmpty(env[k]));
    if (unset.length) return { id: r.id, status: 'closed', reason: `waiting for ${unset.join(', ')}` };
    const by = candidates.find(o => (o.replaces || []).includes(r.id));
    return { id: r.id, status: 'closed', reason: by ? `replaced by ${by.id}` : `the source is ${status.replace(/_/g, ' ')}` };
}

/**
 * P10-2: hours a source's post TEXT is kept (src/collectors/retention.js).
 * A platform-terms window (Reddit 48 h, YouTube and TikTok 30 days) where
 * the source has one, else the spec §19 detail window (the Guardian since
 * Jennifer's ruling of 2026-09-29, "Use normal retention"):
 * RETENTION_DETAIL_DAYS (default 90) days.
 */
function retentionHours(src, env = process.env) {
    if (src && src.retention && src.retention.maxAgeHours > 0) return src.retention.maxAgeHours;
    return retentionDetailDays(env) * 24;
}

// PR #22 security M1: ONE strict parser for every retention window. The
// maintenance job acts on these values irreversibly every few minutes, so a
// bad value (0, negative, "1e3" which parseInt reads as 1, text, below the
// safe minimum) THROWS a clear error: the destructive step fails and changes
// nothing. It never falls back to another value. Unset or empty means the
// documented default.
const RETENTION_DETAIL_DAYS_DEFAULT = 90;
const RETENTION_DETAIL_DAYS_MIN = 30;
const RETENTION_WINDOW_DAYS_MAX = 3650;

/**
 * @param {object} env
 * @param {{ name: string, def: number, min: number, max?: number }} o
 * @returns {number} whole days
 */
function retentionWindowDays(env, { name, def, min, max = RETENTION_WINDOW_DAYS_MAX }) {
    const raw = env ? env[name] : undefined;
    if (raw === undefined || raw === null || String(raw).trim() === '') return def;
    const t = String(raw).trim();
    const n = /^\d+$/.test(t) ? Number(t) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
        throw new Error(`${name}=${JSON.stringify(t)} is not a valid retention window: a whole number of days from ${min} `
            + `to ${max} is required (unset means ${def}). Nothing is removed until it is fixed.`);
    }
    return n;
}

/** The spec §19 detail window in days (RETENTION_DETAIL_DAYS, default 90, minimum 30). */
function retentionDetailDays(env = process.env) {
    return retentionWindowDays(env, { name: 'RETENTION_DETAIL_DAYS', def: RETENTION_DETAIL_DAYS_DEFAULT, min: RETENTION_DETAIL_DAYS_MIN });
}

/**
 * Effective seconds between runs. D4 (Jennifer, 2026-09-29: "Keep 2–3
 * minutes for all"): the source's cadence (150 s, the band) unless an OPEN
 * route's documented quota needs longer (route.pollIntervalSec, e.g. NYT
 * Article Search at 180 s for 500/day), in which case the longest such
 * route governs. A key can shorten a keyless cadence (pollIntervalSecWithEnv).
 * `routeKills`: the database route kill switches (a killed route's quota
 * no longer governs).
 */
function pollIntervalSec(src, env = process.env, { routeKills = [] } = {}) {
    for (const [k, sec] of Object.entries(src.pollIntervalSecWithEnv || {})) {
        if (nonEmpty(env[k])) return sec;
    }
    const base = src.pollIntervalSec || DEFAULT_POLL_SEC;
    const routes = openRoutes(src, env, { routeKills });
    return Math.max(base, ...routes.map(r => r.pollIntervalSec || 0));
}

// D4 band: every cadence is 2–3 minutes, except the routes whose DOCUMENTED
// quota cannot be met even at 180 s (reported to Jennifer, ADR 0001 D4).
// Used by quotaAudit, a test-time audit (see there).
const CADENCE_BAND_SEC = Object.freeze({ min: 120, max: 180 });

/**
 * The quota audit for one route: runs/day at its cadence against its
 * documented caps. A TEST-TIME audit (PR #22 grumpy NIT 18): the D4 cadence
 * decision is enforced by tests/unit/pure/sourceRegistry.test.js running it
 * over every route (with CADENCE_BAND_SEC); nothing at runtime serves it. @returns {null | { route, intervalSec, runsPerDay,
 * requestsPerDay, perDay, fitsQuota, inBand, minIntervalSec, note }}
 */
function quotaAudit(src, route, env = {}) {
    const q = route.quota;
    if (!q) return null;
    const keyed = Object.keys(src.pollIntervalSecWithEnv || {}).some(k => nonEmpty(env[k]));
    const intervalSec = keyed ? pollIntervalSec(src, env) : Math.max(src.pollIntervalSec || DEFAULT_POLL_SEC, route.pollIntervalSec || 0);
    const perRun = q.requestsPerRun || 1;
    const perDay = keyed && q.perDayWithKey ? q.perDayWithKey : q.perDay || null;
    const runsPerDay = Math.floor(86400 / intervalSec);
    const minByDay = perDay ? Math.ceil((86400 * perRun) / perDay) : 0;
    const minByMinute = q.perMinute ? Math.ceil((60 * perRun) / q.perMinute) : 0;
    const minIntervalSec = Math.max(minByDay, minByMinute);
    return {
        route: route.id, intervalSec, runsPerDay, requestsPerDay: runsPerDay * perRun, perDay,
        fitsQuota: intervalSec >= minIntervalSec,
        inBand: intervalSec >= CADENCE_BAND_SEC.min && intervalSec <= CADENCE_BAND_SEC.max,
        minIntervalSec, unpublished: !!q.unpublished, note: q.basis,
    };
}

// Collection window (the 2–3 minute cycle) with a guarded default: a
// missing, non-numeric or non-positive COLLECT_WINDOW_MS falls back to 150 s.
const DEFAULT_COLLECT_WINDOW_MS = DEFAULT_POLL_SEC * 1000;
function collectWindowMs(env = process.env) {
    const n = parseInt(env.COLLECT_WINDOW_MS || '', 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_COLLECT_WINDOW_MS;
}

/** Every env var referenced by the registry, with its docs entry. */
function registryEnvVars() {
    const names = new Set(['COLLECTOR_CONTACT_URL', 'COLLECTORS_ENABLED', 'COLLECTORS_DISABLED', ROUTE_KILL_ENV, 'COLLECT_WINDOW_MS', GATE_APPROVAL_ENV]);
    for (const s of SOURCES) {
        for (const r of s.routes) for (const k of [...(r.requires || []), ...(r.optional || [])]) names.add(k);
        for (const k of s.recordEnv || []) names.add(k);
        for (const k of Object.keys(s.pollIntervalSecWithEnv || {})) names.add(k);
    }
    names.add('REUTERS_CONNECT_TOKEN_URL');
    names.add('REUTERS_CONNECT_API_URL');
    return [...names];
}

// ─── Allowed hosts (F10-2) ───────────────────────────────────────────────────
// Every request and every redirect hop of a route must stay on the route's
// own hosts (src/collectors/http.js; a leading "www." is ignored both ways).
// They are DERIVED, never free-form: the hosts of the route's own URLs
// (params.urls, params.baseUrl), the documented API host of its adapter
// (ADAPTER_HOSTS below), and — for contract or permission routes whose
// endpoint comes from env — the host of that env URL. This also hard-enforces
// the blocked-4 boundary: a redirect from any other feed into cato.org,
// researchgate.net, telegram.org or weixin.qq.com is refused.
const ADAPTER_HOSTS = Object.freeze({
    youtube: ['www.googleapis.com'],
    'tiktok-research': ['open.tiktokapis.com'],
    'x-recent-search': ['api.x.com'],
    'meta-content-library': [],
    'nyt-article-search': ['api.nytimes.com'],
    'guardian-content-api': ['content.guardianapis.com'],
    'ap-media': ['api.ap.org'],
    'reuters-connect': ['auth.thomsonreuters.com', 'api.reutersconnect.com'],
    'licensed-feed': [],
    arxiv: ['export.arxiv.org'],
    pubmed: ['eutils.ncbi.nlm.nih.gov'],
    springer: ['api.springernature.com'],
    elsevier: ['api.elsevier.com'],
    ieee: ['ieeexploreapi.ieee.org'],
    'jstor-dataset': [],
    'scholar-imap': [],
    'govinfo-search': ['api.govinfo.gov'],
    congress: ['api.congress.gov'],
    pew: ['www.pewresearch.org'],
    'wikipedia-talk': ['en.wikipedia.org'],
    'internet-archive': ['archive.org'],
    'github-search': ['api.github.com'],
    'gitlab-projects': ['gitlab.com'],
    'dockerhub-namespace': ['hub.docker.com'],
    'hf-daily-papers': ['huggingface.co'],
    discourse: [],
    stackexchange: ['api.stackexchange.com'],
    'hn-algolia': ['hn.algolia.com'],
    // API calls go to oauth.reddit.com only; www.reddit.com is allowed for the
    // token endpoint alone (the collector narrows each call to its one host).
    reddit: ['oauth.reddit.com', 'www.reddit.com'],
    rss: [],
    'blocked-wechat': [],
    'blocked-telegram': ['api.telegram.org'],
    'blocked-researchgate': [],
    'blocked-cato': [],
});

// Env URLs that name a route's endpoint (contract feeds, overrides).
const ROUTE_URL_ENV = Object.freeze({
    'licensed-feed': route => (route.requires || []).filter(k => k.endsWith('_FEED_URL')),
    // G10-17: WeChat's allowed host is the one Tencent's authorization NAMES,
    // not whatever host the feed URL points at.
    'blocked-wechat': () => ['WECHAT_AUTHORIZED_FEED_HOST'],
    'reuters-connect': () => ['REUTERS_CONNECT_TOKEN_URL', 'REUTERS_CONNECT_API_URL'],
});

const hostOf = (u) => {
    try {
        return new URL(u).hostname.toLowerCase();
    } catch {
        return null;
    }
};

/**
 * The hosts one route may contact.
 * @param {object} route
 * @param {object} [env]
 * @returns {string[]}
 */
function routeAllowedHosts(route, env = process.env) {
    const hosts = new Set(ADAPTER_HOSTS[route.adapter] || []);
    const p = route.params || {};
    for (const u of [...(p.urls || []), ...(p.baseUrl ? [p.baseUrl] : [])]) {
        const h = hostOf(u);
        if (h) hosts.add(h);
    }
    const envNames = ROUTE_URL_ENV[route.adapter] ? ROUTE_URL_ENV[route.adapter](route) : [];
    for (const k of envNames) {
        if (!nonEmpty(env[k])) continue;
        const v = env[k].trim();
        const h = k.endsWith('_HOST') ? v.toLowerCase() : hostOf(v);
        if (h) hosts.add(h);
    }
    return [...hosts].sort();
}

/** Union of a source's route hosts (the registry's per-source allowedHosts). */
function allowedHosts(src, env = process.env) {
    return [...new Set(src.routes.flatMap(r => routeAllowedHosts(r, env)))].sort();
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
    'COLLECTOR_CONTACT_URL', 'COLLECTORS_ENABLED', 'COLLECTORS_DISABLED', ROUTE_KILL_ENV, 'COLLECT_WINDOW_MS',
    'PERMISSION_GATED_FEEDS_ACCEPTED_BY', 'GATE_APPROVED_BY',
    'NCBI_TOOL', 'SCHOLAR_ALERTS_IMAP_PORT', 'SCHOLAR_ALERTS_MAILBOX',
    'REDDIT_MIN_AI_POSTS_7D',
]);

/** @returns {'setting'|'credential'} */
function envClass(name) {
    if (SETTING_ENV.includes(name) || /_REF$/.test(name) || /^SOURCE_[A-Z0-9_]+_ENABLED$/.test(name)) return 'setting';
    return 'credential';
}

module.exports = {
    ADAPTER_HOSTS,
    routeAllowedHosts,
    allowedHosts,
    PERMISSION_GATED_ACK_ENV,
    GATE_APPROVAL_ENV,
    AWAITING_NAMED_APPROVAL,
    namedApproval,
    isGatedRoute,
    routesAwaitingApproval,
    SETTING_ENV,
    envClass,
    AUTH_KINDS,
    GATE_STATUSES,
    SOURCE_TYPES,
    DEFAULT_POLL_SEC,
    SOURCES,
    ENV_DOCS,
    getSource,
    killSwitchEnv,
    killReason,
    ROUTE_KILL_ENV,
    ROUTE_ID_PATTERN,
    getRoute,
    parseDisabledRoutes,
    routeKillReasons,
    staleRouteKills,
    openRoutes,
    sourceStatus,
    pollIntervalSec,
    retentionHours,
    retentionDetailDays,
    retentionWindowDays,
    RETENTION_DETAIL_DAYS_MIN,
    RETENTION_DETAIL_DAYS_DEFAULT,
    quotaAudit,
    CADENCE_BAND_SEC,
    collectWindowMs,
    DEFAULT_COLLECT_WINDOW_MS,
    registryEnvVars,
};
