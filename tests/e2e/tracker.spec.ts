import { PROFILE, expect, runFillieOn, test, waitForResults, type Fixtures } from './fixtures';

async function openApp(fillie: Fixtures, hash: string): Promise<void> {
  await fillie.control.goto(`chrome-extension://${fillie.extensionId}/pages/app.html${hash}`);
  await fillie.control.reload();
  await fillie.control.waitForSelector('.app', { timeout: 20_000 });
}

interface Page {
  rows: Array<{ company: string; role: string; status: string; rating: number | null; notes: string[]; ratingSource: string | null }>;
  localOnly: boolean;
}

test.describe('application tracker', () => {
  test('adds an application by hand, with colourful tags, and keeps it after a reload', async ({ fillie }) => {
    await openApp(fillie, '#/database');
    await expect(fillie.control.locator('.db-empty')).toContainText(/No applications yet/i, { timeout: 15_000 });

    await fillie.control.click('[data-action="add-app"]');
    await fillie.control.fill('#af-company', 'Northwind');
    await fillie.control.fill('#af-role', 'Backend Engineer');
    await fillie.control.locator('label.tag-interview').click();
    await fillie.control.fill('#af-interview', '2026-10-20T14:30');
    await fillie.control.locator('.rating-edit .star').nth(3).click(); // 4 stars
    await fillie.control.fill('#af-notes', '2 year bond\nGood mentors');
    await fillie.control.click('#app-form button[type="submit"]');

    const row = fillie.control.locator('.app-row').first();
    await expect(row).toContainText('Northwind');
    await expect(row.locator('.tag-interview')).toHaveText('Interview');
    await expect(row.locator('.tag-marigold-line')).toBeVisible();
    await expect(row.locator('.tag-note')).toHaveCount(2);
    await expect(row.locator('.star[data-on="true"]')).toHaveCount(4);

    // Not signed in, so it is kept on this device and shown as such.
    await expect(fillie.control.locator('.banner')).toContainText(/this device/i);

    await openApp(fillie, '#/database');
    await expect(fillie.control.locator('.app-row')).toHaveCount(1, { timeout: 15_000 });
  });

  test('changing the rating is the user\'s call and clears the AI mark', async ({ fillie }) => {
    await fillie.sendToWorker({
      type: 'fillie:apps-save',
      app: {
        id: 'a1', company: 'Acme', role: 'Dev', status: 'applied', interviewAt: null, offerLpa: null,
        appliedAt: '2026-10-01', notes: [], rating: 5, ratingSource: 'ai', url: '', host: '', updatedAt: 1,
      },
    });
    await openApp(fillie, '#/database');
    await expect(fillie.control.locator('.ai-badge')).toBeVisible({ timeout: 15_000 });

    await fillie.control.locator('.app-row .star').nth(1).click(); // 2 stars
    await expect(fillie.control.locator('.ai-badge')).toHaveCount(0);
    const page = await fillie.sendToWorker<Page>({ type: 'fillie:apps-list', query: {} });
    expect(page.rows[0]).toMatchObject({ rating: 2, ratingSource: 'user' });
  });

  test('tracks an application automatically when a filled form is submitted', async ({ fillie }) => {
    await fillie.seedProfile(PROFILE);
    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    await page.click('#submit');

    await expect
      .poll(async () => (await fillie.sendToWorker<Page>({ type: 'fillie:apps-list', query: {} })).rows.length, { timeout: 20_000 })
      .toBe(1);
    const { rows } = await fillie.sendToWorker<Page>({ type: 'fillie:apps-list', query: {} });
    expect(rows[0].status).toBe('applied');
    expect(rows[0].company).toBeTruthy();
    // No AI is configured, so no rating is invented.
    expect(rows[0].rating).toBeNull();
  });

  test('keeps one row when the same posting is submitted twice', async ({ fillie }) => {
    const context = { url: 'https://x.test/job', host: 'x.test', pageTitle: 'Job', company: 'Acme', role: 'Dev', detectedAt: 0 };
    await fillie.sendToWorker({ type: 'fillie:apps-track', context });
    await fillie.sendToWorker({ type: 'fillie:apps-track', context });
    const page = await fillie.sendToWorker<Page>({ type: 'fillie:apps-list', query: {} });
    expect(page.rows).toHaveLength(1);
  });

  test('shows the plan on the account page (development build is unlimited)', async ({ fillie }) => {
    await openApp(fillie, '#/account');
    await expect(fillie.control.locator('.banner')).toContainText(/Cloud is not set up/i, { timeout: 15_000 });
  });
});

test.describe('resume choice', () => {
  const resumes = {
    resumes: [
      { id: 'fe', name: 'Frontend', text: 'React CSS TypeScript design systems', updatedAt: 1 },
      { id: 'be', name: 'Backend', text: 'Node Postgres APIs queues', updatedAt: 1 },
    ],
    defaultId: 'fe',
  };

  test('asks which resume to use right after Alt+Shift+F and highlights the best match', async ({ fillie }) => {
    await fillie.seedProfile(PROFILE);
    await fillie.sendToWorker({ type: 'fillie:save-resumes', state: resumes });
    const page = await fillie.open('/basic.html'); // "Backend Engineer at Northwind"
    await runFillieOn(page, fillie);

    const picks = page.locator('.resume-pick');
    await expect(picks).toHaveCount(2, { timeout: 20_000 });
    await expect(page.locator('.resume-pick[data-suggested="true"]')).toContainText('Backend');
    // Nothing has been filled yet: the choice comes first.
    await expect(page.locator('#email')).toHaveValue('');

    await page.locator('.resume-pick[data-fillie-resume="be"]').click();
    await waitForResults(page);
    await expect(page.locator('#email')).toHaveValue('ada@example.com', { timeout: 30_000 });

    await page.click('#submit');
    await expect
      .poll(async () => (await fillie.sendToWorker<{ rows: Array<{ resumeName: string }> }>({ type: 'fillie:apps-list', query: {} })).rows[0]?.resumeName, { timeout: 20_000 })
      .toBe('Backend');
  });

  test('offers an uploaded document that is filed as a resume', async ({ fillie }) => {
    const profile = await fillie.sendToWorker<{ documents?: unknown[] }>({ type: 'fillie:get-profile' });
    await fillie.sendToWorker({
      type: 'fillie:save-profile',
      profile: {
        ...profile,
        documents: [{ id: 'd1', name: 'Resume 2025', fileName: 'resume.pdf', fileType: 'application/pdf', fileSize: 1, keywords: [], category: 'resume', textContent: 'Python SQL', isDefault: true, updatedAt: 1 }],
      },
    });
    await fillie.sendToWorker({ type: 'fillie:save-resumes', state: resumes });
    const suggestion = await fillie.sendToWorker<{ options: Array<{ id: string; name: string }> }>({
      type: 'fillie:suggest-resume',
      context: { url: 'u', host: 'h', pageTitle: 'Job', detectedAt: 0 },
    });
    expect(suggestion.options.map((o) => o.id).sort()).toEqual(['be', 'doc:d1', 'fe']);
  });

  test('shows the resume used, in brackets and italics, when the role could not be read', async ({ fillie }) => {
    await fillie.sendToWorker({ type: 'fillie:save-resumes', state: resumes });
    await fillie.sendToWorker({
      type: 'fillie:apps-track',
      resumeId: 'be',
      context: { url: 'https://x.test/a', host: 'x.test', pageTitle: 'Some page', company: 'Acme', detectedAt: 0 },
    });
    const { rows } = await fillie.sendToWorker<{ rows: Array<{ role: string; resumeName: string }> }>({ type: 'fillie:apps-list', query: {} });
    expect(rows[0]).toMatchObject({ role: '', resumeName: 'Backend' });

    await openApp(fillie, '#/database');
    const note = fillie.control.locator('.app-row .app-resume em');
    await expect(note).toHaveText('(Backend)', { timeout: 15_000 });
    expect(await note.evaluate((el) => getComputedStyle(el).fontStyle)).toBe('italic');
  });
});
