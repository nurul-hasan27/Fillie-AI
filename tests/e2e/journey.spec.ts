import { expect, panel, runFillieOn, test, waitForResults } from './fixtures';

/**
 * One continuous pass through the whole product, in the order a person would do
 * it: set up a profile, run Fillie on a real application form, answer what it
 * could not, approve a draft, submit by hand, and confirm nothing was submitted
 * on Fillie's behalf.
 *
 * The other suites each test one area. This one exists to catch the case where
 * every area passes alone but the journey between them does not hold together.
 */
test.describe('the whole journey', () => {
  test('profile → fill → answer → approve → user submits', async ({ fillie }) => {
    /* 1. Start from a profile the user built themselves. */
    await fillie.control.goto(`chrome-extension://${fillie.extensionId}/pages/app.html#/profile/personal`);
    await fillie.control.reload();
    await fillie.control.waitForSelector('input[name="personal.fullName"]');

    await fillie.control.fill('input[name="personal.fullName"]', 'Ada Lovelace');
    await fillie.control.fill('input[name="personal.email"]', 'ada@example.com');
    await fillie.control.click('[data-action="save-now"]');
    await expect(fillie.control.locator('.saved-flag')).toBeVisible({ timeout: 20_000 });

    /* 2. Open an application form and run Fillie on it. */
    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    // The deterministic layer filled what the profile supports.
    await expect(page.locator('#email')).toHaveValue('ada@example.com');
    await expect(page.locator('#full-name')).toHaveValue('Ada Lovelace');
    await expect(page.locator('#linkedin')).toHaveValue('https://linkedin.com/in/ada');

    /* 3. The panel reports honestly: what it filled, and what it did not. */
    const stats = panel(page).locator('.stat');
    await expect(stats.nth(0)).toContainText('14');
    await expect(stats.nth(1)).toContainText('2');
    await expect(stats.nth(2)).toContainText('16');

    // Every field Fillie touched is individually listed and verifiable, which is
    // what makes "14 filled" checkable rather than a claim. The list is already
    // on screen under "Filled automatically".
    const rows = panel(page).locator('.review-row');
    expect(await rows.count()).toBeGreaterThanOrEqual(12);
    await expect(panel(page)).toContainText('Filled automatically');

    // Open questions are not guessed.
    await expect(page.locator('#cover')).toHaveValue('');
    // A consent box is never ticked on the user's behalf.
    await expect(page.locator('#consent')).not.toBeChecked();

    /* 4. The user answers the one open question by hand. */
    const tasks = panel(page).locator('.task-q');
    expect((await tasks.allTextContents()).join(' ')).toMatch(/work here/i);
    await panel(page).locator('.task', { hasText: 'work here' }).click();

    const drawer = panel(page).locator('.drawer');
    await expect(drawer).toBeVisible();

    // Fillie offers the user's own experience as the basis for the answer.
    const options = drawer.locator('.opt');
    expect(await options.count()).toBeGreaterThan(0);
    await options.filter({ hasText: 'Meridian Analytics' }).first().click();
    await expect(options.filter({ hasText: 'Meridian Analytics' }).first()).toHaveAttribute('data-selected', 'true');

    /* 5. Fillie drafts from what the user chose, and the user approves it. */
    await drawer.locator('[data-fillie-generate]').click();
    await expect(drawer.locator('.draft')).toBeVisible({ timeout: 30_000 });
    await expect(drawer).toContainText('Based on');

    const draft = await drawer.locator('.draft').innerText();
    expect(draft).toMatch(/Meridian/i);
    // With no AI configured, the panel says so rather than implying the model
    // wrote it.
    expect(draft).toMatch(/AI provider was unavailable|nothing was improvised/i);

    // The user decides to keep it for next time.
    await panel(page).locator('.draft-remember').click();
    await drawer.locator('[data-fillie-accept]').click();

    /* 6. The approved answer is written and verified. */
    await expect(page.locator('#cover')).not.toHaveValue('', { timeout: 30_000 });

    // A textarea is read back with inputValue(), not textContent(). The draft is
    // built from the experience the user picked, so it is the user's own words.
    const written = await page.locator('#cover').inputValue();
    expect(written).toMatch(/ingestion API/i);
    expect(written).toMatch(/900ms to 180ms/i);

    /* 7. The answer is remembered for next time. */
    await expect
      .poll(async () => {
        const memory = await fillie.sendToWorker<Array<{ answer: string }>>({ type: 'fillie:get-memory' });
        return memory.length;
      }, { timeout: 20_000 })
      .toBeGreaterThan(0);

    /* 8. The user is still the one who submits. */
    expect(await page.evaluate(() => (window as never as { __fillieSubmitted?: boolean }).__fillieSubmitted)).toBeFalsy();
    await expect(page.locator('#result')).toBeHidden();
    await expect(panel(page).locator('.manual-note', { hasText: 'never submits' })).toBeVisible();

    // Only once the user presses the button does the page do anything.
    await page.locator('#submit').click();
    await expect(page.locator('#result')).toBeVisible();
    expect(await page.evaluate(() => (window as never as { __fillieSubmitted?: boolean }).__fillieSubmitted)).toBe(true);
  });
});
