// PRD P2 device — tablet-class pointer input: a touch-capable 1024×768
// context. A touch drag on the interactive globe rotates it, and a tap
// selects a city.
//
// Rotation proxy: the globe instance does not expose its internal view
// angles; its onDrag callback fires ONLY after dragRotate() has applied
// > 5 px of pointer travel to the view (globe.js CLICK_SUPPRESS_PX), so an
// instrumented onDrag firing IS the rotation assertion. The tap goes
// through a real CDP touch event at the marker position computed with the
// module's own projection math (reduced motion keeps the projection exact).
import { test, expect } from '@playwright/test';
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData,
    enterExplore, focusCity, projectCity, pickCity, stabilizeSnapshot, evidence,
} from './helpers';

test.use({
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    reducedMotion: 'reduce',
});

test('tablet: touch drag rotates the globe, tap selects a city', async ({ page }) => {
    const errors = consoleErrors(page);
    await stabilizeSnapshot(page);   // non-decaying rich snapshot (see helper)
    await gotoAndWaitForData(page);
    await enterExplore(page);

    // Touch is really available in this context.
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);

    // ── Touch drag rotates ──────────────────────────────────────────────────
    await page.evaluate(() => {
        const g = (window as any).PulseGlobe.getInstance();
        const prev = g.getState().onDrag;
        (window as any).__dragFired = false;
        g.setState({
            onDrag: () => {
                (window as any).__dragFired = true;
                if (typeof prev === 'function') prev();
            },
        });
    });

    const cdp = await page.context().newCDPSession(page);
    const cx = 512, cy = 384;
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: cx, y: cy }],
    });
    for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ x: cx + i * 20, y: cy + i * 5 }],
        });
        await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    expect(await page.evaluate(() => (window as any).__dragFired),
        'touch drag must rotate the globe (onDrag fires only after dragRotate applied > 5px)')
        .toBe(true);

    // ── Tap selects a city ──────────────────────────────────────────────────
    const city = await pickCity(page);
    await focusCity(page, city, 1.5);
    // Wait past the drag's user-override window so easing re-converges.
    await page.waitForTimeout(1500);
    const pos = await projectCity(page, city, 1.5);

    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: pos.x, y: pos.y }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect(page.locator('#exp-detail')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#exp-detail .det-city')).toContainText(city.city);
    expect(await page.evaluate(() =>
        (window as any).PulseGlobe.getInstance().getState().selectedId)).toBe(city.city);

    await evidence(page, '11-tablet-tap-select');
    expectNoConsoleErrors(errors);
});
