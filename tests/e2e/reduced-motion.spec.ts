// Reduced motion (G5/G10) — under prefers-reduced-motion: reduce the globe
// must not auto-spin or pulse (the canvas renders a static frame), the CSS
// cue bob / blink animations are disabled, and the drawers still open and
// close. A control test proves the same canvas DOES animate without the
// emulation, so the static-frame assertion cannot pass vacuously.
import { test, expect } from '@playwright/test';
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData, evidence,
} from './helpers';

test.describe('with prefers-reduced-motion: reduce', () => {
    test.use({ reducedMotion: 'reduce' });

    test('no auto-spin/pulse, CSS animations off, drawers still work', async ({ page }) => {
        const errors = consoleErrors(page);
        await gotoAndWaitForData(page);

        // The page sees the emulated media feature.
        expect(await page.evaluate(() =>
            window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

        // No auto-spin, no pulse rings: at the resting view (beat 0, no
        // focus) the canvas must render a STATIC frame — two backing-store
        // captures (toDataURL, so overlaying DOM like the ticking header
        // timer cannot leak into the comparison) 1.5 s apart are identical.
        // (With motion, spin + pulse rings change the frame continuously —
        // see the control test below.) Let initial easing settle first.
        await page.waitForTimeout(1500);
        const grab = () => page.evaluate(() =>
            (document.querySelector('#globe-wrap canvas') as HTMLCanvasElement)
                .toDataURL());
        const shotA = await grab();
        await page.waitForTimeout(1500);
        const shotB = await grab();
        expect(shotA === shotB,
            'canvas must be static under reduced motion (no spin, no pulse)').toBe(true);

        // Decorative CSS animations are disabled (cue bob, header dot blink,
        // yellow health-light pulse).
        for (const selector of ['.intro-cue', '.hdr-dot', '.h-yellow .health-light']) {
            const anim = await page.locator(selector).first().evaluate((el) =>
                getComputedStyle(el).animationName);
            expect(anim, `${selector} animation under reduced motion`).toBe('none');
        }

        // Drawers still open and close.
        await page.locator('#health-chip').click();
        const drawer = page.locator('#health-drawer');
        await expect(drawer).toHaveClass(/open/);
        await expect(drawer.locator('.drawer-kicker')).toContainText('MODEL HEALTH');
        await evidence(page, '10-reduced-motion-drawer');
        await drawer.locator('.drawer-x').click();
        await expect(drawer).not.toHaveClass(/open/);
        await expect(drawer).toHaveAttribute('aria-hidden', 'true');

        expectNoConsoleErrors(errors);
    });
});

test.describe('control: default motion', () => {
    test('the canvas animates when motion is not reduced', async ({ page }) => {
        const errors = consoleErrors(page);
        await gotoAndWaitForData(page);
        await page.waitForTimeout(1500);
        const grab = () => page.evaluate(() =>
            (document.querySelector('#globe-wrap canvas') as HTMLCanvasElement)
                .toDataURL());
        const shotA = await grab();
        await page.waitForTimeout(1500);
        const shotB = await grab();
        expect(shotA === shotB,
            'canvas must animate (spin/pulse) without reduced motion').toBe(false);
        expectNoConsoleErrors(errors);
    });
});
