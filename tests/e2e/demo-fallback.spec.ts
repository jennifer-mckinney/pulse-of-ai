// FR-22 — Demo fallback: with every /api/** request blocked, the page must
// still render the full 30-city experience from the bundled demo data,
// visibly labeled as demo — demo receipts open locally (never fetched),
// and the app logs ZERO console errors of its own (the deliberate network
// failures are handled).
import { test, expect } from '@playwright/test';
import {
    consoleErrors, expectNoConsoleErrors, evidence, enterExplore,
    scrollToBeat,
} from './helpers';

test('demo fallback: /api/** blocked → 30-city demo, DEMO badges, local receipts, no errors', async ({ page }) => {
    // The app's own fetch failures are caught; the only console noise is the
    // browser's resource-load reporting for the deliberately aborted
    // requests, which is allow-listed here (and ONLY here).
    const errors = consoleErrors(page, [
        /Failed to load resource/,
        /net::ERR_FAILED/,
    ]);
    await page.route('**/api/**', (route) => route.abort());

    await page.goto('/');
    await page.waitForFunction(() => {
        const w = window as any;
        return w.PulseStory && w.PulseStory.getCities().length > 0;
    }, undefined, { timeout: 20000 });

    // Demo mode with the full 30-city registry set.
    const state = await page.evaluate(() => {
        const w = window as any;
        return {
            isDemo: w.PulseStory.getState().isDemo,
            cityCount: w.PulseStory.getCities().length,
        };
    });
    expect(state.isDemo).toBe(true);
    expect(state.cityCount).toBe(30);

    // Health chip surfaces the outage — never a fake nominal.
    await expect(page.locator('#health-chip')).toHaveClass(/h-yellow/);
    await expect(page.locator('#health-label')).toHaveText('model health: unavailable');

    // Chapter cards carry the visible demo marker (resolver-level badge).
    await scrollToBeat(page, 1);
    const card = page.locator('#card-col .chapter-card').nth(1);
    await expect(card).toBeVisible();
    await expect(card.locator('.ch-title')).toContainText('— Demo data');

    // Explore renders the same 30-city experience.
    await enterExplore(page);
    await expect(page.locator('#exp-filters .exp-list .city-row')).toHaveCount(30);
    await expect(page.locator('#strip')).toBeVisible();
    // Demo sparklines are synthesized deterministically — every segment has one.
    const segCount = await page.locator('#strip .strip-seg').count();
    expect(await page.locator('#strip svg.seg-area').count()).toBe(segCount);

    // City detail: demo posts, honestly labeled.
    await page.locator('#exp-filters .exp-list .city-row').first().click();
    const detail = page.locator('#exp-detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.det-posts .post')).toHaveCount(3);
    await expect(detail.locator('.det-foot')).toContainText('all posts fictional demo data');

    // Demo receipt opens LOCALLY (no /api/audit fetch is possible — routes
    // are blocked; a fetch would surface as a drawer error, not a receipt).
    await detail.locator('.btn-why').first().click();
    const drawer = page.locator('#audit-drawer');
    await expect(drawer).toHaveClass(/open/);
    await expect(drawer.locator('.drawer-kicker')).toContainText('DEMO DATA');
    expect(await drawer.locator('.steps .step').count()).toBeGreaterThanOrEqual(4);
    await expect(drawer.locator('.drawer-foot')).toContainText('fictional demo data');
    await evidence(page, '09-demo-fallback-receipt');
    await drawer.locator('.drawer-x').click();

    // Health drawer in demo mode: outage banner + labeled demo content.
    await page.locator('#health-chip').click();
    const health = page.locator('#health-drawer');
    await expect(health.locator('.drawer-kicker')).toHaveText(
        'MODEL HEALTH · DEMO DATA', { timeout: 15000 });
    await expect(health.locator('.hb-title')).toContainText('unavailable');
    await expect(health.locator('.alert-feed')).toContainText('fictional demo alerts');

    expectNoConsoleErrors(errors);
});
