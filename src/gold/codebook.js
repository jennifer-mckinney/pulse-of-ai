// src/gold/codebook.js
// Relevance-accuracy Stage 0 (P3): the constants of the relevance codebook
// (docs/governance/relevance-codebook.md, v1). The document is the source of
// record for what the labels MEAN; this module is the source of record for
// the values the gold tables accept. tests/unit/pure/goldLabelling.test.js
// holds the two in step, and migration 070's CHECK constraints accept
// exactly these values.
//
// Jennifer's decision (Relevance-accuracy Stage 0): "Central + incidental
// (Recommended)" — three labels, the binary metric counts central and
// incidental as AI, plus three flags.
//
// Offline only: nothing in the production pipeline requires src/gold.

'use strict';

/** The codebook version every label records (relevance_gold_labels.codebook_version). */
const CODEBOOK_VERSION = '1.0.0';

/** Mutually exclusive topic labels. */
const LABELS = Object.freeze(['AI_CENTRAL', 'AI_INCIDENTAL', 'NOT_AI']);

/** Independent flags, any number per label. */
const FLAGS = Object.freeze(['SPAM', 'BOT_GENERATED', 'LANG']);

/** How a label was produced. */
const METHODS = Object.freeze(['human', 'llm_proposed', 'adjudicated']);

/** The binary metric: central + incidental = AI. */
const BINARY = Object.freeze({ AI_CENTRAL: 'AI', AI_INCIDENTAL: 'AI', NOT_AI: 'NOT_AI' });

/** Agreement thresholds (codebook section 6): reliable / tentative / unreliable. */
const KAPPA_RELIABLE = 0.80;
// Krippendorff's tentative bound is 2/3 (the codebook writes it 0.667): a kappa of exactly 2/3 is tentative.
const KAPPA_TENTATIVE = 2 / 3;
/** Shared items below which an agreement figure is indicative only (codebook section 6, the double-coding floor). */
const KAPPA_MIN_ITEMS = 300;

module.exports = { CODEBOOK_VERSION, LABELS, FLAGS, METHODS, BINARY, KAPPA_RELIABLE, KAPPA_TENTATIVE, KAPPA_MIN_ITEMS };
