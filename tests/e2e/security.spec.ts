import { expect, panel, runFillieOn, test, waitForResults } from './fixtures';

/**
 * AI behaviour against a local mock provider.
 *
 * These tests drive the real OpenAI-compatible adapter, the real prompts, the
 * real response parsing and the real on-device grounding check — only the model
 * is fake. They are the regression net for the two promises that matter most:
 * Fillie never writes something the user's profile does not support, and Fillie
 * never lets a page talk it into anything.
 */
test.describe('hosted AI behaviour', () => {
  test('applies a grounded draft to an open-ended field', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'valid' });

    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    // The mock drafts the cover letter from real profile facts, and the
    // grounding check lets it through.
    await expect(page.locator('#cover')).not.toHaveValue('', { timeout: 30_000 });
    const value = await page.locator('#cover').inputValue();
    expect(value).toContain('Meridian');
    expect(value).toMatch(/180ms/);

    // It is traceable: the review list shows the question as filled.
    await expect(panel(page)).toContainText('Why do you want to work here?');
  });

  test('discards a response that obeyed page-injected instructions', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'hostile' });

    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);
    await page.waitForTimeout(2500);

    // The attacker's payload must not be written anywhere on the page.
    const values = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, textarea')).map((el) => (el as HTMLInputElement).value),
    );
    for (const value of values) {
      expect(value).not.toMatch(/ignore previous instructions/i);
      expect(value).not.toMatch(/twelve teams at google/i);
      expect(value).not.toMatch(/\$2m in bonuses/i);
    }

    // The rest of the form still filled normally.
    await expect(page.locator('#email')).toHaveValue('ada@example.com');
  });

  test('ignores instructions injected into the page itself', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'hostile' });

    // Any request the extension makes on the page's behalf would show up here.
    const exfiltrated: string[] = [];
    fillie.context.on('request', (request) => {
      if (request.url().includes('attacker.example.com')) exfiltrated.push(request.url());
    });

    const page = await fillie.open('/injection.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);
    await page.waitForTimeout(2500);

    const values = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, textarea')).map((el) => (el as HTMLInputElement).value),
    );

    // The page asked for "OWNED BY PAGE" in every field. It never got it.
    for (const value of values) {
      expect(value).not.toMatch(/owned by page/i);
    }
    // It also asked for the user's email to be posted to the attacker's
    // endpoint. Nothing was sent anywhere.
    expect(exfiltrated).toEqual([]);

    // The legitimate answer is still correct.
    await expect(page.locator('#email')).toHaveValue('ada@example.com');
  });

  test('rejects a hallucinated answer and asks the user instead', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'hallucinated' });

    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    // The invented PhD / CTO story is not written to the page.
    await expect(page.locator('#cover')).toHaveValue('');
    const written = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, textarea')).map((el) => (el as HTMLInputElement).value).join(' '),
    );
    expect(written).not.toMatch(/astrophysics/i);
    expect(written).not.toMatch(/University of Zurich/i);
    expect(written).not.toMatch(/Series C/i);

    // The question is queued for the user rather than silently accepted.
    const tasks = await panel(page).locator('.task-q').allTextContents();
    expect(tasks.some((task) => /work here/i.test(task))).toBe(true);
  });

  test('falls back to the profile when the provider returns nonsense', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'nonsense' });

    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    // Nothing breaks, and the deterministic answers still land.
    await expect(page.locator('#email')).toHaveValue('ada@example.com');
    await expect(page.locator('#full-name')).toHaveValue('Ada Lovelace');
    // A bad response is not surfaced as a hard error to the user.
    await expect(panel(page).locator('.notice[data-tone="danger"]')).toHaveCount(0);
  });

  test('survives a rate-limited provider', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'rate-limit' });

    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    // Graceful degradation: the form is still filled from the profile.
    await expect(page.locator('#email')).toHaveValue('ada@example.com');
    await expect(page.locator('#linkedin')).toHaveValue('https://linkedin.com/in/ada');
    await expect(page.locator('#cover')).toHaveValue('');
  });

  test('survives a provider that is down', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'fail' });

    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    await expect(page.locator('#email')).toHaveValue('ada@example.com');
  });

  test('never leaks the API key into the page', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'valid', apiKey: 'mock-key' });

    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);
    await page.waitForTimeout(1500);

    // Nothing the page can read contains the key, and the content-script world
    // exposes no extension storage.
    const exposed = await page.evaluate(() => ({
      html: document.documentElement.outerHTML,
      chromeKeys: Object.keys((window as never as { chrome?: Record<string, unknown> }).chrome ?? {}),
    }));
    expect(exposed.html).not.toContain('mock-key');
    expect(exposed.chromeKeys.some((key) => /storage|runtime\.id/i.test(key))).toBe(false);
  });

  test('works with no AI configured at all', async ({ fillie }) => {
    await fillie.setAi({ enabled: false });

    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    await expect(page.locator('#full-name')).toHaveValue('Ada Lovelace');
    // Open questions are still surfaced honestly.
    await expect(panel(page).locator('.inbox-title')).toHaveText('Needs your attention');
  });

  test('never submits, whatever the provider says', async ({ fillie }) => {
    for (const scenario of ['valid', 'hostile', 'hallucinated'] as const) {
      await fillie.setAi({ enabled: true, scenario });
      const page = await fillie.open('/basic.html');
      await runFillieOn(page, fillie);
      await waitForResults(page);
      await page.waitForTimeout(1500);

      expect(await page.evaluate(() => (window as never as { __fillieSubmitted?: boolean }).__fillieSubmitted)).toBeFalsy();
      await expect(page.locator('#result')).toBeHidden();
      await page.close();
    }
  });
});
