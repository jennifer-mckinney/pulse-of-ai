// tests/unit/pure/composeProject.test.js
// Regression test for PR #8 grumpy #3: the compose project name is pinned to
// `pulse-of-ai`, so every worktree/checkout (and the verify gate's
// `docker compose exec`) resolves to the SAME containers and volumes instead
// of a project name derived from the checkout directory. Two pins must hold:
//   - docker-compose.yml carries a TOP-LEVEL `name: pulse-of-ai`, and
//   - .env.example sets COMPOSE_PROJECT_NAME=pulse-of-ai (the template for
//     .env, which bare `docker compose` calls outside the repo dir read).
// Reads the files as text — no Docker, no YAML dependency.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PROJECT = 'pulse-of-ai';

describe('compose project name is pinned (grumpy #3)', () => {
    test('docker-compose.yml has exactly one top-level `name: pulse-of-ai`', () => {
        const yml = read('docker-compose.yml');
        // Top-level YAML keys start at column 0; an indented `name:` (e.g. a
        // service or volume attribute) does not name the project.
        const topLevelNames = [...yml.matchAll(/^name:[ \t]*(.*?)[ \t]*(?:#.*)?$/gm)]
            .map((m) => m[1].replace(/^['"]|['"]$/g, ''));
        expect(topLevelNames).toEqual([PROJECT]);
    });

    test('.env.example sets COMPOSE_PROJECT_NAME=pulse-of-ai (uncommented, once)', () => {
        const env = read('.env.example');
        const values = [...env.matchAll(/^COMPOSE_PROJECT_NAME=(.*)$/gm)]
            .map((m) => m[1].trim());
        expect(values).toEqual([PROJECT]);
    });
});
