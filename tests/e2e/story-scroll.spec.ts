// Story scroll — programmatic scroll through all 11 beats. Per beat the
// docked chapter card's kicker/title must match the resolver output
// (PulseChapters.resolveChapter over the SAME snapshot the page loaded),
// the card transition math must move opacity/transform, the progress rail
// must advance, and CH05 must flip the legend to category swatches.
import { test, expect } from '@playwright/test';
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData,
    scrollToProg, scrollToBeat, stabilizeSnapshot, evidence, BEATS,
} from './helpers';

test('story: 11 beats — cards match resolver, rail advances, CH05 legend flips', async ({ page }) => {
    const errors = consoleErrors(page);
    await stabilizeSnapshot(page);
    await gotoAndWaitForData(page);

    // Independently resolve every beat from the page's own snapshot — the
    // cards must render exactly this (no drift between resolver and DOM).
    const expected: Array<{ kicker: string; title: string }> = await page.evaluate(() => {
        const w = window as any;
        const cities = w.PulseStory.getCities();
        const insights = w.PulseInsights.computeInsights(cities);
        const isDemo = w.PulseStory.getState().isDemo;
        return w.PulseChapters.STORY.map((beat: any) => {
            const r = w.PulseChapters.resolveChapter(beat, insights, cities, { isDemo });
            return { kicker: r.kicker, title: r.cardTitle };
        });
    });
    expect(expected).toHaveLength(BEATS);

    const cards = page.locator('#card-col .chapter-card');
    await expect(cards).toHaveCount(BEATS);
    const dots = page.locator('#rail .rail-dot');
    await expect(dots).toHaveCount(BEATS);

    // Beats 0–9 are story beats (beat 10 crosses the explore threshold and
    // hides the card column by design). Beat 0 is asserted at prog 0.2:
    // the story chrome only appears past prog 0.14 (showStoryUi), so the
    // exact beat-0 position keeps the card column hidden by design.
    for (let i = 0; i < BEATS - 1; i++) {
        await scrollToProg(page, i === 0 ? 0.2 : i);

        // Active card matches the resolver output.
        const card = cards.nth(i);
        await expect(card).toBeVisible();
        await expect(card.locator('.ch-kicker')).toHaveText(expected[i].kicker);
        await expect(card.locator('.ch-title')).toHaveText(expected[i].title);

        // Centered on the beat: full opacity, no translate (beat 0 is
        // asserted off-center, where the transition math already applies).
        const style = await card.evaluate((el) => ({
            opacity: Number((el as HTMLElement).style.opacity),
            transform: (el as HTMLElement).style.transform,
        }));
        if (i > 0) {
            expect(style.opacity).toBeGreaterThan(0.95);
            expect(style.transform).toBe('translateY(0px)');
        } else {
            expect(style.opacity).toBeGreaterThan(0.3);
        }

        // Progress rail: exactly this beat's dot is active.
        for (let d = 0; d < BEATS; d++) {
            const on = await dots.nth(d).evaluate((el) => el.classList.contains('on'));
            expect(on, `rail dot ${d} at beat ${i}`).toBe(i === d);
        }
    }

    // Transition math: between beats the card fades and translates.
    await scrollToProg(page, 1.4);
    const mid = await cards.nth(1).evaluate((el) => ({
        opacity: Number((el as HTMLElement).style.opacity),
        transform: (el as HTMLElement).style.transform,
    }));
    expect(mid.opacity).toBeLessThan(0.6);
    expect(mid.opacity).toBeGreaterThan(0);
    expect(mid.transform).not.toBe('translateY(0px)');

    // Legend flavors: sentiment gradient on CH01, category swatches on CH05
    // (colorMode 'category' — the drivers beat).
    await scrollToBeat(page, 1);
    await expect(page.locator('#legend')).toBeVisible();
    await expect(page.locator('#legend .legend-grad')).toHaveCount(1);

    await scrollToBeat(page, 5);
    await expect(page.locator('#legend')).toBeVisible();
    await expect(page.locator('#legend .legend-grad')).toHaveCount(0);
    // One swatch per CANONICAL category, always (8 — quiet categories never
    // vanish), labeled with the display name lowercased (prototype casing).
    const swatches = page.locator('#legend > span');
    expect(await swatches.count()).toBe(8);
    await expect(swatches.first()).toContainText('●');
    const swatchTexts = (await swatches.allInnerTexts())
        .map((t) => t.replace('●', '').trim());
    expect(swatchTexts, 'registry order, display labels lowercased').toEqual([
        'social', 'news', 'academic', 'policy',
        'non-profit', 'developer', 'forums', 'blogs',
    ]);
    await evidence(page, '02-story-ch05-legend');

    // Beat 10: explore threshold — cards hide, last rail dot active.
    await scrollToBeat(page, 10);
    await page.waitForFunction(() => (window as any).PulseStory.getState().exploring);
    await expect(page.locator('#card-col')).toBeHidden();
    const lastOn = await dots.nth(BEATS - 1).evaluate((el) => el.classList.contains('on'));
    expect(lastOn).toBe(true);

    expectNoConsoleErrors(errors);
});
