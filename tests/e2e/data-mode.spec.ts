// Data-origin honesty (standup demo population).
//
// The e2e database holds the deterministic LIVE-source fixture, so:
//   1. the live test asserts the intro is interpolated from the snapshot the
//      globe renders (no fixed "4,500 posts … 50 sources … 30 cities") and
//      the kicker says LIVE;
//   2. the demo test serves the SAME fixture re-labeled as the backend demo
//      feed (every row's demo_posts = total — exactly what the API returns
//      for a standup-populated database) and asserts the DEMO kicker, the
//      computed demo wording, the "— Demo data" card marker, the demo receipt
//      wording and the separate demo-feeds figure. The receipt's ingestion
//      step is rendered by the REAL narration code (src/config/audit-narration
//      renderIngestStep, demo branch) — the spec never hand-writes that text.
//      The server side of the same wording is covered by
//      tests/integration/api.dataMode.test.js.
//   3. the empty-hour test serves an empty trailing hour over a non-empty
//      database (data mode 'none').
// In every mode the chapter-one (overview) card's kicker and its rail dot
// follow the data mode like the intro kicker (G9-5): it once read
// "LIVE · REFRESH CYCLE 2–3 MIN" whatever the data was.
import { test, expect, Page } from '@playwright/test';
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData,
    scrollToBeat, scrollToProg, evidence,
} from './helpers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderIngestStep } = require('../../src/config/audit-narration');

// Expected intro numbers from the page's OWN rendered snapshot.
async function introFactsFromPage(page: Page) {
    return page.evaluate(() => {
        const cities = (window as any).PulseStory.getCities();
        let posts = 0;
        let reporting = 0;
        const sources = new Set<string>();
        for (const c of cities) {
            posts += c.total;
            if (c.total > 0) reporting += 1;
            for (const s of c.sources || []) if (s.total > 0 && s.source_name) sources.add(s.source_name);
        }
        return { posts, cities: reporting, sources: sources.size };
    });
}

const fmt = (n: number) => n.toLocaleString('en-US');

// G9-5: the overview card's kicker and its rail dot label.
async function expectOverviewKicker(page: Page, kicker: string) {
    await expect(page.locator('#card-col .chapter-card').nth(0).locator('.ch-kicker')).toHaveText(kicker);
    await expect(page.locator('.rail-dot').first()).toHaveAttribute('aria-label', `Jump to ${kicker}`);
}

// No chapter card claims LIVE when the data is not (G9-5).
async function expectNoLiveKicker(page: Page) {
    const kickers = await page.locator('#card-col .chapter-card .ch-kicker').allTextContents();
    expect(kickers.length).toBe(11);
    for (const k of kickers) expect(k).not.toMatch(/LIVE/);
}

// Unwindowed snapshot (stable against fixture age), optionally re-labeled as
// the backend demo feed.
async function serveSnapshot(page: Page, asDemo: boolean) {
    await page.route('**/api/posts/aggregated-by-location*', async (route) => {
        const url = new URL(route.request().url());
        url.searchParams.delete('from');
        const response = await route.fetch({ url: url.toString() });
        const rows = await response.json();
        const body = asDemo
            ? rows.map((r: any) => ({ ...r, demo_posts: r.total, data_mode: 'demo' }))
            : rows;
        await route.fulfill({ response, json: body });
    });
}

test('live data: LIVE kicker and intro numbers interpolated from the rendered snapshot', async ({ page }) => {
    const errors = consoleErrors(page);
    await serveSnapshot(page, false);
    await gotoAndWaitForData(page);

    await expect(page.locator('#intro-kicker')).toHaveText('LIVE · UPDATED EVERY 2–3 MINUTES');
    await expect(page.locator('#intro')).toHaveAttribute('data-mode', 'live');
    const f = await introFactsFromPage(page);
    expect(f.posts).toBeGreaterThan(0);
    await expect(page.locator('#intro-sub')).toContainText(
        `${fmt(f.posts)} posts an hour across ${fmt(f.sources)} sources and ${fmt(f.cities)} cities`);
    await expect(page.locator('#intro-sub')).not.toContainText('4,500');
    await expectOverviewKicker(page, 'LIVE · REFRESH CYCLE 2–3 MIN');

    // Live chapter titles carry no demo marker.
    await scrollToBeat(page, 1);
    await expect(page.locator('#card-col .chapter-card').nth(1).locator('.ch-title'))
        .not.toContainText('Demo data');
    expectNoConsoleErrors(errors);
});

test('backend demo data: DEMO kicker, computed demo intro, Demo data markers, demo receipt', async ({ page }) => {
    const errors = consoleErrors(page);
    await serveSnapshot(page, true);

    // Health reports the demo mode and one demo feed beside the registry.
    await page.route('**/api/health', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, data_mode: 'demo', demo_feeds: 1 } });
    });
    await page.route('**/api/sources?include_inactive=true', async (route) => {
        const response = await route.fetch();
        const rows = await response.json();
        await route.fulfill({ response, json: rows.concat([{
            id: '00000000-0000-4000-8000-000000000001', name: 'demo_news',
            display_name: 'Demo feed — News (fictional)', source_type: 'demo',
            category: 'news', active: false,
        }]) });
    });
    // Receipt: the fixture post re-labeled as a demo-feed post, its
    // ingestion step rendered by the real narration code's demo branch.
    await page.route('**/api/audit/*', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const { model, methodology_version: _v, ...cfg } = body.ingest.audiences.config;
        const ingest = renderIngestStep({
            model_name: body.ingest.model_name,
            version: body.ingest.methodology_version,
            config: cfg,
        }, { demo: true });
        await route.fulfill({ response, json: {
            ...body, post: { ...body.post, data_origin: 'demo' }, ingest,
        } });
    });

    await gotoAndWaitForData(page);

    // Kicker says DEMO in the prototype's position/styling (same element).
    await expect(page.locator('#intro-kicker')).toHaveText('DEMO · UPDATED EVERY 2–3 MINUTES');
    await expect(page.locator('#intro-kicker')).toHaveClass(/intro-kicker/);
    await expect(page.locator('#intro')).toHaveAttribute('data-mode', 'demo');
    const f = await introFactsFromPage(page);
    await expect(page.locator('#intro-sub')).toContainText(
        `${fmt(f.posts)} fictional posts an hour across ${fmt(f.sources)} demo feeds and ${fmt(f.cities)} cities`);

    // Backend demo is labeled like the bundled fallback, without BEING it:
    // receipts are still fetched (isDemo false).
    const state = await page.evaluate(() => (window as any).PulseStory.getState());
    expect(state).toMatchObject({ isDemo: false, dataMode: 'demo' });
    // G9-5: chapter one says DEMO, like the intro — never LIVE.
    await expectOverviewKicker(page, 'DEMO · REFRESH CYCLE 2–3 MIN');
    await expectNoLiveKicker(page);
    await scrollToBeat(page, 1);
    await expect(page.locator('#card-col .chapter-card').nth(1).locator('.ch-title'))
        .toContainText('— Demo data');

    // Demo receipt from the CH04 featured post.
    await scrollToBeat(page, 4);
    const card = page.locator('#card-col .chapter-card').nth(4);
    await expect(card.locator('.mini-post')).toBeVisible({ timeout: 15000 });
    await card.locator('.btn-trace').click();
    const drawer = page.locator('#audit-drawer');
    await expect(drawer).toHaveClass(/open/);
    await expect(drawer.locator('.drawer-kicker')).toHaveText(/^AUDIT TRAIL · [0-9a-f-]{36} · DEMO DATA$/i,
        { timeout: 15000 });
    await expect(drawer.locator('.steps')).toContainText(
        'This is a fictional demo post generated for this installation');
    await expect(drawer.locator('.steps')).not.toContainText('came from a public source');
    await page.waitForTimeout(600);   // let the drawer finish sliding in for the evidence shot
    await evidence(page, '13-data-mode-demo-receipt');
    await drawer.locator('.drawer-x').click();

    // Health drawer: demo feeds are a separate figure, never sources.
    await page.locator('#health-chip').click();
    const health = page.locator('#health-drawer');
    await expect(health).toHaveClass(/open/);
    await expect(health.locator('.drawer-kicker')).toContainText('MODEL HEALTH · LIVE · DEMO DATA');
    await expect(health.locator('.kv-row', { hasText: 'demo feeds' }))
        .toContainText('1 (fictional demo population, not sources)');
    const sourcesRow = await health.locator('.kv-row', { hasText: 'sources online' }).innerText();
    expect(sourcesRow).toMatch(/\d+ \/ 51 /);   // the registry's 51, demo feed excluded
    await expect(health.locator('.src-list .src-row')).toHaveCount(51);
    expectNoConsoleErrors(errors);
});

// G9-5: an empty trailing hour over a non-empty database is data mode
// 'none' — the intro AND the chapter-one card say so, and nothing says LIVE.
test('empty trailing hour: NO POSTS kicker on the intro and the chapter-one card, never LIVE', async ({ page }) => {
    const errors = consoleErrors(page);
    await page.route('**/api/posts/aggregated-by-location*', async (route) => {
        const url = new URL(route.request().url());
        // The windowed (trailing-hour) query is empty; the unwindowed probe
        // still sees the fixture, so the page concludes 'none', not fallback.
        if (url.searchParams.has('from')) await route.fulfill({ json: [] });
        else await route.continue();
    });
    await gotoAndWaitForData(page);

    await expect(page.locator('#intro')).toHaveAttribute('data-mode', 'none');
    await expect(page.locator('#intro-kicker')).toHaveText('NO POSTS IN THE LAST HOUR');
    const state = await page.evaluate(() => (window as any).PulseStory.getState());
    expect(state).toMatchObject({ isDemo: false, dataMode: 'none' });
    await expectOverviewKicker(page, 'NO POSTS IN THE LAST HOUR');
    await expectNoLiveKicker(page);

    // The docked chapter-one card, as a reader sees it once the story starts.
    await scrollToProg(page, 0.3);
    const card0 = page.locator('#card-col .chapter-card').nth(0);
    await expect(card0).toBeVisible();
    await expect(card0.locator('.ch-kicker')).toHaveText('NO POSTS IN THE LAST HOUR');
    expectNoConsoleErrors(errors);
});
