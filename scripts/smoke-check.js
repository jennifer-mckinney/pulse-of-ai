#!/usr/bin/env node
// scripts/smoke-check.js
// Post-standup smoke check + population summary. scripts/standup.sh runs it
// INSIDE the web container (`docker compose exec web node scripts/smoke-check.js`)
// so it needs no host tooling beyond Docker: it talks to the API on
// 127.0.0.1:$PORT and to the database through src/db/connection.
//
//   node scripts/smoke-check.js [--base-url URL] [--expect-embeddings] [--expect-worker]
//
// Checks (PASS / FAIL / WARN per line):
//   - GET /api/health → 200, db_connected true; its data_mode matches the
//     mode of what the GLOBE renders — the placed rows of
//     /api/posts/aggregated-by-location for the trailing hour (demo_posts /
//     total), not a re-run of health's own SQL — tolerating a demo batch
//     landing between the reads (G9-2)
//   - worker heartbeat: /api/health reports Redis reachable and the worker
//     alive (P9-7) — WARN by default, FAIL with --expect-worker (standup)
//   - worker failed jobs: every BullMQ queue in /api/health's worker.queues
//     has 0 failed jobs (a legitimately purged or blanked post completes as
//     a no-op, so any failure is a real error) — WARN by default, FAIL with
//     --expect-worker; unreadable counts are never read as 0
//   - GET / serves the story page (index.html + its main.js bundle)
//   - the page's own API calls return DATA, not just 200: aggregated cities
//     in the trailing hour (with coordinates), themes, latest bias job,
//     source timeseries, methodology registry, a city drill-down query
//   - population counts: posts, audit decisions, bias assessments, embeddings
//   - one receipt: GET /api/audit/:id has ≥3 decisions, each with all four
//     audience views (public / plain / config / researcher), and a bias block
//     with a lineage value
//   - `npm run replay -- --post <id>` on that post → RESULT: PASS
//
// Embeddings: a missing vector is WARN by default (standup continues without
// embeddings when the model could not be downloaded); --expect-embeddings
// makes it a FAIL.
//
//   - the source registry: GET /api/sources serves every registry source,
//     and the per-source collection status is printed (collecting / online,
//     awaiting key / approval / licence, blocked, disabled)
//   - live collection: WARN unless at least one source collected
//     successfully in the last hour
//
// The population summary labels the trailing hour LIVE (every post from a
// real registry source), DEMO (every post from a demo feed), MIXED or NONE,
// per category.
//
// Exit code: 0 when no check FAILed, 1 otherwise.

'use strict';

require('dotenv').config();

const { execFileSync } = require('child_process');
const db = require('../src/db/connection');
const { deriveDataMode } = require('../src/config/data-mode');
const { SOURCES } = require('../src/config/source-registry');

const AUDIENCES = ['public', 'plain', 'config', 'researcher'];
const LINEAGES = new Set(['recorded', 'inferred', 'current']);

function parseArgs(argv) {
    const opts = {
        baseUrl: `http://127.0.0.1:${process.env.PORT || 3000}`,
        expectEmbeddings: false,
        expectWorker: false,
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--base-url') opts.baseUrl = argv[++i];
        else if (argv[i] === '--expect-embeddings') opts.expectEmbeddings = true;
        else if (argv[i] === '--expect-worker') opts.expectWorker = true;
        else throw new Error(`unknown argument '${argv[i]}'`);
    }
    return opts;
}

/** Collects check results and prints them as they happen. */
function reporter(out) {
    const results = [];
    const record = (status, name, detail) => {
        results.push({ status, name, detail });
        out(`  [${status}] ${name}${detail ? ` — ${detail}` : ''}`);
    };
    return {
        results,
        pass: (n, d) => record('PASS', n, d),
        fail: (n, d) => record('FAIL', n, d),
        warn: (n, d) => record('WARN', n, d),
        failed: () => results.some(r => r.status === 'FAIL'),
    };
}

async function getJson(baseUrl, path, init) {
    const res = await fetch(baseUrl + path, { ...init, signal: AbortSignal.timeout(10000) });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, body };
}

/** Run one check; an exception inside it is a FAIL, never a crash. */
async function check(r, name, fn) {
    try {
        await fn();
    } catch (err) {
        r.fail(name, err.message);
    }
}

/**
 * Data mode of the rows the globe renders: rows WITH coordinates (the
 * frontend drops the rest), demo_posts summed against total.
 * @param {object[]} rows  /api/posts/aggregated-by-location body
 * @returns {{ posts: number, demo: number, mode: string }}
 */
function modeOfAggregatedRows(rows) {
    let posts = 0;
    let demo = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || row.lat === null || row.lat === undefined) continue;
        const t = Number(row.total) || 0;
        posts += t;
        demo += Math.min(Number(row.demo_posts) || 0, t);
    }
    return { posts, demo, mode: deriveDataMode(demo, posts) };
}

/**
 * Compare /api/health data_mode with the globe's rows, race-tolerantly: the
 * demo feed may land a batch (or posts may age out of the hour) between two
 * reads, so each attempt reads globe → health → globe and passes when
 * health matches EITHER globe snapshot. A disagreement that survives every
 * attempt is a real mismatch.
 * @param {{ readAggregated: () => Promise<{posts, demo, mode}>,
 *           readHealthMode: () => Promise<string>,
 *           attempts?: number, delayMs?: number }} io
 * @returns {Promise<{ ok: boolean, health: string, expected: string, globe: object }>}
 */
async function checkDataMode({ readAggregated, readHealthMode, attempts = 3, delayMs = 2000 }) {
    let last = null;
    for (let i = 0; i < attempts; i++) {
        if (i > 0 && delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        const before = await readAggregated();
        const health = await readHealthMode();
        const after = await readAggregated();
        if (health === before.mode) return { ok: true, health, expected: before.mode, globe: before };
        if (health === after.mode) return { ok: true, health, expected: after.mode, globe: after };
        last = { ok: false, health, expected: after.mode, globe: after };
    }
    return last;
}

/**
 * 0 failed jobs on every queue of /api/health's worker.queues. Counts that
 * could not be read (null) are not a pass.
 * @param {Record<string, { failed: number }>|null} queues
 * @returns {{ ok: boolean, detail: string }}
 */
function failedJobsVerdict(queues) {
    if (!queues || typeof queues !== 'object') {
        return { ok: false, detail: 'queue counts unavailable from /api/health (redis unreachable or the read timed out)' };
    }
    const failed = Object.entries(queues)
        .map(([name, c]) => [name, Number(c && c.failed) || 0])
        .filter(([, n]) => n > 0);
    if (failed.length === 0) return { ok: true, detail: `0 failed jobs on ${Object.keys(queues).length} queues` };
    return { ok: false, detail: failed.map(([name, n]) => `${name}: ${n} failed`).join(', ') };
}

async function counts() {
    const one = async (sql) => (await db.dbGet(sql)).n;
    return {
        posts:          await one('SELECT COUNT(*)::int AS n FROM raw_posts'),
        postsLastHour:  await one(`SELECT COUNT(*)::int AS n FROM raw_posts
                                   WHERE collected_at >= NOW() - INTERVAL '1 hour'`),
        demoPosts:      await one(`SELECT COUNT(*)::int AS n FROM raw_posts rp
                                   JOIN data_sources ds ON ds.id = rp.source_id
                                   WHERE ds.source_type = 'demo'`),
        decisions:      await one('SELECT COUNT(*)::int AS n FROM decision_audit_log'),
        bias:           await one('SELECT COUNT(*)::int AS n FROM bias_assessments'),
        embeddings:     await one('SELECT COUNT(*)::int AS n FROM post_embeddings'),
        cities:         await one(`SELECT COUNT(DISTINCT location)::int AS n FROM raw_posts
                                   WHERE location <> ''`),
        categories:     await one(`SELECT COUNT(DISTINCT ds.category)::int AS n
                                   FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id`),
    };
}

async function run(opts, out) {
    const r = reporter(out);
    const base = opts.baseUrl;
    out(`Smoke check against ${base}`);

    // ── API + frontend ───────────────────────────────────────────────────────
    await check(r, 'GET /api/health', async () => {
        const { status, body } = await getJson(base, '/api/health');
        if (status === 200 && body && body.db_connected === true) {
            r.pass('GET /api/health', `200, db_connected true, status ${body.status}`);
        } else {
            r.fail('GET /api/health', `status ${status}, db_connected ${body && body.db_connected}`);
        }
    });

    // The API must SAY where the data came from (the page's DEMO kicker and
    // "Demo data" markers read this): /api/health data_mode must match the
    // mode of what the globe renders (G9-2).
    await check(r, 'data mode reported', async () => {
        let health = null;
        const result = await checkDataMode({
            readAggregated: async () => {
                // A fresh `from` per read: a new query string, so the
                // route's 10 s response cache never serves a stale snapshot.
                const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
                const res = await getJson(base,
                    `/api/posts/aggregated-by-location?from=${encodeURIComponent(since)}`);
                if (res.status !== 200) throw new Error(`aggregated-by-location status ${res.status}`);
                return modeOfAggregatedRows(res.body);
            },
            readHealthMode: async () => {
                health = (await getJson(base, '/api/health')).body;
                return health && health.data_mode;
            },
            attempts: opts.dataModeAttempts || 3,
        });
        (result.ok ? r.pass : r.fail)('data mode reported',
            `/api/health data_mode '${result.health}'${result.ok ? ' matches' : ` but`} the globe's rows `
            + `('${result.expected}': ${result.globe.demo} of ${result.globe.posts} placed trailing-hour posts `
            + `from demo feeds), ${health && health.active_sources} real active sources, `
            + `${health && health.demo_feeds} demo feeds`);
    });

    await check(r, 'worker heartbeat', async () => {
        const { body } = await getJson(base, '/api/health');
        const reachable = Boolean(body && body.redis && body.redis.reachable);
        const w = (body && body.worker) || {};
        if (reachable && w.alive) {
            r.pass('worker heartbeat', `redis reachable, last beat ${w.last_heartbeat}`);
            return;
        }
        const detail = reachable
            ? `redis reachable, worker not alive (last beat ${w.last_heartbeat || 'never'})`
            : 'redis NOT reachable from web';
        (opts.expectWorker ? r.fail : r.warn)('worker heartbeat', detail);
    });

    await check(r, 'worker failed jobs', async () => {
        const { body } = await getJson(base, '/api/health');
        const queues = body && body.worker ? body.worker.queues : null;
        const verdict = failedJobsVerdict(queues);
        (verdict.ok ? r.pass : (opts.expectWorker ? r.fail : r.warn))('worker failed jobs', verdict.detail);
    });

    // ── Source registry + per-source collection status ─────────────────────
    await check(r, 'source registry', async () => {
        const { status, body } = await getJson(base, '/api/sources');
        const reg = Array.isArray(body) ? body.filter(x => x && x.registry === true) : [];
        const count = (st) => reg.filter(x => x.status === st).length;
        const online = reg.filter(x => x.online).length;
        // G10-18: the registry's own size, not a hardcoded 51.
        (status === 200 && reg.length === SOURCES.length ? r.pass : r.fail)('source registry',
            `${reg.length}/${SOURCES.length} registry sources served — collecting ${count('collecting')} (online ${online}), `
            + `awaiting key ${count('awaiting_key')}, awaiting approval ${count('awaiting_approval')}, `
            + `awaiting licence ${count('awaiting_licence')}, blocked ${count('blocked')}, disabled ${count('disabled')}, `
            + `blocked by source ${count('blocked_by_source')}`);
        for (const x of reg) {
            const label = x.status === 'collecting' ? (x.online ? 'online' : 'collecting') : x.status.replace(/_/g, ' ');
            const last = x.last_success_at ? `, last ok ${new Date(x.last_success_at).toISOString().slice(11, 19)}Z, ${x.last_item_count} items` : '';
            const why = x.status === 'collecting' ? (x.last_error_kind ? `, last error: ${x.last_error_kind}${x.last_http_status ? ` (HTTP ${x.last_http_status})` : ''}` : '')
                : x.status === 'blocked' ? ' — blocked: no compliant access'
                    : x.status === 'blocked_by_source' ? ` — ${x.status_reason}` : ` — needs ${(x.missing_env || []).join(', ') || x.status_reason}`;
            out(`      ${String(x.rank).padStart(2)}. ${x.slug.padEnd(18)} ${x.category.padEnd(9)} ${label}${last}${why}`);
        }
        const collecting = count('collecting');
        if (collecting === 0) r.warn('live collection', 'no registry source is collecting (contact URL unset or every source switched off)');
        else if (online > 0) r.pass('live collection', `${online} of ${collecting} collecting sources succeeded in the last hour`);
        else r.warn('live collection', `${collecting} sources collecting, none has succeeded in the last hour yet`);
    });

    await check(r, 'GET / serves the story page', async () => {
        const res = await fetch(base + '/', { signal: AbortSignal.timeout(10000) });
        const html = await res.text();
        const ok = res.status === 200 && html.includes('<title>The Pulse of AI</title>')
            && html.includes('js/main.js');
        (ok ? r.pass : r.fail)('GET / serves the story page',
            `status ${res.status}${ok ? ', index.html with js/main.js' : ', unexpected body'}`);
        const js = await fetch(base + '/js/main.js', { signal: AbortSignal.timeout(10000) });
        (js.status === 200 ? r.pass : r.fail)('GET /js/main.js', `status ${js.status}`);
    });

    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    let sampleCity = null;
    await check(r, 'globe data (trailing hour)', async () => {
        const { status, body } = await getJson(base,
            `/api/posts/aggregated-by-location?from=${encodeURIComponent(from)}`);
        const rows = Array.isArray(body) ? body : [];
        const placed = rows.filter(c => c.lat !== null && c.lat !== undefined);
        if (status === 200 && placed.length > 0) {
            sampleCity = placed[0].city;
            r.pass('globe data (trailing hour)', `${placed.length} cities with coordinates`);
        } else {
            r.fail('globe data (trailing hour)', `status ${status}, ${rows.length} rows — the page would fall back to its bundled demo set`);
        }
    });

    await check(r, 'themes', async () => {
        const { status, body } = await getJson(base, '/api/themes');
        const n = Array.isArray(body) ? body.length : 0;
        (status === 200 && n > 0 ? r.pass : r.fail)('themes', `status ${status}, ${n} themes`);
    });

    await check(r, 'bias monitor (latest job)', async () => {
        const { status, body } = await getJson(base, '/api/bias/latest');
        const n = body && Array.isArray(body.all_assessments) ? body.all_assessments.length : 0;
        (status === 200 && n > 0 ? r.pass : r.fail)('bias monitor (latest job)',
            `status ${status}, ${n} assessments, ${body && body.violations ? body.violations.length : 0} violation(s)`);
    });

    await check(r, 'source ribbon timeseries', async () => {
        const { status, body } = await getJson(base, '/api/sources/timeseries?hours=12');
        const rows = Array.isArray(body) ? body : [];
        const withData = rows.filter(c => (c.series || []).some(p => p.total > 0));
        (status === 200 && withData.length > 0 ? r.pass : r.fail)('source ribbon timeseries',
            `status ${status}, ${withData.length}/${rows.length} categories with posts`);
    });

    await check(r, 'methodology registry', async () => {
        const { status, body } = await getJson(base, '/api/methodology');
        const n = Array.isArray(body) ? body.length : 0;
        (status === 200 && n > 0 ? r.pass : r.fail)('methodology registry', `status ${status}, ${n} versions`);
    });

    await check(r, 'city drill-down query', async () => {
        if (!sampleCity) return r.fail('city drill-down query', 'no city to query');
        const { status, body } = await getJson(base, '/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: sampleCity, limit: 3 }),
        });
        const n = body && Array.isArray(body.results) ? body.results.length : 0;
        (status === 200 && n > 0 ? r.pass : r.fail)('city drill-down query',
            `status ${status}, ${n} posts for ${sampleCity}`);
    });

    // ── Population counts ────────────────────────────────────────────────────
    const c = await counts();
    (c.posts > 0 ? r.pass : r.fail)('posts stored', `${c.posts} total, ${c.postsLastHour} in the trailing hour`);
    (c.decisions > 0 ? r.pass : r.fail)('audit decisions stored', String(c.decisions));
    (c.bias > 0 ? r.pass : r.fail)('bias assessments stored', String(c.bias));
    if (c.embeddings > 0) r.pass('embeddings stored', String(c.embeddings));
    else if (opts.expectEmbeddings) r.fail('embeddings stored', '0 — embeddings were expected');
    else r.warn('embeddings stored', '0 — embeddings service unavailable; vector search is empty');

    // ── One receipt + replay ─────────────────────────────────────────────────
    // Newest post that the real pipeline scored on all three per-post stages.
    const sample = await db.dbGet(
        `SELECT rp.id
         FROM raw_posts rp
         WHERE (SELECT COUNT(DISTINCT decision_type) FROM decision_audit_log d
                WHERE d.raw_post_id = rp.id
                  AND d.decision_type IN ('sentiment', 'relevance', 'discourse')) = 3
         ORDER BY rp.collected_at DESC
         LIMIT 1`,
    );
    if (!sample) {
        r.fail('audit receipt', 'no post with sentiment + relevance + discourse decisions');
    } else {
        await check(r, 'audit receipt', async () => {
            const { status, body } = await getJson(base, `/api/audit/${sample.id}`);
            const decisions = body && Array.isArray(body.decisions) ? body.decisions : [];
            const complete = decisions.filter(d => d.audiences
                && AUDIENCES.every(a => d.audiences[a] !== undefined && d.audiences[a] !== null));
            const lineage = body && body.bias ? body.bias.lineage : undefined;
            const layers = body && body.bias && Array.isArray(body.bias.layers) ? body.bias.layers.length : 0;
            const ok = status === 200 && decisions.length >= 3 && complete.length === decisions.length
                && LINEAGES.has(lineage) && layers > 0;
            (ok ? r.pass : r.fail)('audit receipt',
                `post ${sample.id}: ${decisions.length} decisions, ${complete.length} with all four `
                + `audience views, bias lineage '${lineage}', ${layers} fairness layers`);
        });

        await check(r, 'npm run replay', async () => {
            let output;
            let code = 0;
            try {
                output = execFileSync('npm', ['run', '--silent', 'replay', '--', '--post', sample.id],
                    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (err) {
                code = err.status;
                output = `${err.stdout || ''}${err.stderr || ''}`;
            }
            const verdict = (output.match(/RESULT: (\w+)/) || [])[1] || 'none';
            (code === 0 && verdict === 'PASS' ? r.pass : r.fail)('npm run replay',
                `post ${sample.id}: RESULT ${verdict} (exit ${code})`);
        });
    }

    // ── Population summary ───────────────────────────────────────────────────
    const byCat = await db.dbAll(
        `SELECT ds.category,
                COUNT(*) FILTER (WHERE ds.source_type <> 'demo')::int AS live,
                COUNT(*) FILTER (WHERE ds.source_type = 'demo')::int  AS demo
         FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id
         WHERE rp.collected_at >= NOW() - INTERVAL '1 hour'
         GROUP BY ds.category ORDER BY ds.category`);
    const hourLive = byCat.reduce((n, x) => n + x.live, 0);
    const hourDemo = byCat.reduce((n, x) => n + x.demo, 0);
    let label;
    if (hourLive + hourDemo === 0) label = 'NONE — no posts in the trailing hour';
    else if (hourDemo === 0) label = `LIVE — ${hourLive} real posts collected from registry sources in the trailing hour`;
    else if (hourLive === 0) label = `DEMO — fictional posts scored by the real pipeline (${hourDemo} in the trailing hour; live collection yielded none)`;
    else label = `MIXED — ${hourLive} live and ${hourDemo} demo posts in the trailing hour (demo posts age out within the hour)`;
    if (c.posts > 0 && c.demoPosts === 0 && hourLive === 0) label += '; older posts in the DB are not from the demo feed';
    if (c.posts === 0) label = 'NO DATA — no posts stored (NO DEMO FEED DATA, no live posts)';
    out('');
    out('Population summary');
    out(`  data:               ${label}`);
    out(`  posts:              ${c.posts} (${c.postsLastHour} in the trailing hour)`);
    for (const x of byCat) out(`    ${x.category.padEnd(10)}        live ${String(x.live).padStart(4)}  demo ${String(x.demo).padStart(4)}`);
    out(`  cities:             ${c.cities}`);
    out(`  categories:         ${c.categories}`);
    out(`  audit decisions:    ${c.decisions}`);
    out(`  bias assessments:   ${c.bias}`);
    out(`  embeddings:         ${c.embeddings}`);

    const fails = r.results.filter(x => x.status === 'FAIL').length;
    const warns = r.results.filter(x => x.status === 'WARN').length;
    out('');
    out(`SMOKE: ${fails === 0 ? 'PASS' : 'FAIL'} (${r.results.length} checks, ${fails} failed, ${warns} warning(s))`);
    return fails === 0 ? 0 : 1;
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        process.stderr.write(`smoke-check: ${err.message}\n`);
        process.exit(2);
    }
    run(opts, line => process.stdout.write(line + '\n'))
        .catch((err) => {
            process.stderr.write(`smoke-check: FAILED — ${err.message}\n`);
            return 1;
        })
        .then(async (code) => {
            await db.closePool().catch(() => {});
            process.exit(code);
        });
}

module.exports = { parseArgs, run, modeOfAggregatedRows, checkDataMode, failedJobsVerdict };
