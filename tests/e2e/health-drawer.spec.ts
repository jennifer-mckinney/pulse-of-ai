// FR-24 / US-6/7 — Health drawer: opens from the header chip; the seeded
// yellow banner renders; ALERT HISTORY rows carry severity classes;
// the VERSIONED METHODOLOGY table has ≥ 4 rows; the registry-active
// sources stat is present. Live data only — no demo fallback labels.
import { test, expect } from '@playwright/test';
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

    // Registry-active sources stat, honestly labeled (G20).
    await expect(drawer.locator('.sec-lbl', { hasText: 'SOURCES · REGISTRY-ACTIVE' }))
        .toHaveCount(1);
    const sourcesRow = drawer.locator('.kv-row', { hasText: 'sources registry-active' });
    await expect(sourcesRow).toHaveCount(1);
    await expect(sourcesRow.locator('.kv-v')).toHaveText(
        /^\d+ \/ \d+ \(configured active, not liveness\)$/);

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

    expectNoConsoleErrors(errors);
});
