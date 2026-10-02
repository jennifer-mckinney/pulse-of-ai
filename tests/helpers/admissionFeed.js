// tests/helpers/admissionFeed.js
// A hand-written RSS feed whose items exercise every admission outcome of the
// collector (src/collectors/base.js collect): one invalid item, one too old,
// one that no admission pattern matches, one in-batch duplicate, and three
// that patterns match. EXPECTED_* are written out by hand from
// admission_filter@1.0.0's PATTERNS (src/collectors/ai-filter.js), never
// computed with the code under test.

'use strict';

const { RECORDED_AT } = require('./fixtureTransport');

const HOUR = 3600000;
const at = ms => new Date(Date.parse(RECORDED_AT) - ms).toUTCString();

function item({ guid, title, description, ageMs = HOUR }) {
    return '<item>'
        + (title ? `<title>${title}</title>` : '')
        + (description ? `<description>${description}</description>` : '')
        + (guid ? `<guid isPermaLink="false">${guid}</guid>` : '')
        + `<pubDate>${at(ageMs)}</pubDate>`
        + '</item>';
}

/** The feed body. */
function admissionFeedXml() {
    return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Test feed</title>'
        // patterns 09 (large language models), 10 (language models), 14 (OpenAI)
        + item({ guid: 'a1', title: 'OpenAI releases a large language model', description: 'It was trained on public text.' })
        // pattern 06 (machine learning)
        + item({ guid: 'a2', title: 'Machine learning helps farmers', description: 'Crop yields rise.' })
        // no pattern
        + item({ guid: 'a3', title: 'Football results from the weekend', description: 'The home side won.' })
        // older than the 7-day window
        + item({ guid: 'a4', title: 'AI rules from long ago', description: 'Old news.', ageMs: 30 * 24 * HOUR })
        // no id and no text: invalid
        + item({})
        // a1 again: an in-batch duplicate
        + item({ guid: 'a1', title: 'OpenAI releases a large language model', description: 'It was trained on public text.' })
        // patterns 00 (AI) and 19 (robots)
        + item({ guid: 'a5', title: 'Robots and AI at the expo', description: 'Crowds gathered.' })
        + '</channel></rss>';
}

// Evaluations by rule for a route of scope 'filter' (BBC Technology).
const EXPECTED_FILTER = Object.freeze({
    invalid:       { admitted: 0, rejected: 1 },
    old:           { admitted: 0, rejected: 1 },
    no_pattern:    { admitted: 0, rejected: 1 },
    duplicate:     { admitted: 0, rejected: 1 },
    any_pattern:   { admitted: 3, rejected: 0 },
    'pattern:00':  { admitted: 1, rejected: 0 },
    'pattern:06':  { admitted: 1, rejected: 0 },
    'pattern:09':  { admitted: 1, rejected: 0 },
    'pattern:10':  { admitted: 1, rejected: 0 },
    'pattern:14':  { admitted: 1, rejected: 0 },
    'pattern:19':  { admitted: 1, rejected: 0 },
});

// The same feed on a route of scope 'ai': nothing is out of scope; the item
// no pattern matches is admitted and counted as such (a shadow measurement).
const EXPECTED_AI = Object.freeze({
    ...EXPECTED_FILTER,
    no_pattern:    { admitted: 1, rejected: 0 },
});

const EXPECTED_DROPPED_FILTER = Object.freeze({ invalid: 1, old: 1, outOfScope: 1, duplicate: 1 });

module.exports = { admissionFeedXml, EXPECTED_FILTER, EXPECTED_AI, EXPECTED_DROPPED_FILTER };
