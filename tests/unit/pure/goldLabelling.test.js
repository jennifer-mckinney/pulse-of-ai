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

    it('caps the note length', () => {
        expect(l.parseAnswer(`c # ${'x'.repeat(5000)}`).note).toHaveLength(2000);
    });
});

describe('assertLocalOnly — never against a remote database or in production', () => {
    it.each([undefined, '', 'localhost', '127.0.0.1', '::1', '[::1]'])('allows host %j', (host) => {
        expect(() => l.assertLocalOnly({ POSTGRES_HOST: host, NODE_ENV: 'development' })).not.toThrow();
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
            .toEqual({ itemId: ok.item_id, label: 'NOT_AI', flags: ['SPAM'], inputHash: ok.input_hash, note: 'airline spam' });
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
