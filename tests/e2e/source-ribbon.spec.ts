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

    // Explore: ribbon visible with one segment per CANONICAL category,
    // always (allCategoryRows pads quiet categories with zero rows — the
    // prototype marimekko's "all categories, always" contract). Live DB:
    // forums renders as an honest zero segment (no seeded forum sources).
    await enterExplore(page);
    const strip = page.locator('#strip');
    await expect(strip).toBeVisible();
    const segs = strip.locator('.strip-seg');
    const expectedRows: Array<{ category: string; slug: string; flexPct: number; volume: number }> =
        await page.evaluate(() => {
            const w = window as any;
            const rows = w.PulseInsights.allCategoryRows(w.PulseStory.getCities());
            const flex = w.PulseUI.pure.ribbonFlexPercents(rows);
            return rows.map((r: any, i: number) => ({
                category: r.category,
                slug: w.PulseGlobe.math.normalizeCategorySlug(r.category),
                flexPct: flex[i],
                volume: r.volume,
            }));
        });
    expect(expectedRows.length, 'full canonical taxonomy').toBe(8);
    await expect(segs).toHaveCount(8);
    // Forums enumerated with an honest zero on the live seed.
    const forumsRow = expectedRows.find((r) => r.slug === 'forums');
    expect(forumsRow, 'forums segment present').toBeTruthy();
    expect(forumsRow!.volume).toBe(0);

    // flex-basis widths follow ribbonFlexPercents (share-proportional with
    // a minimum readable sliver for zero segments, renormalized to 100).
    for (let i = 0; i < expectedRows.length; i++) {
        const basis = await segs.nth(i).evaluate((el) =>
            (el as HTMLElement).style.flexBasis);
        expect(basis.endsWith('%')).toBe(true);
        expect(Math.abs(parseFloat(basis) - expectedRows[i].flexPct),
            `segment ${i} width`).toBeLessThan(0.01);
    }
    // The displayed percentage stays the REAL share: a zero segment reads 0%.
    const forumsIdx = expectedRows.findIndex((r) => r.slug === 'forums');
    await expect(segs.nth(forumsIdx).locator('.seg-vol')).toHaveText('0/hr · 0%');
    await expect(segs.nth(forumsIdx).locator('.seg-cat')).toHaveText('Forums');

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

test('ribbon: live timeseries FAILURE → no sparklines, no fabricated words, honest notice', async ({ page }) => {
    // Grumpy #1: a live /api/sources/timeseries failure must not flip the
    // ribbon into demo synthesis. The aborted request is the only allowed
    // console noise.
    const errors = consoleErrors(page, [/Failed to load resource/, /sources\/timeseries/]);
    await stabilizeSnapshot(page);
    await page.route('**/api/sources/timeseries*', (route) => route.abort());
    await gotoAndWaitForData(page);
    await enterExplore(page);

    const strip = page.locator('#strip');
    await expect(strip).toBeVisible();
    await expect(strip.locator('.strip-seg')).toHaveCount(8);

    // The outage notice renders (same voice as the other fallback labels)…
    await expect(strip.locator('.strip-note'))
        .toHaveText('live timeseries unavailable — sparklines omitted');
    // …no sparkline SVGs are drawn for live segments (zero-volume segments
    // draw a flat zero baseline, which is honest — count only segments with
    // volume > 0 by asserting no NON-flat polyline: simplest honest check is
    // that no segment carries fabricated cue words and the live segments
    // have no synthesized series).
    const fabricated = await page.evaluate(() => {
        const w = (window as any);
        const rows = w.PulseUI.pure.ribbonModel(
            w.PulseStory.getCities(), null, { demo: false });
        return rows.filter((r: any) => r.volume > 0 && r.series !== null).length;
    });
    expect(fabricated, 'no live segment may synthesize a series').toBe(0);
    // DOM cross-check: the only sparklines on the strip are the flat zero
    // baselines of zero-volume segments — every volume>0 segment is bare.
    const svgVsZero = await page.evaluate(() => {
        const segs = Array.from(document.querySelectorAll('#strip .strip-seg'));
        const zeroSegs = segs.filter((s) =>
            (s.querySelector('.seg-vol') as HTMLElement).innerText.startsWith('0/hr'));
        const withSvg = segs.filter((s) => s.querySelector('svg.seg-area'));
        return {
            zero: zeroSegs.length,
            svg: withSvg.length,
            liveWithSvg: withSvg.filter((s) => !zeroSegs.includes(s)).length,
        };
    });
    expect(svgVsZero.liveWithSvg, 'volume>0 segments must have no sparkline').toBe(0);
    expect(svgVsZero.svg).toBe(svgVsZero.zero);
    // No quoted cue words anywhere (the old bug rendered “AI” “models”).
    const quoted = await strip.locator('.seg-words').allInnerTexts();
    expect(quoted.join(' ')).not.toContain('“AI”');
    expect(quoted.join(' ')).not.toContain('“models”');

    expectNoConsoleErrors(errors);
});
