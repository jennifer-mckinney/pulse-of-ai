// FR-20/21 — Explore mode: scrolling past the threshold shows the filter
// panel; sentiment segmented filters PARTITION the city list (no city in
// two buckets); category chips filter by dominant category; COLOR BY
// toggles the globe color mode; the city list is always sorted
// most-positive → most-negative; clicking a city opens the detail panel
// (posts, sentiment pill + NEUTRAL relevance pill) and selects it on the
// globe; × closes.
import { test, expect, Page } from '@playwright/test';
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData,
    scrollToProg, enterExplore, stabilizeSnapshot, evidence,
} from './helpers';

// The sentiment segmented control is the SECOND .seg in the filter panel
// (the first is COLOR BY).
function sentimentSeg(page: Page) {
    return page.locator('#exp-filters > .seg').last();
}

async function cityNames(page: Page): Promise<string[]> {
    return page.locator('#exp-filters .exp-list .city-row .city-name').allInnerTexts();
}

test('explore: threshold, partitioned filters, sort, detail panel, close', async ({ page }) => {
    const errors = consoleErrors(page);
    await stabilizeSnapshot(page);   // non-decaying rich snapshot (see helper)
    await gotoAndWaitForData(page);

    // Below the threshold the explore chrome stays hidden.
    await scrollToProg(page, 5);
    await expect(page.locator('#explore')).toBeHidden();

    // Past the threshold: filter panel appears.
    await enterExplore(page);
    await expect(page.locator('#exp-filters .exp-title')).toContainText('EXPLORE');
    await evidence(page, '05-explore-panel');

    // ── Sorted city list (All): most-positive → most-negative, matching the
    // module's own comparator over the live snapshot.
    const allNames = await cityNames(page);
    expect(allNames.length).toBeGreaterThanOrEqual(10);
    const expectedOrder: string[] = await page.evaluate(() => {
        const w = window as any;
        return w.PulseUI.pure.filterAndSortCities(
            w.PulseStory.getCities(), { sent: 'All', cat: 'All' })
            .map((c: any) => c.city);
    });
    expect(allNames).toEqual(expectedOrder);
    const nets: number[] = await page.evaluate((names: string[]) => {
        const w = window as any;
        const by: Record<string, any> = {};
        for (const c of w.PulseStory.getCities()) by[c.city] = c;
        return names.map((n) => w.PulseUtils.netSentiment(by[n]));
    }, allNames);
    for (let i = 1; i < nets.length; i++) {
        expect(nets[i - 1] + 1e-9, `sort at row ${i}`).toBeGreaterThanOrEqual(nets[i]);
    }

    // ── Sentiment filters partition the list: disjoint buckets whose union
    // is exactly the All list.
    const seg = sentimentSeg(page);
    await expect(seg.locator('.seg-btn')).toHaveText(['All', 'Positive', 'Neutral', 'Negative']);
    const buckets: Record<string, string[]> = {};
    for (const f of ['Positive', 'Neutral', 'Negative']) {
        await seg.locator('.seg-btn', { hasText: f }).click();
        buckets[f] = await cityNames(page);
    }
    const union = [...buckets.Positive, ...buckets.Neutral, ...buckets.Negative];
    expect(union.length, 'no city may appear in two sentiment buckets')
        .toBe(new Set(union).size);
    expect(union.sort()).toEqual([...allNames].sort());

    // Back to All.
    await seg.locator('.seg-btn', { hasText: 'All' }).click();

    // ── Category chips: pick the first real category chip; every listed
    // city's dominant category must match.
    const chip = page.locator('#exp-filters .chips .chip').nth(1);
    const chipLabel = (await chip.innerText()).trim();
    await chip.click();
    await expect(page.locator('#exp-filters .chips .chip').nth(1)).toHaveClass(/on/);
    const catNames = await cityNames(page);
    const mismatches: string[] = await page.evaluate(({ names, label }) => {
        const w = window as any;
        const by: Record<string, any> = {};
        for (const c of w.PulseStory.getCities()) by[c.city] = c;
        return names.filter((n: string) =>
            w.PulseUI.pure.catLabel(w.PulseUI.pure.cityTopSlug(by[n])) !== label);
    }, { names: catNames, label: chipLabel });
    expect(mismatches).toEqual([]);
    await page.locator('#exp-filters .chips .chip').first().click();   // All

    // ── COLOR BY toggles the globe color mode.
    const colorSeg = page.locator('#exp-filters .mode-row .seg');
    await colorSeg.locator('.seg-btn', { hasText: 'Source' }).click();
    expect(await page.evaluate(() =>
        (window as any).PulseGlobe.getInstance().getState().colorMode)).toBe('category');
    await colorSeg.locator('.seg-btn', { hasText: 'Sentiment' }).click();
    expect(await page.evaluate(() =>
        (window as any).PulseGlobe.getInstance().getState().colorMode)).toBe('sentiment');

    // ── City detail: click a city with live posts (the seeded snapshot's
    // loudest city), assert posts + pills + globe selection.
    const target: string = await page.evaluate(() => {
        const cities = (window as any).PulseStory.getCities().slice();
        cities.sort((a: any, b: any) => b.total - a.total);
        return cities[0].city;
    });
    await page.locator('#exp-filters .city-row', { hasText: target }).first().click();

    const detail = page.locator('#exp-detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.det-city')).toContainText(target);
    await expect(detail.locator('.det-sub')).toContainText('posts/hr');
    await expect(detail.locator('.det-score')).toHaveText(/^[+−-]\d\.\d\d$/);

    // Globe selection follows.
    expect(await page.evaluate(() =>
        (window as any).PulseGlobe.getInstance().getState().selectedId)).toBe(target);

    // Posts load from POST /api/query.
    const posts = detail.locator('.det-posts .post');
    await expect(posts.first()).toBeVisible({ timeout: 15000 });
    const first = posts.first();
    await expect(first.locator('.post-text')).not.toBeEmpty();
    // Sentiment pill always; relevance pill in the NEUTRAL (dim) style,
    // never sentiment-colored (prototype bug d guard).
    await expect(first.locator('.score-pill').first()).toHaveText(/^[+−-]\d\.\d\d$/);
    const relPills = detail.locator('.det-posts .score-pill.dim');
    expect(await relPills.count(), 'at least one relevance pill').toBeGreaterThanOrEqual(1);
    await expect(relPills.first()).toHaveText(/^rel \d+%$/);
    const relColor = await relPills.first().evaluate((el) => (el as HTMLElement).style.color);
    expect(relColor, 'relevance pill must not carry an inline sentiment color').toBe('');
    await evidence(page, '05-explore-city-detail');

    // ── × closes the panel and clears the globe selection.
    await detail.locator('.det-x').click();
    await expect(detail).toBeHidden();
    expect(await page.evaluate(() =>
        (window as any).PulseGlobe.getInstance().getState().selectedId)).toBeNull();

    expectNoConsoleErrors(errors);
});
