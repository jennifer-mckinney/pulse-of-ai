// src/config/ai-lexicon.js
// The AI vocabulary shared by the two places that decide "is this about AI":
//
//   src/collectors/ai-filter.js   COLLECTION scope — which items of a
//                                 site-wide or technology feed are kept at
//                                 all (a yes/no gate, tuned for precision:
//                                 product names, "AI" upper case only).
//   src/pipeline/relevance.js     the registered RELEVANCE score of a stored
//                                 post (relevance@1.2.0): how many lexicon
//                                 terms it uses, out of the lexicon size.
//
// How they relate (P10-13): every relevance term that can be ambiguous is
// matched with the SAME rule the filter uses, from this module, so a post
// the filter admitted for "AI" is not scored 0 by relevance for want of the
// same word, and the filter's precision rules (case-sensitive "AI", whole
// words for acronyms) hold in both. The filter's extra product and topic
// patterns (ChatGPT, OpenAI, deepfake, robotics, …) widen COLLECTION only;
// they are not relevance terms, because the relevance lexicon is a
// registered, versioned methodology (src/config/methodology-registry.js)
// and changes only as a new version.
//
// relevance@1.2.0 matching (the fix for substring hits such as "Robert"
// matching "bert" or "chatbots" never matching a whole-word rule):
//   - "AI" is case-sensitive and a whole word (A.I. allowed): never "said",
//     "Thai" or "ai" inside a URL;
//   - short acronyms (LLM, NLP, BERT) are whole words; LLM and NLP in any
//     case, BERT upper case only (Bert is a name);
//   - "gpt" is a whole word, with ChatGPT and a version suffix (GPT-4o)
//     allowed;
//   - every other term is case-insensitive with word boundaries at both
//     ends, a plural "s" allowed, and a hyphen or space between words.

'use strict';

// "AI" / "A.I." upper case only, not followed by a lower-case letter.
// Shared object: ai-filter.js PATTERNS uses this exact expression.
const AI_ACRONYM_RE = /\bA\.?I\.?(?![a-z])/;
const LLM_RE = /\bLLMs?\b/i;
const NLP_RE = /\bNLP\b/i;
const GPT_RE = /\b(?:chat)?gpt(?:-?\d+(?:\.\d+)?o?)?s?\b/i;
const BERT_RE = /\bBERT\b/;

/** Whole-word, case-insensitive phrase pattern: spaces or hyphens between words, optional plural. */
function phrase(p) {
    const words = p.split(/[\s-]+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`\\b${words.join('[\\s-]+')}s?\\b`, 'i');
}

// relevance@1.2.0: the 20 relevance@1.1.0 terms, in their order, plus "AI"
// (the filter's primary signal) — 21 terms. `term` is what is recorded in
// matchedKeywords; `pattern` is the matching rule above.
const RELEVANCE_TERMS_1_2_0 = Object.freeze([
    { term: 'artificial intelligence', pattern: phrase('artificial intelligence') },
    { term: 'machine learning', pattern: phrase('machine learning') },
    { term: 'deep learning', pattern: phrase('deep learning') },
    { term: 'neural network', pattern: phrase('neural network') },
    { term: 'large language model', pattern: phrase('large language model') },
    { term: 'llm', pattern: LLM_RE },
    { term: 'natural language processing', pattern: phrase('natural language processing') },
    { term: 'nlp', pattern: NLP_RE },
    { term: 'transformer', pattern: phrase('transformer') },
    { term: 'reinforcement learning', pattern: phrase('reinforcement learning') },
    { term: 'generative ai', pattern: phrase('generative ai') },
    { term: 'computer vision', pattern: phrase('computer vision') },
    { term: 'foundation model', pattern: phrase('foundation model') },
    { term: 'fine-tuning', pattern: phrase('fine tuning') },
    { term: 'embeddings', pattern: /\bembeddings?\b/i },
    { term: 'gpt', pattern: GPT_RE },
    { term: 'bert', pattern: BERT_RE },
    { term: 'diffusion model', pattern: phrase('diffusion model') },
    { term: 'autonomous agent', pattern: phrase('autonomous agent') },
    { term: 'ai safety', pattern: phrase('ai safety') },
    { term: 'AI', pattern: AI_ACRONYM_RE },
]);

/** Human-readable matching rule per term (registered in relevance@1.2.0's config). */
function describeRule(t) {
    if (t.pattern === AI_ACRONYM_RE) return 'case-sensitive whole word "AI" or "A.I."';
    if (t.pattern === BERT_RE) return 'case-sensitive whole word "BERT"';
    if (t.pattern === GPT_RE) return 'whole word, any case; "ChatGPT" and a version suffix (GPT-4o) allowed';
    if (t.pattern === LLM_RE) return 'whole word, any case, plural allowed';
    if (t.pattern === NLP_RE) return 'whole word, any case';
    return 'whole words, any case, space or hyphen between words, plural allowed';
}

module.exports = {
    AI_ACRONYM_RE, LLM_RE, NLP_RE, GPT_RE, BERT_RE, RELEVANCE_TERMS_1_2_0, describeRule, phrase,
};
