import { PROFILE, expect, panel, runFillieOn, test, waitForResults } from './fixtures';

/**
 * The unknown-question workflow: Fillie asks a small number of real questions,
 * the user answers, Fillie drafts something grounded, the user approves it, and
 * the answer is written to the page. The user submits by hand.
 */
test.describe('unknown questions', () => {
  test('walks the user through a question and fills it once approved', async ({ fillie }) => {
    const page = await fillie.open('/unknown.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    const questions = await panel(page).locator('.task-q').allTextContents();
    expect(questions).toContain('Describe a situation where you showed leadership.');
    expect(questions).toContain('What would you say your greatest strength is, and why?');

    // Facts that were in the profile were filled without asking.
    await expect(page.locator('#name')).toHaveValue('Ada Lovelace');
    await expect(page.locator('#salary')).toHaveValue('£75,000');
    await expect(page.locator('#relocate')).toHaveValue('yes');

    // Open the story question.
    await panel(page).locator('.task', { hasText: 'showed leadership' }).click();
    const drawer = panel(page).locator('.drawer');
    await expect(drawer).toBeVisible();

    // The original question is shown verbatim, with an explanation.
    await expect(drawer.locator('.original-q')).toContainText('Describe a situation where you showed leadership.');
    await expect(drawer.locator('.notice')).toContainText(/detail/i);

    // Fillie offers the user's own projects and experiences as choices.
    const options = drawer.locator('.opt');
    expect(await options.count()).toBeGreaterThan(0);
    const labels = await options.allTextContents();
    expect(labels.join(' | ')).toMatch(/Trailhead|Meridian/i);

    // The draft button is disabled until the user answers.
    const draft = drawer.locator('[data-fillie-generate]');
    await expect(draft).toBeDisabled();

    await options.first().click();
    await expect(options.first()).toHaveAttribute('data-selected', 'true');
    await expect(draft).toBeEnabled();
    await draft.click();

    // A draft appears, with the facts it came from.
    const draftBox = drawer.locator('.draft');
    await expect(draftBox).toBeVisible({ timeout: 30_000 });
    await expect(drawer).toContainText('Based on');

    const accept = drawer.locator('[data-fillie-accept]');
    await expect(accept).toBeVisible();
    // Remembering is the user's decision, so it is ticked deliberately here.
    await panel(page).locator('.draft-remember').click();
    await accept.click();

    // The approved answer is written to the page and verified.
    await expect(page.locator('#leadership')).not.toHaveValue('', { timeout: 30_000 });

    // And remembered for next time (saved asynchronously after the fill).
    await expect
      .poll(async () => (await fillie.sendToWorker<unknown[]>({ type: 'fillie:get-memory' })).length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    // Nothing was submitted.
    expect(await page.evaluate(() => (window as never as { __fillieSubmitted?: boolean }).__fillieSubmitted)).toBeFalsy();
  });

  test('asks for a salary figure when the profile has none', async ({ fillie }) => {
    // Without a stored expectation Fillie must not invent one.
    await fillie.seedProfile({
      preferences: { ...PROFILE.preferences, salaryExpectation: '', noticePeriod: '', availability: '' },
    });

    const page = await fillie.open('/unknown.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    const salaryTask = panel(page).locator('.task', { hasText: 'salary expectations' });
    await expect(salaryTask).toHaveCount(1);
    await expect(page.locator('#salary')).toHaveValue('');

    await salaryTask.click();
    const drawer = panel(page).locator('.drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText(/never guesses pay|expected salary/i);

    const input = drawer.locator('[data-fillie-answer]');
    await input.fill('€82,000 plus equity');
    await drawer.locator('[data-fillie-generate]').click();
    // A figure the user typed is worth keeping for every other application.
    await panel(page).locator('.draft-remember').click();
    await drawer.locator('[data-fillie-accept]').click({ timeout: 30_000 });

    await expect(page.locator('#salary')).toHaveValue(/82,000/, { timeout: 30_000 });

    await expect
      .poll(async () => {
        const entries = await fillie.sendToWorker<Array<{ answer: string }>>({ type: 'fillie:get-memory' });
        return entries.map((entry) => entry.answer).join(' ');
      }, { timeout: 15_000 })
      .toContain('82,000');
  });

  test('asks before agreeing to anything on the user’s behalf', async ({ fillie }) => {
    await fillie.seedProfile({ preferences: { ...PROFILE.preferences, willingToRelocate: '' } });

    const page = await fillie.open('/unknown.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    await expect(page.locator('#relocate')).toHaveValue('');
    await panel(page).locator('.task', { hasText: 'willing to relocate' }).click();

    const drawer = panel(page).locator('.drawer');
    await drawer.locator('.opt', { hasText: 'Yes' }).click();
    await expect(drawer.locator('.opt', { hasText: 'Yes' })).toHaveAttribute('data-selected', 'true');

    await drawer.locator('[data-fillie-generate]').click();
    await drawer.locator('[data-fillie-accept]').click({ timeout: 30_000 });

    await expect(page.locator('#relocate')).toHaveValue('yes', { timeout: 30_000 });
  });

  test('skips a question on request', async ({ fillie }) => {
    const page = await fillie.open('/unknown.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    const before = await panel(page).locator('.task').count();
    expect(before).toBeGreaterThan(0);
    await panel(page).locator('.task').first().click();
    await panel(page).locator('.foot .btn-ghost').click();

    await expect(panel(page).locator('.task')).toHaveCount(before - 1, { timeout: 15_000 });
    // The skipped field was not written to.
    await expect(page.locator('#strength')).toHaveValue('');
  });

  test('writes an approved answer but only remembers it when asked', async ({ fillie }) => {
    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    await panel(page).locator('.task', { hasText: 'work here' }).click();
    const drawer = panel(page).locator('.drawer');
    await drawer.locator('.opt', { hasText: 'Meridian Analytics' }).first().click();
    await drawer.locator('[data-fillie-generate]').click();
    await expect(drawer.locator('.draft')).toBeVisible({ timeout: 30_000 });

    // A company-specific draft defaults to "this application only", so the box
    // starts off rather than quietly opting the user in.
    const remember = panel(page).locator('[data-fillie-remember]');
    await expect(remember).not.toBeChecked();
    await expect(panel(page).locator('.draft-remember .ff-body')).toContainText('this application only');

    await drawer.locator('[data-fillie-accept]').click();

    // The answer is written to the page either way…
    await expect(page.locator('#cover')).not.toHaveValue('', { timeout: 30_000 });
    // …but opting out means nothing was stored.
    await expect
      .poll(async () => (await fillie.sendToWorker<unknown[]>({ type: 'fillie:get-memory' })).length, { timeout: 15_000 })
      .toBe(0);
  });

  test('counts a reuse so the Memory list shows which answers earn their keep', async ({ fillie }) => {
    const first = await fillie.open('/unknown.html');
    await runFillieOn(first, fillie);
    await waitForResults(first);

    await panel(first).locator('.task', { hasText: 'showed leadership' }).click();
    let drawer = panel(first).locator('.drawer');
    await drawer.locator('.opt').first().click();
    await drawer.locator('[data-fillie-generate]').click();
    await panel(first).locator('.draft-remember').click();
    await drawer.locator('[data-fillie-accept]').click({ timeout: 30_000 });
    await expect(first.locator('#leadership')).not.toHaveValue('', { timeout: 30_000 });

    await expect
      .poll(async () => {
        const entries = await fillie.sendToWorker<Array<{ useCount: number }>>({ type: 'fillie:get-memory' });
        return entries.length;
      }, { timeout: 15_000 })
      .toBeGreaterThan(0);

    // A second form with the same question reuses it, and the counter moves.
    const second = await fillie.open('/unknown.html');
    await runFillieOn(second, fillie);
    await waitForResults(second);

    await expect
      .poll(async () => {
        const entries = await fillie.sendToWorker<Array<{ useCount: number }>>({ type: 'fillie:get-memory' });
        return Math.max(...entries.map((entry) => entry.useCount));
      }, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);
  });

  test('reuses an approved answer for a similar question later', async ({ fillie }) => {
    const first = await fillie.open('/unknown.html');
    await runFillieOn(first, fillie);
    await waitForResults(first);

    await panel(first).locator('.task', { hasText: 'showed leadership' }).click();
    let drawer = panel(first).locator('.drawer');
    await drawer.locator('.opt').first().click();
    const textInputs = drawer.locator('[data-fillie-answer]');
    if (await textInputs.count()) {
      await textInputs.last().fill('I led the routing team of four and we shipped the offline map.');
    }
    await drawer.locator('[data-fillie-generate]').click();
    await panel(first).locator('.draft-remember').click();
    await drawer.locator('[data-fillie-accept]').click({ timeout: 30_000 });
    await expect(first.locator('#leadership')).not.toHaveValue('', { timeout: 30_000 });

    await expect
      .poll(async () => {
        const entries = await fillie.sendToWorker<Array<{ question: string }>>({ type: 'fillie:get-memory' });
        return entries.some((entry) => /leadership/i.test(entry.question));
      }, { timeout: 15_000 })
      .toBe(true);

    // A later form asks a semantically similar question; the memory is reused
    // rather than the user being asked again.
    const second = await fillie.open('/unknown.html');
    await runFillieOn(second, fillie);
    await waitForResults(second);

    const rows = panel(second).locator('.review-row', { hasText: 'leadership' });
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    await expect(rows).toContainText(/Meridian|Trace|offline|lead/i);
  });
});