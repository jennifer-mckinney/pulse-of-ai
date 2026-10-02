#!/usr/bin/env node
// scripts/gold-agreement.js — `npm run gold:agreement -- [--sample ID] [--a NAME --b NAME] [--codebook V] [--json]`
// Relevance-accuracy Stage 0 (P3): inter-annotator agreement on the gold
// set — Cohen's kappa per labeller pair (three-class, binary "central +
// incidental = AI", and per flag), over each labeller's LATEST label per
// item. Adjudicated labels are excluded (they are not independent);
// llm_proposed labels are included under their own labeller name, so
// Claude-vs-human agreement is measured the same way.
// Read-only. Thresholds: docs/governance/relevance-codebook.md, section 6.
// The kappa over the sample is sample-conditional (the sample over-samples
// rare strata), so each pair also prints a design-weighted kappa and an ordinal
// kappa; below 300 shared items every reading is indicative only.

'use strict';

require('dotenv').config();

const USAGE = 'usage: npm run gold:agreement -- [--sample ID] [--a NAME --b NAME] [--codebook VERSION] [--json]';

function parseArgs(argv) {
    const args = Array.isArray(argv) ? [...argv] : [];
    const out = { sample: null, a: null, b: null, codebook: null, json: false };
    const value = (flag) => {
        const v = args.shift();
        if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
        return v;
    };
    while (args.length) {
        const a = args.shift();
        switch (a) {
            case '--sample': out.sample = value(a); break;
            case '--a': out.a = value(a); break;
            case '--b': out.b = value(a); break;
            case '--codebook': out.codebook = value(a); break;
            case '--json': out.json = true; break;
            default: throw new Error(`unknown argument ${a}\n${USAGE}`);
        }
    }
    if (Boolean(out.a) !== Boolean(out.b)) throw new Error('--a and --b go together');
    if (out.a && out.a === out.b) throw new Error('--a and --b must name two different labellers');
    if (!out.codebook) out.codebook = require('../src/gold/codebook').CODEBOOK_VERSION;
    return out;
}

const fmt = (x, d = 3) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(d));

async function main(argv, { env = process.env, out = l => process.stdout.write(l + '\n') } = {}) {
    const opts = parseArgs(argv);
    require('../src/gold/labelling').assertLocalOnly(env);
    const { agreementReport, interpretKappa } = require('../src/gold/agreement');
    const { labelRows } = require('../src/gold/store');
    const rows = await labelRows({ sampleId: opts.sample, codebookVersion: opts.codebook, methods: ['human', 'llm_proposed'] });
    const report = agreementReport(rows, { pair: opts.a ? [opts.a, opts.b] : null });
    const result = {
        sample_id: opts.sample,
        codebook_version: opts.codebook,
        labellers: report.labellers,
        pairs: report.pairs.map(p => ({
            a: p.a, b: p.b, n: p.n, enough_items: p.enoughItems,
            three_class: { kappa: p.threeClass.kappa, ci95: p.threeClass.ci95, po: p.threeClass.po, reading: interpretKappa(p.threeClass.kappa), confusion: p.threeClass.confusion },
            binary: { kappa: p.binary.kappa, ci95: p.binary.ci95, po: p.binary.po, reading: interpretKappa(p.binary.kappa) },
            ordinal: { kappa: p.ordinal.kappa, reading: interpretKappa(p.ordinal.kappa) },
            design_weighted: {
                three_class: { kappa: p.weighted.threeClass.kappa, po: p.weighted.threeClass.po },
                binary: { kappa: p.weighted.binary.kappa, po: p.weighted.binary.po },
            },
            flags: Object.fromEntries(Object.entries(p.flags).map(([f, k]) => [f, { kappa: k.kappa, po: k.po, reading: interpretKappa(k.kappa) }])),
        })),
    };
    if (opts.json) {
        out(JSON.stringify(result, null, 2));
        return result;
    }
    out(`gold agreement${opts.sample ? ` for ${opts.sample}` : ''} (codebook ${opts.codebook}): ${rows.length} label row(s), `
        + `${report.labellers.length} labeller(s), ${result.pairs.length} pair(s) with shared items`);
    for (const p of result.pairs) {
        out('');
        out(`${p.a} vs ${p.b}: ${p.n} shared item(s)${p.enough_items ? '' : ' (below 300: every reading is indicative only)'}`);
        const ci = (c) => (c ? ` [${fmt(c[0])}, ${fmt(c[1])}]` : '');
        out(`  three-class  kappa ${fmt(p.three_class.kappa)}${ci(p.three_class.ci95)}  agreement ${fmt(p.three_class.po)}  ${p.three_class.reading}`);
        out(`  binary       kappa ${fmt(p.binary.kappa)}${ci(p.binary.ci95)}  agreement ${fmt(p.binary.po)}  ${p.binary.reading}`);
        out(`  ordinal      kappa ${fmt(p.ordinal.kappa)}  (linearly weighted: central / incidental / not-AI in order)`);
        out(`  design-weighted (population estimate)  binary kappa ${fmt(p.design_weighted.binary.kappa)}  three-class kappa ${fmt(p.design_weighted.three_class.kappa)}`);
        for (const [f, k] of Object.entries(p.flags)) out(`  flag ${f.padEnd(14)} kappa ${fmt(k.kappa)}  agreement ${fmt(k.po)}  ${k.reading}`);
        const cats = Object.keys(p.three_class.confusion);
        if (cats.length) {
            out(`  confusion (rows ${p.a}, columns ${p.b}): ${cats.join(' / ')}`);
            for (const r of cats) out(`    ${r.padEnd(14)} ${cats.map(c => String(p.three_class.confusion[r][c]).padStart(5)).join(' ')}`);
        }
    }
    return result;
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    const db = require('../src/db/connection');
    main(process.argv.slice(2))
        .then(async () => { await db.closePool(); process.exit(0); })
        .catch(async (err) => {
            process.stderr.write(`gold-agreement: FAILED — ${require('../src/collectors/redact').scrub(err.message)}\n`);
            await db.closePool().catch(() => {});
            process.exit(1);
        });
}

module.exports = { main, parseArgs, USAGE };
