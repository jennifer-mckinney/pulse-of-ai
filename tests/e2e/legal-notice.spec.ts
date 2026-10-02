// Appropriate Legal Notices (AGPL-3.0-or-later + the section 7(b) author
// attribution, ADDITIONAL-TERMS.md): the header "about" chip opens a panel
// that shows the copyright, "Built on Pulse of AI by Jennifer McKinney"
// linked to the upstream repository, the license link, the additional
// terms, a "Source code" link (AGPL section 13) and the no-warranty line.
// Escape closes it. Zero console errors (the strict CSP stays clean).
import { test, expect } from '@playwright/test';
import { consoleErrors, expectNoConsoleErrors, gotoAndWaitForData, evidence } from './helpers';

const UPSTREAM = 'https://github.com/jennifer-mckinney/pulse-of-ai';

test('legal notice: about chip opens the AGPL notices with the source link', async ({ page }) => {
    const errors = consoleErrors(page);
    await gotoAndWaitForData(page);

    const chip = page.locator('#about-chip');
    const panel = page.locator('#about-panel');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();

    await chip.click();
    await expect(panel).toBeVisible();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');

    const items = panel.locator('li.about-item');
    await expect(items).toHaveCount(6);
    await expect(panel.locator('[data-notice="copyright"]')).toHaveText('Copyright © 2026 Jennifer McKinney');

    const attribution = panel.getByRole('link', { name: 'Built on Pulse of AI by Jennifer McKinney' });
    await expect(attribution).toHaveAttribute('href', UPSTREAM);

    const license = panel.getByRole('link', { name: /AGPL-3\.0/ });
    await expect(license).toHaveAttribute('href', `${UPSTREAM}/blob/master/LICENSE`);

    await expect(panel.getByRole('link', { name: /Additional terms/ }))
        .toHaveAttribute('href', `${UPSTREAM}/blob/master/ADDITIONAL-TERMS.md`);

    const source = panel.getByRole('link', { name: 'Source code' });
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute('href', UPSTREAM);

    await expect(panel.locator('[data-notice="warranty"]')).toContainText('No warranty');
    await evidence(page, '14-legal-notice');

    // Escape from a link INSIDE the panel closes it and returns keyboard
    // focus to the controlling chip, never leaving it in a hidden subtree
    // (Copilot r4151202232).
    await attribution.focus();
    await expect(attribution).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(chip).toBeFocused();

    expectNoConsoleErrors(errors);
});

// The .stage is fixed and clips overflow, so at a narrow or zoomed viewport
// the wrapped notice lines must stay reachable: the panel is bounded to the
// viewport below its top and scrolls (Copilot r4158623080). 320 x 240 CSS px
// is a phone width at a high zoom.
test('legal notice: the static notices remain when legal.config.js fails to load', async ({ page }) => {
    // No console-error assertion: the aborted request is logged by the browser.
    await page.route('**/js/config/legal.config.js', (route) => route.abort());
    await gotoAndWaitForData(page);
    const chip = page.locator('#about-chip');
    await expect(chip).toBeVisible();
    await chip.click();
    const panel = page.locator('#about-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('li.about-item')).toHaveCount(6);
    await expect(panel.getByRole('link', { name: 'Built on Pulse of AI by Jennifer McKinney' })).toHaveAttribute('href', UPSTREAM);
});

// A malformed config must take the fallback path: an empty list would wipe
// the static notices, and a null entry used to throw before initModules().
for (const [label, body] of [
    ['an empty NOTICE list', 'window.PulseLegalConfig = { NOTICE: [] };'],
    ['a null entry', 'window.PulseLegalConfig = { NOTICE: [null] };'],
    ['an entry without text', 'window.PulseLegalConfig = { NOTICE: [{ id: "x" }] };'],
    ['a partial list (one notice only)', 'window.PulseLegalConfig = { NOTICE: [{ id: "copyright", text: "x" }] };'],
    ['a duplicated id', 'window.PulseLegalConfig = { NOTICE: ['
        + '{ id: "copyright", text: "a" }, { id: "copyright", text: "b" },'
        + '{ id: "attribution", text: "c", href: "https://e.test/a" }, { id: "license", text: "d", href: "https://e.test/l" },'
        + '{ id: "terms", text: "e", href: "https://e.test/t" }, { id: "source", text: "f", href: "https://e.test/s" },'
        + '{ id: "warranty", text: "g" }] };'],
    ['an empty href on a linked notice', 'window.PulseLegalConfig = { NOTICE: ['
        + '{ id: "copyright", text: "a" }, { id: "attribution", text: "c", href: "" },'
        + '{ id: "license", text: "d", href: "https://e.test/l" }, { id: "terms", text: "e", href: "https://e.test/t" },'
        + '{ id: "source", text: "f", href: "https://e.test/s" }, { id: "warranty", text: "g" }] };'],
] as const) {
    test(`legal notice: ${label} keeps the static, interactive notices and the page boots`, async ({ page }) => {
        await page.route('**/js/config/legal.config.js', (route) => route.fulfill({ contentType: 'application/javascript', body }));
        await gotoAndWaitForData(page);   // initModules() ran: the data loaded
        const chip = page.locator('#about-chip');
        await expect(chip).toBeVisible();
        await chip.click();
        const panel = page.locator('#about-panel');
        await expect(panel).toBeVisible();
        await expect(panel.locator('li.about-item')).toHaveCount(6);
        await expect(panel.getByRole('link', { name: 'Built on Pulse of AI by Jennifer McKinney' })).toHaveAttribute('href', UPSTREAM);
    });
}

test('legal notice: opening the receipt drawer folds the panel away', async ({ page }) => {
    await gotoAndWaitForData(page);
    const chip = page.locator('#about-chip');
    await chip.click();
    await expect(page.locator('#about-panel')).toBeVisible();
    // The health drawer opens through the same class toggle every drawer uses.
    await page.locator('#health-chip').click();
    await expect(page.locator('#health-drawer')).toHaveClass(/open/);
    await expect(page.locator('#about-panel')).toBeHidden();
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
});

test('legal notice: a drawer opening without moving focus takes it out of the folded panel', async ({ page }) => {
    await gotoAndWaitForData(page);
    const chip = page.locator('#about-chip');
    await chip.click();
    // Focus a notice link, then open the drawer by a path that does not move
    // focus (a Safari click on a button): toggle the class the drawer API sets.
    await page.locator('#about-panel a').first().focus();
    await page.evaluate(() => {
        const d = document.getElementById('health-drawer');
        d.classList.add('open');
        d.setAttribute('aria-hidden', 'false');
    });
    await expect(page.locator('#about-panel')).toBeHidden();
    await expect(page.locator('#health-drawer')).toBeFocused();
});

test('legal notice: a class change on an already-open drawer keeps the panel open', async ({ page }) => {
    await gotoAndWaitForData(page);
    await page.locator('#health-chip').click();
    await expect(page.locator('#health-drawer')).toHaveClass(/open/);
    // The chip is inert while the drawer is open (and says so), so open the
    // panel directly, then change an unrelated class on the open drawer.
    await expect(page.locator('#about-chip')).toHaveAttribute('aria-disabled', 'true');
    await page.evaluate(() => {
        const p = document.getElementById('about-panel');
        p.hidden = false;
        document.getElementById('about-chip').setAttribute('aria-expanded', 'true');
        document.getElementById('health-drawer').classList.add('unrelated-state');
    });
    // two animation frames: the observer's microtask has long run by then
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
    await expect(page.locator('#about-panel')).toBeVisible();
    await expect(page.locator('#about-chip')).toHaveAttribute('aria-expanded', 'true');
});

test('legal notice: the about chip does nothing while a drawer is open, and is re-enabled after', async ({ page }) => {
    await gotoAndWaitForData(page);
    const chip = page.locator('#about-chip');
    await page.locator('#health-chip').click();
    await expect(page.locator('#health-drawer')).toHaveClass(/open/);
    await expect(chip).toHaveAttribute('aria-disabled', 'true');
    await chip.click({ force: true });
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#about-panel')).toBeHidden();
    await page.locator('#health-drawer .drawer-x').click();
    await expect(page.locator('#health-drawer')).not.toHaveClass(/open/);
    await expect(chip).not.toHaveAttribute('aria-disabled', 'true');
    await chip.click();
    await expect(page.locator('#about-panel')).toBeVisible();
});

test('legal notice: a drawer opened from a focused notice link returns focus to the about chip', async ({ page }) => {
    await gotoAndWaitForData(page);
    await page.locator('#about-chip').click();
    await page.locator('#about-panel a').first().focus();
    // programmatic open with no control: the opener would be the notice link
    await page.evaluate(() => (window as any).PulseUI.openHealth());
    await expect(page.locator('#health-drawer')).toHaveClass(/open/);
    await page.locator('#health-drawer .drawer-x').click();
    await expect(page.locator('#health-drawer')).not.toHaveClass(/open/);
    await expect(page.locator('#about-chip')).toBeFocused();
});

for (const width of [320, 540, 600, 700]) {
    test(`legal notice: at ${width}px the panel opens below the header and inside the viewport`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await gotoAndWaitForData(page);
        await page.locator('#about-chip').click();
        const panel = await page.locator('#about-panel').boundingBox();
        expect(panel).not.toBeNull();
        for (const sel of ['#about-chip', '#health-chip', '#credits-link', '#insight-chip']) {
            const b = await page.locator(sel).boundingBox();
            expect(panel!.y, sel + ' stays above the panel').toBeGreaterThanOrEqual(b!.y + b!.height - 1);
        }
        expect(panel!.x).toBeGreaterThanOrEqual(0);
        expect(panel!.x + panel!.width).toBeLessThanOrEqual(width);
    });
}

test('legal notice: a short viewport bounds the panel and scrolls to the last notice', async ({ page }) => {
    const errors = consoleErrors(page);
    await page.setViewportSize({ width: 320, height: 240 });
    await gotoAndWaitForData(page);

    const chip = page.locator('#about-chip');
    const panel = page.locator('#about-panel');
    await chip.click();
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(240);
    // More notice text than fits: the panel scrolls instead of clipping.
    const scroll = await panel.evaluate(el => ({
        overflowY: getComputedStyle(el).overflowY,
        scrollable: el.scrollHeight > el.clientHeight,
    }));
    expect(scroll.overflowY).toBe('auto');
    expect(scroll.scrollable).toBe(true);

    const warranty = panel.locator('[data-notice="warranty"]');
    await warranty.scrollIntoViewIfNeeded();
    const w = await warranty.boundingBox();
    expect(w).not.toBeNull();
    expect(w!.y + w!.height).toBeLessThanOrEqual(240);
    await expect(warranty).toBeInViewport();

    expectNoConsoleErrors(errors);
});

// A pointer click on the chip closes the panel too. In Safari a click does
// not move focus to the button, so a link inside the panel that had keyboard
// focus would stay focused inside the hidden subtree. The click is
// dispatched without moving focus (as Safari does), and focus must still
// land on the chip (Copilot r4158521470).
test('legal notice: closing by a click that does not move focus returns it to the chip', async ({ page }) => {
    const errors = consoleErrors(page);
    await gotoAndWaitForData(page);

    const chip = page.locator('#about-chip');
    const panel = page.locator('#about-panel');
    await chip.click();
    await expect(panel).toBeVisible();

    const attribution = panel.getByRole('link', { name: 'Built on Pulse of AI by Jennifer McKinney' });
    await attribution.focus();
    await expect(attribution).toBeFocused();

    await chip.dispatchEvent('click');
    await expect(panel).toBeHidden();
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(chip).toBeFocused();

    // Focus the user moved elsewhere on the page is left where it is.
    await chip.dispatchEvent('click');
    await expect(panel).toBeVisible();
    await page.locator('#health-chip').focus();
    await chip.dispatchEvent('click');
    await expect(panel).toBeHidden();
    await expect(page.locator('#health-chip')).toBeFocused();

    expectNoConsoleErrors(errors);
});
