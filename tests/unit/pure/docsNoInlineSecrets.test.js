// tests/unit/pure/docsNoInlineSecrets.test.js
// PR #22 security M3: operator docs must never tell anyone to type a
// credential inline (`SOME_API_KEY=… npm run …`): the line lands in the
// shell history, outside every scrubbing control. The README's keyed-source
// run uses an interactive prompt or a private env file instead, and says why.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../..');

/** Every Markdown file an operator reads: the root docs and docs/ (evidence excluded). */
function operatorDocs() {
    const out = fs.readdirSync(ROOT).filter(f => f.endsWith('.md')).map(f => path.join(ROOT, f));
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'evidence') walk(p); } else if (e.name.endsWith('.md')) out.push(p);
        }
    };
    walk(path.join(ROOT, 'docs'));
    return out;
}

// A credential-named variable assigned a value directly in front of a command.
const INLINE_SECRET = /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CLIENT_ID)=\S+(?:\s+[A-Z0-9_]+=\S+)*\s+(?:npm|npx|node|docker|bash|sh|yarn)\b/;

test('the detector catches the pattern it guards against', () => {
    expect(INLINE_SECRET.test('GUARDIAN_API_KEY=... GUARDIAN_COMMERCIAL_LICENSE_REF=... npm run collect')).toBe(true);
    expect(INLINE_SECRET.test('REFRESH_TOKEN=abc docker compose up -d web')).toBe(true);
    expect(INLINE_SECRET.test('read -rs GUARDIAN_API_KEY; export GUARDIAN_API_KEY')).toBe(false);
});

test('no operator doc shows a credential typed inline before a command', () => {
    const hits = [];
    for (const f of operatorDocs()) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (INLINE_SECRET.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
});

test('the README keyed-source run uses a prompt or a private env file and warns about shell history', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('### Adding a keyed source'), readme.indexOf('### Embeddings'));
    expect(section).toMatch(/shell history/);
    expect(section).toMatch(/read -rs/);
    expect(section).toMatch(/node --env-file=/);
    expect(section).toMatch(/unset GUARDIAN_API_KEY/);
});
