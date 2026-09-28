// Tooltip — hovering a city marker on the interactive globe shows the
// fixed tooltip with name / sentiment / volume + category share bars,
// clamped inside the viewport.
//
// Determinism: the marker position is computed with the globe module's OWN
// exported math (PulseGlobe.math.project) after pinning the camera on the
// target city. Reduced motion is emulated so the ±7° focus-drift term is
// zero and the projection is exact.
import { test, expect } from '@playwright/test';
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData,
    enterExplore, focusCity, projectCity, pickCity, stabilizeSnapshot, evidence,
} from './helpers';

test.use({ reducedMotion: 'reduce' });

test('tooltip: hover a city marker → name/sentiment/volume + category bars, in-viewport', async ({ page }) => {
    const errors = consoleErrors(page);
    await stabilizeSnapshot(page);   // non-decaying rich snapshot (see helper)
    await gotoAndWaitForData(page);
    await enterExplore(page);

    const city = await pickCity(page);
    await focusCity(page, city, 1.5);
    const pos = await projectCity(page, city, 1.5);

    // Hover the marker (pointer events drive the globe's hit test).
    await page.mouse.move(pos.x, pos.y);
    // The hover handler fires on pointermove; nudge once to be safe.
    await page.mouse.move(pos.x + 1, pos.y);

    const tip = page.locator('#tip');
    await expect(tip).toBeVisible();
    await expect(tip.locator('.tip-city')).toHaveText(city.city);
    await expect(tip.locator('.tip-sent')).toHaveText(/^[+−-]\d\.\d\d$/);
    await expect(tip.locator('.tip-sub')).toHaveText(`${city.total} posts/hr`);

    // Category share bars (top-4) with percent values.
    const bars = tip.locator('.tip-bar-row');
    expect(await bars.count()).toBeGreaterThanOrEqual(1);
    await expect(bars.first().locator('.tip-bar-v')).toHaveText(/^\d+%$/);

    // Clamped inside the viewport.
    const box = await tip.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);

    await evidence(page, '06-tooltip');

    // Moving off the globe hides the tooltip.
    await page.mouse.move(5, 5);
    await expect(tip).toBeHidden();

    expectNoConsoleErrors(errors);
});
