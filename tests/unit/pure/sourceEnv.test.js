// tests/unit/pure/sourceEnv.test.js
// Every env var the collectors read is documented in .env.example (with
// where to get it) and passed through to the containers by
// docker-compose.yml; every per-source kill switch is passed through too.
// .env.example carries NO secret values.

'use strict';

const fs = require('fs');
const path = require('path');
const { registryEnvVars, ENV_DOCS, SOURCES, killSwitchEnv, envClass } = require('../../../src/config/source-registry');

const ROOT = path.join(__dirname, '../../..');
const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
const exampleValue = (k) => {
    const m = example.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1] : undefined;
};

/** The body of one compose anchor block (`x-name: &name` up to the next blank line). */
function anchorBlock(name) {
    const m = compose.match(new RegExp(`^x-${name}: &${name}\\n((?:  .*\\n)+)`, 'm'));
    return m ? m[1] : '';
}
const settingsBlock = anchorBlock('collector-settings');
const credentialBlock = anchorBlock('collector-env');
const presenceBlock = anchorBlock('collector-presence');
const passes = (block, k) => new RegExp(`^\\s+${k}: \\$\\{${k}:-[^}]*\\}$`, 'm').test(block);

test.each(registryEnvVars())('%s is in .env.example and docker-compose.yml under its env class (F9-2)', (k) => {
    expect(exampleValue(k)).toBeDefined();
    if (envClass(k) === 'setting') {
        // Settings reach every collecting role.
        expect(passes(settingsBlock, k)).toBe(true);
        expect(credentialBlock).not.toMatch(new RegExp(`^\\s+${k}:`, 'm'));
    } else {
        // Credentials: the value to the worker only; web gets a presence marker.
        expect(passes(credentialBlock, k)).toBe(true);
        expect(presenceBlock).toContain(`  ${k}: \${${k}:+set}`);
        expect(settingsBlock).not.toMatch(new RegExp(`^\\s+${k}:`, 'm'));
    }
    if (ENV_DOCS[k].signup) expect(example).toContain(ENV_DOCS[k].signup);
});

test('the anchors are merged into the right roles only (F9-2)', () => {
    const env = (svc) => (compose.match(new RegExp(`^  ${svc}:\\n(?:(?!^  [a-z_]+:\\n)[\\s\\S])*?^    environment:\\n      <<: \\[([^\\]]*)\\]`, 'm')) || [])[1];
    expect(env('web')).toBe('*app-env, *collector-settings, *collector-presence');
    expect(env('worker')).toBe('*app-env, *collector-settings, *collector-env');
    expect(env('populate')).toBe('*app-env, *collector-settings');
    // *collector-env is referenced exactly once (the worker).
    expect(compose.match(/\*collector-env\b/g)).toHaveLength(1);
});

test('credentials, keys and permission references ship EMPTY', () => {
    for (const k of registryEnvVars()) {
        if (/(KEY|TOKEN|SECRET|PASSWORD|_REF|CLIENT_ID|_USER|_HOST|_PATH|_DIR|FEED_URL)$/.test(k)) {
            expect([k, exampleValue(k)]).toEqual([k, '']);
        }
    }
});

test('the contact URL and global switch have working defaults', () => {
    expect(exampleValue('COLLECTOR_CONTACT_URL')).toMatch(/^https:\/\//);
    expect(exampleValue('COLLECTORS_ENABLED')).toBe('true');
});

test('every per-source kill switch reaches the containers', () => {
    for (const s of SOURCES) expect(settingsBlock).toContain(`${killSwitchEnv(s.slug)}: \${${killSwitchEnv(s.slug)}:-}`);
    expect(example).toMatch(/SOURCE_BBC_NEWS_ENABLED=false/);
});

test('the stale Twitter / Reddit / Semantic Scholar settings are gone', () => {
    expect(example).not.toMatch(/^(TWITTER_BEARER_TOKEN|REDDIT_USER_AGENT|SEMANTIC_SCHOLAR_API_KEY)=/m);
});
