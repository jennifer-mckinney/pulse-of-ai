// FR-24 / US-6/7 — Health drawer: opens from the header chip; the seeded
// yellow banner renders; ALERT HISTORY rows carry severity classes;
// the VERSIONED METHODOLOGY table has ≥ 4 rows; the registry-active
// sources stat is present. Live data only — no demo fallback labels.
import { test, expect } from '@playwright/test';
// Counts come from the registry itself (SOURCES.length), never a literal.
const { SOURCES } = require('../../src/config/source-registry');
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData, evidence,
} from './helpers';

test('health drawer: yellow banner, alert history, methodology table, sources stat', async ({ page }) => {
    const errors = consoleErrors(page);
    await gotoAndWaitForData(page);

    await page.locator('#health-chip').click();
    const drawer = page.locator('#health-drawer');
    await expect(drawer).toHaveClass(/open/);
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');

    // Live header — never the demo label on a reachable backend.
    await expect(drawer.locator('.drawer-kicker')).toHaveText(
        'MODEL HEALTH · LIVE', { timeout: 15000 });
    await expect(drawer.locator('.drawer-title')).toHaveText(
        'The watchdog watches itself.');

    // Seeded yellow banner (1 unresolved alert in the dev seed).
    const banner = drawer.locator('.health-banner');
    await expect(banner).toBeVisible();
    await expect(banner.locator('.hb-title')).toContainText('Yellow');
    await expect(banner.locator('.hb-title')).toContainText('active alert');
    await expect(banner.locator('.health-light')).toHaveClass(/yellow/);

    // Sources: the registry of record (52 since Rev. 4) with live status (ADR 0001).
    // "online" counts only sources that collected successfully in the last
    // hour (G20: never configured flags passed off as liveness).
    await expect(drawer.locator('.sec-lbl', { hasText: new RegExp(`^SOURCES · \\d+ / ${SOURCES.length} ONLINE$`) }))
        .toHaveCount(1);
    const sourcesRow = drawer.locator('.kv-row', { hasText: 'sources online' });
    await expect(sourcesRow).toHaveCount(1);
    await expect(sourcesRow.locator('.kv-v')).toHaveText(
        new RegExp(`^\\d+ / ${SOURCES.length} \\(collected successfully in the last hour\\)$`));
    // All of them listed under the 8 categories; the blocked 4 say so and cite terms.
    expect(SOURCES.length).toBe(52);
    await expect(drawer.locator('.src-list .src-row')).toHaveCount(SOURCES.length);
    await expect(drawer.locator('.src-list .src-cat')).toHaveCount(8);
    const blocked = drawer.locator('.src-row', { has: page.locator('.src-status.st-blocked') });
    await expect(blocked).toHaveCount(4);
    for (const name of ['WeChat / Weixin (Tencent)', 'Telegram', 'ResearchGate', 'Cato Institute']) {
        const row = blocked.filter({ hasText: name });
        await expect(row.locator('.src-status')).toHaveText('blocked: no compliant access');
        await expect(row.locator('a.src-terms')).toHaveAttribute('href', /^https:\/\//);
    }
    await expect(drawer.locator('.src-row', { hasText: 'Hacker News (Y Combinator)' })).toHaveCount(1);
    // Reddit (#52, ADR 0001 ruling 8): built, off until Reddit approves —
    // "awaiting approval" in Forums, citing the Reddit Data API Terms.
    const reddit = drawer.locator('.src-row', { hasText: /^Reddit/ });
    await expect(reddit).toHaveCount(1);
    await expect(reddit.locator('.src-status')).toHaveText('awaiting approval');
    await expect(reddit.locator('a.src-terms')).toHaveAttribute('href', 'https://redditinc.com/policies/data-api-terms');

    // ALERT HISTORY · LAST 12H rows with severity classes.
    await expect(drawer.locator('.sec-lbl', { hasText: 'ALERT HISTORY · LAST 12H' }))
        .toHaveCount(1);
    const alertRows = drawer.locator('.alert-feed .alert-row');
    expect(await alertRows.count()).toBeGreaterThanOrEqual(1);
    const n = await alertRows.count();
    for (let i = 0; i < n; i++) {
        const cls = await alertRows.nth(i).getAttribute('class');
        expect(cls, `alert row ${i} severity class`)
            .toMatch(/sev-(alert|watch|pass)/);
        await expect(alertRows.nth(i).locator('.alert-sev'))
            .toHaveText(/^(ALERT|WATCH|PASS)$/);
        await expect(alertRows.nth(i).locator('.alert-time'))
            .toHaveText(/^\d\d:\d\d UTC$/);
    }
    // Live history — the demo-fallback note must NOT render.
    await expect(drawer.locator('.alert-feed')).not.toContainText(
        'fictional demo alerts');

    // VERSIONED METHODOLOGY table with ≥ 4 model@version rows.
    await expect(drawer.locator('.sec-lbl', { hasText: 'VERSIONED METHODOLOGY' }))
        .toHaveCount(1);
    const methodologyKeys = await drawer
        .locator('.sec-lbl:has-text("VERSIONED METHODOLOGY") + .kv .kv-k')
        .allInnerTexts();
    expect(methodologyKeys.length).toBeGreaterThanOrEqual(4);
    for (const key of methodologyKeys) {
        expect(key, 'methodology key must be model@version').toMatch(/.+@.+/);
    }

    await evidence(page, '08-health-drawer');

    // Close via ×; chip aria state follows.
    await drawer.locator('.drawer-x').click();
    await expect(drawer).not.toHaveClass(/open/);
    await expect(page.locator('#health-chip')).toHaveAttribute('aria-expanded', 'false');
    // Keyboard focus returns to the chip that opened the drawer instead of
    // staying on the × inside the now-hidden drawer.
    await expect(page.locator('#health-chip')).toBeFocused();

    expectNoConsoleErrors(errors);
});

// FR-24 red state (PR #8 review): a critical unresolved alert must turn the
// header chip AND the drawer banner red — both the load-time poll (main.js)
// and the drawer's chip refresh (ui.js). /api/health is stubbed with a
// critical alert; everything else stays live.
test('health chip + banner go red for a critical alert', async ({ page }) => {
    const errors = consoleErrors(page);
    await page.route('**/api/health', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'healthy',
                db_connected: true,
                last_job: null,
                active_alerts: [
                    { id: 'a1', alert_type: 'bias_violation', severity: 'critical', created_at: new Date().toISOString() },
                    { id: 'a2', alert_type: 'bias_violation', severity: 'warning', created_at: new Date().toISOString() },
                ],
            }),
        });
    });
    await gotoAndWaitForData(page);

    const chip = page.locator('#health-chip');
    await expect(chip).toHaveClass(/h-red/);
    await expect(chip).not.toHaveClass(/h-yellow/);
    await expect(page.locator('#health-label')).toHaveText('2 active alerts · 1 critical');

    await chip.click();
    const drawer = page.locator('#health-drawer');
    await expect(drawer).toHaveClass(/open/);
    const banner = drawer.locator('.health-banner');
    await expect(banner.locator('.hb-title')).toHaveText('Red — 2 active alerts, 1 critical');
    await expect(banner.locator('.health-light')).toHaveClass(/\bred\b/);
    // The drawer's refetch keeps the chip red (ui.js path).
    await expect(chip).toHaveClass(/h-red/);

    expectNoConsoleErrors(errors);
});

// Whole-window history (PR #8 review): flagged rows listed individually with
// the methodology version that produced them, pass rows collapsed into one
// summary per layer, and an explicit notice when the flagged-row safety cap
// truncated the list. /api/bias/history is stubbed so the cap case is
// deterministic; everything else stays live.
test('health drawer: pass summaries, lineage tags and the truncation notice', async ({ page }) => {
    const errors = consoleErrors(page);
    const now = Date.now();
    const iso = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();
    await page.route('**/api/bias/history*', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                window_hours: 12, window_start: iso(720), generated_at: iso(0),
                total_count: 1181, alert_count: 501, pass_count: 680,
                truncated: true, alert_cap: 500,
                alerts: [{
                    id: 'x1', time: iso(4), severity: 'alert', layer: 'Location concentration',
                    assessment_type: 'location_concentration', group_value: 'London',
                    metric_name: 'share_of_total_posts', value: 0.5, threshold: 0.35,
                    detail: 'Location concentration: share_of_total_posts 0.500 (τ = 0.35) for London. Threshold exceeded.',
                    citation: 'Suresh & Guttag (2021)', model_name: 'pulse-bias-monitor-v1',
                    version: '1.1.0', lineage: 'inferred',
                }],
                pass_summary: [{
                    severity: 'pass', layer: 'Negative dominance', assessment_type: 'negative_dominance',
                    count: 680, first_time: iso(719), last_time: iso(2),
                    metric_name: 'negative_share', latest_value: 0.21, threshold: 0.6,
                    detail: '680 passing checks in the window · latest negative_share 0.210 (τ = 0.6).',
                    citation: 'Suresh & Guttag (2021)', model_name: 'pulse-bias-monitor-v1',
                    version: '1.1.0', lineage: 'recorded',
                }],
            }),
        });
    });
    await gotoAndWaitForData(page);
    await page.locator('#health-chip').click();
    const drawer = page.locator('#health-drawer');
    await expect(drawer).toHaveClass(/open/);

    const feed = drawer.locator('.alert-feed');
    await expect(feed.locator('.history-notice')).toHaveText(
        'showing the newest 1 of 501 flagged assessments — the list is truncated at the '
        + '500-row safety cap (full history via GET /api/bias/history)');

    const rows = feed.locator('.alert-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveClass(/sev-alert/);
    await expect(rows.nth(0).locator('.alert-cite')).toHaveText(
        'Suresh & Guttag (2021) · pulse-bias-monitor-v1@1.1.0 · inferred');

    const summary = feed.locator('.alert-row.alert-summary');
    await expect(summary).toHaveCount(1);
    await expect(summary).toHaveClass(/sev-pass/);
    await expect(summary.locator('.alert-time')).toHaveText(/^\d\d:\d\d UTC$/);
    await expect(summary.locator('.alert-detail')).toContainText('680 passing checks in the window');
    await expect(summary.locator('.alert-detail')).toContainText(/First pass \d\d:\d\d UTC\./);
    await expect(summary.locator('.alert-cite')).toHaveText(
        'Suresh & Guttag (2021) · pulse-bias-monitor-v1@1.1.0');

    expectNoConsoleErrors(errors);
});
