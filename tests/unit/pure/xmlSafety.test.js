// tests/unit/pure/xmlSafety.test.js
// F10-15: XXE and entity expansion. Pins the behaviour of both XML parsers
// the collectors use (rss-parser and xml2js, both on sax): an external
// entity is never resolved, nested entities are never expanded, and parse
// time does not grow with the entity nesting depth (a load-robust check:
// 3 → 10 levels would multiply the work by 10^7 if entities expanded). The collectors additionally refuse any
// body declaring a DTD with entities before parsing (rejectDtdEntities).

'use strict';

const Parser = require('rss-parser');
const xml2js = require('xml2js');
const { RssAtomCollector, rejectDtdEntities } = require('../../../src/collectors/base');
const { ParseError } = require('../../../src/collectors/errors');

const XXE = `<?xml version="1.0"?>
<!DOCTYPE rss [ <!ENTITY xxe SYSTEM "file:///etc/hosts"> ]>
<rss version="2.0"><channel><title>t</title>
<item><title>AI &xxe; news</title><description>&xxe;</description></item></channel></rss>`;

const { scalingAsync } = require('../../helpers/scaling');

/** A billion-laughs document with `levels` levels of 10× nested entities. */
function laughs(levels) {
    const lol = ['<!ENTITY lol0 "lol">'];
    for (let i = 1; i <= levels; i++) lol.push(`<!ENTITY lol${i} "${`&lol${i - 1};`.repeat(10)}">`);
    return `<?xml version="1.0"?>
<!DOCTYPE rss [ ${lol.join(' ')} ]>
<rss version="2.0"><channel><title>t</title><item><title>&lol${levels};</title></item></channel></rss>`;
}
const LAUGHS = laughs(10);
// A hang is a failure whatever the load; normal parses take ~1 ms.
const HARD_MS = 2000;

async function timedParse(fn) {
    const t0 = Date.now();
    let out;
    let err = null;
    try { out = await fn(); } catch (e) { err = e; }
    return { ms: Date.now() - t0, out, err };
}

describe.each([['external entity (XXE)', XXE], ['10-level nested entities', LAUGHS]])('%s', (_, doc) => {
    test('rss-parser: no expansion, no file read, no hang', async () => {
        await new Parser().parseString('<rss version="2.0"><channel><title>w</title></channel></rss>');
        const { ms, out, err } = await timedParse(() => new Parser().parseString(doc));
        expect(ms).toBeLessThan(HARD_MS);
        const text = JSON.stringify(out || err.message);
        expect(text).not.toMatch(/localhost|lollol|127\.0\.0\.1/);
    });

    test('xml2js: no expansion, no file read, no hang', async () => {
        const { ms, out, err } = await timedParse(() => xml2js.parseStringPromise(doc, { explicitArray: false }));
        expect(ms).toBeLessThan(HARD_MS);
        const text = JSON.stringify(out || err.message);
        expect(text).not.toMatch(/localhost|lollol|127\.0\.0\.1/);
    });

    test('the collectors refuse the body before parsing', async () => {
        expect(() => rejectDtdEntities(doc)).toThrow(ParseError);
        const c = Object.create(RssAtomCollector.prototype);
        await expect(c.parse(doc)).rejects.toThrow(/declares a DTD with entities/);
    });
});

test('a plain feed, and a DOCTYPE without entities, still parse', async () => {
    expect(() => rejectDtdEntities('<?xml version="1.0"?><!DOCTYPE rss><rss/>')).not.toThrow();
    const c = Object.create(RssAtomCollector.prototype);
    const feed = await c.parse('<rss version="2.0"><channel><title>w</title><item><title>AI</title></item></channel></rss>');
    expect(feed.items[0].title).toBe('AI');
});

// Load-robust: parse time must not follow the entity nesting depth. With
// expansion, 10 levels is 10^7 times the work of 3 levels; without, the two
// documents differ by a few hundred bytes.
test.each([
    ['rss-parser', d => new Parser().parseString(d)],
    ['xml2js', d => xml2js.parseStringPromise(d, { explicitArray: false })],
])('%s: parse time does not grow with entity depth (no expansion)', async (_, parse) => {
    const r = await scalingAsync(parse, laughs, [3, 10]);
    expect(r.large).toBeLessThan(HARD_MS);
    const { FAST_MS, MAX_RATIO } = require('../../helpers/scaling');
    expect(r.large < FAST_MS || r.ratio < MAX_RATIO).toBe(true);
});
