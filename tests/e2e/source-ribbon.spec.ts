// Source ribbon (marimekko) — visible only in explore mode; segment widths
// are flex-basis proportional to volume share; sparkline SVGs render from
// the 12h timeseries; the "← 12h" axis label lives ONLY in the first
// segment (inline — README regression guard); hovering a segment dims
// non-matching cities on the globe (asserted via the globe's dimTest
// state); clicking applies the category filter + category color mode.
import { test, expect } from '@playwright/test';
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData,
    scrollToProg, enterExplore, stabilizeSnapshot, evidence,
} from './helpers';

test('ribbon: explore-only, proportional segments, sparklines, 12h label, hover dim, click filter', async ({ page }) => {
    const errors = consoleErrors(page);
    await stabilizeSnapshot(page);   // non-decaying rich snapshot (see helper)
    await gotoAndWaitForData(page);

    // Story mode: ribbon hidden.
    await scrollToProg(page, 5);
    await expect(page.locator('#strip')).toBeHidden();

    // Explore: ribbon visible with one segment per category present.
    await enterExplore(page);
    const strip = page.locator('#strip');
    await expect(strip).toBeVisible();
    const segs = strip.locator('.strip-seg');
    const expectedRows: Array<{ category: string; slug: string; sharePct: number }> =
        await page.evaluate(() => {
            const w = window as any;
            const rows = w.PulseInsights.ribbonRows(w.PulseStory.getCities());
            const tot = rows.reduce((a: number, r: any) => a + r.share, 0) || 1;
            return rows.map((r: any) => ({
                category: r.category,
                slug: w.PulseGlobe.math.normalizeCategorySlug(r.category),
                sharePct: (r.share / tot) * 100,
            }));
        });
    expect(expectedRows.length).toBeGreaterThanOrEqual(2);
    await expect(segs).toHaveCount(expectedRows.length);

    // flex-basis proportional widths.
    for (let i = 0; i < expectedRows.length; i++) {
        const basis = await segs.nth(i).evaluate((el) =>
            (el as HTMLElement).style.flexBasis);
        expect(basis.endsWith('%')).toBe(true);
        expect(Math.abs(parseFloat(basis) - expectedRows[i].sharePct),
            `segment ${i} width`).toBeLessThan(0.01);
    }

    // Sparkline SVGs: the live 12h timeseries feeds them (categories the
    // timeseries omits fall back gracefully — require at least one).
    expect(await strip.locator('svg.seg-area').count()).toBeGreaterThanOrEqual(1);
    expect(await strip.locator('svg.seg-area polyline').count())
        .toBeGreaterThanOrEqual(1);

    // "← 12h" only in the first segment, inline.
    const axis = strip.locator('.seg-axis');
    await expect(axis).toHaveCount(1);
    await expect(segs.first().locator('.seg-axis')).toHaveText('← 12h');

    await evidence(page, '07-source-ribbon');

    // Hover a segment → the globe dimTest spotlights that category
    // (non-matching cities dim).
    const target = expectedRows[0];
    await segs.first().hover();
    const dim = await page.evaluate((slug) => {
        const g = (window as any).PulseGlobe.getInstance();
        const dimTest = g.getState().dimTest;
        if (typeof dimTest !== 'function') return null;
        return {
            match: dimTest({ top: slug }),
            other: dimTest({ top: '__no_such_category__' }),
        };
    }, target.slug);
    expect(dim, 'hover must install a dimTest on the globe').not.toBeNull();
    expect(dim!.match).toBe(true);
    expect(dim!.other).toBe(false);

    // Leaving the ribbon clears the spotlight (no filters set → null).
    await page.mouse.move(10, 10);
    await page.waitForFunction(() =>
        (window as any).PulseGlobe.getInstance().getState().dimTest === null);

    // Click applies the category filter + colorMode 'category'.
    await segs.first().click();
    expect(await page.evaluate(() =>
        (window as any).PulseGlobe.getInstance().getState().colorMode))
        .toBe('category');
    // The matching chip in the filter panel is now active.
    const onChips = page.locator('#exp-filters .chips .chip.on');
    await expect(onChips).toHaveCount(1);
    const chipText = (await onChips.innerText()).trim();
    const expectedLabel = await page.evaluate((slug) =>
        (window as any).PulseUI.pure.catLabel(slug), target.slug);
    expect(chipText).toBe(expectedLabel);
    // And the city list is filtered to that category.
    const listedMismatch = await page.evaluate((slug) => {
        const w = window as any;
        const by: Record<string, any> = {};
        for (const c of w.PulseStory.getCities()) by[c.city] = c;
        const names = Array.from(document.querySelectorAll(
            '#exp-filters .exp-list .city-row .city-name'))
            .map((el) => (el as HTMLElement).innerText);
        return names.filter((n) => w.PulseUI.pure.cityTopSlug(by[n]) !== slug);
    }, target.slug);
    expect(listedMismatch).toEqual([]);

    expectNoConsoleErrors(errors);
});
