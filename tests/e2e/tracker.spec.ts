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

  test('shows the plan on the account page', async ({ fillie }) => {
    await openApp(fillie, '#/account');
    // Works with or without real cloud keys: the plan card is always there, and
    // signed-out users see provider-branded sign-in buttons when the cloud is configured.
    await expect(fillie.control.locator('.hero-card')).toBeVisible({ timeout: 15_000 });
    const configured = (await fillie.control.locator('.banner').filter({ hasText: /Cloud is not set up/i }).count()) === 0;
    if (configured) {
      await expect(fillie.control.locator('.oauth-btn')).toHaveCount(3);
      await expect(fillie.control.locator('.oauth-google')).toContainText('Continue with Google');
    }
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

  test('turns a resume once uploaded under the old Documents page into a resume, so nothing is lost', async ({ fillie }) => {
    const profile = await fillie.sendToWorker<{ documents?: unknown[] }>({ type: 'fillie:get-profile' });
    await fillie.sendToWorker({
      type: 'fillie:save-profile',
      profile: {
        ...profile,
        documents: [{ id: 'd1', name: 'Resume 2025', fileName: 'resume.pdf', fileType: 'application/pdf', fileSize: 1, keywords: [], category: 'resume', textContent: 'Python SQL', isDefault: true, updatedAt: 1 }],
      },
    });
    const state = await fillie.sendToWorker<{ resumes: Array<{ id: string; name: string; text: string }>; defaultId: string }>({ type: 'fillie:get-resumes' });
    expect(state.resumes).toHaveLength(1);
    expect(state.resumes[0]).toMatchObject({ name: 'Resume 2025', text: 'Python SQL' });
    expect(state.defaultId).toBe(state.resumes[0].id);

    // Once the user has saved their own resumes, the old document no longer adds a second copy.
    await fillie.sendToWorker({ type: 'fillie:save-resumes', state: resumes });
    const suggestion = await fillie.sendToWorker<{ options: Array<{ id: string }> }>({
      type: 'fillie:suggest-resume',
      context: { url: 'u', host: 'h', pageTitle: 'Job', detectedAt: 0 },
    });
    expect(suggestion.options.map((o) => o.id).sort()).toEqual(['be', 'fe']);
  });

  test('the Documents page is gone; Resumes sits in the Profile list, and the old address still works', async ({ fillie }) => {
    await openApp(fillie, '#/profile/personal');
    const profileLinks = fillie.control.locator('nav[aria-label="Profile sections"] .side-link');
    const labels = (await profileLinks.allInnerTexts()).map((t) => t.trim());
    expect(labels).not.toContain('Documents');
    expect(labels.indexOf('Resumes')).toBe(labels.indexOf('Preferences') - 1);
    expect(labels.indexOf('Resumes')).toBeGreaterThan(labels.indexOf('Links'));
    // And it is no longer listed under the Fillie group.
    expect(await fillie.control.locator('nav[aria-label="Other sections"] .side-link', { hasText: 'Resumes' }).count()).toBe(0);

    await openApp(fillie, '#/profile/documents');
    await expect(fillie.control.locator('.topbar h1')).toHaveText('Resumes');
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

test.describe('sign-in popup', () => {
  test('opens a small centred window (not a tab), and closes it when the provider redirects back', async ({ fillie }) => {
    const callback = `chrome-extension://${fillie.extensionId}/pages/auth-callback.html#access_token=at&refresh_token=rt&expires_in=3600`;
    const start = `http://127.0.0.1:4321/mock-auth/redirect?delay=2500&to=${encodeURIComponent(callback)}`;
    const tabsBefore = fillie.context.pages().length;

    // Watch the browser's windows while the sign-in runs, since the popup lives only a moment.
    const watcher = fillie.control.evaluate(async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 40; i += 1) {
        for (const w of await chrome.windows.getAll()) seen.add(String(w.type));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return [...seen];
    });

    // What the Google/GitHub/Apple buttons do, against a local stand-in for the provider.
    const pending = fillie.sendToWorker<{ ok: boolean; url?: string; error?: string }>({ type: 'fillie:auth-popup', url: start });
    const popup = await fillie.context.waitForEvent('page', { timeout: 15_000 });

    // A separate popup-type window appeared. (Headless Chromium ignores the requested 480x720 size; real browsers honour it.)
    expect(await watcher).toContain('popup');

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.url).toContain('access_token=at');

    // The popup closes by itself and no stray tab is left behind.
    await expect.poll(() => popup.isClosed(), { timeout: 15_000 }).toBe(true);
    expect(fillie.context.pages().length).toBe(tabsBefore);
  });

  test('closing the popup cancels the sign-in', async ({ fillie }) => {
    const pending = fillie.sendToWorker<{ ok: boolean; error?: string }>({
      type: 'fillie:auth-popup',
      url: 'http://127.0.0.1:4321/health',
    });
    const popup = await fillie.context.waitForEvent('page', { timeout: 15_000 });
    await popup.close();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cancel/i);
  });

  test('a web page cannot trigger the callback', async ({ fillie }) => {
    const reply = await fillie.sendToWorker<{ ok: boolean }>({ type: 'fillie:auth-callback', url: 'https://evil.example/#access_token=x' });
    expect(reply.ok).toBe(false);
  });
});

test.describe('a form you fill is tracked straight away', () => {
  type Rows = { rows: Array<{ company: string; role: string; status: string; offeredCtc: string; notes: string[] }> };
  const rows = (fillie: Fixtures) => fillie.sendToWorker<Rows>({ type: 'fillie:apps-list', query: {} });

  test('shows up in the database as soon as Fillie fills it, without pressing submit, with the pay the posting states', async ({ fillie }) => {
    await fillie.seedProfile(PROFILE);
    const page = await fillie.open('/posting-with-pay.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);
    await expect(page.locator('#email')).toHaveValue('ada@example.com', { timeout: 30_000 });
    // Note: the submit button is never pressed.

    await expect.poll(async () => (await rows(fillie)).rows.length, { timeout: 20_000 }).toBe(1);
    const { rows: tracked } = await rows(fillie);
    // Role and company are read from the page, not guessed from a sentence in the body.
    expect(tracked[0]).toMatchObject({ status: 'applied', company: 'Initech', role: 'Platform Engineer' });
    expect(tracked[0].offeredCtc).toContain('8-12 LPA');
    expect(tracked[0].notes).toContain('2 year bond');
  });

  test('saves no pay when the posting does not state one (nothing is guessed)', async ({ fillie }) => {
    await fillie.seedProfile(PROFILE);
    const page = await fillie.open('/posting-without-pay.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    await expect.poll(async () => (await rows(fillie)).rows.length, { timeout: 20_000 }).toBe(1);
    expect((await rows(fillie)).rows[0].offeredCtc).toBe('');
  });

  test('filling the same page again does not add a second row, and the popup numbers count it', async ({ fillie }) => {
    await fillie.seedProfile(PROFILE);
    const first = await fillie.open('/posting-with-pay.html');
    await runFillieOn(first, fillie);
    await waitForResults(first);
    await expect.poll(async () => (await rows(fillie)).rows.length, { timeout: 20_000 }).toBe(1);

    const second = await fillie.open('/posting-with-pay.html');
    await runFillieOn(second, fillie);
    await waitForResults(second);
    await second.waitForTimeout(1500);
    expect((await rows(fillie)).rows).toHaveLength(1);

    await fillie.sendToWorker({
      type: 'fillie:apps-save',
      app: { ...(await rows(fillie)).rows[0], status: 'interview', interviewAt: new Date(Date.now() + 26 * 3_600_000).toISOString().slice(0, 16) },
    });
    const summary = await fillie.sendToWorker<{ total: number; counts: Record<string, number>; upcoming: Array<{ company: string }> }>({ type: 'fillie:apps-summary' });
    expect(summary.total).toBe(1);
    expect(summary.counts.interview).toBe(1);
    expect(summary.upcoming).toHaveLength(1);
  });

  test('the popup leads with the total, the interviews and a quiet footer', async ({ fillie }) => {
    await fillie.sendToWorker({
      type: 'fillie:apps-save',
      app: {
        id: 'p1', company: 'Initech', role: 'Platform Engineer', status: 'interview', interviewAt: new Date(Date.now() + 30 * 3_600_000).toISOString().slice(0, 16),
        offerLpa: null, offeredCtc: '', appliedAt: '2026-10-01', notes: [], rating: null, ratingSource: null, url: '', host: '', resumeName: '', updatedAt: 1,
      },
    });
    const popup = await fillie.context.newPage();
    await popup.goto(`chrome-extension://${fillie.extensionId}/pages/popup.html`);
    await expect(popup.locator('.pop-total')).toContainText('1', { timeout: 20_000 });
    await expect(popup.locator('.pop-total')).toContainText('form filled');
    await expect(popup.locator('.pop-chip-interview b')).toHaveText('1');
    await expect(popup.locator('.pop-interview').first()).toContainText('Initech');
    // The AI status and the shortcut are now small, at the bottom.
    const order = await popup.evaluate(() => [...document.querySelectorAll('.pop-body > *')].map((el) => el.className.split(' ')[0]));
    expect(order.slice(0, 2)).toEqual(['pop-summary', 'pop-upcoming']);
    expect(order[order.length - 1]).toBe('pop-foot');
    await expect(popup.locator('.pop-foot')).toContainText('⌥⇧F');
  });
});

test.describe('popup polish', () => {
  const when = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString().slice(0, 16);
  const interview = (n: number) => ({
    id: `i${n}`, company: `Company ${n}`, role: 'Engineer', status: 'interview', interviewAt: when(10 + n * 5),
    offerLpa: null, offeredCtc: '', appliedAt: '2026-10-01', notes: [], rating: null, ratingSource: null, url: '', host: '', resumeName: '', updatedAt: 1,
  });
  const openPopup = async (fillie: Fixtures) => {
    const popup = await fillie.context.newPage();
    await popup.goto(`chrome-extension://${fillie.extensionId}/pages/popup.html`);
    await popup.waitForSelector('.pop-total', { timeout: 20_000 });
    return popup;
  };

  test('opens with the saved numbers straight away, and trusts them for a minute without asking again', async ({ fillie }) => {
    await fillie.sendToWorker({ type: 'fillie:apps-save', app: interview(1) });
    const first = await openPopup(fillie);
    await expect(first.locator('.pop-total b')).toHaveText('1');
    await first.close();

    // Plant a different number in the saved copy, as if it were the last thing the popup saw.
    // If the popup asked the database again it would show 1; it must show the saved 7.
    await fillie.control.evaluate(async () => {
      const stored = await chrome.storage.local.get('fillie:popup-cache');
      const cache = stored['fillie:popup-cache'];
      cache.summary.total = 7;
      cache.at = Date.now();
      await chrome.storage.local.set({ 'fillie:popup-cache': cache, 'fillie:popup-dirty': 0 });
    });
    const second = await openPopup(fillie);
    await expect(second.locator('.pop-total b')).toHaveText('7');
    // It is there on the first paint: no placeholder digits, nothing counting.
    expect(await second.locator('.pop-total b.skeleton').count()).toBe(0);
    await second.close();

    // Saving an application marks the saved numbers stale, so the next open shows the truth.
    await fillie.sendToWorker({ type: 'fillie:apps-save', app: interview(2) });
    const third = await openPopup(fillie);
    await expect(third.locator('.pop-total b')).toHaveText('2', { timeout: 15_000 });
  });

  test('only the interview list scrolls, and only when there are more than two', async ({ fillie }) => {
    await fillie.sendToWorker({ type: 'fillie:apps-save', app: interview(1) });
    await fillie.sendToWorker({ type: 'fillie:apps-save', app: interview(2) });
    const two = await openPopup(fillie);
    await expect(two.locator('.pop-interview')).toHaveCount(2);
    await expect(two.locator('.pop-interviews')).toHaveAttribute('data-scroll', 'false');
    await two.close();

    for (const n of [3, 4, 5]) await fillie.sendToWorker({ type: 'fillie:apps-save', app: interview(n) });
    const five = await openPopup(fillie);
    await expect(five.locator('.pop-interview')).toHaveCount(5);
    const list = five.locator('.pop-interviews');
    await expect(list).toHaveAttribute('data-scroll', 'true');
    const metrics = await five.evaluate(() => {
      const el = document.querySelector('.pop-interviews') as HTMLElement;
      const top = (sel: string) => Math.round((document.querySelector(sel) as HTMLElement).getBoundingClientRect().top);
      return { client: el.clientHeight, scroll: el.scrollHeight, cta: top('.pop-cta'), page: document.documentElement.scrollHeight - document.documentElement.clientHeight };
    });
    expect(metrics.scroll).toBeGreaterThan(metrics.client); // the list scrolls...
    expect(metrics.client).toBeLessThanOrEqual(132); // ...inside a two-row window
    expect(metrics.page).toBeLessThanOrEqual(1); // ...and the popup itself does not
    // Scrolling the list leaves everything else where it was.
    await list.evaluate((el) => (el.scrollTop = 80));
    const ctaAfter = await five.evaluate(() => Math.round((document.querySelector('.pop-cta') as HTMLElement).getBoundingClientRect().top));
    expect(ctaAfter).toBe(metrics.cta);
  });

  test('shows a crown and "Premium" quietly for premium users, and a small "Get premium" for everyone else', async ({ fillie }) => {
    const free = await openPopup(fillie);
    await expect(free.locator('.pop-getpremium')).toHaveText('Get premium');
    expect(await free.locator('.pop-premium').count()).toBe(0);
    expect(await free.locator('body').innerText()).not.toMatch(/unlocked/i);
    // Let the first popup finish saving what it learned, so it cannot overwrite the copy planted below.
    await expect.poll(() => free.evaluate(async () => Boolean(((await chrome.storage.local.get('fillie:popup-cache'))['fillie:popup-cache'] as { summary?: unknown } | undefined)?.summary))).toBe(true);
    await free.evaluate(async () => {
      const stored = await chrome.storage.local.get('fillie:popup-cache');
      const cache = stored['fillie:popup-cache'];
      cache.status.access = { allowed: true, plan: 'paid', remaining: 3, limit: 3, signedIn: true, email: 'asha@example.com' };
      cache.at = Date.now();
      await chrome.storage.local.set({ 'fillie:popup-cache': cache, 'fillie:popup-dirty': 0 });
    });
    await free.close();

    const paid = await openPopup(fillie);
    await expect(paid.locator('.pop-premium')).toContainText('Premium');
    await expect(paid.locator('.pop-premium svg.pop-crown')).toBeVisible();
    expect(await paid.locator('.pop-getpremium').count()).toBe(0);
    expect(await paid.locator('body').innerText()).not.toMatch(/unlocked/i);
  });

  test('offers free AI setup at the bottom when no AI is set up, and says "Ready" when one is', async ({ fillie }) => {
    await fillie.seedProfile(PROFILE);
    const popup = await openPopup(fillie);
    const setup = popup.locator('.pop-foot .pop-setup-ai');
    await expect(setup).toContainText("it's free");
    expect(await popup.locator('.pop-foot').innerText()).not.toMatch(/gemini/i);

    const [settings] = await Promise.all([fillie.context.waitForEvent('page'), setup.click()]);
    await settings.waitForLoadState('domcontentloaded');
    expect(settings.url()).toContain('/pages/app.html#/settings/ai');
    await settings.close();
    await popup.close();

    await fillie.setAi({ enabled: true, scenario: 'valid' });
    const ready = await openPopup(fillie);
    await expect(ready.locator('.pop-foot')).toContainText('Ready', { timeout: 15_000 });
    expect(await ready.locator('.pop-setup-ai').count()).toBe(0);
  });

  test('the on-page panel offers the free setup when Alt+Shift+F runs without AI, and not when AI is ready', async ({ fillie }) => {
    await fillie.seedProfile(PROFILE);
    const page = await fillie.open('/basic.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);
    const nudge = page.locator('.ai-nudge');
    await expect(nudge).toContainText('free', { timeout: 20_000 });
    const [settings] = await Promise.all([fillie.context.waitForEvent('page'), nudge.locator('[data-fillie-action="setup-ai"]').click()]);
    await settings.waitForLoadState('domcontentloaded');
    expect(settings.url()).toContain('#/settings/ai');
    await settings.close();

    await fillie.setAi({ enabled: true, scenario: 'valid' });
    const again = await fillie.open('/basic.html');
    await runFillieOn(again, fillie);
    await waitForResults(again);
    await again.waitForTimeout(1200);
    expect(await again.locator('.ai-nudge').count()).toBe(0);
  });

  test('the popup fills its window: no outer rectangle and no scrollbar', async ({ fillie }) => {
    const popup = await openPopup(fillie);
    const m = await popup.evaluate(() => {
      const card = document.querySelector('.popup') as HTMLElement;
      const r = card.getBoundingClientRect();
      return { left: r.left, top: r.top, overflowY: getComputedStyle(document.documentElement).overflowY, body: getComputedStyle(document.body).overflowY };
    });
    expect(m.left).toBe(0);
    expect(m.top).toBe(0);
    expect(m.overflowY).toBe('hidden');
    expect(m.body).toBe('hidden');
  });

  test('the popup follows the Notion style: warm paper, 12px cards, no shadows, a midnight total and sticky-note counters', async ({ fillie }) => {
    const popup = await openPopup(fillie);
    const style = await popup.evaluate(() => {
      const css = (selector: string) => getComputedStyle(document.querySelector(selector) as HTMLElement);
      return {
        canvas: css('.popup').backgroundColor,
        total: { radius: css('.pop-hero-top').borderTopLeftRadius, bg: css('.pop-hero-top').backgroundColor },
        chip: css('.pop-chip-applied').borderTopLeftRadius,
        shadows: ['.pop-hero-top', '.pop-chip-applied', '.pop-cta'].map((s) => css(s).boxShadow),
        cta: css('.pop-cta').backgroundColor,
      };
    });
    expect(style.canvas).toBe('rgb(246, 245, 244)'); // #f6f5f4, the paper canvas
    expect(style.total).toEqual({ radius: '12px', bg: 'rgb(2, 9, 58)' }); // midnight sticky note
    expect(style.chip).toBe('12px');
    expect(style.shadows.every((s) => s === 'none')).toBe(true);
    // Blue is the one filled button while there is a form to fill; with no form on the page it goes flat grey.
    expect(['rgb(0, 117, 222)', 'rgb(239, 237, 235)']).toContain(style.cta);
  });

  test('the popup follows the theme chosen in Appearance, and the header always fits', async ({ fillie }) => {
    // The system is light; the extension is told to be dark.
    await fillie.control.evaluate(() => chrome.storage.local.set({ 'fillie:theme': 'dark' }));
    const popup = await fillie.context.newPage();
    await popup.emulateMedia({ colorScheme: 'light' });
    await popup.setViewportSize({ width: 380, height: 700 });
    await popup.goto(`chrome-extension://${fillie.extensionId}/pages/popup.html`);
    await popup.waitForSelector('.pop-total b', { timeout: 20_000 });
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await popup.locator('.popup').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(25, 25, 24)');

    await fillie.control.evaluate(() => chrome.storage.local.set({ 'fillie:theme': 'light' }));
    await popup.reload();
    await popup.waitForSelector('.pop-total b');
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light');

    // "System" follows the browser.
    await fillie.control.evaluate(() => chrome.storage.local.set({ 'fillie:theme': 'system' }));
    await popup.emulateMedia({ colorScheme: 'dark' });
    await popup.reload();
    await popup.waitForSelector('.pop-total b');
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
    await fillie.control.evaluate(() => chrome.storage.local.remove('fillie:theme'));

    // The header is the logo, the name and the buttons, and the open-Fillie button stays inside the window.
    await expect(popup.locator('.pop-brand .pop-name')).toHaveText('Fillie');
    expect(await popup.locator('.pop-mark').innerText()).toBe(''); // the logo stays a clean image
    expect(await popup.locator('h1').count()).toBe(0);
    const box = await popup.locator('.pop-ext').boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(380 - 8);
    expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
  });

  test('"Get premium" is the brightest thing in the header, and a signed-in user shows only their initial', async ({ fillie }) => {
    const popup = await openPopup(fillie);
    const bg = await popup.locator('.pop-getpremium').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(255, 177, 16)'); // marigold
    await expect(popup.locator('.pop-getpremium svg.pop-crown')).toBeVisible();
    await popup.evaluate(async () => {
      const cache = (await chrome.storage.local.get('fillie:popup-cache'))['fillie:popup-cache'];
      cache.status.access = { allowed: true, plan: 'trial', remaining: 2, limit: 3, signedIn: true, email: 'a.very.long.email.address.indeed@example-company.com' };
      cache.at = Date.now();
      await chrome.storage.local.set({ 'fillie:popup-cache': cache, 'fillie:popup-dirty': 0 });
    });
    await popup.reload();
    await popup.waitForSelector('.pop-user');
    await expect(popup.locator('.pop-user')).toHaveText('A');
    expect(await popup.locator('.pop-user-email').count()).toBe(0);
    const ext = await popup.locator('.pop-ext').boundingBox();
    expect(ext!.x + ext!.width).toBeLessThanOrEqual(372);
  });
});
