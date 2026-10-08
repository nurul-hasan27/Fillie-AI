import { expect, test, PROFILE, runFillieOn, waitForResults } from './fixtures';
import type { Application } from '../../src/core/cloud/types';

/**
 * The heart on the page, "Interview prep" in the Database, and the guided tour, in the real extension.
 * (The tour stays out of automated browsers unless a test switches it on with `force`.)
 */
const TOUR = (state: Record<string, unknown>) => (window as unknown as { chrome: typeof chrome }).chrome.storage.local.set({ 'fillie:tour': state });

test.describe('hearts and Interview prep', () => {
  test('hearting an answer keeps it with the application, shows again next time, and is read in Interview prep', async ({ fillie }) => {
    await fillie.seedProfile(PROFILE);
    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    const panel = page.locator('[data-fillie-panel="true"]');
    const hearts = panel.locator('.heart-btn');
    await expect(hearts.first()).toBeVisible({ timeout: 20_000 });
    expect(await hearts.count()).toBeGreaterThan(2);
    const label = await hearts.first().getAttribute('aria-label');
    await hearts.first().click();
    await expect(hearts.first()).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator('.heart-speck').first()).toBeAttached(); // the little confetti burst
    await page.screenshot({ path: '/tmp/claude-501/ext-heart.png' });

    // It is stored with the application: the exact question and the exact answer.
    await expect
      .poll(async () => {
        const rows = (await fillie.sendToWorker<{ rows: Application[] }>({ type: 'fillie:apps-list', query: {} })).rows;
        return rows[0]?.savedAnswers?.length ?? 0;
      })
      .toBe(1);
    const [row] = (await fillie.sendToWorker<{ rows: Application[] }>({ type: 'fillie:apps-list', query: {} })).rows;
    const saved = row!.savedAnswers![0]!;
    expect(label).toContain(saved.question);
    expect(saved.answer.length).toBeGreaterThan(0);

    // Running Fillie again on the same page shows that heart already filled in.
    await page.reload();
    await runFillieOn(page, fillie);
    await waitForResults(page);
    await expect(panel.locator('.heart-btn[aria-pressed="true"]')).toHaveCount(1, { timeout: 20_000 });

    // Interview prep on the Database card.
    const app = await fillie.context.newPage();
    await app.goto(`chrome-extension://${fillie.extensionId}/pages/app.html#/database`);
    const prep = app.locator('.prep-btn').first();
    await expect(prep).toContainText('Interview prep');
    await expect(prep.locator('b')).toHaveText('1');
    await prep.click();
    const modal = app.locator('.prep-modal');
    await expect(modal).toBeVisible();
    const question = modal.locator('.prep-q').first();
    await expect(question).toContainText(saved.question);
    await expect(modal.locator('.prep-item[data-open="true"]')).toHaveCount(0);
    await question.click();
    await expect(modal.locator('.prep-item[data-open="true"] .prep-a')).toHaveText(saved.answer);
    await app.screenshot({ path: '/tmp/claude-501/ext-prep.png' });
    await question.click(); // closes again
    await expect(modal.locator('.prep-item[data-open="true"]')).toHaveCount(0);

    // Remove it: the card's count goes to zero.
    await question.click();
    await modal.locator('[data-action="remove-prep"]').click();
    await expect(modal.locator('.prep-empty')).toBeVisible();
    await modal.locator('.prep-close').click();
    await expect(app.locator('.prep-btn').first().locator('b')).toHaveText('0');
    const after = (await fillie.sendToWorker<{ rows: Application[] }>({ type: 'fillie:apps-list', query: {} })).rows[0]!;
    expect(after.savedAnswers).toEqual([]);
    await app.close();
  });

  test('explains the heart the first time and never again', async ({ fillie }) => {
    await fillie.control.evaluate(TOUR, { welcome: true, seen: {}, force: true });
    await fillie.seedProfile(PROFILE);
    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);
    const panel = page.locator('[data-fillie-panel="true"]');
    await expect(panel.locator('.heart-tip')).toContainText('Tap the heart', { timeout: 20_000 });
    await expect(panel.locator('.heart-nudge').first()).toBeVisible();
    await page.screenshot({ path: '/tmp/claude-501/ext-heart-tip.png' });
    await panel.locator('.heart-btn').first().click();
    await expect(panel.locator('.heart-tip')).toHaveCount(0);
    const seen = await fillie.control.evaluate(async () => (await chrome.storage.local.get('fillie:tour'))['fillie:tour']);
    expect(seen.seen.heart).toBe(true);

    await page.reload();
    await runFillieOn(page, fillie);
    await waitForResults(page);
    await expect(panel.locator('.heart-btn').first()).toBeVisible({ timeout: 20_000 });
    expect(await panel.locator('.heart-tip').count()).toBe(0);
  });
});

test.describe('the guided tour', () => {
  const open = async (fillie: Parameters<Parameters<typeof test>[2]>[0]['fillie'], hash = '#/profile/personal', query = '') => {
    const page = await fillie.context.newPage();
    await page.goto(`chrome-extension://${fillie.extensionId}/pages/app.html${query}${hash}`);
    return page;
  };

  test('a new user is walked through every part, with the page changing as it goes', async ({ fillie }) => {
    await fillie.control.evaluate(TOUR, { welcome: false, seen: {}, force: true });
    const page = await open(fillie);
    const card = page.locator('.ft-card');
    await expect(card.locator('.ft-title')).toHaveText('Hi, I’m Fillie!');
    await expect(card.locator('.ft-art svg')).toBeVisible();
    await page.screenshot({ path: '/tmp/claude-501/ext-tour-1.png' });

    const titles: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      titles.push(await card.locator('.ft-title').innerText());
      hashes.push(await page.evaluate(() => location.hash));
      if (i === 1) {
        // A step that points at something highlights it.
        await expect(page.locator('.ft-spot')).toHaveCSS('opacity', '1');
        await page.screenshot({ path: '/tmp/claude-501/ext-tour-2.png' });
      }
      if (i === 4) await expect(card.locator('.ft-keys kbd')).toHaveText(['Alt', 'Shift', 'F']);
      if (i === 5) {
        await expect(card.locator('.ft-heart')).toBeVisible();
        await page.screenshot({ path: '/tmp/claude-501/ext-tour-heart.png' });
      }
      const next = card.locator('.ft-primary');
      const label = await next.innerText();
      const before = titles[i]!;
      await next.click();
      if (label === 'Let’s go') break;
      // Some steps open another page first, so wait for the new step to appear.
      await expect(card.locator('.ft-title')).not.toHaveText(before);
    }
    expect(titles).toEqual([
      'Hi, I’m Fillie!', 'Tell me about you', 'One resume per role', 'Add a free AI key', 'Open any job form', 'Tap the heart',
      'Every form lands here', 'Never miss an interview', '3 free fills every week', 'You’re ready!',
    ]);
    expect(hashes[1]).toBe('#/profile/personal');
    expect(hashes[2]).toBe('#/resume');
    expect(hashes[3]).toBe('#/settings/ai');
    expect(hashes[6]).toBe('#/database');
    expect(hashes[8]).toBe('#/account');
    await expect(page.locator('.ft-root')).toHaveCount(0);
    await expect(page.locator('body > canvas')).toHaveCount(1); // the finishing confetti

    const state = await fillie.control.evaluate(async () => (await chrome.storage.local.get('fillie:tour'))['fillie:tour']);
    expect(state.welcome).toBe(true);
    expect(Object.keys(state.seen)).toEqual(expect.arrayContaining(['database', 'ai', 'account']));

    // It does not come back.
    await page.reload();
    await page.waitForTimeout(800);
    expect(await page.locator('.ft-root').count()).toBe(0);
    await page.close();
  });

  test('can be skipped at any step, with Escape or the button, and Back goes back', async ({ fillie }) => {
    await fillie.control.evaluate(TOUR, { welcome: false, seen: {}, force: true });
    const page = await open(fillie);
    const card = page.locator('.ft-card');
    await card.locator('.ft-primary').click();
    await expect(card.locator('.ft-title')).toHaveText('Tell me about you');
    await card.getByRole('button', { name: 'Back' }).click();
    await expect(card.locator('.ft-title')).toHaveText('Hi, I’m Fillie!');
    await card.locator('.ft-primary').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.ft-root')).toHaveCount(0);
    const state = await fillie.control.evaluate(async () => (await chrome.storage.local.get('fillie:tour'))['fillie:tour']);
    expect(state.welcome).toBe(true);
    await page.close();
  });

  test('"Take the tour" in the sidebar plays it again', async ({ fillie }) => {
    await fillie.control.evaluate(TOUR, { welcome: true, seen: Object.fromEntries(['profile', 'resume', 'ai', 'database', 'memory', 'account', 'privacy'].map((k) => [k, true])), force: true });
    const page = await open(fillie);
    await page.waitForTimeout(500);
    expect(await page.locator('.ft-root').count()).toBe(0);
    await page.getByRole('button', { name: 'Take the tour' }).click();
    await expect(page.locator('.ft-card .ft-title')).toHaveText('Hi, I’m Fillie!');
    await page.keyboard.press('Escape');
    await page.close();
  });

  test('after the tour, each section shows a short tip the first time, then never again', async ({ fillie }) => {
    await fillie.control.evaluate(TOUR, { welcome: true, seen: {}, force: true });
    const page = await open(fillie, '#/database');
    const tip = page.locator('.ft-root[data-tip="true"] .ft-card');
    await expect(tip.locator('.ft-title')).toHaveText('Your applications');
    await expect(tip.locator('.ft-art svg')).toBeVisible();
    await page.screenshot({ path: '/tmp/claude-501/ext-tip.png' });
    // A tip does not block the page.
    await expect(page.locator('.ft-dim')).toBeHidden();
    await tip.getByRole('button', { name: 'Got it' }).click();
    await expect(page.locator('.ft-root')).toHaveCount(0);

    await page.evaluate(() => (location.hash = '#/memory'));
    await expect(page.locator('.ft-card .ft-title')).toHaveText('What I remember');
    await page.keyboard.press('Escape');
    await page.evaluate(() => (location.hash = '#/database'));
    await page.waitForTimeout(500);
    expect(await page.locator('.ft-root').count()).toBe(0);
    await page.close();
  });

  test('never appears for automated browsers unless switched on', async ({ fillie }) => {
    const page = await open(fillie);
    await page.waitForTimeout(800);
    expect(await page.locator('.ft-root').count()).toBe(0);
    await page.close();
  });

  test('the popup points at its one button the first time', async ({ fillie }) => {
    await fillie.control.evaluate(TOUR, { welcome: true, seen: {}, force: true });
    await fillie.seedProfile(PROFILE);
    const popup = await fillie.context.newPage();
    await popup.setViewportSize({ width: 380, height: 620 });
    await popup.goto(`chrome-extension://${fillie.extensionId}/pages/popup.html`);
    const tip = popup.locator('.ft-root[data-tip="true"] .ft-card');
    await expect(tip.locator('.ft-title')).toHaveText('This is the button', { timeout: 20_000 });
    await expect(tip.locator('.ft-keys kbd')).toHaveText(['Alt', 'Shift', 'F']);
    await popup.screenshot({ path: '/tmp/claude-501/ext-popup-tip.png' });
    await tip.getByRole('button', { name: 'Got it' }).click();
    await popup.reload();
    await popup.waitForSelector('.pop-cta');
    await popup.waitForTimeout(600);
    expect(await popup.locator('.ft-root').count()).toBe(0);
  });
});
