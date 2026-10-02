// K1 — source credit and link back on every excerpt and receipt
// (docs/research/k1-attribution-design.md). The seeded fixture posts carry a
// permalink on their own source's domain, so the live path is asserted end to end:
//   - the city post list, the CH04 mini-post and the audit drawer each show
//     "via <credit>" and a link to the original (new tab, noopener);
//   - demo posts (backend unreachable) show the demo label and NO link;
//   - the credits page lists the credited sources and the notices;
//   - the console stays clean (strict CSP: no inline script or style).
import { test, expect } from '@playwright/test';
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData, enterExplore,
    scrollToBeat, stabilizeSnapshot, pickCity, evidence,
} from './helpers';

test('city post list: every excerpt shows its credit and a safe link back', async ({ page }) => {
    const errors = consoleErrors(page);
    await stabilizeSnapshot(page);
    await gotoAndWaitForData(page);
    await enterExplore(page);

    const target = await pickCity(page);
    await page.locator('#exp-filters .city-row', { hasText: target.city }).first().click();
    const posts = page.locator('#exp-detail .det-posts .post');
    await expect(posts.first()).toBeVisible({ timeout: 15000 });

    const n = await posts.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
        const post = posts.nth(i);
        const credit = post.locator('.credit');
        await expect(credit, `post ${i} has a credit line`).toHaveCount(1);
        await expect(credit).toContainText('via ');
        // the credit sits directly under the excerpt, before the score row
        const order = await post.evaluate((el) =>
            Array.from(el.children).map((c) => c.className.split(' ')[0]));
        expect(order.indexOf('post-text')).toBeLessThan(order.indexOf('credit'));
        expect(order.indexOf('credit')).toBeLessThan(order.indexOf('post-row'));

        const link = credit.locator('a.credit-link');
        await expect(link).toHaveCount(1);
        await expect(link).toHaveAttribute('href', /^https:\/\/[a-z0-9.-]+\/e2e\/dev-seed-\d+-\d+$/);
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        // the link text names the destination host, which is the href's host
        const href = (await link.getAttribute('href')) as string;
        const host = new URL(href).hostname.replace(/^www\./, '');
        await expect(link).toHaveText(host + ' ↗');
        await expect(link).toHaveAttribute('aria-label', 'Read the original at ' + host + ' (opens in a new tab)');
    }
    // the old "via X" in the meta line is gone (no double credit)
    await expect(posts.first().locator('.post-meta')).not.toContainText('via ');
    await evidence(page, '20-attribution-city-posts');

    // The receipt opened from the same post carries the same credit + link.
    await posts.first().locator('.btn-why').click();
    const drawer = page.locator('#audit-drawer');
    await expect(drawer).toHaveClass(/open/);
    const steps = drawer.locator('.steps .step');
    await expect(steps.nth(2)).toBeAttached({ timeout: 15000 });
    const dc = drawer.locator('.drawer-post .credit');
    await expect(dc).toHaveCount(1);
    await expect(dc).toContainText('via ');
    await expect(dc.locator('a.credit-link')).toHaveAttribute('href', /^https:\/\/[a-z0-9.-]+\/e2e\//);
    await expect(dc.locator('a.credit-link')).toHaveAttribute('rel', 'noopener noreferrer');
    await evidence(page, '21-attribution-audit-drawer');

    expectNoConsoleErrors(errors);
});

test('audit drawer error state: the excerpt keeps its credit and link when the receipt is unavailable', async ({ page }) => {
    const errors = consoleErrors(page, [/Failed to load resource/]);
    await page.route('**/api/audit/*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Internal server error"}' }));
    await stabilizeSnapshot(page);
    await gotoAndWaitForData(page);
    await enterExplore(page);
    const target = await pickCity(page);
    await page.locator('#exp-filters .city-row', { hasText: target.city }).first().click();
    const posts = page.locator('#exp-detail .det-posts .post');
    await expect(posts.first()).toBeVisible({ timeout: 15000 });
    await posts.first().locator('.btn-why').click();
    const drawer = page.locator('#audit-drawer');
    await expect(drawer).toHaveClass(/open/);
    await expect(drawer).toContainText('audit trail unavailable');
    const dc = drawer.locator('.drawer-post .credit');
    await expect(dc).toContainText('via ');
    await expect(dc.locator('a.credit-link')).toHaveAttribute('href', /^https:\/\/[a-z0-9.-]+\/e2e\//);
    expectNoConsoleErrors(errors);
});

test('CH04 mini-post: credit and link under the excerpt', async ({ page }) => {
    const errors = consoleErrors(page);
    await stabilizeSnapshot(page);
    await gotoAndWaitForData(page);
    await scrollToBeat(page, 4);
    const mini = page.locator('#card-col .chapter-card').nth(4).locator('.mini-post');
    await expect(mini).toBeVisible({ timeout: 15000 });
    await expect(mini.locator('.credit')).toContainText('via ');
    await expect(mini.locator('.credit a.credit-link')).toHaveAttribute('href', /^https:\/\/[a-z0-9.-]+\/e2e\//);
    await expect(mini.locator('.credit a.credit-link')).toHaveAttribute('target', '_blank');
    expectNoConsoleErrors(errors);
});

test('demo fallback: a fictional post shows the demo label and no link', async ({ page }) => {
    const errors = consoleErrors(page, [/Failed to load resource/, /net::ERR_FAILED/]);
    await page.route('**/api/**', (route) => route.abort());
    await page.goto('/');
    await page.waitForFunction(() => {
        const w = window as any;
        return w.PulseStory && w.PulseStory.getCities().length > 0;
    }, undefined, { timeout: 20000 });
    await enterExplore(page);
    await page.locator('#exp-filters .exp-list .city-row').first().click();
    const posts = page.locator('#exp-detail .det-posts .post');
    await expect(posts).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
        const credit = posts.nth(i).locator('.credit');
        await expect(credit).toHaveText('fictional demo post · no real source');
        await expect(credit).toHaveClass(/credit-demo/);
        await expect(posts.nth(i).locator('a')).toHaveCount(0);
    }
    // the local demo receipt says the same, and links nowhere
    await posts.first().locator('.btn-why').click();
    const dc = page.locator('#audit-drawer .drawer-post .credit');
    await expect(dc).toHaveText('fictional demo post · no real source');
    await expect(page.locator('#audit-drawer .drawer-post a')).toHaveCount(0);
    expectNoConsoleErrors(errors);
});

test('credits page: notices, credited sources, safe links', async ({ page }) => {
    const errors = consoleErrors(page);
    await page.goto('/credits.html');
    await expect(page).toHaveTitle(/Credits/);
    await expect(page.locator('h1')).toHaveText('Sources and credits');
    // the notices come from the API
    const notices = page.locator('#credits-notices li');
    await expect(notices.first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#credits-notices')).toContainText('shortened');
    await expect(page.locator('#credits-notices')).toContainText('fictional');
    // at least one credited source row from the seeded fixture
    const rows = page.locator('#credits-sources .credits-row');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(rows.first().locator('.credits-credit')).toContainText('Excerpts are credited: via ');
    // every link on the page is https, new-tab, noopener
    const hrefs = await page.locator('#credits-sources a').evaluateAll((as) =>
        as.map((a) => [(a as HTMLAnchorElement).href, (a as HTMLAnchorElement).target, (a as HTMLAnchorElement).rel]));
    for (const [href, target, rel] of hrefs) {
        expect(href).toMatch(/^https?:\/\//);
        expect(target).toBe('_blank');
        expect(rel).toBe('noopener noreferrer');
    }
    await evidence(page, '22-credits-page');
    // back link returns to the story
    await page.locator('.credits-back a').click();
    await expect(page).toHaveURL(/\/$/);
    expectNoConsoleErrors(errors);
});

test('header credits link opens the credits page', async ({ page }) => {
    const errors = consoleErrors(page);
    await gotoAndWaitForData(page);
    const link = page.locator('#credits-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'credits.html');
    await link.click();
    await expect(page).toHaveURL(/credits\.html$/);
    expectNoConsoleErrors(errors);
});

// The header gained a "credits" chip: at phone width every chip must stay on
// screen (body overflow-x is hidden, so a clipped health chip is unreachable).
test.describe('phone width (375px)', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('header chips all fit; the health drawer is still reachable', async ({ page }) => {
        const errors = consoleErrors(page);
        await gotoAndWaitForData(page);
        for (const sel of ['#credits-link', '#health-chip', '#insight-chip']) {
            const box = await page.locator(sel).boundingBox();
            expect(box, sel + ' is rendered').not.toBeNull();
            expect(box!.x, sel + ' starts on screen').toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width, sel + ' ends on screen').toBeLessThanOrEqual(375);
        }
        await evidence(page, '23-attribution-mobile-header');
        await page.locator('#health-chip').click();
        await expect(page.locator('#health-drawer')).toHaveClass(/open/);
        await page.locator('#health-drawer .drawer-x').click();
        // the wrapped header must not overlap the explore filter column
        await enterExplore(page);
        const health = await page.locator('#health-chip').boundingBox();
        const filters = await page.locator('#exp-filters').boundingBox();
        expect(health!.y + health!.height, 'header ends above the explore filters').toBeLessThanOrEqual(filters!.y);
        expectNoConsoleErrors(errors);
    });

    test('credits page has no horizontal scroll', async ({ page }) => {
        await page.goto('/credits.html');
        await expect(page.locator('#credits-sources .credits-row').first()).toBeVisible({ timeout: 15000 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
    });
});
