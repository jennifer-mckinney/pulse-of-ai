#!/usr/bin/env node
// scripts/collect.js — `npm run collect [-- --only slug1,slug2]`
// Runs ONE real collection job through the pipeline (src/collectors/runner.js):
// collect → store → sentiment / relevance / discourse (audited) → bias →
// embed jobs. Honors every gate, kill switch and poll interval. Prints the
// per-source outcome and the job's counts.

'use strict';

require('dotenv').config();
const db = require('../src/db/connection');
const { runCollection } = require('../src/collectors/runner');
const { scrub } = require('../src/collectors/redact');

const USAGE = 'usage: npm run collect [-- --only slug1,slug2]\n'
    + '       npm run collect -- --supervised --only <slug>   (dry run: fetch, print a sample, store nothing)';
const SAMPLE_SIZE = 5;

/** @returns {{ slugs?: string[], supervised?: boolean } | { error: string }} */
function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv : [];
    const supervised = args.includes('--supervised');
    const i = args.indexOf('--only');
    if (i < 0) {
        return supervised ? { error: `--supervised needs --only <slug> (one source)\n${USAGE}` } : { slugs: undefined };
    }
    // G10-23: `--only` without a value is a usage error, not a TypeError.
    const v = args[i + 1];
    const slugs = typeof v === 'string' && !v.startsWith('--') ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (!slugs.length) return { error: `--only needs a comma-separated list of source slugs\n${USAGE}` };
    if (supervised) {
        return slugs.length === 1 ? { slugs, supervised: true } : { error: `--supervised runs exactly one source\n${USAGE}` };
    }
    return { slugs };
}

class UsageError extends Error {}

/**
 * PR #22 security M2: the supervised run's READ-ONLY view of a source's
 * database governance state — the kill switch (data_sources, F10-10) and
 * the refusal state (source_collection_state, F10-5). One SELECT; nothing
 * is written.
 * @returns {Promise<object|null>} null when the source has no data_sources row
 */
async function readGovernance(slug) {
    const { dbGet } = require('../src/db/connection');
    const row = await dbGet(
        `SELECT ds.collection_disabled_at AS disabled_at, ds.collection_disabled_reason AS disabled_reason,
                ds.collection_disabled_by AS disabled_by,
                s.access_denied_at, s.access_denied_status, s.access_denied_kind, s.refused_until, s.refusal_count
         FROM data_sources ds
         LEFT JOIN source_collection_state s ON s.source_id = ds.id
         WHERE ds.name = $1`,
        [slug],
    );
    return row || null;
}

/**
 * Refuse (UsageError) when the database says this source must not be
 * contacted: its kill switch is set, or it refused us and its cooldown has
 * not ended — exactly what the worker's runner honours. Fails closed: a
 * source with no data_sources row cannot be checked, so it is refused too.
 */
function assertDbGatesOpen(slug, gov, env, now = Date.now()) {
    const { refusalGate } = require('../src/collectors/refusal');
    if (!gov) {
        throw new UsageError(`${slug} has no data_sources row, so its kill switch and refusal state cannot be checked `
            + '— run `npm run seed` first');
    }
    if (gov.disabled_at) {
        throw new UsageError(`${slug} is disabled by the database kill switch`
            + `${gov.disabled_by ? ` (by ${gov.disabled_by})` : ''}${gov.disabled_reason ? ` — ${gov.disabled_reason}` : ''}`
            + `; enable it with npm run source:enable -- ${slug} before a supervised run`);
    }
    const gate = refusalGate(gov, slug, env, now);
    if (gate.state === 'cooldown') throw new UsageError(`${slug} is in its refusal cooldown: ${gate.reason}`);
    return gate;
}

/**
 * P10-17: the supervised first run of a newly keyed source. Fetches every
 * OPEN route of ONE source through the real collectors and the polite HTTP
 * client (robots, allowed hosts and redaction all apply), prints what it got
 * and a sample of the payloads exactly as they would be stored, and stores
 * NOTHING: no raw_posts, scores, cursor, collection state or job — its only
 * database access is ONE read of the source's kill switch and refusal state
 * (PR #22 security M2), which it honours. The operator reads the sample and signs off before
 * the credential goes into the worker's env, which is what schedules the
 * source (README, "Adding a keyed source").
 * @returns {Promise<{ slug, status, routes: object[], sample: object[] }>}
 */
async function supervisedRun({
    slug, env = process.env, transport, out = line => process.stdout.write(line + '\n'), governance = readGovernance,
}) {
    const { getSource, sourceStatus } = require('../src/config/source-registry');
    const { buildCollectors } = require('../src/collectors/index');
    const { HttpClient } = require('../src/collectors/http');
    const src = getSource(slug);
    if (!src) throw new UsageError(`unknown source '${slug}' (not a registry slug)\n${USAGE}`);
    const st = sourceStatus(src, env);
    if (st.status !== 'collecting') {
        throw new UsageError(`${slug} is not collecting under this environment (${st.status}): ${st.reason}`);
    }
    // PR #22 security M2: the database kill switch and the refusal cooldown
    // apply to a supervised run as to every scheduled one (read-only).
    assertDbGatesOpen(slug, await governance(slug), env);
    out(`SUPERVISED DRY RUN — ${src.name} (${slug}); routes: ${st.openRoutes.join(', ')}`);
    out('Nothing is stored: no posts, scores, cursors or collection state are written.');
    const http = new HttpClient({ env, transport });
    const routes = [];
    const sample = [];
    for (const c of buildCollectors(src, { env, http, cursor: {}, httpCache: {} })) {
        try {
            const r = await c.collect();
            const warnings = (r.warnings || []).map(w => scrub(w.text, env));
            routes.push({ route: c.route.id, fetched: r.fetched, kept: r.payloads.length, warnings });
            out(`  ${c.route.id}: fetched ${r.fetched}, kept ${r.payloads.length}${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
            for (const p of r.payloads) if (sample.length < SAMPLE_SIZE) sample.push({ route: c.route.id, ...p });
        } catch (err) {
            routes.push({ route: c.route.id, error: scrub(err.message, env) });
            out(`  ${c.route.id}: FAILED — ${scrub(err.message, env)}`);
        }
    }
    out(`Sample (${sample.length} of what would be stored, text as redacted):`);
    for (const p of sample) {
        const text = String(p.text || '').replace(/\s+/g, ' ');
        out(`  - [${p.published_at || 'no date'}] ${p.id}${p.location ? ` · ${p.location} (${p.location_basis})` : ''}`);
        out(`    ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`);
        if (p.url) out(`    ${p.url}`);
    }
    out('Sign-off: if the sample is on topic and carries no personal data beyond the ingest claim, add the credential to '
        + 'the worker\'s env and recreate it (docker compose up -d worker web) to schedule the source.');
    return { slug, status: st.status, routes, sample };
}

async function main(argv, out = line => process.stdout.write(line + '\n'), { transport, env, governance } = {}) {
    const parsed = parseArgs(argv);
    if (parsed.error) throw new UsageError(parsed.error);
    const { slugs } = parsed;
    if (parsed.supervised) return supervisedRun({ slug: slugs[0], out, transport, env, governance });
    const s = await runCollection({ slugs, triggeredBy: 'manual', log: out });
    out(`job ${s.jobId}: ${s.sourcesQueried} sources queried, ${s.postsCollected} items collected, `
        + `${s.postsProcessed} new posts scored, ${s.embedQueued} embed jobs queued, `
        + `bias ${s.bias ? `${s.bias.violationsFound} violation(s)` : 'not run (no new posts)'}`);
    out(`new posts by category: ${JSON.stringify(s.byCategory)}`);
    return s;
}

/**
 * G10-23: close the BullMQ queues only when the run actually loaded them (a
 * run that queued no embed or retry job never connects to Redis; requiring
 * the module just to close it opened connections for nothing).
 */
async function closeQueuesIfOpened(cache = require.cache) {
    const id = require.resolve('../src/queues/index');
    if (!cache[id]) return false;
    const q = cache[id].exports;
    await Promise.allSettled(Object.values(q).filter(x => x && typeof x.close === 'function').map(x => x.close()));
    return true;
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    main(process.argv.slice(2))
        .then(async () => {
            await closeQueuesIfOpened();
            await db.closePool();
            process.exit(0);
        })
        .catch(async (err) => {
            if (err instanceof UsageError) {
                process.stderr.write(`${scrub(err.message)}\n`);
                await db.closePool().catch(() => {});
                process.exit(2);
            }
            process.stderr.write(`collect: FAILED — ${scrub(err.message)}\n`);
            await closeQueuesIfOpened().catch(() => {});
            await db.closePool().catch(() => {});
            process.exit(1);
        });
}

module.exports = {
    main, parseArgs, supervisedRun, readGovernance, assertDbGatesOpen, closeQueuesIfOpened, UsageError, USAGE, SAMPLE_SIZE,
};
