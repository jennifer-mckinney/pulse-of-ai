// tests/unit/replay.test.js
// Unit tests for the P1-4 replay engine (src/audit/replay.js) and its CLI
// wrapper (scripts/replay.js, with an injected fake DB). The "seeded post"
// fixtures are built exactly the way the pipeline's save* functions persist
// a decision: stored output = the scorer's fields, input_hash = SHA-256 of
// the content, model_name = the code's MODEL_NAME snapshot.

'use strict';

const crypto = require('crypto');
const {
    STATUS,
    OUT_OF_SCOPE,
    sameValue,
    replayDecision,
    replayPost,
    formatReport,
} = require('../../src/audit/replay');
const { main, parseArgs, USAGE } = require('../../scripts/replay');
const sentiment = require('../../src/pipeline/sentiment');
const relevance = require('../../src/pipeline/relevance');
const discourse = require('../../src/pipeline/discourse');

const POST_ID = '11111111-2222-4333-8444-555555555555';
const CONTENT = 'Machine learning research shows large language model evaluation '
    + 'should improve because the data is great and the findings are wonderful, '
    + 'therefore we propose a better approach.';

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

// Registered configs as seeded (scripts/seed.js) — subsets the replay reads.
const SENTIMENT_CFG = { positive_threshold: 0.05, negative_threshold: -0.05 };
const RELEVANCE_CFG = { keywords: ['artificial intelligence', 'machine learning', 'ai'], score_per_match: 0.1 };
const DISCOURSE_CFG = { dimensions: { participation: { weight: 0.15 }, justification_level: { weight: 0.3 } } };

/** One decision row exactly as saveSentiment/saveRelevance/saveDQI write it. */
function seededDecision(type, content = CONTENT) {
    if (type === 'sentiment') {
        const s = sentiment.computeSentiment(content);
        return {
            decision_type: 'sentiment', model_name: sentiment.MODEL_NAME,
            input_hash: sha(content), component: 'sentiment', version: '1.0.0',
            config: SENTIMENT_CFG,
            output: {
                score: s.score, comparative: s.comparative, indicator: s.indicator,
                positiveWords: s.positiveWords, negativeWords: s.negativeWords,
            },
        };
    }
    if (type === 'relevance') {
        const r = relevance.computeRelevance(content);
        return {
            decision_type: 'relevance', model_name: relevance.MODEL_NAME,
            input_hash: sha(content), component: 'relevance', version: '1.0.0',
            config: RELEVANCE_CFG,
            output: { score: r.score, matchedKeywords: r.matchedKeywords },
        };
    }
    const q = discourse.computeDQI(content);
    return {
        decision_type: 'discourse', model_name: discourse.MODEL_NAME,
        input_hash: sha(content), component: 'discourse', version: '1.0.0-DQI',
        config: DISCOURSE_CFG,
        output: { total: q.total, dimensions: q.dimensions },
    };
}

function seededPost() {
    return {
        post: { id: POST_ID, content: CONTENT },
        decisions: ['sentiment', 'relevance', 'discourse'].map(t => seededDecision(t)),
    };
}

describe('replayPost — a pipeline-seeded post reproduces', () => {
    it('re-runs every stored stage and reports PASS with exit code 0', () => {
        const report = replayPost(seededPost());
        expect(report.stages.map(s => [s.stage, s.status])).toEqual([
            ['sentiment', STATUS.PASS],
            ['relevance', STATUS.PASS],
            ['discourse', STATUS.PASS],
        ]);
        expect(report.result).toBe('PASS');
        expect(report.exitCode).toBe(0);
        for (const s of report.stages) {
            expect(s.diffs).toEqual([]);
            expect(s.notCompared).toEqual([]);
        }
    });

    it('states registered-config drift as caveats instead of hiding it behind the PASS', () => {
        const report = replayPost(seededPost());
        const byStage = Object.fromEntries(report.stages.map(s => [s.stage, s]));
        expect(byStage.sentiment.caveats).toEqual([]);       // thresholds agree
        expect(byStage.relevance.caveats.join(' ')).toMatch(/registered keyword list \(3\) ≠ code lexicon \(20\)/);
        expect(byStage.relevance.caveats.join(' ')).toMatch(/score_per_match 0\.1 ≠ code 1\/20/);
        expect(byStage.discourse.caveats.join(' ')).toMatch(/registered DQI dimensions/);
    });

    it('always lists the receipt stages that are out of per-post replay scope', () => {
        const report = replayPost(seededPost());
        expect(report.outOfScope.map(o => o.stage)).toEqual(['ingestion', 'bias']);
        const text = formatReport(report).join('\n');
        expect(text).toContain('[PASS] sentiment (afinn-sentiment-v5 @ methodology 1.0.0)');
        expect(text).toContain('[NOT RE-RUNNABLE] ingestion — out of per-post replay scope');
        expect(text).toContain('[NOT RE-RUNNABLE] bias — out of per-post replay scope');
        expect(text).toContain('caveat: config drift: registered keyword list');
        expect(text.trim().split('\n').pop()).toBe('RESULT: PASS');
    });
});

describe('replayDecision — divergence is reported, never smoothed over', () => {
    it('a fabricated stored output (seed-demo style) is a DIVERGENCE with per-field diffs', () => {
        const d = seededDecision('sentiment');
        d.model_name = 'afinn-sentiment-v5.0.2';
        d.output = { score: 4, comparative: 0.28, indicator: 'positive' };
        const r = replayDecision(CONTENT, d);
        expect(r.status).toBe(STATUS.DIVERGENCE);
        expect(r.diffs.map(x => x.field)).toEqual(expect.arrayContaining(['score', 'comparative']));
        expect(r.notCompared).toEqual(['positiveWords', 'negativeWords']);
        expect(r.caveats[0]).toMatch(/stored model_name 'afinn-sentiment-v5\.0\.2' ≠ code model 'afinn-sentiment-v5'/);
        const text = formatReport(replayPost({ post: { id: POST_ID, content: CONTENT }, decisions: [d] })).join('\n');
        expect(text).toContain('[DIVERGENCE] sentiment');
        expect(text).toMatch(/score: stored 4 ≠ replayed \d+/);
        expect(text).toContain('not compared (absent from stored output): positiveWords, negativeWords');
        expect(text).toContain('RESULT: DIVERGENCE');
    });

    it('content that no longer hashes to the scored input diverges on input_hash', () => {
        const d = seededDecision('relevance');
        const r = replayDecision(CONTENT + ' (edited)', d);
        expect(r.status).toBe(STATUS.DIVERGENCE);
        expect(r.diffs[0].field).toBe('input_hash');
        expect(r.reason).toMatch(/no longer hashes/);
    });

    it('a missing input_hash is a caveat, not a silent pass', () => {
        const d = seededDecision('discourse');
        delete d.input_hash;
        const r = replayDecision(CONTENT, d);
        expect(r.status).toBe(STATUS.PASS);
        expect(r.caveats).toContain('no stored input_hash — input identity could not be verified');
    });

    it('a divergent stage makes the whole replay exit 1', () => {
        const input = seededPost();
        input.decisions[1].output.score = 0.99;
        const report = replayPost(input);
        expect(report.result).toBe('DIVERGENCE');
        expect(report.exitCode).toBe(1);
    });
});

describe('replayDecision — NOT RE-RUNNABLE is honest and never a pass', () => {
    it('decision types without a deterministic scorer', () => {
        const r = replayDecision(CONTENT, { decision_type: 'topic', output: { label: 'x' } });
        expect(r.status).toBe(STATUS.NOT_RERUNNABLE);
        expect(r.reason).toMatch(/no deterministic scorer .* 'topic'/);
    });

    it('posts whose content is no longer stored', () => {
        for (const content of [null, '']) {
            const r = replayDecision(content, seededDecision('sentiment'));
            expect(r.status).toBe(STATUS.NOT_RERUNNABLE);
            expect(r.reason).toMatch(/no longer available/);
        }
    });

    it('stored outputs that carry none of the reproducible fields', () => {
        const d = seededDecision('discourse');
        d.output = { unrelated: 1 };
        const r = replayDecision(CONTENT, d);
        expect(r.status).toBe(STATUS.NOT_RERUNNABLE);
        expect(r.reason).toMatch(/none of the reproducible fields/);
        const d2 = seededDecision('discourse');
        d2.output = null;
        expect(replayDecision(CONTENT, d2).status).toBe(STATUS.NOT_RERUNNABLE);
    });

    it('any un-run stage (or no decisions at all) is PARTIAL with exit 3', () => {
        const input = seededPost();
        input.decisions.push({ decision_type: 'demographic', output: {} });
        const report = replayPost(input);
        expect(report.result).toBe('PARTIAL');
        expect(report.exitCode).toBe(3);
        const empty = replayPost({ post: { id: POST_ID, content: CONTENT }, decisions: [] });
        expect(empty.result).toBe('PARTIAL');
        expect(empty.exitCode).toBe(3);
        expect(formatReport(empty).join('\n')).toContain('no stored decisions for this post');
    });
});

describe('sameValue — deep comparison with numeric tolerance', () => {
    it('compares numbers, arrays (ordered) and objects (by key)', () => {
        expect(sameValue(0.1 + 0.2, 0.3)).toBe(true);
        expect(sameValue(0.3, 0.31)).toBe(false);
        expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true);
        expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false);
        expect(sameValue(['a'], 'a')).toBe(false);
        expect(sameValue({ x: 1, y: [2] }, { y: [2], x: 1 })).toBe(true);
        expect(sameValue({ x: 1 }, { x: 1, y: 2 })).toBe(false);
        expect(sameValue('positive', 'positive')).toBe(true);
        expect(sameValue(null, 0)).toBe(false);
    });

    it('drift checks tolerate missing configs', () => {
        const d = seededDecision('relevance');
        d.config = null;
        expect(replayDecision(CONTENT, d).caveats).toEqual([]);
        const s = seededDecision('sentiment');
        s.config = { positive_threshold: 0.1, negative_threshold: -0.1 };
        expect(replayDecision(CONTENT, s).caveats).toHaveLength(2);
        const q = seededDecision('discourse');
        q.config = null;
        expect(replayDecision(CONTENT, q).caveats).toEqual([]);
        expect(OUT_OF_SCOPE).toHaveLength(2);
    });
});

describe('scripts/replay.js — CLI wrapper', () => {
    function fakeDb(input, { fail } = {}) {
        return {
            dbGet: async () => {
                if (fail) throw new Error('connection refused');
                return input ? input.post : undefined;
            },
            dbAll: async () => (input ? input.decisions : []),
        };
    }
    function capture() {
        const lines = { out: [], err: [] };
        return { lines, io: { out: l => lines.out.push(l), err: l => lines.err.push(l) } };
    }

    it('parses --post and --json and rejects bad input', () => {
        expect(parseArgs(['--post', POST_ID])).toEqual({ postId: POST_ID, json: false });
        expect(parseArgs(['--post', POST_ID, '--json'])).toEqual({ postId: POST_ID, json: true });
        expect(parseArgs([]).error).toBe(USAGE);
        expect(parseArgs(undefined).error).toBe(USAGE);
        expect(parseArgs(['--post', 'nope']).error).toMatch(/must be a UUID/);
    });

    it('prints the per-stage report and exits with the replay code', async () => {
        const { lines, io } = capture();
        const code = await main(['--post', POST_ID], { ...io, db: fakeDb(seededPost()) });
        expect(code).toBe(0);
        expect(lines.out[0]).toBe(`Replay — post ${POST_ID}`);
        expect(lines.out).toContain('RESULT: PASS');
    });

    it('--json emits the structured report', async () => {
        const { lines, io } = capture();
        const code = await main(['--post', POST_ID, '--json'], { ...io, db: fakeDb(seededPost()) });
        expect(code).toBe(0);
        expect(JSON.parse(lines.out.join('\n')).result).toBe('PASS');
    });

    it('usage errors, unknown posts and DB failures exit 2', async () => {
        let c = capture();
        expect(await main([], c.io)).toBe(2);
        expect(c.lines.err[0]).toBe(USAGE);
        c = capture();
        expect(await main(['--post', POST_ID], { ...c.io, db: fakeDb(null) })).toBe(2);
        expect(c.lines.err[0]).toMatch(/not found/);
        c = capture();
        expect(await main(['--post', POST_ID], { ...c.io, db: fakeDb(null, { fail: true }) })).toBe(2);
        expect(c.lines.err[0]).toMatch(/database error — connection refused/);
    });
});
