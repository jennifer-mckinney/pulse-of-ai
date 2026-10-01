#!/usr/bin/env node
// scripts/gold-label.js — the LOCAL-ONLY relevance labelling CLI
// Relevance-accuracy Stage 0 (P3); docs/governance/relevance-codebook.md.
//
//   npm run gold:label -- --sample ID --labeller NAME [--method human|adjudicated] [--limit N]
//   npm run gold:label -- --import FILE.jsonl --labeller NAME --model MODEL_ID
//
// Interactive mode shows each item's text (read from raw_posts, hash-checked)
// and records one label per answer (src/gold/labelling.js has the syntax).
// Labelling is blind: the current decision and other labels are hidden,
// except in --method adjudicated, which resolves disagreements.
// Import mode records llm_proposed labels from JSON Lines
// ({ item_id, label, flags?, input_hash, note? } per line), all or nothing.
//
// Never served by the API. Refuses NODE_ENV=production and any non-loopback
// POSTGRES_HOST (assertLocalOnly).

'use strict';

require('dotenv').config();

const fs = require('fs');

const USAGE = 'usage: npm run gold:label -- --sample ID --labeller NAME [--method human|adjudicated] [--limit N]\n'
    + '       npm run gold:label -- --import FILE.jsonl --labeller NAME --model MODEL_ID';

function parseArgs(argv) {
    const args = Array.isArray(argv) ? [...argv] : [];
    const out = { sample: null, labeller: null, method: null, limit: Infinity, importFile: null, model: null };
    const value = (flag) => {
        const v = args.shift();
        if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
        return v;
    };
    while (args.length) {
        const a = args.shift();
        switch (a) {
            case '--sample': out.sample = value(a); break;
            case '--labeller': out.labeller = value(a); break;
            case '--method': out.method = value(a); break;
            case '--limit': out.limit = Number(value(a)); break;
            case '--import': out.importFile = value(a); break;
            case '--model': out.model = value(a); break;
            default: throw new Error(`unknown argument ${a}\n${USAGE}`);
        }
    }
    if (!out.labeller || !out.labeller.trim()) throw new Error(`--labeller is required\n${USAGE}`);
    if (out.importFile) {
        if (out.method && out.method !== 'llm_proposed') throw new Error('--import records llm_proposed labels only');
        if (!out.model) throw new Error(`--import needs --model\n${USAGE}`);
        out.method = 'llm_proposed';
        return out;
    }
    if (out.model) throw new Error('--model applies to --import only');
    out.method = out.method || 'human';
    if (!['human', 'adjudicated'].includes(out.method)) throw new Error('--method must be human or adjudicated (llm_proposed labels come in with --import)');
    if (!out.sample) throw new Error(`--sample is required\n${USAGE}`);
    if (out.limit !== Infinity && (!Number.isInteger(out.limit) || out.limit <= 0)) throw new Error('--limit must be a positive integer');
    return out;
}

/** readline-backed io; ask() resolves null at end of input. */
/* istanbul ignore next -- terminal wiring; the session is tested with a fake io */
function terminalIo() {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let closed = false;
    rl.on('close', () => { closed = true; });
    return {
        print: (l) => process.stdout.write(`${l}\n`),
        ask: (p) => (closed ? Promise.resolve(null) : new Promise((resolve) => {
            const onClose = () => resolve(null);
            rl.once('close', onClose);
            rl.question(p, (ans) => { rl.off('close', onClose); resolve(ans); });
        })),
        close: () => rl.close(),
    };
}

async function main(argv, { env = process.env, io = null, out = l => process.stdout.write(l + '\n') } = {}) {
    const opts = parseArgs(argv);
    const labelling = require('../src/gold/labelling');
    labelling.assertLocalOnly(env);
    const store = require('../src/gold/store');
    if (opts.importFile) {
        const text = fs.readFileSync(opts.importFile, 'utf8');
        const r = await labelling.importProposals({ store, text, labeller: opts.labeller, modelId: opts.model });
        out(`imported ${r.imported} llm_proposed label(s) as ${opts.labeller} (model ${opts.model})`);
        return r;
    }
    const session = io || terminalIo();
    try {
        const r = await labelling.runSession({
            store, io: session, labeller: opts.labeller, sampleId: opts.sample, method: opts.method, limit: opts.limit,
        });
        session.print(`done: ${r.labelled} labelled, ${r.skipped} skipped, ${r.unavailable} unavailable${r.quit ? ' (quit)' : ''}`);
        return r;
    } finally {
        if (session.close) session.close();
    }
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    const db = require('../src/db/connection');
    main(process.argv.slice(2))
        .then(async () => { await db.closePool(); process.exit(0); })
        .catch(async (err) => {
            process.stderr.write(`gold-label: FAILED — ${require('../src/collectors/redact').scrub(err.message)}\n`);
            await db.closePool().catch(() => {});
            process.exit(1);
        });
}

module.exports = { main, parseArgs, USAGE };
