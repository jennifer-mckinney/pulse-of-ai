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
// Terminal safety: post text, notes and labeller names come from outside (a
// post is attacker-controlled text), so they are printed through sanitize():
// C0/C1 control characters, including ESC (terminal escape sequences, OSC 52
// clipboard writes), are replaced.
//
// Notes are short (at most NOTE_MAX characters) and may not quote the post:
// the gold rows are immutable, so a quoted post would outlive the retention of
// its text. The LLM import records no notes at all.
//
// Labeller namespaces: a human labeller may not be named "llm:...", and the
// import always records its labels as "llm:<model id>", so a model's labels
// can neither pose as nor collapse into a person's.
//
// Answer syntax:  c | i | n  [+s] [+b] [+l]  [# note]
//   c = AI_CENTRAL, i = AI_INCIDENTAL, n = NOT_AI;
//   +s = SPAM, +b = BOT_GENERATED, +l = LANG;
//   k = skip, q = quit, ? = help.

'use strict';

const { LABELS, FLAGS, METHODS, CODEBOOK_VERSION } = require('./codebook');

const LABEL_KEYS = Object.freeze({ c: 'AI_CENTRAL', i: 'AI_INCIDENTAL', n: 'NOT_AI' });
const FLAG_KEYS = Object.freeze({ s: 'SPAM', b: 'BOT_GENERATED', l: 'LANG' });
const NOTE_MAX = 200;
// A note that repeats this many consecutive characters of the post is a quotation.
const QUOTE_WINDOW = 25;
// Control characters except \n and \t, plus the Unicode line separators.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;
// Invisible format characters (bidi overrides, zero-width marks, BOM) can reorder or hide text on screen.
const FORMAT_RE = /\p{Cf}/gu;
// An email, URL or @handle in a note would be a personal identifier in an immutable row.
const NOTE_IDENTIFIER_RE = /[^\s@]+@[^\s@]+\.[^\s@]+|https?:\/\/|www\.|(?:^|[^\w.@])@\w{2,}/i;
const LLM_PREFIX = 'llm:';
// Bounds of an --import file (read by scripts/gold-label.js, checked again here).
const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
const IMPORT_MAX_LINES = 100000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const ANSWER_RE = /^([cin])((?:\s*\+\s*[sbl])*)$/;
const LOOPBACK = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);
// The ports of the project's own development and test databases (docker-compose.yml).
const DEFAULT_DB_PORTS = new Set(['5433', '5434']);

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
 * Replace control characters (keeping newline and tab) so untrusted text
 * cannot drive the labeller's terminal.
 * @param {unknown} text
 * @returns {string}
 */
function sanitize(text) {
    return String(text === null || text === undefined ? '' : text).replace(CONTROL_RE, '�').replace(FORMAT_RE, '');
}

const squash = (t) => String(t).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
// One entry: the same post text is checked against every note typed for it.
let squashed = { text: null, value: '' };
function squashedPost(text) {
    if (squashed.text !== text) squashed = { text, value: squash(text) };
    return squashed.value;
}

/** True when the note repeats QUOTE_WINDOW or more consecutive characters of the post text. */
function noteQuotesPost(note, postText) {
    const n = squash(note);
    const p = squashedPost(postText);
    if (n.length < QUOTE_WINDOW) return false;
    for (let i = 0; i + QUOTE_WINDOW <= n.length; i++) {
        if (p.includes(n.slice(i, i + QUOTE_WINDOW))) return true;
    }
    return false;
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
    const note = hash >= 0 ? raw.slice(hash + 1).trim() || null : null;
    if (note && note.length > NOTE_MAX) return { action: 'invalid', reason: `a note is at most ${NOTE_MAX} characters` };
    if (body === 'k') return { action: 'skip' };
    if (body === 'q') return { action: 'quit' };
    if (body === '?') return { action: 'help' };
    const m = body.match(ANSWER_RE);
    if (!m) return { action: 'invalid' };
    const flags = canonicalFlags((m[2].match(/[sbl]/g) || []).map(k => FLAG_KEYS[k]));
    return { action: 'label', label: LABEL_KEYS[m[1]], flags, note };
}

/**
 * Refuse to run anywhere but against the project's local databases, never in
 * production. A loopback host can still be a tunnel to a production database,
 * so the effective port must also be the development port (5434) or the test
 * port (5433), or be acknowledged with GOLD_ALLOW_DB_PORT=<that port>. Every
 * gold tool that reads post text or writes gold rows calls it.
 * @param {NodeJS.ProcessEnv} env
 */
function assertLocalOnly(env = process.env) {
    if (env.NODE_ENV === 'production') {
        throw new Error('gold tools are local-only: refusing to run with NODE_ENV=production');
    }
    const host = String(env.POSTGRES_HOST || '').trim().toLowerCase();
    if (!LOOPBACK.has(host)) {
        throw new Error(`gold tools are local-only: POSTGRES_HOST "${host}" is not a loopback address (localhost, 127.0.0.1, ::1)`);
    }
    // The port src/db/connection.js uses: its defaults are 5433 (test) and 5432, so an unset
    // POSTGRES_PORT fails closed (5432 is not a project port) unless acknowledged.
    const port = String(env.NODE_ENV === 'test' ? (env.POSTGRES_TEST_PORT || '5433') : (env.POSTGRES_PORT || '5432')).trim();
    if (!DEFAULT_DB_PORTS.has(port) && String(env.GOLD_ALLOW_DB_PORT || '').trim() !== port) {
        throw new Error(`gold tools are local-only: database port ${port} is not the development (5434) or test (5433) port; `
            + `if it is a local throwaway database, set GOLD_ALLOW_DB_PORT=${port}`);
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
        // Accepted in the file, never stored (see the header): a model's note could quote the post.
        note: null,
    };
}

/** A human or adjudicator name: printable, at most 100 characters, and never in the "llm:" namespace. */
function validateLabeller(labeller) {
    const name = String(labeller === null || labeller === undefined ? '' : labeller).trim();
    if (!name) throw new Error('a labeller name is required');
    if (name.length > 100) throw new Error('a labeller name is at most 100 characters');
    if (sanitize(name) !== name) throw new Error('a labeller name may not contain control characters');
    if (name.toLowerCase().startsWith(LLM_PREFIX)) {
        throw new Error(`the "${LLM_PREFIX}" labeller namespace is reserved for llm_proposed labels (use --import)`);
    }
    return name;
}

/**
 * Interactive labelling loop.
 * @param {{ store: object, io: { print: (l: string) => void, ask: (p: string) => Promise<string|null> },
 *           labeller: string, sampleId: string, method?: 'human'|'adjudicated',
 *           limit?: number, codebookVersion?: string, itemId?: string }} opts
 *   itemId: relabel ONE item (a correction: a new row, the latest counts); the
 *           labeller's current label is shown, since it is their own.
 * @returns {Promise<{ labelled: number, skipped: number, unavailable: number, quit: boolean }>}
 */
async function runSession({ store, io, labeller, sampleId, method = 'human', limit = Infinity, codebookVersion = CODEBOOK_VERSION, itemId = null }) {
    const who = validateLabeller(labeller);
    if (!['human', 'adjudicated'].includes(method)) throw new Error('the interactive session records human or adjudicated labels only');
    let items;
    if (itemId) {
        if (!UUID_RE.test(itemId)) throw new Error('--relabel needs a gold item UUID');
        const one = await store.getItem(sampleId, itemId.toLowerCase());
        if (!one) throw new Error(`item ${itemId} is not a live item of sample ${sampleId}`);
        items = [one];
    } else {
        items = await store.pendingItems({ sampleId, labeller: who, method, codebookVersion });
    }
    const summary = { labelled: 0, skipped: 0, unavailable: 0, quit: false };
    io.print(`${items.length} item(s) to label in sample ${sanitize(sampleId)} as ${sanitize(who)} (${method}, codebook ${codebookVersion}). "?" for help.`);
    for (const item of items) {
        if (summary.labelled >= limit) break;
        const text = await store.itemText(item);
        if (text.status !== 'ok') {
            summary.unavailable += 1;
            io.print(`-- item ${item.id}: skipped, text ${text.status} (retention or edit); not labelled.`);
            continue;
        }
        io.print('');
        io.print(`== item ${item.id}  [category: ${sanitize(item.category)}]`);
        if (method === 'adjudicated' || itemId) {
            for (const l of await store.labelsFor(item.id)) {
                if (itemId && method !== 'adjudicated' && l.labeller !== who) continue;
                io.print(`   ${sanitize(l.labeller)} (${l.method}): ${l.label}${l.flags.length ? ` +${l.flags.join(' +')}` : ''}${l.note ? `  # ${sanitize(l.note)}` : ''}`);
            }
        }
        // Every line is marked, so a post cannot fake the tool's own output lines.
        io.print(sanitize(text.content).split('\n').map(l => `| ${l}`).join('\n'));
        for (;;) {
            const answer = await io.ask('label> ');
            const a = answer === null ? { action: 'quit' } : parseAnswer(answer);
            if (a.action === 'help') { HELP.forEach(l => io.print(l)); continue; }
            if (a.action === 'invalid') { io.print(a.reason ? `${a.reason}; "?" for help` : 'not understood; "?" for help'); continue; }
            if (a.action === 'quit') { summary.quit = true; return summary; }
            if (a.action === 'skip') { summary.skipped += 1; break; }
            if (a.note && NOTE_IDENTIFIER_RE.test(a.note)) {
                io.print('a note may not contain an email address, URL or @handle; reword it');
                continue;
            }
            if (a.note && noteQuotesPost(a.note, text.content)) {
                io.print(`a note may not quote the post (${QUOTE_WINDOW}+ consecutive characters); shorten or reword it`);
                continue;
            }
            await store.recordLabel({
                itemId: item.id, label: a.label, flags: a.flags, labeller: who, method,
                modelId: null, codebookVersion, inputHash: text.inputHash, note: a.note,
            });
            summary.labelled += 1;
            break;
        }
    }
    return summary;
}

/**
 * Record llm_proposed labels from JSON Lines text, under the labeller
 * "llm:<model id>". All-or-nothing: every line is validated (and its hash
 * checked by the database trigger) inside the store's transaction. A file is
 * bounded (IMPORT_MAX_LINES) and may name an item only once: with two lines for
 * one item "the latest" would be arbitrary.
 */
async function importProposals({ store, text, modelId, codebookVersion = CODEBOOK_VERSION }) {
    const model = String(modelId === null || modelId === undefined ? '' : modelId).trim();
    if (!model) throw new Error('--model is required for llm_proposed labels');
    const labeller = `${LLM_PREFIX}${model}`;
    if (labeller.length > 100 || sanitize(labeller) !== labeller) throw new Error('--model must be a printable id of at most 96 characters');
    const lines = String(text).split(/\r?\n/);
    if (lines.length > IMPORT_MAX_LINES) throw new Error(`an import file is at most ${IMPORT_MAX_LINES} lines`);
    const rows = [];
    const seen = new Set();
    lines.forEach((line, i) => {
        if (!line.trim()) return;
        let parsed;
        try { parsed = JSON.parse(line); } catch { throw new Error(`line ${i + 1}: not valid JSON`); }
        let row;
        try { row = validateProposal(parsed); } catch (err) { throw new Error(`line ${i + 1}: ${err.message}`); }
        if (seen.has(row.itemId)) throw new Error(`line ${i + 1}: item ${row.itemId} appears more than once in the file`);
        seen.add(row.itemId);
        rows.push(row);
    });
    if (!rows.length) throw new Error('no proposals to import');
    await store.recordLabels(rows.map(r => ({
        ...r, labeller, method: 'llm_proposed', modelId: model, codebookVersion,
    })));
    return { imported: rows.length, labeller };
}

module.exports = {
    LABEL_KEYS, FLAG_KEYS, HELP, NOTE_MAX, QUOTE_WINDOW, IMPORT_MAX_LINES, IMPORT_MAX_BYTES, LLM_PREFIX, METHODS,
    parseAnswer, assertLocalOnly, validateProposal, validateLabeller, sanitize, noteQuotesPost,
    runSession, importProposals, canonicalFlags,
};
