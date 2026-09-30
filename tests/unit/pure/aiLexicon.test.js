// tests/unit/pure/aiLexicon.test.js
// PR #22 grumpy H3: relevance@1.2.0 registered "AI" as a case-sensitive
// WHOLE word (migration 029). The shared expression must not match inside
// upper-case words such as AIDS, AIG, AIM or AIR, in relevance or in the
// collection filter that shares it.

const { AI_ACRONYM_RE } = require('../../../src/config/ai-lexicon');
const { computeRelevance } = require('../../../src/pipeline/relevance');
const { isAiRelated } = require('../../../src/collectors/ai-filter');

describe('AI_ACRONYM_RE — case-sensitive whole word "AI" / "A.I."', () => {
    it.each([
        'HIV/AIDS funding cut',
        'AIG shares fall',
        'AIM listing for a miner',
        'AIR QUALITY warning issued',
        'AI2 releases a model',
        'said the maid',
        'Thailand trip',
    ])('does not match inside another word: %s', (text) => {
        expect(AI_ACRONYM_RE.test(text)).toBe(false);
        expect(computeRelevance(text, '1.2.0').matchedKeywords).not.toContain('AI');
    });

    it.each([
        'A.I. rules are coming',
        'The AI Act passed',
        'AI-powered search',
        'Is AI safe?',
        "AI's future",
        'New rules (AI) apply',
    ])('matches the acronym as a whole word: %s', (text) => {
        expect(AI_ACRONYM_RE.test(text)).toBe(true);
        expect(computeRelevance(text, '1.2.0').matchedKeywords).toContain('AI');
    });

    it('the collection filter shares the rule: AIDS / AIG / AIM / AIR alone are not admitted', () => {
        for (const t of ['HIV/AIDS funding cut', 'AIG shares fall', 'AIM listing', 'AIR QUALITY']) {
            expect(isAiRelated(t)).toBe(false);
        }
        expect(isAiRelated('The AI Act passed')).toBe(true);
    });
});
