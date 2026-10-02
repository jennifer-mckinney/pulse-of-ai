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
// P10-18: credentials are no longer hand-listed — the worker loads the env file.
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
        // Credentials: the value to the worker only (its env_file); web gets a
        // presence marker, never the value.
        expect(credentialBlock).toBe('');
        expect(compose).not.toMatch(new RegExp(`^\\s+${k}: \\$\\{${k}:-`, 'm'));
        expect(presenceBlock).toContain(`  ${k}: \${${k}:+set}`);
        expect(settingsBlock).not.toMatch(new RegExp(`^\\s+${k}:`, 'm'));
    }
    if (ENV_DOCS[k].signup) expect(example).toContain(ENV_DOCS[k].signup);
});

test('the anchors are merged into the right roles only (F9-2)', () => {
    const env = (svc) => (compose.match(new RegExp(`^  ${svc}:\\n(?:(?!^  [a-z_]+:\\n)[\\s\\S])*?^    environment:\\n      <<: \\[([^\\]]*)\\]`, 'm')) || [])[1];
    expect(env('web')).toBe('*app-env, *collector-settings, *collector-presence');
    expect(env('worker')).toBe('*app-env, *collector-settings');
    expect(env('populate')).toBe('*app-env, *collector-settings');
    // P10-18: the worker — and ONLY the worker — loads the env file.
    expect(compose.match(/env_file:/g)).toHaveLength(1);
    const worker = compose.slice(compose.indexOf('\n  worker:\n'), compose.indexOf('\n  embeddings:'));
    expect(worker).toMatch(/env_file:\n\s+- path: \$\{PULSE_ENV_FILE:-\.env\}\n\s+required: true/);   // PR #22 grumpy L12
    // web and the env-file-fed worker must use the same Redis logical db.
    expect(compose).toMatch(/^  REDIS_DB: \$\{REDIS_DB:-\}$/m);
});

test('credentials, keys and permission references ship EMPTY', () => {
    for (const k of registryEnvVars()) {
        if (/(KEY|TOKEN|SECRET|PASSWORD|_REF|CLIENT_ID|_USER|_HOST|_PATH|_DIR|FEED_URL)$/.test(k)) {
            expect([k, exampleValue(k)]).toEqual([k, '']);
        }
    }
});

// D1 ("Off for others, on for you"): a clone collects NOTHING until its
// operator sets their own contact URL, and the permission-gated feeds stay
// closed until the operator records their acceptance. No default anywhere.
test('the contact URL and the permission-gated acknowledgement ship EMPTY (D1)', () => {
    expect(exampleValue('COLLECTOR_CONTACT_URL')).toBe('');
    expect(exampleValue('PERMISSION_GATED_FEEDS_ACCEPTED_BY')).toBe('');
    expect(settingsBlock).toContain('  COLLECTOR_CONTACT_URL: ${COLLECTOR_CONTACT_URL:-}\n');
    expect(settingsBlock).toContain('  PERMISSION_GATED_FEEDS_ACCEPTED_BY: ${PERMISSION_GATED_FEEDS_ACCEPTED_BY:-}\n');
    // PR #22 decision G5: the named gate approval ships empty too.
    expect(exampleValue('GATE_APPROVED_BY')).toBe('');
    expect(settingsBlock).toContain('  GATE_APPROVED_BY: ${GATE_APPROVED_BY:-}\n');
    // No contact URL is baked in anywhere the containers or standup read.
    for (const f of ['.env.example', 'docker-compose.yml', 'scripts/standup.sh', 'scripts/lib/stack.sh', 'Dockerfile']) {
        expect([f, fs.readFileSync(path.join(ROOT, f), 'utf8')]).not.toEqual([f, expect.stringMatching(/github\.com\/jennifer-mckinney\/pulse-of-ai/)]);
    }
});

// Migration 073: the per-route kill switch is a setting like
// COLLECTORS_DISABLED — catalogued, documented, shipped EMPTY and passed
// through to every collecting role (applies on a container recreate).
test('COLLECTORS_DISABLED_ROUTES is catalogued, ships empty and reaches the containers', () => {
    expect(registryEnvVars()).toContain('COLLECTORS_DISABLED_ROUTES');
    expect(envClass('COLLECTORS_DISABLED_ROUTES')).toBe('setting');
    expect(exampleValue('COLLECTORS_DISABLED_ROUTES')).toBe('');
    expect(example).toMatch(/^# e\.g\. COLLECTORS_DISABLED_ROUTES=hugging_face\/forum-latest$/m);
    expect(settingsBlock).toContain('  COLLECTORS_DISABLED_ROUTES: ${COLLECTORS_DISABLED_ROUTES:-}\n');
});

test('the global switch has a working default', () => {
    expect(exampleValue('COLLECTORS_ENABLED')).toBe('true');
});

test('every per-source kill switch reaches the containers', () => {
    for (const s of SOURCES) expect(settingsBlock).toContain(`${killSwitchEnv(s.slug)}: \${${killSwitchEnv(s.slug)}:-}`);
    expect(example).toMatch(/SOURCE_BBC_NEWS_ENABLED=false/);
});

test('the stale Twitter / Semantic Scholar settings are gone (Reddit returns only through the approved Data API)', () => {
    expect(example).not.toMatch(/^(TWITTER_BEARER_TOKEN|SEMANTIC_SCHOLAR_API_KEY)=/m);
    // The old Reddit block shipped a fake User-Agent; the approval-gated one
    // (source #52) ships every Reddit credential EMPTY.
    for (const k of ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT', 'REDDIT_API_APPROVAL_REF']) {
        expect([k, exampleValue(k)]).toEqual([k, '']);
    }
    expect(exampleValue('REDDIT_MIN_AI_POSTS_7D')).toBe('20');
});
