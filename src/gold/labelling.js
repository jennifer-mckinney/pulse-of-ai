// src/gold/labelling.js
// Relevance-accuracy Stage 0 (P3): the LOCAL-ONLY labelling session behind
// scripts/gold-label.js. Never served by the API: no route or the server
// requires src/gold (tests/unit/pure/goldLabelling.test.js enforces it), and
// assertLocalOnly refuses a non-loopback database host or NODE_ENV=production.
//
// Blind labelling: the labeller sees the post text and its source category,
// never the current relevance decision, the stratum or another labeller's
// label (except when ADJUDICATING a disagreement, which is the point).
//
// The text is read from raw_posts at labelling time and its sha256 must
// equal the item's input_hash (the text the sampler saw). The gold tables
// never copy post text, so text retention (src/collectors/retention.js)
// still applies: an item whose text was removed or changed is skipped, not
// labelled from memory.
//
// Answer syntax:  c | i | n  [+s] [+b] [+l]  [# note]
//   c = AI_CENTRAL, i = AI_INCIDENTAL, n = NOT_AI;
//   +s = SPAM, +b = BOT_GENERATED, +l = LANG;
//   k = skip, q = quit, ? = help.

'use strict';

const { LABELS, FLAGS, METHODS, CODEBOOK_VERSION } = require('./codebook');

const LABEL_KEYS = Object.freeze({ c: 'AI_CENTRAL', i: 'AI_INCIDENTAL', n: 'NOT_AI' });
const FLAG_KEYS = Object.freeze({ s: 'SPAM', b: 'BOT_GENERATED', l: 'LANG' });
const NOTE_MAX = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const ANSWER_RE = /^([cin])((?:\s*\+\s*[sbl])*)$/;
const LOOPBACK = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);

const HELP = [
    'Label the text by the relevance codebook (docs/governance/relevance-codebook.md):',
    '  c = AI_CENTRAL     AI is the main topic',
    '  i = AI_INCIDENTAL  AI is mentioned substantively but is not the main topic',
    '  n = NOT_AI         not about AI (including passing or non-AI senses of a word)',
    'Flags (any number): +s SPAM, +b BOT_GENERATED, +l LANG (cannot judge the language)',
    'Optional note after "#".   k = skip   q = quit   ? = this help',
    'Examples:  c    i+l    n +s # airline-support spam',
];

/** Flags in codebook order, de-duplicated. */
function canonicalFlags(flags) {
    const set = new Set(flags);
    return FLAGS.filter(f => set.has(f));
}

/**
 * Parse one answer typed at the labelling prompt.
 * @param {string} input
 * @returns {{action: 'label', label: string, flags: string[], note: string|null}
 *          | {action: 'skip'|'quit'|'help'|'invalid'}}
 */
function parseAnswer(input) {
    const raw = typeof input === 'string' ? input : '';
    const hash = raw.indexOf('#');
    const body = (hash >= 0 ? raw.slice(0, hash) : raw).trim().toLowerCase();
    const note = hash >= 0 ? raw.slice(hash + 1).trim().slice(0, NOTE_MAX) || null : null;
    if (body === 'k') return { action: 'skip' };
    if (body === 'q') return { action: 'quit' };
    if (body === '?') return { action: 'help' };
    const m = body.match(ANSWER_RE);
    if (!m) return { action: 'invalid' };
    const flags = canonicalFlags((m[2].match(/[sbl]/g) || []).map(k => FLAG_KEYS[k]));
    return { action: 'label', label: LABEL_KEYS[m[1]], flags, note };
}

/**
 * Refuse to run anywhere but against a local database, never in production.
 * @param {NodeJS.ProcessEnv} env
 */
function assertLocalOnly(env = process.env) {
    if (env.NODE_ENV === 'production') {
        throw new Error('gold labelling is local-only: refusing to run with NODE_ENV=production');
    }
    const host = String(env.POSTGRES_HOST || '').trim().toLowerCase();
    if (!LOOPBACK.has(host)) {
        throw new Error(`gold labelling is local-only: POSTGRES_HOST "${host}" is not a loopback address (localhost, 127.0.0.1, ::1)`);
    }
}

/**
 * Validate one line of an llm_proposed import (JSON Lines).
 * @param {unknown} row  { item_id, label, flags?, input_hash, note? }
 * @returns {{ itemId, label, flags, inputHash, note }}
 */
function validateProposal(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('each line must be a JSON object');
    if (typeof row.item_id !== 'string' || !UUID_RE.test(row.item_id)) throw new Error('item_id must be a gold item UUID');
    if (!LABELS.includes(row.label)) throw new Error(`label must be one of ${LABELS.join(', ')}`);
    const flags = row.flags === undefined ? [] : row.flags;
    if (!Array.isArray(flags)) throw new Error('flags must be an array');
    for (const f of flags) if (!FLAGS.includes(f)) throw new Error(`unknown flag "${f}"`);
    if (typeof row.input_hash !== 'string' || !HASH_RE.test(row.input_hash)) throw new Error('input_hash must be the item\'s sha256 (64 hex)');
    if (row.note !== undefined && row.note !== null && typeof row.note !== 'string') throw new Error('note must be a string');
    return {
        itemId: row.item_id.toLowerCase(),
        label: row.label,
        flags: canonicalFlags(flags),
        inputHash: row.input_hash,
        note: row.note ? row.note.slice(0, NOTE_MAX) : null,
    };
}

/**
 * Interactive labelling loop.
 * @param {{ store: object, io: { print: (l: string) => void, ask: (p: string) => Promise<string|null> },
 *           labeller: string, sampleId: string, method?: 'human'|'adjudicated',
 *           limit?: number, codebookVersion?: string }} opts
 * @returns {Promise<{ labelled: number, skipped: number, unavailable: number, quit: boolean }>}
 */
async function runSession({ store, io, labeller, sampleId, method = 'human', limit = Infinity, codebookVersion = CODEBOOK_VERSION }) {
    if (!labeller || !String(labeller).trim()) throw new Error('a labeller name is required');
    if (!['human', 'adjudicated'].includes(method)) throw new Error('the interactive session records human or adjudicated labels only');
    const items = await store.pendingItems({ sampleId, labeller, method });
    const summary = { labelled: 0, skipped: 0, unavailable: 0, quit: false };
    io.print(`${items.length} item(s) to label in sample ${sampleId} as ${labeller} (${method}, codebook ${codebookVersion}). "?" for help.`);
    for (const item of items) {
        if (summary.labelled >= limit) break;
        const text = await store.itemText(item);
        if (text.status !== 'ok') {
            summary.unavailable += 1;
            io.print(`-- item ${item.id}: skipped, text ${text.status} (retention or edit); not labelled.`);
            continue;
        }
        io.print('');
        io.print(`== item ${item.id}  [category: ${item.category}]`);
        if (method === 'adjudicated') {
            for (const l of await store.labelsFor(item.id)) {
                io.print(`   ${l.labeller} (${l.method}): ${l.label}${l.flags.length ? ` +${l.flags.join(' +')}` : ''}${l.note ? `  # ${l.note}` : ''}`);
            }
        }
        io.print(text.content);
        for (;;) {
            const answer = await io.ask('label> ');
            const a = answer === null ? { action: 'quit' } : parseAnswer(answer);
            if (a.action === 'help') { HELP.forEach(l => io.print(l)); continue; }
            if (a.action === 'invalid') { io.print('not understood; "?" for help'); continue; }
            if (a.action === 'quit') { summary.quit = true; return summary; }
            if (a.action === 'skip') { summary.skipped += 1; break; }
            await store.recordLabel({
                itemId: item.id, label: a.label, flags: a.flags, labeller: labeller.trim(), method,
                modelId: null, codebookVersion, inputHash: text.inputHash, note: a.note,
            });
            summary.labelled += 1;
            break;
        }
    }
    return summary;
}

/**
 * Record llm_proposed labels from JSON Lines text. All-or-nothing: every
 * line is validated (and its hash checked by the database trigger) inside
 * the store's transaction.
 */
async function importProposals({ store, text, labeller, modelId, codebookVersion = CODEBOOK_VERSION }) {
    if (!labeller || !String(labeller).trim()) throw new Error('a labeller name is required');
    if (!modelId || !String(modelId).trim()) throw new Error('--model is required for llm_proposed labels');
    const rows = [];
    String(text).split(/\r?\n/).forEach((line, i) => {
        if (!line.trim()) return;
        let parsed;
        try { parsed = JSON.parse(line); } catch { throw new Error(`line ${i + 1}: not valid JSON`); }
        try { rows.push(validateProposal(parsed)); } catch (err) { throw new Error(`line ${i + 1}: ${err.message}`); }
    });
    if (!rows.length) throw new Error('no proposals to import');
    await store.recordLabels(rows.map(r => ({
        ...r, labeller: labeller.trim(), method: 'llm_proposed', modelId: modelId.trim(), codebookVersion,
    })));
    return { imported: rows.length };
}

module.exports = {
    LABEL_KEYS, FLAG_KEYS, HELP, NOTE_MAX, METHODS,
    parseAnswer, assertLocalOnly, validateProposal, runSession, importProposals, canonicalFlags,
};
