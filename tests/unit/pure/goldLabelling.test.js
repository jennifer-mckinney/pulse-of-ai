// tests/unit/pure/goldLabelling.test.js
// Relevance-accuracy Stage 0 (P3): the codebook constants
// (src/gold/codebook.js), their parity with the codebook document
// (docs/governance/relevance-codebook.md), and the labelling CLI's pure
// parts (src/gold/labelling.js): answer parsing, the local-only guard,
// LLM-proposal import validation.

'use strict';

const fs = require('fs');
const path = require('path');
const cb = require('../../../src/gold/codebook');
const l = require('../../../src/gold/labelling');

const DOC = fs.readFileSync(path.join(__dirname, '../../../docs/governance/relevance-codebook.md'), 'utf8');

describe('codebook constants', () => {
    it('labels, flags and methods are exactly Jennifer\'s decision', () => {
        expect(cb.LABELS).toEqual(['AI_CENTRAL', 'AI_INCIDENTAL', 'NOT_AI']);
        expect(cb.FLAGS).toEqual(['SPAM', 'BOT_GENERATED', 'LANG']);
        expect(cb.METHODS).toEqual(['human', 'llm_proposed', 'adjudicated']);
        expect(cb.CODEBOOK_VERSION).toBe('1.0.0');
    });

    it('the binary metric counts central and incidental as AI', () => {
        expect(cb.BINARY).toEqual({ AI_CENTRAL: 'AI', AI_INCIDENTAL: 'AI', NOT_AI: 'NOT_AI' });
    });

    it('the codebook document states the same version, labels, flags and methods', () => {
        expect(DOC).toMatch(new RegExp(`codebook_version:\\s*\`${cb.CODEBOOK_VERSION.replace(/\./g, '\\.')}\``));
        for (const x of [...cb.LABELS, ...cb.FLAGS, ...cb.METHODS]) expect(DOC).toContain(`\`${x}\``);
    });

    it('the codebook lists every OPEN edge case the library tags', () => {
        const { EDGE_CASES } = require('../../../src/config/ai-lexicon-tiers');
        for (const e of EDGE_CASES) expect(DOC).toContain(`\`${e.id}\``);
        expect((DOC.match(/\*\*Status: OPEN\*\*/g) || []).length).toBe(EDGE_CASES.length);
    });
});

describe('parseAnswer — the labelling prompt', () => {
    it.each([
        ['c', { action: 'label', label: 'AI_CENTRAL', flags: [], note: null }],
        ['I', { action: 'label', label: 'AI_INCIDENTAL', flags: [], note: null }],
        ['n', { action: 'label', label: 'NOT_AI', flags: [], note: null }],
        ['n+s', { action: 'label', label: 'NOT_AI', flags: ['SPAM'], note: null }],
        ['c +l +b', { action: 'label', label: 'AI_CENTRAL', flags: ['BOT_GENERATED', 'LANG'], note: null }],
        ['n+s+s', { action: 'label', label: 'NOT_AI', flags: ['SPAM'], note: null }],
        ['i # mentions GPT in passing', { action: 'label', label: 'AI_INCIDENTAL', flags: [], note: 'mentions GPT in passing' }],
        ['  k  ', { action: 'skip' }],
        ['q', { action: 'quit' }],
        ['?', { action: 'help' }],
    ])('%j', (input, expected) => {
        expect(l.parseAnswer(input)).toEqual(expected);
    });

    it.each(['', 'x', 'c+z', 'cn', '+s', 'c s'])('invalid: %j', (input) => {
        expect(l.parseAnswer(input).action).toBe('invalid');
    });

    it('refuses a note over the 200-character cap', () => {
        expect(l.parseAnswer(`c # ${'x'.repeat(200)}`).note).toHaveLength(200);
        expect(l.parseAnswer(`c # ${'x'.repeat(201)}`)).toMatchObject({ action: 'invalid' });
    });
});

describe('assertLocalOnly — never against a remote database or in production', () => {
    it.each([undefined, '', 'localhost', '127.0.0.1', '::1', '[::1]'])('allows host %j', (host) => {
        expect(() => l.assertLocalOnly({ POSTGRES_HOST: host, NODE_ENV: 'development', POSTGRES_PORT: '5434' })).not.toThrow();
    });

    it.each(['postgres', 'db.example.com', '10.0.0.5', '0.0.0.0'])('refuses host %j', (host) => {
        expect(() => l.assertLocalOnly({ POSTGRES_HOST: host })).toThrow(/local-only/);
    });

    it('refuses NODE_ENV=production', () => {
        expect(() => l.assertLocalOnly({ POSTGRES_HOST: 'localhost', NODE_ENV: 'production' })).toThrow(/production/);
    });
});

describe('validateProposal — one line of an llm_proposed import', () => {
    const ok = { item_id: '11111111-1111-4111-8111-111111111111', label: 'NOT_AI', flags: ['SPAM'], input_hash: 'a'.repeat(64) };

    it('accepts a well-formed line and normalises flags', () => {
        expect(l.validateProposal({ ...ok, flags: ['SPAM', 'SPAM'], note: 'airline spam' }))
            .toEqual({ itemId: ok.item_id, label: 'NOT_AI', flags: ['SPAM'], inputHash: ok.input_hash, note: null });
    });

    it.each([
        [{ ...ok, item_id: 'nope' }, /item_id/],
        [{ ...ok, label: 'MAYBE' }, /label/],
        [{ ...ok, flags: ['FUN'] }, /flag/],
        [{ ...ok, flags: 'SPAM' }, /flags/],
        [{ ...ok, input_hash: 'xyz' }, /input_hash/],
        [{ ...ok, note: 42 }, /note/],
        [null, /object/],
    ])('rejects %j', (row, err) => {
        expect(() => l.validateProposal(row)).toThrow(err);
    });
});

describe('the labelling CLI is never served by the API', () => {
    it('no route or the server references the gold modules or the labelling script', () => {
        const dir = path.join(__dirname, '../../../src/routes');
        const files = [...fs.readdirSync(dir).map(f => path.join(dir, f)), path.join(__dirname, '../../../src/server.js')];
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            expect(src).not.toMatch(/gold|relevance_gold/);
        }
    });
});

describe('review fixes: import namespace, terminal safety, notes, local-only port', () => {
    it('import records under llm:<model>, and refuses an item named twice or a huge file', async () => {
        const seen = [];
        const st = { recordLabels: async (rows) => { seen.push(...rows); return rows.length; } };
        const id = '11111111-1111-4111-8111-111111111111';
        const line = JSON.stringify({ item_id: id, label: 'NOT_AI', input_hash: 'a'.repeat(64), note: 'quoted post text here' });
        const r = await l.importProposals({ store: st, text: line, modelId: 'claude-x' });
        expect(r).toEqual({ imported: 1, labeller: 'llm:claude-x' });
        expect(seen[0]).toMatchObject({ labeller: 'llm:claude-x', method: 'llm_proposed', modelId: 'claude-x', note: null });
        await expect(l.importProposals({ store: st, text: `${line}\n${line}`, modelId: 'm' })).rejects.toThrow(/line 2: item .* more than once/);
        await expect(l.importProposals({ store: st, text: '\n'.repeat(l.IMPORT_MAX_LINES + 1), modelId: 'm' })).rejects.toThrow(/at most/);
    });

    it('sanitize replaces terminal escapes and control characters but keeps newline and tab', () => {
        expect(l.sanitize('a\u001b[2Jb\u001b]52;c;QQ==\u0007c\u0085d\ne\tf')).toBe('a\uFFFD[2Jb\uFFFD]52;c;QQ==\uFFFDc\uFFFDd\ne\tf');
        expect(l.sanitize(null)).toBe('');
    });

    it('a session prints post text sanitized, and refuses a note that quotes the post', async () => {
        const out = [];
        const answers = ['c # the post says: this is a quoted passage of the post', 'c # fine'];
        const recorded = [];
        const store = {
            pendingItems: async () => [{ id: 'i1', category: 'news', raw_post_id: 'p', input_hash: 'h' }],
            itemText: async () => ({ status: 'ok', content: 'evil \u001b[2J this is a quoted passage of the post', inputHash: 'h' }),
            labelsFor: async () => [],
            recordLabel: async (x) => { recorded.push(x); },
        };
        const io = { print: (m) => out.push(m), ask: async () => answers.shift() };
        await l.runSession({ store, io, labeller: 'ann', sampleId: 's' });
        expect(out.join('\n')).not.toMatch(/\u001b/);
        expect(out.join('\n')).toMatch(/may not quote the post/);
        expect(recorded).toHaveLength(1);
        expect(recorded[0].note).toBe('fine');
    });

    it('labeller names: the llm: namespace is reserved, control characters and long names refused', () => {
        expect(() => l.validateLabeller('LLM:x')).toThrow(/reserved/);
        expect(() => l.validateLabeller('a\u001bb')).toThrow(/control/);
        expect(() => l.validateLabeller('x'.repeat(101))).toThrow(/100/);
        expect(l.validateLabeller('  ann ')).toBe('ann');
    });

    it('noteQuotesPost compares case- and space-insensitively over a 25-character window', () => {
        expect(l.noteQuotesPost('short', 'short')).toBe(false);
        expect(l.noteQuotesPost('It SAYS  the quick brown fox jumps over', 'The quick brown fox jumps over the dog')).toBe(true);
        expect(l.noteQuotesPost('airline-support spam, nothing copied', 'Delta reservations number change my flight')).toBe(false);
    });

    it('assertLocalOnly also checks the database port', () => {
        expect(() => l.assertLocalOnly({ POSTGRES_HOST: 'localhost', POSTGRES_PORT: '5434' })).not.toThrow();
        expect(() => l.assertLocalOnly({ POSTGRES_HOST: 'localhost', NODE_ENV: 'test', POSTGRES_TEST_PORT: '5433' })).not.toThrow();
        expect(() => l.assertLocalOnly({ POSTGRES_HOST: 'localhost', POSTGRES_PORT: '5432' })).toThrow(/port 5432/);
        // Unset: src/db/connection.js would connect to 5432, so it fails closed.
        expect(() => l.assertLocalOnly({ POSTGRES_HOST: 'localhost' })).toThrow(/port 5432/);
        expect(() => l.assertLocalOnly({ POSTGRES_HOST: 'localhost', POSTGRES_PORT: '5432', GOLD_ALLOW_DB_PORT: '5432' })).not.toThrow();
    });

    it('relabel shows only the labeller\'s own labels and records a new row', async () => {
        const out = [];
        const rec = [];
        const id = '22222222-2222-4222-8222-222222222222';
        const store = {
            getItem: async () => ({ id, category: 'news', raw_post_id: 'p', input_hash: 'h' }),
            itemText: async () => ({ status: 'ok', content: 'text', inputHash: 'h' }),
            labelsFor: async () => [
                { labeller: 'ann', method: 'human', label: 'NOT_AI', flags: [], note: null },
                { labeller: 'bob', method: 'human', label: 'AI_CENTRAL', flags: [], note: null },
            ],
            recordLabel: async (x) => { rec.push(x); },
        };
        await l.runSession({ store, io: { print: (m) => out.push(m), ask: async () => 'c' }, labeller: 'ann', sampleId: 's', itemId: id });
        expect(out.join('\n')).toMatch(/ann \(human\): NOT_AI/);
        expect(out.join('\n')).not.toMatch(/bob/);
        expect(rec).toHaveLength(1);
        await expect(l.runSession({ store, io: {}, labeller: 'ann', sampleId: 's', itemId: 'nope' })).rejects.toThrow(/UUID/);
    });
});

describe('review fixes round 2: format characters, identifiers in notes, quoted block', () => {
    it('sanitize strips bidi and zero-width format characters', () => {
        expect(l.sanitize('a\u202Eb\u200Bc\u2066d\uFEFFe')).toBe('abcde');
    });

    it('a note with an email, URL or @handle is refused; a plain note passes', async () => {
        const out = [];
        const answers = ['c # mail me at a.b@example.com', 'c # see https://example.com', 'c # ping @someone', 'c # contact (@alice) now', 'c # ping:@bob', 'c # plain topic note'];
        const recorded = [];
        const store = {
            pendingItems: async () => [{ id: 'i1', category: 'news', raw_post_id: 'p', input_hash: 'h' }],
            itemText: async () => ({ status: 'ok', content: 'first line\n== item fake\nlabel> c', inputHash: 'h' }),
            labelsFor: async () => [],
            recordLabel: async (x) => { recorded.push(x); },
        };
        await l.runSession({ store, io: { print: (m) => out.push(m), ask: async () => answers.shift() }, labeller: 'ann', sampleId: 's' });
        expect(out.filter(m => /may not contain an email/.test(m))).toHaveLength(5);
        expect(recorded).toHaveLength(1);
        expect(recorded[0].note).toBe('plain topic note');
        // The untrusted block is marked line by line: a post cannot fake the tool's own lines.
        expect(out.join('\n')).toMatch(/\| first line\n\| == item fake\n\| label> c/);
    });
});
