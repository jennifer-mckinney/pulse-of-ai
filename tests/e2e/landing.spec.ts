// FR-17 — Landing: page loads, the canvas globe is mounted AND painted
// (first frame marked within the 1000 ms budget — P1-6),
// the intro lede renders, header chips render, and the health chip
// reflects the live /api/health state (seeded: 1 unresolved alert →
// yellow). Zero console errors.
import { test, expect } from '@playwright/test';
// Counts come from the registry itself (SOURCES.length), never a literal.
const { SOURCES } = require('../../src/config/source-registry');
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData, evidence,
} from './helpers';

test('landing: canvas painted, intro lede, header chips, seeded health state', async ({ page }) => {
    const errors = consoleErrors(page);
    await gotoAndWaitForData(page);

    // Security headers (F1): the strict CSP must be present on the document
    // response — and since the whole suite asserts a clean console, any CSP
    // violation the policy would cause shows up as a console error here.
    const headers = await page.request.get('/').then((r) => r.headers());
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain("script-src 'self'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');

    // Canvas present inside the globe mount.
    const canvas = page.locator('#globe-wrap canvas');
    await expect(canvas).toHaveCount(1);

    // P1-6 perf budget: globe.js marks its first painted frame. The mark's
    // startTime is ms since navigation start; it must land under 1000 ms.
    const firstFrameMs = await page.waitForFunction(() => {
        const m = performance.getEntriesByName('pulse:first-frame', 'mark');
        return m.length > 0 ? m[0].startTime : null;
    }).then((h) => h.jsonValue() as Promise<number>);
    console.log(`[perf] pulse:first-frame at ${firstFrameMs.toFixed(1)} ms after navigation start`);
    expect(firstFrameMs, 'first globe frame within the 1000 ms budget').toBeLessThan(1000);

    // Painted: sample a center region of the backing store and require a
    // meaningful number of non-transparent pixels (the sphere body fills
    // the center; a blank canvas has alpha 0 everywhere after clearRect).
    const paintedPixels = await page.evaluate(() => {
        const c = document.querySelector('#globe-wrap canvas') as HTMLCanvasElement;
        const ctx = c.getContext('2d')!;
        const w = c.width, h = c.height;
        const size = Math.min(200, w, h);
        const data = ctx.getImageData(
            Math.floor((w - size) / 2), Math.floor((h - size) / 2), size, size).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 0) painted++;
        }
        return painted;
    });
    expect(paintedPixels).toBeGreaterThan(1000);

    // Intro lede visible with the editorial copy.
    await expect(page.locator('#intro')).toBeVisible();
    await expect(page.locator('.intro-title')).toHaveText('The Pulse of AI');
    await expect(page.locator('.intro-kicker')).toContainText('LIVE');
    // Byline counts come from the source registry (GET /api/sources), not a
    // hardcoded "7 source categories" / "50 sources" claim (ADR 0001).
    await expect(page.locator('#intro-byline'))
        .toHaveText(`INTERACTIVE · ${SOURCES.length} SOURCES · 8 CATEGORIES · EVERY SCORE AUDITABLE`);
    await expect(page.locator('#intro-skip')).toBeVisible();

    // Header chips: time-to-insight timer + health chip.
    await expect(page.locator('#insight-chip')).toBeVisible();
    await expect(page.locator('#insight-label')).toHaveText('time to insight');
    await expect(page.locator('#health-chip')).toBeVisible();

    // Health chip reflects the LIVE endpoint state. The dev seed leaves one
    // unresolved alert, so the chip must go yellow with an alert count —
    // asserted against the API itself so the spec never hardcodes seed
    // details that drift.
    const health = await page.request.get('/api/health').then((r) => r.json());
    const alertCount = Array.isArray(health.active_alerts)
        ? health.active_alerts.length : 0;
    expect(alertCount, 'dev seed must leave ≥1 unresolved alert (yellow state)')
        .toBeGreaterThan(0);
    await expect(page.locator('#health-chip')).toHaveClass(/h-yellow/);
    await expect(page.locator('#health-label')).toHaveText(
        alertCount === 1 ? '1 active alert' : `${alertCount} active alerts`);

    await evidence(page, '01-landing');
    expectNoConsoleErrors(errors);
});
