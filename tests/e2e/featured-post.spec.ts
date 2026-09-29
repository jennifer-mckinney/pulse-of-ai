// Featured-post beats — CH03 (negativity) and CH04 (positivity) embed a
// mini-post receipt teaser with the "Why does it say that? →" button;
// clicking it opens the audit drawer. Live data path (POST /api/query on
// the beat's highlight city).
import { test, expect } from '@playwright/test';
import {
    consoleErrors, expectNoConsoleErrors, gotoAndWaitForData,
    scrollToBeat, stabilizeSnapshot, evidence,
} from './helpers';

const NEGATIVITY = 3;
const POSITIVITY = 4;

test('featured posts: mini-post on CH03/CH04, trace button opens the audit drawer', async ({ page }) => {
    const errors = consoleErrors(page);
    // Unwindowed snapshot: the featured-post block renders only when the
    // beat's highlight city clears the MIN_TOTAL eligibility guard — see
    // stabilizeSnapshot's docstring.
    await stabilizeSnapshot(page);
    await gotoAndWaitForData(page);

    const cards = page.locator('#card-col .chapter-card');

    for (const beat of [NEGATIVITY, POSITIVITY]) {
        await scrollToBeat(page, beat);
        const card = cards.nth(beat);
        await expect(card).toBeVisible();
        // The teaser loads async from POST /api/query — wait for it.
        const mini = card.locator('.mini-post');
        await expect(mini, `beat ${beat} mini-post`).toBeVisible({ timeout: 15000 });
        await expect(mini.locator('.mini-post-text')).not.toBeEmpty();
        await expect(mini.locator('.score-pill')).toHaveCount(1);
        await expect(mini.locator('.btn-trace')).toHaveText('Why does it say that? →');
    }

    await evidence(page, '03-featured-post-ch04');

    // Clicking the trace button opens the audit drawer with the receipt.
    await scrollToBeat(page, POSITIVITY);
    await cards.nth(POSITIVITY).locator('.btn-trace').click();
    const drawer = page.locator('#audit-drawer');
    await expect(drawer).toHaveClass(/open/);
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');
    await expect(drawer.locator('.drawer-kicker')).toContainText('AUDIT TRAIL');
    await expect(drawer.locator('.drawer-title')).toHaveText('Why does it say that?');

    expectNoConsoleErrors(errors);
});
