import { MOCK_AI, PROFILE, expect, runFillieOn, test, waitForResults, type Fixtures } from './fixtures';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/**
 * The Fillie app tab: profile editing, autosave, resume import, memory editing
 * and the settings screens. These drive the real UI in the real extension page.
 */
const RESUMES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'resumes');

async function seedMinimal(fillie: Fixtures): Promise<void> {
  await fillie.sendToWorker({ type: 'fillie:save-profile', profile: { version: 1, updatedAt: 0 } });
  await fillie.sendToWorker({ type: 'fillie:save-memory', memory: [] });
}

/**
 * Opens the app tab at a route. A hash-only `goto` does not reload the
 * document, and the app reads storage once at boot, so an explicit reload is
 * what makes a fresh read of storage happen.
 */
async function openApp(fillie: Fixtures, hash: string): Promise<void> {
  await fillie.control.goto(`chrome-extension://${fillie.extensionId}/pages/app.html${hash}`);
  await fillie.control.reload();
  await fillie.control.waitForSelector('.app', { timeout: 20_000 });
}

test.describe('profile tab', () => {
  test('edits a field and persists it to extension storage', async ({ fillie }) => {
    await seedMinimal(fillie);
    await openApp(fillie, '#/profile/personal');

    await fillie.control.fill('input[name="personal.fullName"]', 'Grace Hopper');
    await fillie.control.fill('input[name="personal.email"]', 'grace@example.com');
    // The topbar Save button is the explicit path; autosave also runs.
    await fillie.control.click('[data-action="save-now"]');
    await expect(fillie.control.locator('.saved-flag')).toBeVisible({ timeout: 15_000 });

    const stored = await fillie.sendToWorker<{ personal: { fullName: string; email: string } }>({
      type: 'fillie:get-profile',
    });
    expect(stored.personal.fullName).toBe('Grace Hopper');
    expect(stored.personal.email).toBe('grace@example.com');
  });

  test('saves a profile written by a background worker', async ({ fillie }) => {
    await seedMinimal(fillie);
    await fillie.sendToWorker({
      type: 'fillie:save-profile',
      profile: {
        version: 1,
        updatedAt: 0,
        education: { university: 'University of London', degree: 'BSc', coursework: ['Databases'] },
      },
    });

    // A hash-only goto would not reload the document, so the app would keep the
    // profile it read at boot. Reload to exercise the real cold start.
    await openApp(fillie, '#/profile/education');
    await expect(fillie.control.locator('input[name="education.university"]')).toHaveValue('University of London');
    await expect(fillie.control.locator('input[name="education.degree"]')).toHaveValue('BSc');
  });

  test('persists experience repeater items including long multi-line responsibilities across reload', async ({ fillie }) => {
    await seedMinimal(fillie);
    await openApp(fillie, '#/profile/experience');

    await fillie.control.click('[data-action="add-experience"]');
    await expect(fillie.control.locator('.repeater-item')).toHaveCount(1);

    await fillie.control.fill('.repeater-item input[name="role"]', 'Full Stack Developer');
    await fillie.control.fill('.repeater-item input[name="organisation"]', 'Stripe');
    const responsibilitiesText = 'Designed, built, and launched payment APIs.\nImproved database query performance by 40%, reducing latency.\nMentored 3 junior developers; led weekly architectural syncs.';
    await fillie.control.fill('.repeater-item textarea[name="responsibilities"]', responsibilitiesText);
    await fillie.control.fill('.repeater-item textarea[name="achievements"]', 'Recognized as Top Performer for Q3\nShipped MVP ahead of deadline');

    await fillie.control.click('[data-action="save-now"]');
    await expect(fillie.control.locator('.saved-flag')).toBeVisible({ timeout: 15_000 });

    // Verify it saved to extension storage:
    const stored = await fillie.sendToWorker<{ experience: Array<{ role: string; organisation: string; responsibilities: string[]; achievements: string[] }> }>({
      type: 'fillie:get-profile',
    });
    expect(stored.experience).toHaveLength(1);
    expect(stored.experience[0].role).toBe('Full Stack Developer');
    expect(stored.experience[0].organisation).toBe('Stripe');
    expect(stored.experience[0].responsibilities).toEqual([
      'Designed, built, and launched payment APIs.',
      'Improved database query performance by 40%, reducing latency.',
      'Mentored 3 junior developers; led weekly architectural syncs.',
    ]);
    expect(stored.experience[0].achievements).toEqual([
      'Recognized as Top Performer for Q3',
      'Shipped MVP ahead of deadline',
    ]);

    // Reload the app page completely and verify the fields populate from storage:
    await openApp(fillie, '#/profile/experience');
    await expect(fillie.control.locator('.repeater-item input[name="role"]')).toHaveValue('Full Stack Developer');
    await expect(fillie.control.locator('.repeater-item input[name="organisation"]')).toHaveValue('Stripe');
    await expect(fillie.control.locator('.repeater-item textarea[name="responsibilities"]')).toHaveValue(responsibilitiesText);
  });

  test('configures 10th, 12th and additional schools in education section', async ({ fillie }) => {
    await seedMinimal(fillie);
    await openApp(fillie, '#/profile/education');

    await fillie.control.fill('input[name="education.twelfthSchool"]', 'Delhi Public School');
    await fillie.control.fill('input[name="education.twelfthBoard"]', 'CBSE');
    await fillie.control.fill('input[name="education.twelfthStream"]', 'Science');
    await fillie.control.fill('input[name="education.twelfthYear"]', '2022');
    await fillie.control.fill('input[name="education.twelfthPercentage"]', '88%');

    await fillie.control.fill('input[name="education.tenthSchool"]', 'St. Xavier High School');
    await fillie.control.fill('input[name="education.tenthBoard"]', 'ICSE');
    await fillie.control.fill('input[name="education.tenthYear"]', '2020');
    await fillie.control.fill('input[name="education.tenthPercentage"]', '92%');

    // Add another school:
    await fillie.control.click('[data-action="add-school"]');
    await expect(fillie.control.locator('[data-repeater="schools"] .repeater-item')).toHaveCount(1);
    await fillie.control.fill('[data-repeater="schools"] .repeater-item input[name="schoolName"]', 'Primary Academy');
    await fillie.control.fill('[data-repeater="schools"] .repeater-item input[name="level"]', 'Middle School');

    await fillie.control.click('[data-action="save-now"]');
    await expect(fillie.control.locator('.saved-flag')).toBeVisible({ timeout: 15_000 });

    const stored = await fillie.sendToWorker<{ education: Record<string, any> }>({
      type: 'fillie:get-profile',
    });
    expect(stored.education.twelfthSchool).toBe('Delhi Public School');
    expect(stored.education.twelfthBoard).toBe('CBSE');
    expect(stored.education.twelfthStream).toBe('Science');
    expect(stored.education.tenthSchool).toBe('St. Xavier High School');
    expect(stored.education.tenthBoard).toBe('ICSE');
    expect(stored.education.schools).toHaveLength(1);
    expect(stored.education.schools[0].schoolName).toBe('Primary Academy');

    // Reload page and verify all fields populate:
    await openApp(fillie, '#/profile/education');
    await expect(fillie.control.locator('input[name="education.twelfthSchool"]')).toHaveValue('Delhi Public School');
    await expect(fillie.control.locator('input[name="education.tenthSchool"]')).toHaveValue('St. Xavier High School');
    await expect(fillie.control.locator('[data-repeater="schools"] .repeater-item input[name="schoolName"]')).toHaveValue('Primary Academy');
  });

  test('shows profile completeness in the sidebar', async ({ fillie }) => {
    await seedMinimal(fillie);
    await openApp(fillie, '#/profile/personal');
    await expect(fillie.control.locator('.side-foot .ff-meta').first()).toContainText('%');
  });

  test('shows real usage counters on the Advanced screen', async ({ fillie }) => {
    await openApp(fillie, '#/settings/advanced');
    const advanced = fillie.control.locator('body');
    await expect(advanced).toContainText('Version', { timeout: 20_000 });
    await expect(advanced).toContainText('Sessions run');

    // Counters are zero on a fresh install.
    await expect(advanced).toContainText(/Sessions run\s*0/, { timeout: 20_000 });

    // A session on a real form moves them.
    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);
    await expect(page.locator('#email')).toHaveValue('ada@example.com', { timeout: 30_000 });

    // The counter is read from storage each time the screen is opened, so a
    // reload is enough — the values were never going to be live-bound.
    await openApp(fillie, '#/settings/advanced');
    await expect(fillie.control.locator('body')).toContainText(/Sessions run\s*1/, { timeout: 20_000 });
  });

  test('exports a backup without the API key', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'valid', apiKey: 'secret-key-for-export' });
    await openApp(fillie, '#/settings/profile');

    const [download] = await Promise.all([
      fillie.control.waitForEvent('download', { timeout: 20_000 }),
      fillie.control.click('[data-action="export-data"]'),
    ]);
    expect(download.suggestedFilename()).toBe('fillie-backup.json');

    // A backup is a file the user may share, so the key must not be in it.
    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    const text = await readFile(filePath!, 'utf8');
    expect(text).not.toContain('secret-key-for-export');

    const parsed = JSON.parse(text) as { profile: { personal: { fullName: string } }; memory: unknown[] };
    expect(parsed.profile.personal.fullName).toBe('Ada Lovelace');
    expect(Array.isArray(parsed.memory)).toBe(true);
  });

  test('re-imports a backup without clearing the stored API key', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'valid', apiKey: 'secret-key-for-import' });
    const stored = await fillie.sendToWorker<{ config: Record<string, unknown> }>({ type: 'fillie:get-settings' });
    const backup = {
      profile: { ...PROFILE, personal: { ...PROFILE.personal, fullName: 'Grace Hopper' } },
      memory: [],
      // Exactly what an export produces: the key stripped.
      settings: { ...stored, config: { ...stored.config, apiKey: '' } },
    };

    await openApp(fillie, '#/settings/profile');
    // The input is hidden behind a styled label, so wait for the control itself
    // rather than for it to be visible.
    await fillie.control.waitForSelector('#import-data', { state: 'attached' });
    await fillie.control.setInputFiles('#import-data', {
      name: 'fillie-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    });

    // The profile came across…
    await expect
      .poll(async () => {
        const profile = await fillie.sendToWorker<{ personal: { fullName: string } }>({ type: 'fillie:get-profile' });
        return profile.personal.fullName;
      }, { timeout: 20_000 })
      .toBe('Grace Hopper');

    // …and the key the user already had is still in place.
    const settings = await fillie.sendToWorker<{ config: { apiKey: string } }>({ type: 'fillie:get-settings' });
    expect(settings.config.apiKey).toBe('secret-key-for-import');
  });
});

test.describe('resume import', () => {
  test.skip(!existsSync(RESUMES), 'resume fixtures have not been generated');

  for (const [label, file] of [
    ['PDF', 'resume.pdf'],
    ['DOCX', 'resume.docx'],
  ] as const) {
    test(`suggests values from a ${label} and only applies them on request`, async ({ fillie }) => {
      await seedMinimal(fillie);
      await openApp(fillie, '#/settings/profile');

      await fillie.control.setInputFiles('#resume-file', path.join(RESUMES, file));

      // A preview appears; nothing is saved yet.
      const preview = fillie.control.locator('#import-result');
      await expect(preview).toBeVisible({ timeout: 20_000 });
      await expect(preview).toContainText('What was found');

      // The profile is still empty before the user applies it.
      const before = await fillie.sendToWorker<{ personal: { email: string } }>({ type: 'fillie:get-profile' });
      expect(before.personal.email).toBe('');

      await fillie.control.click('[data-action="apply-import"]');
      await expect(fillie.control).toHaveURL(/#\/profile\/personal/);

      // The app autosaves on a debounce, so poll storage rather than reading it
      // the instant after the click.
      await expect
        .poll(
          async () => {
            const profile = await fillie.sendToWorker<{ personal: { email: string } }>({
              type: 'fillie:get-profile',
            });
            return profile.personal.email;
          },
          { timeout: 20_000 },
        )
        .toMatch(/@example\.com$/);

      const stored = await fillie.sendToWorker<{
        personal: { email: string; fullName: string };
        education: { university: string };
        links: { linkedin: string };
      }>({ type: 'fillie:get-profile' });

      expect(stored.personal.fullName.length).toBeGreaterThan(3);
      expect(stored.education.university).not.toBe('');
      expect(stored.links.linkedin).toMatch(/linkedin\.com\/in\//);

      // The imported values are now editable in the UI.
      await expect(fillie.control.locator('input[name="personal.email"]')).toHaveValue(stored.personal.email);
    });
  }

  test('can discard an import without changing the profile', async ({ fillie }) => {
    await seedMinimal(fillie);
    await openApp(fillie, '#/settings/profile');

    await fillie.control.setInputFiles('#resume-file', path.join(RESUMES, 'resume.docx'));
    await expect(fillie.control.locator('#import-result')).toBeVisible({ timeout: 20_000 });
    await fillie.control.click('[data-action="discard-import"]');

    const stored = await fillie.sendToWorker<{ personal: { email: string } }>({ type: 'fillie:get-profile' });
    expect(stored.personal.email).toBe('');
    // The slot is emptied, so there is nothing left to apply.
    await expect(fillie.control.locator('#import-result')).toBeEmpty();
  });

  test('explains a file type it cannot read', async ({ fillie }) => {
    await seedMinimal(fillie);
    await openApp(fillie, '#/settings/profile');

    await fillie.control.setInputFiles('#resume-file', {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Grace Hopper\ngrace@example.com'),
    });

    await expect(fillie.control.locator('#import-result')).toContainText(/PDF and DOCX/i, { timeout: 20_000 });
  });
});

test.describe('memory tab', () => {
  const entry = {
    id: 'mem-1',
    question: 'Why do you want to work here?',
    intent: 'motivation',
    answer: 'Because of the ingestion work at Meridian Analytics.',
    sources: [],
    userFacts: [],
    context: { company: 'Northwind', role: 'Backend Engineer', host: 'northwind.test', isGeneric: false },
    createdAt: 1,
    updatedAt: 1,
    useCount: 1,
  };

  test('lists, edits and deletes a learned answer', async ({ fillie }) => {
    test.slow();
    await seedMinimal(fillie);
    await fillie.sendToWorker({ type: 'fillie:save-memory', memory: [entry] });

    await openApp(fillie, '#/memory');
    await expect(fillie.control.locator('.memory-item')).toHaveCount(1);
    await expect(fillie.control.locator('body')).toContainText('Meridian Analytics');

    // Edit.
    await fillie.control.click('[data-action="edit-memory"]');
    await fillie.control.waitForSelector('#memory-answer');
    await fillie.control.fill('#memory-answer', 'Updated answer about Meridian Analytics.');
    await fillie.control.click('[data-action="save-memory"]');

    await expect
      .poll(async () => {
        const memory = await fillie.sendToWorker<Array<{ answer: string }>>({ type: 'fillie:get-memory' });
        return memory[0]?.answer;
      }, { timeout: 15_000 })
      .toBe('Updated answer about Meridian Analytics.');

    // Delete, accepting the confirmation dialog.
    fillie.control.once('dialog', (dialog) => void dialog.accept());
    await fillie.control.click('[data-action="delete-memory"]');
    await expect(fillie.control.locator('.memory-item')).toHaveCount(0, { timeout: 15_000 });

    const memory = await fillie.sendToWorker<unknown[]>({ type: 'fillie:get-memory' });
    expect(memory).toHaveLength(0);
  });

  test('filters the list with the search box', async ({ fillie }) => {
    await seedMinimal(fillie);
    await fillie.sendToWorker({
      type: 'fillie:save-memory',
      memory: [
        entry,
        { ...entry, id: 'mem-2', question: 'Tell us about a project', answer: 'Trailhead wayfinding app.' },
      ],
    });

    await openApp(fillie, '#/memory');
    await expect(fillie.control.locator('.memory-item')).toHaveCount(2);

    await fillie.control.fill('#memory-search', 'Trailhead');
    await expect(fillie.control.locator('.memory-item')).toHaveCount(1);
    await expect(fillie.control.locator('.memory-item')).toContainText('Trailhead');
  });

  test('says so plainly when nothing has been learned yet', async ({ fillie }) => {
    await seedMinimal(fillie);
    await openApp(fillie, '#/memory');
    await expect(fillie.control.locator('body')).toContainText(/No saved answers yet/i);
  });
});

test.describe('settings tab', () => {
  const row = (id: string) => `.provider-row[data-provider="${id}"]`;
  const testButton = (id: string) => `[data-action="test-provider"][data-id="${id}"]`;
  type Settings = {
    enabled: boolean;
    providerOrder: string[];
    providerModels: Record<string, string>;
    providerBaseUrls: Record<string, string>;
    config: Record<string, unknown> & { apiKeys?: Record<string, string> };
  } & Record<string, unknown>;
  const settingsOf = (fillie: Fixtures) => fillie.sendToWorker<Settings>({ type: 'fillie:get-settings' });

  test('reorders the AI platforms and keeps the order', async ({ fillie }) => {
    await openApp(fillie, '#/settings/ai');
    expect((await settingsOf(fillie)).providerOrder[0]).toBe('gemini');

    await fillie.control.click('[data-action="move-provider"][data-id="gemini"][data-dir="1"]');

    await expect.poll(async () => (await settingsOf(fillie)).providerOrder.slice(0, 2), { timeout: 15_000 }).toEqual(['cerebras', 'gemini']);
    // The rows are drawn in the new order.
    await expect(fillie.control.locator('.provider-row').first()).toHaveAttribute('data-provider', 'cerebras');
  });

  test('turns hosted AI off without breaking the offline engine', async ({ fillie }) => {
    await openApp(fillie, '#/settings/ai');
    // The checkbox is visually replaced by a styled track, so the clickable
    // element is the label wrapping it.
    const toggle = fillie.control.locator('.ff-switch:has(input[name="enabled"])');
    await expect(toggle).toBeVisible();

    const before = await fillie.control.locator('input[name="enabled"]').isChecked();
    await toggle.click();

    await expect
      .poll(async () => (await settingsOf(fillie)).enabled, { timeout: 15_000 })
      .toBe(!before);

    // A form still fills with the hosted provider switched off.
    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);
    await expect(page.locator('#email')).toHaveValue('ada@example.com');
  });

  test('switches theme and remembers it', async ({ fillie }) => {
    await openApp(fillie, '#/settings/appearance');
    await fillie.control.click('[data-theme="dark"]');

    await expect(fillie.control.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await fillie.control.evaluate(() => localStorage.getItem('fillie:theme'))).toBe('dark');
  });

  test('tests a platform connection against a local endpoint', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'valid' });
    await openApp(fillie, '#/settings/ai');

    await fillie.control.click(testButton('openai-compatible'));
    await expect(fillie.control.locator(`${row('openai-compatible')} .provider-test`)).toContainText(/Connected to/i, { timeout: 20_000 });
  });

  test('saves every AI control the user can reach', async ({ fillie }) => {
    await openApp(fillie, '#/settings/ai');
    await fillie.control.waitForSelector('input[name="config.temperature"]');

    // Each control's stored value must change when the control does. A control
    // that renders but never saves is silently broken, so they are checked
    // together rather than one at a time.
    const cases: Array<[string, string, (s: Settings) => unknown, unknown]> = [
      ['input[name="config.temperature"]', '0.7', (s) => s.config.temperature, 0.7],
      ['input[name="config.maxOutputTokens"]', '1200', (s) => s.config.maxOutputTokens, 1200],
      ['input[name="batchSize"]', '12', (s) => s.batchSize, 12],
      ['input[name="maxRetries"]', '3', (s) => s.maxRetries, 3],
      ['input[name="model.cerebras"]', 'my-model', (s) => s.providerModels.cerebras, 'my-model'],
      ['input[name="baseUrl.openai-compatible"]', 'https://example.test/v1', (s) => s.providerBaseUrls['openai-compatible'], 'https://example.test/v1'],
      ['input[name="key.together"]', 'a-together-key', (s) => s.config.apiKeys?.together, 'a-together-key'],
    ];

    for (const [selector, input, read, expected] of cases) {
      const field = fillie.control.locator(selector);
      await expect(field, selector).toBeVisible();
      await field.fill(String(input));
      await field.blur();
      await expect.poll(async () => read(await settingsOf(fillie)), { timeout: 15_000 }, ).toBe(expected);
    }

    // The confidence sliders commit as they move, without waiting for blur.
    await fillie.control.locator('input[name="autoFillThreshold"]').fill('0.7');
    await expect
      .poll(async () => (await settingsOf(fillie)).autoFillThreshold as number, { timeout: 15_000 })
      .toBeCloseTo(0.7, 2);

    // Switching JSON mode off is honoured too.
    await fillie.control.locator('.ff-switch:has(input[name="config.jsonMode"])').click();
    await expect.poll(async () => (await settingsOf(fillie)).config.jsonMode, { timeout: 15_000 }).toBe(false);
  });

  test('stores the timeout in milliseconds when the UI shows seconds', async ({ fillie }) => {
    await openApp(fillie, '#/settings/ai');
    const field = fillie.control.locator('input[name="config.timeoutMs"]');
    await expect(field).toBeVisible();

    // The control reads seconds; the setting is stored in milliseconds.
    await field.fill('45');
    await field.blur();

    await expect.poll(async () => (await settingsOf(fillie)).config.timeoutMs, { timeout: 15_000 }).toBe(45_000);
  });

  test('reports a failing connection instead of claiming success', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'rate-limit' });
    await openApp(fillie, '#/settings/ai');

    await fillie.control.click(testButton('openai-compatible'));
    await expect(fillie.control.locator(`${row('openai-compatible')} .provider-test`)).toContainText(/rate limit/i, { timeout: 20_000 });
  });

  /**
   * Each platform's key field is raw markup, so it once missed the `data-bind`
   * attribute that routes a keystroke into settings. A typed key has to reach
   * the provider, and the Test button has to wake up as soon as a key exists.
   */
  test('saves a typed API key, enables Test, and passes the key to the provider', async ({ fillie }) => {
    await openApp(fillie, '#/settings/ai');
    const id = 'openai-compatible';

    // The fixture seeds a key; clear it to start from "no key".
    await fillie.control.locator(`input[name="key.${id}"]`).fill('');
    await expect(fillie.control.locator(testButton(id))).toBeDisabled();

    await fillie.control.locator(`input[name="baseUrl.${id}"]`).fill(`${MOCK_AI}/valid/v1`);
    await fillie.control.locator(`input[name="model.${id}"]`).fill('mock-model');
    // A fake key: it only ever travels to the local mock server.
    await fillie.control.locator(`input[name="key.${id}"]`).fill('typed-key-in-the-ui');
    await fillie.control.locator(`input[name="key.${id}"]`).blur();

    await expect.poll(async () => (await settingsOf(fillie)).config.apiKeys?.[id], { timeout: 20_000 }).toBe('typed-key-in-the-ui');

    // Typing a key enables Test without a page reload.
    await expect(fillie.control.locator(testButton(id))).toBeEnabled();
    await fillie.control.click(testButton(id));
    await expect(fillie.control.locator(`${row(id)} .provider-test`)).toContainText(/connected/i, { timeout: 20_000 });

    // The key survives a reload, so the user is not asked for it again.
    await openApp(fillie, '#/settings/ai');
    await expect(fillie.control.locator(`input[name="key.${id}"]`)).toHaveValue('typed-key-in-the-ui');
  });

  test('shows a provider 404 as a failure rather than claiming success', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'valid' });
    await openApp(fillie, '#/settings/ai');

    // An unroutable base URL makes the mock 404, exactly as a gateway does for a gated model.
    const url = fillie.control.locator('input[name="baseUrl.openai-compatible"]');
    await url.fill(`${MOCK_AI}/no-such-scenario/v1`);
    await url.blur();
    await fillie.control.click(testButton('openai-compatible'));

    const result = fillie.control.locator(`${row('openai-compatible')} .provider-test`);
    await expect(result).toHaveAttribute('data-ok', 'false', { timeout: 20_000 });
    // The provider's own words, not just a status code, so the cause is visible.
    await expect(result).toContainText(/no-such-scenario|not found/i);
    await expect(fillie.control.locator('body')).not.toContainText(/connected to/i);
  });

  /**
   * Settings persist in chrome.storage.local, so a browser that saved the old
   * Gemini preset kept naming the gated `gemini-2.5-flash` after the preset was
   * corrected. The saved model has to be migrated on read.
   */
  test('migrates a stored Gemini model that is closed to new API keys', async ({ fillie }) => {
    const stored = await settingsOf(fillie);
    await fillie.sendToWorker({
      type: 'fillie:save-settings',
      settings: {
        ...stored,
        config: { ...stored.config, provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'a-key-from-before-the-fix' },
        providerModels: { ...stored.providerModels, gemini: 'gemini-2.5-flash' },
      },
    });

    await openApp(fillie, '#/settings/ai');

    await expect(fillie.control.locator('input[name="model.gemini"]')).toHaveValue('gemini-3.5-flash-lite');
    // The user's key is untouched by the migration.
    await expect(fillie.control.locator('input[name="key.gemini"]')).toHaveValue('a-key-from-before-the-fix');
  });

  /** A Gemini model left in the Groq field made Groq answer 404 and hid the cause. */
  test('repairs a model left over from another provider', async ({ fillie }) => {
    const stored = await settingsOf(fillie);
    await fillie.sendToWorker({
      type: 'fillie:save-settings',
      settings: {
        ...stored,
        config: { ...stored.config, provider: 'groq', model: 'gemini-3.5-flash-lite', apiKey: 'a-groq-key' },
        providerModels: { ...stored.providerModels, groq: 'gemini-3.5-flash-lite' },
      },
    });

    await openApp(fillie, '#/settings/ai');

    await expect(fillie.control.locator('input[name="model.groq"]')).toHaveValue('openai/gpt-oss-20b');
    await expect(fillie.control.locator('input[name="key.groq"]')).toHaveValue('a-groq-key');
  });

  /**
   * A reasoning model (everything Groq still hosts) emits its chain of thought
   * before the answer. The probe budget has to survive that.
   */
  test('a reasoning model is not reported as a broken connection', async ({ fillie }) => {
    await fillie.setAi({ enabled: true, scenario: 'valid', provider: 'groq' });
    await openApp(fillie, '#/settings/ai');

    await fillie.control.click(testButton('groq'));
    const result = fillie.control.locator(`${row('groq')} .provider-test`);
    await expect(result).toContainText(/connected/i, { timeout: 20_000 });
    await expect(result).toHaveAttribute('data-ok', 'true');
  });

  test('cannot test a platform until a key is added', async ({ fillie }) => {
    await openApp(fillie, '#/settings/ai');
    await expect(fillie.control.locator(`${row('gemini')} .ff-chip`)).toHaveText('No key');
    await expect(fillie.control.locator(testButton('gemini'))).toBeDisabled();
  });
});

test.describe('popup', () => {
  test('runs on the active tab from the keyboard shortcut', async ({ fillie }) => {
    const page = await fillie.open('/basic.html');
    await page.bringToFront();

    // The manifest advertises Alt+Shift+F; the service worker routes it to the
    // same message the popup button sends.
    const dispatched = await fillie.control.evaluate(async () => {
      const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, resolve));
      const tab = tabs[0];
      if (tab?.id === undefined) return 'no active tab';
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'fillie:run' });
        return 'sent';
      } catch (error) {
        return `error: ${String(error)}`;
      }
    });
    expect(dispatched).toBe('sent');

    await expect(page.locator('#email')).toHaveValue('ada@example.com', { timeout: 30_000 });
    expect(await page.evaluate(() => (window as never as { __fillieSubmitted?: boolean }).__fillieSubmitted)).toBeFalsy();
  });

  test('shows the primary action and never submits', async ({ fillie }) => {
    const page = await fillie.open('/basic.html');

    const popup = await fillie.context.newPage();
    await popup.goto(`chrome-extension://${fillie.extensionId}/pages/popup.html`);

    // The popup acts on whichever tab is active. Opening it as a tab makes it
    // the active one, so focus the form and let the popup re-read: a real popup
    // is never itself the active tab, which is what this reproduces.
    await page.bringToFront();
    await popup.reload();
    await popup.waitForSelector('.pop-cta', { timeout: 20_000 });

    // The action is offered for the open page.
    await expect(popup.locator('.pop-cta')).toContainText('Fill this page');

    await popup.locator('[data-action="run"]').click({ force: true });
    // The form is filled and verified…
    await expect(page.locator('#email')).toHaveValue('ada@example.com', { timeout: 30_000 });
    // …and never submitted.
    expect(await page.evaluate(() => (window as never as { __fillieSubmitted?: boolean }).__fillieSubmitted)).toBeFalsy();
  });

  test('disables the action on a page Fillie cannot reach', async ({ fillie }) => {
    // A chrome:// page has no content script, so the popup must not offer to
    // fill it.
    const popup = await fillie.context.newPage();
    await popup.goto(`chrome-extension://${fillie.extensionId}/pages/popup.html`);
    await popup.waitForSelector('.pop-cta', { timeout: 20_000 });

    // The popup tab itself is the active tab here, and Fillie correctly refuses
    // to act on an extension page.
    await expect(popup.locator('.pop-cta')).toBeDisabled();
    await expect(popup.locator('.pop-cta')).toContainText('No form on this page');
  });

  test('offers profile setup when there is no profile yet', async ({ fillie }) => {
    await seedMinimal(fillie);
    const popup = await fillie.context.newPage();
    await popup.goto(`chrome-extension://${fillie.extensionId}/pages/popup.html`);
    await popup.waitForSelector('[data-action="open-profile"]', { timeout: 20_000 });
    await expect(popup.locator('.pop-hero')).toContainText(/Tell Fillie about you/i);
  });
});

test.describe('accessibility', () => {
  test('respects prefers-reduced-motion in the app', async ({ fillie }) => {
    await fillie.control.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(fillie, '#/profile/personal');
    // The app still renders; reduced motion only removes transitions.
    await expect(fillie.control.locator('.topbar h1')).toBeVisible();
  });

  test('keeps the overlay reachable and labelled', async ({ fillie }) => {
    const page = await fillie.open('/basic.html');
    await fillie.sendToWorker({ type: 'fillie:run', url: page.url() });
    // Drive it the way the popup does.
    await fillie.control.evaluate(async (target: string) => {
      const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) => chrome.tabs.query({}, resolve));
      const tab = tabs.find((candidate) => candidate.url === target);
      await new Promise<void>((resolve) => chrome.tabs.sendMessage(tab!.id as number, { type: 'fillie:run' }, () => resolve()));
    }, page.url());

    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-fillie-panel="true"]')?.shadowRoot?.querySelector('.panel')),
      undefined,
      { timeout: 30_000 },
    );

    // Every icon-only control carries a name.
    const unnamed = await page.evaluate(() => {
      const root = document.querySelector('[data-fillie-panel="true"]')?.shadowRoot;
      if (!root) return ['no shadow root'];
      return Array.from(root.querySelectorAll('button'))
        .filter((button) => !button.textContent?.trim() && !button.getAttribute('aria-label'))
        .map((button) => button.outerHTML.slice(0, 80));
    });
    expect(unnamed).toEqual([]);
  });
});
