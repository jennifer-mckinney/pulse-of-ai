// tests/unit/pure/goldScriptsArgs.test.js
// Relevance-accuracy Stage 0: argument parsing of the four offline scripts
// (gold-sample, gold-label, gold-agreement, relevance-eval). No database.

'use strict';

const sample = require('../../../scripts/gold-sample');
const label = require('../../../scripts/gold-label');
const agreement = require('../../../scripts/gold-agreement');
const evalScript = require('../../../scripts/relevance-eval');
const labelling = require('../../../src/gold/labelling');

describe('gold-sample parseArgs', () => {
    it('parses every option', () => {
        expect(sample.parseArgs(['--total', '200', '--seed', 's1', '--min-per-stratum', '5', '--weight', 'script:cjk=4',
            '--weight', 'decision:not_relevant=2', '--since', '2026-09-01', '--sample-id', 'gold-a', '--write', '--json']))
            .toEqual({ total: 200, seed: 's1', minPerStratum: 5, weights: ['script:cjk=4', 'decision:not_relevant=2'],
                since: '2026-09-01', sampleId: 'gold-a', write: true, json: true });
    });

    it.each([
        [[], /--total/],
        [['--total', '0', '--seed', 's'], /--total/],
        [['--total', '1.5', '--seed', 's'], /--total/],
        [['--total', '10'], /--seed/],
        [['--total', '10', '--seed', ''], /needs a value|--seed/],
        [['--total', '10', '--seed', 's', '--min-per-stratum', '-1'], /min-per-stratum/],
        [['--total', '10', '--seed', 's', '--since', 'yesterday-ish'], /--since/],
        [['--total', '10', '--seed', 's', '--write'], /--sample-id/],
        [['--total', '10', '--seed', 's', '--sample-id', 'Bad Id'], /--sample-id/],
        [['--total', '10', '--seed', 's\u001b[2J\nx'], /--seed may not contain/],
        [['--total', '10', '--seed', 'a\u200Bb'], /--seed may not contain/],
        [['--total', '10', '--seed', 's', '--bogus'], /unknown argument/],
        [['--total'], /needs a value/],
    ])('rejects %j', (argv, err) => {
        expect(() => sample.parseArgs(argv)).toThrow(err);
    });
});

describe('gold-label parseArgs', () => {
    it('interactive defaults to the human method', () => {
        expect(label.parseArgs(['--sample', 'gold-a', '--labeller', 'ann']))
            .toMatchObject({ sample: 'gold-a', labeller: 'ann', method: 'human', limit: Infinity, importFile: null });
    });

    it('import mode is llm_proposed and needs --model', () => {
        expect(label.parseArgs(['--import', 'f.jsonl', '--model', 'm']))
            .toMatchObject({ importFile: 'f.jsonl', method: 'llm_proposed', model: 'm' });
    });

    it.each([
        [['--sample', 'g'], /--labeller/],
        [['--labeller', 'ann'], /--sample/],
        [['--sample', 'g', '--labeller', 'ann', '--method', 'llm_proposed'], /--method/],
        [['--sample', 'g', '--labeller', 'ann', '--method', 'guess'], /--method/],
        [['--sample', 'g', '--labeller', 'ann', '--limit', '0'], /--limit/],
        [['--sample', 'g', '--labeller', 'ann', '--model', 'm'], /--model applies to --import/],
        [['--import', 'f'], /--model/],
        [['--import', 'f', '--labeller', 'x', '--model', 'm'], /--labeller does not apply to --import/],
        [['--import', 'f', '--model', 'm', '--method', 'human'], /llm_proposed/],
        [['--import', 'f', '--model', 'm', '--sample', 'g'], /file and --model only/],
        [['--sample', 'g', '--labeller', 'ann', '--relabel', 'i', '--limit', '3'], /--relabel and --limit/],
        [['--x'], /unknown argument/],
    ])('rejects %j', (argv, err) => {
        expect(() => label.parseArgs(argv)).toThrow(err);
    });
});

describe('gold-agreement parseArgs', () => {
    it('defaults the codebook version to the current one', () => {
        expect(agreement.parseArgs([])).toMatchObject({ codebook: '1.0.0', a: null, b: null, json: false });
        expect(agreement.parseArgs(['--sample', 'g', '--a', 'x', '--b', 'y', '--codebook', '0.9.0', '--json']))
            .toEqual({ sample: 'g', a: 'x', b: 'y', codebook: '0.9.0', json: true });
    });

    it.each([
        [['--a', 'x'], /together/],
        [['--a', 'x', '--b', 'x'], /different/],
        [['--nope'], /unknown argument/],
        [['--a', 'x\ny', '--b', 'z'], /--a may not contain/],
        [['--sample', 'g\u001b[2J'], /--sample may not contain/],
        [['--codebook', '1\n2'], /--codebook may not contain/],
    ])('rejects %j', (argv, err) => {
        expect(() => agreement.parseArgs(argv)).toThrow(err);
    });
});

describe('argv echoed in errors is made single-line and printable', () => {
    it.each([
        ['gold-sample', () => sample.parseArgs(['--\u001b]52;c;QQ==\u0007'])],
        ['gold-sample since', () => sample.parseArgs(['--total', '1', '--seed', 's', '--since', '\u001b[2J'])],
        ['gold-agreement', () => agreement.parseArgs(['--\u001b[2J'])],
        ['relevance-eval', () => evalScript.parseArgs(['--since', '\u001b[2J'])],
        ['relevance-eval category', () => evalScript.parseArgs(['--category', '\u001b[2J'])],
    ])('%s', (_n, run) => {
        let msg = '';
        try { run(); } catch (e) { msg = e.message; }
        expect(msg).not.toBe('');
        expect(msg.split('\n')[0]).not.toMatch(/[\u0000-\u001f]/);
    });
});

describe('relevance-eval parseArgs', () => {
    it('parses every option', () => {
        expect(evalScript.parseArgs(['--since', '2026-09-01', '--category', 'news', '--limit', '100', '--json']))
            .toEqual({ since: '2026-09-01', category: 'news', limit: 100, json: true });
    });

    it.each([
        [['--since', 'later'], /--since/],
        [['--category', 'tech'], /canonical category/],
        [['--limit', '-3'], /--limit/],
        [['--write'], /unknown argument/],
    ])('rejects %j', (argv, err) => {
        expect(() => evalScript.parseArgs(argv)).toThrow(err);
    });
});

describe('labelling session guards (pure, fake store)', () => {
    const store = { pendingItems: async () => [] };
    const io = { print: () => {}, ask: async () => null };

    it('requires a labeller and an interactive method', async () => {
        await expect(labelling.runSession({ store, io, labeller: ' ', sampleId: 's' })).rejects.toThrow(/labeller/);
        await expect(labelling.runSession({ store, io, labeller: 'a', sampleId: 's', method: 'llm_proposed' })).rejects.toThrow(/human or adjudicated/);
    });

    it('an empty queue ends immediately', async () => {
        expect(await labelling.runSession({ store, io, labeller: 'a', sampleId: 's' }))
            .toEqual({ labelled: 0, skipped: 0, unavailable: 0, quit: false });
    });

    it('end of input quits', async () => {
        const s = {
            pendingItems: async () => [{ id: 'i1', category: 'news' }],
            itemText: async () => ({ status: 'ok', content: 'text', inputHash: 'a'.repeat(64) }),
        };
        expect(await labelling.runSession({ store: s, io, labeller: 'a', sampleId: 's' })).toMatchObject({ quit: true, labelled: 0 });
    });

    it('import refuses missing labeller, model, empty input and bad lines (with the line number)', async () => {
        const st = { recordLabels: async () => 0 };
        await expect(labelling.importProposals({ store: st, text: '', modelId: '' })).rejects.toThrow(/--model/);
        await expect(labelling.importProposals({ store: st, text: '\n\n', modelId: 'm' })).rejects.toThrow(/no proposals/);
        await expect(labelling.importProposals({ store: st, text: '{bad', modelId: 'm' })).rejects.toThrow(/line 1: not valid JSON/);
        await expect(labelling.importProposals({ store: st, text: '\n{"item_id":"x"}', modelId: 'm' })).rejects.toThrow(/line 2: item_id/);
    });
});
