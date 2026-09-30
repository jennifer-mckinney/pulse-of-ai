// tests/unit/pure/dependencyPins.test.js — F10-12: the collector's parsing
// and mail dependencies are pinned exactly, CI audits production
// dependencies, and the mail libraries stay lazily loaded.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

test.each(['imapflow', 'mailparser', 'xml2js', 'htmlparser2', 'nodemailer'])('%s is pinned to an exact version that the lockfile installs', (name) => {
    const spec = pkg.dependencies[name];
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages[`node_modules/${name}`].version).toBe(spec);
});

test('CI fails on a high-severity advisory in a production dependency', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/run: npm audit --omit=dev --audit-level=high/);
});

test('imapflow and mailparser are loaded only inside the Scholar mailbox route', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/collectors/adapters/academic.js'), 'utf8');
    const top = src.slice(0, src.indexOf('class '));
    expect(top).not.toMatch(/require\('(imapflow|mailparser)'\)/);
    jest.isolateModules(() => {
        require('../../../src/collectors/index');
        expect(Object.keys(require.cache).some(k => /node_modules\/(imapflow|mailparser)\//.test(k))).toBe(false);
    });
});
