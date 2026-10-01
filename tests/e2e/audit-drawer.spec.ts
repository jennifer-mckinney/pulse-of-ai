// FR-23 / US-2 — Audit drawer: opens with the AUDIT TRAIL kicker + post id,
// all four audience tabs switch content (Public prose ≠ Regulator key/value
// table ≠ Researcher mono repro), bias layers render PASS / N-A rows with τ
// values, the header timer freezes to "first receipt ✓" on the FIRST open,
// and closing restores the prior view.
import { test, expect, Page, Locator } from '@playwright/test';
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData,
    scrollToBeat, stabilizeSnapshot, evidence, enterExplore,
} from './helpers';

test('audit drawer: audiences, bias layers, timer freeze, close restores view', async ({ page }) => {
    const errors = consoleErrors(page);
    // Unwindowed snapshot so the CH04 featured post (the receipt's entry
    // point) is guaranteed to render — see stabilizeSnapshot's docstring.
    await stabilizeSnapshot(page);
    await gotoAndWaitForData(page);

    // Open the receipt from the CH04 featured post (live post → live audit).
    await scrollToBeat(page, 4);
    const card = page.locator('#card-col .chapter-card').nth(4);
    await expect(card.locator('.mini-post')).toBeVisible({ timeout: 15000 });
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const opener = card.locator('.btn-trace');
    await opener.click();

    const drawer = page.locator('#audit-drawer');
    await expect(drawer).toHaveClass(/open/);

    // Kicker carries the audit-trail label + the live post's UUID.
    await expect(drawer.locator('.drawer-kicker')).toHaveText(
        /^AUDIT TRAIL · [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        { timeout: 15000 });

    // Timeline loaded: ingest → sentiment → relevance → bias ⇒ ≥ 3 steps.
    // The kicker renders before the timeline fetch resolves, so wait for the
    // third step (auto-retrying) instead of counting once — a one-shot
    // count() raced the fetch and read 0 on a fresh database.
    const steps = drawer.locator('.steps .step');
    await expect(steps.nth(2)).toBeAttached({ timeout: 15000 });
    expect(await steps.count()).toBeGreaterThanOrEqual(3);

    // Audience tabs — all four present, defaulting to Public.
    const tabs = drawer.locator('.drawer-seg .seg-btn');
    await expect(tabs).toHaveText(['Public', 'Journalist', 'Regulator', 'Researcher']);
    await expect(tabs.nth(0)).toHaveClass(/on/);

    // Public: prose paragraphs, no key/value tables in the steps.
    const publicText = await drawer.locator('.steps').innerText();
    expect(publicText.length).toBeGreaterThan(40);
    await expect(drawer.locator('.steps .kv')).toHaveCount(0);
    await evidence(page, '04-audit-drawer-public');

    // Journalist: still prose, but DIFFERENT text than Public (the backend
    // serves distinct per-audience texts — G17 closed).
    await tabs.nth(1).click();
    const journalistText = await drawer.locator('.steps').innerText();
    expect(journalistText).not.toBe(publicText);
    await expect(drawer.locator('.steps .kv')).toHaveCount(0);

    // Regulator: key/value config tables replace the prose.
    await tabs.nth(2).click();
    expect(await drawer.locator('.steps .kv').count()).toBeGreaterThanOrEqual(1);
    expect(await drawer.locator('.steps .kv-row').count()).toBeGreaterThanOrEqual(2);
    await evidence(page, '04-audit-drawer-regulator');

    // Researcher: mono repro blocks.
    await tabs.nth(3).click();
    expect(await drawer.locator('.steps .step-repro').count()).toBeGreaterThanOrEqual(1);
    const reproClass = await drawer.locator('.steps .step-repro').first()
        .getAttribute('class');
    expect(reproClass).toContain('mono');
    const researcherText = await drawer.locator('.steps').innerText();
    expect(researcherText).not.toBe(publicText);

    // Bias fairness layers: the prototype's three literature-named layers
    // lead — Demographic parity (real value + τ; the computed platform-
    // sentiment-parity check), Equalized odds and Counterfactual fairness
    // (honest N-A, never fabricated) — with citations; extra real checks
    // (Location concentration, Negative dominance) follow.
    const layers = drawer.locator('.layers .layer');
    expect(await layers.count()).toBeGreaterThanOrEqual(3);
    const layerNames = await drawer.locator('.layers .layer-name').allInnerTexts();
    expect(layerNames.slice(0, 3)).toEqual([
        'Demographic parity', 'Equalized odds', 'Counterfactual fairness',
    ]);
    const layerCites = await drawer.locator('.layers .layer-cite').allInnerTexts();
    expect(layerCites.slice(0, 3)).toEqual([
        'Barocas & Selbst (2016)', 'Hardt et al. (2016)', 'Kusner et al. (2017)',
    ]);
    expect(await drawer.locator('.layer-ok.ok').count(), 'PASS rows')
        .toBeGreaterThanOrEqual(1);
    expect(await drawer.locator('.layer-ok.na').count(), 'N-A rows (the two planned layers)')
        .toBeGreaterThanOrEqual(2);
    const layerVals = await drawer.locator('.layer-val').allInnerTexts();
    expect(layerVals[0], 'Demographic parity carries a REAL value + τ').toContain('τ');
    expect(layerVals.some((t) => t.includes('τ')), 'τ threshold values').toBe(true);
    // P0-3: the computed Demographic parity row states what it measures
    // (source categories, not people) — the versioned bias config's note.
    // bias@1.4.0 (migration 032) adds its minimum-sample rule to that note.
    await expect(layers.first().locator('.layer-note'))
        .toHaveText('parity measured across source categories (platform), not user demographics; '
            + 'only categories with at least 10 posts in the job are compared');

    // Timer froze at the FIRST receipt (US-1) and stays frozen.
    await expect(page.locator('#insight-label')).toHaveText('first receipt ✓');
    const frozen = await page.locator('#insight-timer').innerText();
    await page.waitForTimeout(1600);
    await expect(page.locator('#insight-timer')).toHaveText(frozen);

    // Close restores the prior view: drawer hidden, story card still there,
    // scroll position untouched.
    await drawer.locator('.drawer-x').click();
    await expect(drawer).not.toHaveClass(/open/);
    await expect(drawer).toHaveAttribute('aria-hidden', 'true');
    await expect(card).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    // Keyboard focus returns to the button that opened the receipt instead
    // of staying on the × inside the now-hidden drawer.
    await expect(opener).toBeFocused();

    expectNoConsoleErrors(errors);
});

// Safari (and some assistive tech) do not focus a button on a mouse click,
// so document.activeElement stays <body> when the receipt opens. The drawer
// must still hand focus back to the button that opened it on close: each
// opener passes itself explicitly instead of the drawer inferring it from
// activeElement (Copilot thread on public/js/ui.js setDrawerOpen).
// dispatchEvent('click') fires the click WITHOUT moving focus, reproducing
// that browser behaviour in Chromium.
async function openWithoutFocus(page: Page, opener: Locator) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await opener.dispatchEvent('click');
    expect(await page.evaluate(() => document.activeElement === document.body),
        'the synthetic click must leave focus on <body>').toBe(true);
}

test('audit drawer: focus returns to an opener the click never focused', async ({ page }) => {
    const errors = consoleErrors(page);
    await stabilizeSnapshot(page);
    await gotoAndWaitForData(page);
    const drawer = page.locator('#audit-drawer');

    // 1. The CH04 featured-post button (story.js → PulseUI.openAudit).
    await scrollToBeat(page, 4);
    const card = page.locator('#card-col .chapter-card').nth(4);
    await expect(card.locator('.mini-post')).toBeVisible({ timeout: 15000 });
    const trace = card.locator('.btn-trace');
    await openWithoutFocus(page, trace);
    await expect(drawer).toHaveClass(/open/);
    await drawer.locator('.drawer-x').click();
    await expect(drawer).not.toHaveClass(/open/);
    await expect(trace).toBeFocused();

    // 2. An explore detail panel "why?" button (ui.js renderDetailPosts).
    await enterExplore(page);
    const target: string = await page.evaluate(() => {
        const cities = (window as any).PulseStory.getCities().slice();
        cities.sort((a: any, b: any) => b.total - a.total);
        return cities[0].city;
    });
    await page.locator('#exp-filters .city-row', { hasText: target }).first().click();
    const why = page.locator('#exp-detail .det-posts .btn-why').first();
    await expect(why).toBeVisible({ timeout: 15000 });
    await openWithoutFocus(page, why);
    await expect(drawer).toHaveClass(/open/);
    await drawer.locator('.drawer-x').click();
    await expect(drawer).not.toHaveClass(/open/);
    await expect(why).toBeFocused();

    expectNoConsoleErrors(errors);
});
