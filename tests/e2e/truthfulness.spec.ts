// Truthfulness + self-hosting guards:
//   - the aggregated snapshot request carries a `from=` trailing-hour
//     window (G16 — "posts/hr" labels must be honest),
//   - "posts / hour" / "/hr" labels actually render,
//   - the retired GET /api/config returns 404 (C5 — no token endpoint),
//   - ZERO external-origin network requests across the whole run (FR-25:
//     fonts and land geometry are self-hosted, no CDN, no tile services).
import { test, expect } from '@playwright/test';
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData,
    scrollToProg, enterExplore, evidence,
} from './helpers';

test('truthfulness: hour-windowed fetch, /hr labels, /api/config 404, same-origin only', async ({ page }) => {
    const errors = consoleErrors(page);
    const requests: string[] = [];
    page.on('request', (req) => requests.push(req.url()));

    const loadedAt = Date.now();
    await gotoAndWaitForData(page);

    // Aggregated request is windowed to the trailing hour.
    const aggregated = requests.filter((u) =>
        u.includes('/api/posts/aggregated-by-location'));
    expect(aggregated.length).toBeGreaterThanOrEqual(1);
    const windowed = aggregated.find((u) => u.includes('?from='));
    expect(windowed, 'aggregated fetch must carry a from= window').toBeTruthy();
    const from = new URL(windowed!).searchParams.get('from')!;
    const fromMs = Date.parse(from);
    expect(Number.isFinite(fromMs)).toBe(true);
    const windowMs = loadedAt - fromMs;
    expect(Math.abs(windowMs - 3600000),
        'from= must be ~1 trailing hour (±5 min tolerance)')
        .toBeLessThan(5 * 60 * 1000);

    // "posts / hour" stat label on the overview card.
    await scrollToProg(page, 0.2);
    const overview = page.locator('#card-col .chapter-card').first();
    await expect(overview).toBeVisible();
    await expect(overview.locator('.ch-stat-k').first()).toHaveText('posts / hour');

    // "/hr" volume labels in the explore city list.
    await enterExplore(page);
    await expect(page.locator('#exp-filters .city-row .city-vol').first())
        .toHaveText(/\/hr$/);

    // Drive the remaining fetch surfaces so the same-origin sweep covers
    // them (timeseries, query, audit, health drawer set).
    await page.locator('#exp-filters .city-row').first().click();
    await expect(page.locator('#exp-detail')).toBeVisible();
    await page.locator('#health-chip').click();
    await expect(page.locator('#health-drawer')).toHaveClass(/open/);
    await page.waitForTimeout(1000);

    // The retired Mapbox-era config endpoint is gone.
    const config = await page.request.get('/api/config');
    expect(config.status(), 'GET /api/config must 404 (C5: no token endpoint)')
        .toBe(404);

    // ZERO external-origin requests: every request the page made — fonts,
    // land geometry, API calls — stays on the dev origin.
    const external = requests.filter((u) => {
        if (u.startsWith('data:') || u.startsWith('blob:')) return false;
        try {
            return new URL(u).origin !== 'http://localhost:3000';
        } catch {
            return false;
        }
    });
    expect(external, 'no external-origin requests allowed (FR-25)').toEqual([]);

    // Self-hosted assets actually loaded: vendored land geometry + fonts.
    expect(requests.some((u) => u.includes('/vendor/world-atlas/')),
        'vendored land geometry must load').toBe(true);
    expect(requests.some((u) => u.includes('/vendor/fonts/')),
        'self-hosted fonts must load').toBe(true);

    await evidence(page, '12-truthfulness-explore');
    expectNoConsoleErrors(errors);
});
