#!/usr/bin/env node
// scripts/smoke-check.js
// Post-standup smoke check + population summary. scripts/standup.sh runs it
// INSIDE the web container (`docker compose exec web node scripts/smoke-check.js`)
// so it needs no host tooling beyond Docker: it talks to the API on
// 127.0.0.1:$PORT and to the database through src/db/connection.
//
//   node scripts/smoke-check.js [--base-url URL] [--expect-embeddings]
//
// Checks (PASS / FAIL / WARN per line):
//   - GET /api/health → 200, db_connected true; data_mode matches the
//     demo-feed share of the trailing hour (demo / live / mixed / none)
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
// The summary labels the data DEMO whenever it came from the demo feed —
// live collection is not implemented, so nothing here is ever called live.
//
// Exit code: 0 when no check FAILed, 1 otherwise.

'use strict';

require('dotenv').config();

const { execFileSync } = require('child_process');
const db = require('../src/db/connection');

const AUDIENCES = ['public', 'plain', 'config', 'researcher'];
const LINEAGES = new Set(['recorded', 'inferred', 'current']);

function parseArgs(argv) {
    const opts = {
        baseUrl: `http://127.0.0.1:${process.env.PORT || 3000}`,
        expectEmbeddings: false,
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--base-url') opts.baseUrl = argv[++i];
        else if (argv[i] === '--expect-embeddings') opts.expectEmbeddings = true;
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
    // "Demo data" markers read this): cross-check /api/health data_mode
    // against the demo-feed share of the trailing hour in the database.
    await check(r, 'data mode reported', async () => {
        const { body } = await getJson(base, '/api/health');
        const w = await db.dbGet(
            `SELECT COUNT(*)::int AS posts,
                    COUNT(*) FILTER (WHERE ds.source_type = 'demo')::int AS demo
             FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id
             WHERE rp.collected_at >= NOW() - INTERVAL '1 hour'`);
        const expected = w.posts === 0 ? 'none'
            : w.demo === w.posts ? 'demo' : w.demo === 0 ? 'live' : 'mixed';
        const got = body && body.data_mode;
        (got === expected ? r.pass : r.fail)('data mode reported',
            `/api/health data_mode '${got}' (${w.demo} of ${w.posts} trailing-hour posts from demo feeds), `
            + `${body && body.active_sources} real active sources, ${body && body.demo_feeds} demo feeds`);
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
    const demoOnly = c.demoPosts > 0 && c.demoPosts === c.posts;
    let label;
    if (c.demoPosts > 0) {
        label = 'DEMO — fictional posts scored by the real pipeline (live collection is not implemented yet)';
        if (!demoOnly) label += `; ${c.posts - c.demoPosts} other post(s) already in the DB (seed fixtures, not live-collected)`;
    } else {
        label = 'NO DEMO FEED DATA — posts present were not produced by the demo feed (live collection is not implemented yet)';
    }
    out('');
    out('Population summary');
    out(`  data:               ${label}`);
    out(`  posts:              ${c.posts} (${c.postsLastHour} in the trailing hour)`);
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

module.exports = { parseArgs, run };
