// Shared helpers for the Pulse of AI E2E specs.
//
// Every spec collects console errors via trackConsole() and asserts the run
// stayed clean (expectNoConsoleErrors) — a rendering path that logs errors
// is a failure even when the DOM assertions pass.
//
// Story math constants mirror public/js/story.js / design.config.js:
//   pacing 1.15 vh/beat, 11 beats, explore threshold prog > N − 1.45.
import { Page, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export const BEATS = 11;
export const PACING = 1.15;               // GLOBE.pacingVhPerChapter
export const EVIDENCE_DIR = path.join(__dirname, '..', '..', 'docs', 'evidence', 'e2e');

// ── Console-error tracking ──────────────────────────────────────────────────

// consoleErrors: attach BEFORE page.goto. Collects console.error output and
// uncaught page errors into the returned (live) array. The favicon 404 is
// browser noise (the page ships no favicon link) and is always ignored;
// specs that deliberately block requests pass extra allow patterns
// (e.g. /Failed to load resource/ when /api/** is aborted on purpose).
export function consoleErrors(page: Page, allow: RegExp[] = []): string[] {
    const errors: string[] = [];
    const allowAll = [/favicon\.ico/].concat(allow);
    page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        const url = msg.location() ? msg.location().url : '';
        const line = text + (url ? ' [' + url + ']' : '');
        if (allowAll.some((re) => re.test(line))) return;
        errors.push(line);
    });
    page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
    return errors;
}

export function expectNoConsoleErrors(errors: string[]) {
    expect(errors, 'console must stay clean:\n' + errors.join('\n')).toEqual([]);
}

// ── Snapshot stabilization ──────────────────────────────────────────────────

// stabilizeSnapshot: strip the `from=` trailing-hour window off the
// aggregated snapshot request, so the page renders the FULL seeded dataset
// instead of whatever happens to fall in the last hour.
//
// Why: the dev seed's posts age out of the trailing-hour window, and once a
// city's windowed total drops below the resolver's MIN_TOTAL (5) guard the
// sentiment-ranked beats legitimately suppress their highlights + featured
// posts (audit G13/G14 — by design, not a bug). Specs that assert the RICH
// experience (featured posts, theme legends, ribbon categories) would decay
// with the seed's age; unwindowed data is stable forever. The truthfulness
// spec deliberately does NOT use this helper — it asserts the window.
export async function stabilizeSnapshot(page: Page) {
    await page.route('**/api/posts/aggregated-by-location*', async (route) => {
        const url = new URL(route.request().url());
        url.searchParams.delete('from');
        const response = await route.fetch({ url: url.toString() });
        await route.fulfill({ response });
    });
}

// ── Page lifecycle ──────────────────────────────────────────────────────────

// gotoAndWaitForData: open the page and wait until the story has a city
// snapshot (live or demo) and the globe module is mounted.
export async function gotoAndWaitForData(page: Page) {
    await page.goto('/');
    await page.waitForFunction(() => {
        const w = window as any;
        return w.PulseStory && w.PulseGlobe && w.PulseGlobe.getInstance()
            && w.PulseStory.getCities().length > 0;
    }, undefined, { timeout: 20000 });
}

// scrollToProg: set scroll so the story progress lands on `prog` beats
// (fractional allowed), then wait for the scroll handler to apply it.
export async function scrollToProg(page: Page, prog: number) {
    await page.evaluate(({ p, pacing }) => {
        window.scrollTo({ top: p * pacing * window.innerHeight, behavior: 'auto' });
    }, { p: prog, pacing: PACING });
    await page.waitForFunction((p) => {
        const s = (window as any).PulseStory.getState();
        return Math.abs(s.prog - p) < 0.02;
    }, prog, { timeout: 5000 });
    // One extra frame so card styles / globe state settle after apply().
    await page.waitForTimeout(100);
}

export async function scrollToBeat(page: Page, index: number) {
    await scrollToProg(page, index);
}

// enterExplore: jump to the final beat and wait for explore chrome.
export async function enterExplore(page: Page) {
    await scrollToProg(page, BEATS - 1);
    await page.waitForFunction(() => (window as any).PulseStory.getState().exploring === true);
    await expect(page.locator('#explore')).toBeVisible();
    await page.waitForFunction(() =>
        (document.getElementById('exp-filters') as HTMLElement).childElementCount > 0);
}

// ── Globe geometry (deterministic city → screen projection) ────────────────

// projectCity: compute the current screen position of a city marker using
// the module's own exported math. Assumes the view has CONVERGED on a focus
// at the city's own lat/lon with the given zoom (the caller sets
// setState({focus, zoom}) and waits), and corrects for the ±7° focus-drift
// term at the moment of evaluation (drift is 0 under reduced motion).
export async function projectCity(
    page: Page, city: { lat: number; lng: number }, zoom: number,
): Promise<{ x: number; y: number }> {
    return page.evaluate(({ lat, lon, z }) => {
        const w = window as any;
        const m = w.PulseGlobe.math;
        const canvas = w.PulseGlobe.getInstance().canvas as HTMLCanvasElement;
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const drift = reduced ? 0
            : Math.sin(performance.now() / 9000) * 7 * m.D2R;
        const phi0 = Math.max(-50, Math.min(50, lat * 0.75)) * m.D2R;
        const view = {
            lam: lon * m.D2R + drift,
            sinP0: Math.sin(phi0),
            cosP0: Math.cos(phi0),
            R: m.sphereRadius(W, H, z),
            cx: W * 0.5,
            cy: H * 0.5,
        };
        const pt = m.project(lat * m.D2R, lon * m.D2R, view);
        const rect = canvas.getBoundingClientRect();
        return { x: rect.left + pt[0], y: rect.top + pt[1] };
    }, { lat: city.lat, lon: city.lng, z: zoom });
}

// focusCity: pin the interactive globe on a city and give easing time to
// converge (EASE 0.055/frame ⇒ ~99% in ~1.5 s at 60 fps).
export async function focusCity(
    page: Page, city: { lat: number; lng: number }, zoom: number,
) {
    await page.evaluate(({ lat, lon, z }) => {
        (window as any).PulseGlobe.getInstance().setState({
            focus: { lat, lon }, zoom: z,
        });
    }, { lat: city.lat, lon: city.lng, z: zoom });
    await page.waitForTimeout(2200);
}

// pickCity: a live normalized city row (highest volume first — its marker is
// big, so hit-testing is forgiving).
export async function pickCity(page: Page): Promise<{ city: string; lat: number; lng: number; total: number }> {
    return page.evaluate(() => {
        const cities = (window as any).PulseStory.getCities()
            .filter((c: any) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
        cities.sort((a: any, b: any) => b.total - a.total);
        const c = cities[0];
        return { city: c.city, lat: c.lat, lng: c.lng, total: c.total };
    });
}

// ── Evidence screenshots ────────────────────────────────────────────────────

export async function evidence(page: Page, name: string) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
        path: path.join(EVIDENCE_DIR, name + '.png'),
        fullPage: false,
    });
}
