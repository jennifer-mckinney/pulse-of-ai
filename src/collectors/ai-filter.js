// src/collectors/ai-filter.js
// Local AI-scope filter for site-wide and technology feeds (registry routes
// with scope 'filter'). A feed that is already AI-specific (scope 'ai') is
// not filtered. This is a COLLECTION scope rule, separate from the pipeline's
// relevance score (src/pipeline/relevance.js), which is registered methodology.
//
// Deliberately precise over broad: "AI" must be the upper-case word (so
// "said", "Thai" or "ai" in a URL never match), product names are specific.

'use strict';

const PATTERNS = [
    /\bA\.?I\.?(?![a-z])/,                     // AI, A.I. (upper case only)
    /\bAGI\b/,
    /\bLLMs?\b/,
    /\bNLP\b/,
    /\bGPT(?:-?\d(?:\.\d)?o?)?\b/,
    /artificial[\s-]intelligence/i,
    /machine[\s-]learning/i,
    /deep[\s-]learning/i,
    /neural[\s-]net(?:work)?s?/i,
    /large[\s-]language[\s-]models?/i,
    /language[\s-]models?/i,
    /generative\s+(?:ai|models?|tools?)/i,
    /natural[\s-]language[\s-]processing/i,
    /computer[\s-]vision/i,
    /\b(?:chatbots?|chatgpt|openai|anthropic|deepmind|copilot|midjourney|hugging\s?face|stable\s+diffusion|mistral\s+ai)\b/i,
    /\bdeepfakes?\b/i,
    /facial[\s-]recognition/i,
    /\balgorithmic\b/i,
    /\bautonomous\s+(?:vehicles?|agents?|weapons?|driving)\b/i,
    /\brobot(?:s|ics|axis?)?\b/i,
];

/**
 * @param {string} text  title + summary
 * @returns {boolean}
 */
function isAiRelated(text) {
    if (typeof text !== 'string' || text === '') return false;
    return PATTERNS.some(re => re.test(text));
}

module.exports = { isAiRelated, PATTERNS };
