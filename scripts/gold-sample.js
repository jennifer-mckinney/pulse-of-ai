#!/usr/bin/env node
// scripts/gold-sample.js — `npm run gold:sample -- --total N --seed S [options]`
// Relevance-accuracy Stage 0 (P3): draw a stratified gold-set sample of
// stored posts (docs/governance/relevance-codebook.md, section 9).
//
// Strata: category × scope × current relevance decision × writing script.
// Without --write it is a DRY RUN: it reads the population and prints the
// allocation, writing nothing. With --write --sample-id ID it records the
// selected items in relevance_gold_items (append-only, migration 070) in one
// transaction. No post text is printed or copied.
//
// Options:
//   --total N               sample size (required)
//   --seed S                draw seed (required; the same seed over the same
//                           posts reproduces the sample)
//   --min-per-stratum M     minimum per stratum, capped at its size (default 2)
//   --weight dim:value=x    stratum weight, repeatable (dims: category, scope,
//                           decision, script)
//   --since ISO-DATE        only posts collected since this date
//   --sample-id ID          sample name (required with --write)
//   --write                 record the items
//   --json                  machine-readable output

'use strict';

require('dotenv').config();

const USAGE = 'usage: npm run gold:sample -- --total N --seed S [--min-per-stratum M] [--weight dim:value=x ...] '
    + '[--since YYYY-MM-DD] [--sample-id ID --write] [--json]';

const SAMPLE_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

function parseArgs(argv) {
    const args = Array.isArray(argv) ? [...argv] : [];
    const out = { total: null, seed: null, minPerStratum: 2, weights: [], since: null, sampleId: null, write: false, json: false };
    const value = (flag) => {
        const v = args.shift();
        if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
        return v;
    };
    while (args.length) {
        const a = args.shift();
        switch (a) {
            case '--total': out.total = Number(value(a)); break;
            case '--seed': out.seed = value(a); break;
            case '--min-per-stratum': out.minPerStratum = Number(value(a)); break;
            case '--weight': out.weights.push(value(a)); break;
            case '--since': out.since = value(a); break;
            case '--sample-id': out.sampleId = value(a); break;
            case '--write': out.write = true; break;
            case '--json': out.json = true; break;
            default: throw new Error(`unknown argument ${a}\n${USAGE}`);
        }
    }
    if (!Number.isInteger(out.total) || out.total <= 0) throw new Error(`--total must be a positive integer\n${USAGE}`);
    if (!out.seed || !out.seed.trim() || out.seed.length > 200) throw new Error(`--seed is required (1–200 characters)\n${USAGE}`);
    if (!Number.isInteger(out.minPerStratum) || out.minPerStratum < 0) throw new Error('--min-per-stratum must be a non-negative integer');
    if (out.since !== null && Number.isNaN(Date.parse(out.since))) throw new Error(`--since must be a date (got "${out.since}")`);
    if (out.write && !out.sampleId) throw new Error(`--write needs --sample-id\n${USAGE}`);
    if (out.sampleId !== null && !SAMPLE_ID_RE.test(out.sampleId)) {
        throw new Error('--sample-id must be 3–64 characters of a-z, 0-9, ".", "_" or "-", starting with a letter or digit');
    }
    return out;
}

async function main(argv, { out = l => process.stdout.write(l + '\n') } = {}) {
    const opts = parseArgs(argv);
    const sampler = require('../src/gold/sampler');
    const store = require('../src/gold/store');
    const weights = sampler.parseWeightSpecs(opts.weights);

    const candidates = [];
    for await (const c of store.streamCandidates({ since: opts.since })) candidates.push(c);
    if (!candidates.length) throw new Error('no posts to sample (no stored, non-demo posts with text)');
    const plan = sampler.planSample(candidates, { total: opts.total, seed: opts.seed, minPerStratum: opts.minPerStratum, weights });

    let written = 0;
    if (opts.write) written = await store.insertItems(plan.items, { sampleId: opts.sampleId, seed: opts.seed });

    const summary = {
        sample_id: opts.sampleId,
        written: opts.write,
        sampler_version: sampler.SAMPLER_VERSION,
        seed: opts.seed,
        population: candidates.length,
        sample_size: plan.items.length,
        items_written: written,
        strata: plan.strata.map(s => ({
            stratum: s.key, population: s.population, weight: s.weight, sample_size: s.sampleSize,
            design_weight: s.sampleSize ? s.population / s.sampleSize : null,
        })),
    };
    if (opts.json) {
        out(JSON.stringify(summary, null, 2));
    } else {
        out(`gold sample${opts.sampleId ? ` ${opts.sampleId}` : ''} (sampler ${summary.sampler_version}, seed "${opts.seed}"): `
            + `${summary.sample_size} of ${summary.population} posts in ${summary.strata.length} strata — `
            + (opts.write ? `${written} items WRITTEN` : 'DRY RUN, nothing written (add --sample-id ID --write)'));
        out(`${'stratum (category|scope|decision|script)'.padEnd(48)} ${'population'.padStart(10)} ${'weight'.padStart(7)} ${'sample'.padStart(7)} ${'design_w'.padStart(9)}`);
        for (const s of summary.strata) {
            out(`${s.stratum.padEnd(48)} ${String(s.population).padStart(10)} ${String(s.weight).padStart(7)} `
                + `${String(s.sample_size).padStart(7)} ${(s.design_weight === null ? '-' : s.design_weight.toFixed(2)).padStart(9)}`);
        }
    }
    return summary;
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    const db = require('../src/db/connection');
    main(process.argv.slice(2))
        .then(async () => { await db.closePool(); process.exit(0); })
        .catch(async (err) => {
            process.stderr.write(`gold-sample: FAILED — ${require('../src/collectors/redact').scrub(err.message)}\n`);
            await db.closePool().catch(() => {});
            process.exit(1);
        });
}

module.exports = { main, parseArgs, USAGE };
