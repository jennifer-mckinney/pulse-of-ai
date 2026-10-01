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
