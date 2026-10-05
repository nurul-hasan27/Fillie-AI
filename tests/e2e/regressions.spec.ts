import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractResume } from '../../src/core/resume';
import { expect, panel, runFillieOn, test, waitForResults } from './fixtures';

/**
 * Regression cover for specific defects found while building Fillie. Each test
 * names the behaviour it protects rather than the file it lives in, so a failure
 * points at something a user would notice.
 */
test.describe('regressions', () => {
  test('the app page renders at full width, not collapsed to one column', async ({ fillie }) => {
    // A stray `class="app"` on the shell element made the grid apply twice and
    // squeezed every form field to zero width.
    await fillie.control.goto(`chrome-extension://${fillie.extensionId}/pages/app.html#/profile/personal`);
    await fillie.control.reload();
    await fillie.control.waitForSelector('input[name="personal.fullName"]');

    const width = await fillie.control.locator('input[name="personal.fullName"]').evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(200);
  });

  test('two profile fields can be edited one after another', async ({ fillie }) => {
    // Re-rendering on the first field's `change` event detached the second input
    // mid-edit, so the second value was silently lost.
    await fillie.control.goto(`chrome-extension://${fillie.extensionId}/pages/app.html#/profile/personal`);
    await fillie.control.reload();
    await fillie.control.waitForSelector('input[name="personal.fullName"]');

    await fillie.control.fill('input[name="personal.fullName"]', 'Ada Byron');
    await fillie.control.fill('input[name="personal.email"]', 'ada.byron@example.com');
    await fillie.control.click('[data-action="save-now"]');

    await expect
      .poll(async () => {
        const profile = await fillie.sendToWorker<{ personal: { fullName: string; email: string } }>({
          type: 'fillie:get-profile',
        });
        return `${profile.personal.fullName}|${profile.personal.email}`;
      }, { timeout: 20_000 })
      .toBe('Ada Byron|ada.byron@example.com');
  });

  test('a dropdown in the profile saves its selection', async ({ fillie }) => {
    // `<select>` was excluded from the change handler, so no dropdown could
    // ever be set.
    await fillie.control.goto(`chrome-extension://${fillie.extensionId}/pages/app.html#/profile/personal`);
    await fillie.control.reload();
    await fillie.control.waitForSelector('select[name="personal.gender"]');

    await fillie.control.selectOption('select[name="personal.gender"]', 'Non-binary');
    await expect
      .poll(async () => {
        const profile = await fillie.sendToWorker<{ personal: { gender: string } }>({ type: 'fillie:get-profile' });
        return profile.personal.gender;
      }, { timeout: 20_000 })
      .toBe('Non-binary');
  });

  test('a "no form here" page is informational, not an error', async ({ fillie }) => {
    const page = await fillie.open('/empty.html');
    await runFillieOn(page, fillie);
    await waitForResults(page);

    // It should read as guidance, not as a failure the user has to recover from.
    await expect(panel(page).locator('.notice[data-tone="danger"]')).toHaveCount(0);
    await expect(panel(page).locator('.notice')).toContainText(/could not find any question fields/i);
  });

  test('a resume PDF keeps technology names intact', async () => {
    // A camelCase split in the PDF text reader turned "TypeScript" into
    // "Type Script", which no form question could ever match. The parsing itself
    // is unit tested; this checks it end to end from the fixture file.
    const buffer = await readFile(path.resolve('tests/fixtures/resumes/resume.pdf'));
    const result = await extractResume(
      new File([new Uint8Array(buffer)], 'resume.pdf', { type: 'application/pdf' }),
    );

    expect(result.text).toContain('TypeScript');
    expect(result.suggestions.skills?.programmingLanguages).toContain('TypeScript');
    // "University of Cambridge" has no word before "University".
    expect(result.suggestions.education?.university).toBe('University of Cambridge');
  });

  test('an unreadable resume tells the user instead of doing nothing', async ({ fillie }) => {
    await fillie.control.goto(`chrome-extension://${fillie.extensionId}/pages/app.html#/settings/profile`);
    await fillie.control.reload();
    await fillie.control.waitForSelector('#resume-file');

    await fillie.control.setInputFiles('#resume-file', {
      name: 'resume.pages',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('not a real document'),
    });

    // An early version navigated away from the panel that held the warning, so
    // the user saw nothing at all.
    await expect(fillie.control.locator('#import-result')).toContainText(/PDF and DOCX/i, { timeout: 20_000 });
  });
});
