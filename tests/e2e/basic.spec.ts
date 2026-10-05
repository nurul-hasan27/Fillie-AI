import { expect, panel, runFillieOn, test, waitForResults } from './fixtures';

/**
 * End-to-end on a realistic application form, using the offline engine so the
 * test is hermetic. Nothing here may ever submit.
 */
test.describe('basic form', () => {
  test('fills every question the profile can answer, and never submits', async ({ fillie }) => {
    const page = await fillie.open('/basic.html');

    await runFillieOn(page, fillie);
    await waitForResults(page);

    // Contact and identity
    await expect(page.locator('#full-name')).toHaveValue('Ada Lovelace');
    await expect(page.locator('#email')).toHaveValue('ada@example.com');
    await expect(page.locator('#phone')).toHaveValue('+44 20 7946 0000');
    await expect(page.locator('#location')).toHaveValue('London, United Kingdom');
    await expect(page.locator('#dob')).toHaveValue('1999-12-10');

    // Education
    await expect(page.locator('#university')).toHaveValue('University of London');
    await expect(page.locator('#degree')).toHaveValue('bsc');
    await expect(page.locator('#cgpa')).toHaveValue('8.6');
    await expect(page.locator('#grad-year')).toHaveValue('2021');
    await expect(page.locator('#years')).toHaveValue('0.5');

    // Choice controls
    await expect(page.locator('#mode-hybrid')).toBeChecked();
    await expect(page.locator('#mode-remote')).not.toBeChecked();
    await expect(page.locator('#skill-python')).toBeChecked();
    await expect(page.locator('#skill-go')).toBeChecked();
    await expect(page.locator('#skill-k8s')).not.toBeChecked();

    // Links
    await expect(page.locator('#linkedin')).toHaveValue('https://linkedin.com/in/ada');
    await expect(page.locator('#github')).toHaveValue('https://github.com/ada');

    // Open-ended questions are queued for the user, never guessed.
    await expect(page.locator('#cover')).toHaveValue('');

    // The hard requirement.
    expect(await page.evaluate(() => (window as never as { __fillieSubmitted?: boolean }).__fillieSubmitted)).toBeFalsy();
    await expect(page.locator('#result')).toBeHidden();
  });

  test('shows a task inbox for what it could not answer', async ({ fillie }) => {
    const page = await fillie.open('/basic.html');

    await runFillieOn(page, fillie);
    await waitForResults(page);

    await expect(panel(page).locator('.inbox-title')).toHaveText('Needs your attention', { timeout: 30_000 });
    const tasks = panel(page).locator('.task');
    await expect(tasks).toHaveCount(2);

    const questions = await panel(page).locator('.task-q').allTextContents();
    expect(questions).toContain('Why do you want to work here?');
    // Consent is a decision, so Fillie asks rather than ticking it.
    expect(questions.join(' ')).toMatch(/privacy policy/i);

    // A consent box is never auto-ticked.
    await expect(page.locator('#consent')).not.toBeChecked();
  });

  test('reports what it filled and what is left', async ({ fillie }) => {
    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    const stats = panel(page).locator('.stat');
    await expect(stats.nth(0)).toContainText('14');
    await expect(stats.nth(1)).toContainText('2');
    await expect(stats.nth(2)).toContainText('16');

    // Every filled row is individually listed.
    const rows = panel(page).locator('.review-row');
    expect(await rows.count()).toBeGreaterThanOrEqual(12);
    await expect(panel(page)).toContainText('Fillie never submits forms');
  });

  test('says so plainly on a page with no form', async ({ fillie }) => {
    const page = await fillie.open('/empty.html');

    await runFillieOn(page, fillie);
    await waitForResults(page);

    const notice = panel(page).locator('.notice');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText(/could not find any question fields/i);
    await expect(panel(page).locator('[data-fillie-action="fill"]')).toHaveCount(0);
  });

  test('lets the user close the panel', async ({ fillie }) => {
    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    await panel(page).locator('button[aria-label="Close Fillie"]').click();
    await expect(panel(page)).toHaveCount(0);
  });
});