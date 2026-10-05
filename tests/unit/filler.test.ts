import { describe, expect, it, vi } from 'vitest';
import { scanDocument, type ScannedField } from '../../src/content/scanner';
import { fillField, fillFields, readFieldValue, verifyFields } from '../../src/content/filler';
import { setHtml } from './fixtures';

function scan(): ScannedField[] {
  return scanDocument(document);
}

function byLabel(fields: ScannedField[], label: string): ScannedField {
  const field = fields.find((f) => f.label === label);
  if (!field) throw new Error(`No field labelled "${label}" in [${fields.map((f) => f.label).join(', ')}]`);
  return field;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

describe('field filling', () => {
  it('writes text inputs through the native setter and fires events', async () => {
    setHtml(`<form><label for="n">Full name</label><input id="n" /></form>`);
    const events: string[] = [];
    const input = document.getElementById('n') as HTMLInputElement;
    for (const type of ['input', 'change', 'blur']) input.addEventListener(type, () => events.push(type));

    const result = await fillField(byLabel(scan(), 'Full name'), 'Ada Lovelace');
    expect(result.filled).toBe(true);
    expect(result.verified).toBe(true);
    expect(input.value).toBe('Ada Lovelace');
    expect(events).toContain('input');
    expect(events).toContain('change');
  });

  it('fills textareas with multi-line answers', async () => {
    setHtml(`<form><label for="a">About you</label><textarea id="a"></textarea></form>`);
    const field = byLabel(scan(), 'About you');
    const answer = 'First line.\n\nSecond paragraph.';
    const result = await fillField(field, answer);
    expect(result.filled).toBe(true);
    expect(readFieldValue(field)).toBe(answer);
  });

  it('selects the closest matching option in a dropdown', async () => {
    setHtml(`
      <form>
        <label for="c">Country</label>
        <select id="c"><option value="">Select</option><option value="uk">United Kingdom</option><option value="de">Germany</option></select>
      </form>
    `);
    const field = byLabel(scan(), 'Country');
    const result = await fillField(field, 'UK');
    expect(result.verified).toBe(true);
    expect((field.control.input as HTMLSelectElement).value).toBe('uk');
  });

  it('reports failure when no dropdown option matches', async () => {
    setHtml(`
      <form>
        <label for="c">Country</label>
        <select id="c"><option value="">Select</option><option value="uk">United Kingdom</option></select>
      </form>
    `);
    const result = await fillField(byLabel(scan(), 'Country'), 'Atlantis');
    expect(result.filled).toBe(false);
    expect(result.error).toContain('Atlantis');
  });

  it('checks exactly the matching radio option', async () => {
    setHtml(`
      <fieldset>
        <legend>Work mode</legend>
        <label><input type="radio" name="m" value="remote" /> Remote</label>
        <label><input type="radio" name="m" value="hybrid" /> Hybrid</label>
      </fieldset>
    `);
    const field = byLabel(scan(), 'Work mode');
    const result = await fillField(field, 'Hybrid');
    expect(result.verified).toBe(true);
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map((r) => r.checked)).toEqual([false, true]);
  });

  it('checks several checkboxes for a multi-select question', async () => {
    setHtml(`
      <div>
        <p class="title">Which skills do you have?</p>
        <label><input type="checkbox" name="s" value="js" /> JavaScript</label>
        <label><input type="checkbox" name="s" value="py" /> Python</label>
        <label><input type="checkbox" name="s" value="go" /> Go</label>
      </div>
    `);
    const field = byLabel(scan(), 'Which skills do you have?');
    const result = await fillField(field, ['JavaScript', 'Go']);
    expect(result.verified).toBe(true);
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes.map((b) => b.checked)).toEqual([true, false, true]);
  });

  it('checks an agreement checkbox', async () => {
    setHtml(`<form><label><input type="checkbox" name="terms" /> I agree to the privacy policy</label></form>`);
    const field = byLabel(scan(), 'I agree to the privacy policy');
    const result = await fillField(field, true);
    expect(result.verified).toBe(true);
    expect((field.control.input as HTMLInputElement).checked).toBe(true);
  });

  it('never writes to file inputs', async () => {
    setHtml(`<form><label for="cv">Upload your CV</label><input id="cv" type="file" /></form>`);
    const field = byLabel(scan(), 'Upload your CV');
    const result = await fillField(field, '/etc/passwd');
    expect(result.filled).toBe(false);
    expect(result.method).toBe('file');
  });

  it('attaches uploaded document to file input using dataUrl and fileName', async () => {
    setHtml(`<form><label for="cv">Upload your CV</label><input id="cv" type="file" /></form>`);
    const field = byLabel(scan(), 'Upload your CV');
    const b64 = btoa('Test resume document content');
    const result = await fillField(field, {
      fileName: 'resume.pdf',
      dataUrl: `data:application/pdf;base64,${b64}`,
    });
    expect(result.filled).toBe(true);
    expect(result.verified).toBe(true);
    const input = document.getElementById('cv') as HTMLInputElement;
    expect(input.files?.length).toBe(1);
    expect(input.files?.[0].name).toBe('resume.pdf');
  });

  it('detects validation messages the page raises after filling', async () => {
    setHtml(`
      <form>
        <label for="e">Email</label>
        <input id="e" type="email" />
        <span id="err" role="alert" hidden>Enter a valid email address</span>
      </form>
    `);
    const input = document.getElementById('e') as HTMLInputElement;
    input.addEventListener('change', () => {
      if (!input.validity.valid) document.getElementById('err')!.removeAttribute('hidden');
    });
    const result = await fillField(byLabel(scan(), 'Email'), 'not-an-email');
    expect(result.filled).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.error).toContain('valid email');
  });

  it('verifies a value that the page silently rejects', async () => {
    setHtml(`<form><label for="n">Name</label><input id="n" /></form>`);
    const input = document.getElementById('n') as HTMLInputElement;
    // Simulate a controlled component that resets what it does not accept.
    input.addEventListener('input', () => {
      if (input.value !== 'Ada') input.value = '';
    });
    const result = await fillField(byLabel(scan(), 'Name'), 'Grace');
    expect(result.filled).toBe(false);
    expect(result.error).toContain('rejected');
  });

  it('reports empty fields during verification', async () => {
    setHtml(`<form><label for="n">Name</label><input id="n" /></form>`);
    const field = byLabel(scan(), 'Name');
    await fillField(field, 'Ada');
    const results = await verifyFields([field], 0);
    expect(results.get(field.id)?.verified).toBe(true);

    (field.control.input as HTMLInputElement).value = '';
    const afterReset = await verifyFields([field], 0);
    expect(afterReset.get(field.id)?.verified).toBe(false);
    expect(afterReset.get(field.id)?.error).toContain('empty');
  });

  it('fills many fields and summarises outcomes', async () => {
    setHtml(`
      <form>
        <label for="a">Full name</label><input id="a" />
        <label for="b">Email</label><input id="b" />
        <label for="c">Phone</label><input id="c" />
      </form>
    `);
    const fields = scan();
    const summary = await fillFields(
      [
        { field: byLabel(fields, 'Full name'), answer: 'Ada Lovelace' },
        { field: byLabel(fields, 'Email'), answer: 'ada@example.com' },
        { field: byLabel(fields, 'Phone'), answer: '' },
      ],
      undefined,
      0,
    );
    expect(summary.attempted).toBe(3);
    expect(summary.verified).toBe(2);
  });

  it('does not re-write a value that is already correct', async () => {
    setHtml(`<form><label for="n">Name</label><input id="n" value="Ada" /></form>`);
    const field = byLabel(scan(), 'Name');
    const result = await fillField(field, 'Ada');
    expect(result.method).toBe('already-set');
    expect(result.verified).toBe(true);
  });

  it('respects a disabled control by refusing to write', async () => {
    setHtml(`<form><label for="n">Name</label><input id="n" disabled /></form>`);
    const field = byLabel(scan(), 'Name');
    expect(field.disabled).toBe(true);
    const result = await fillField(field, 'Ada');
    expect(result.filled).toBe(false);
  });

  it('reports when a custom widget rejects the chosen option', async () => {
    setHtml(`
      <div role="listbox" aria-label="Department">
        <div role="option">Engineering</div>
        <div role="option">Design</div>
      </div>
    `);
    const field = byLabel(scan(), 'Department');
    const result = await fillField(field, 'Marketing');
    expect(result.filled).toBe(false);
  });

  it('clicks the matching custom ARIA option', async () => {
    setHtml(`
      <div role="listbox" aria-label="Department">
        <div role="option" id="opt-eng">Engineering</div>
        <div role="option" id="opt-des">Design</div>
      </div>
    `);
    const clickSpy = vi.fn();
    document.getElementById('opt-des')!.addEventListener('click', clickSpy);
    const field = byLabel(scan(), 'Department');
    const result = await fillField(field, 'Design');
    expect(result.filled).toBe(true);
    expect(clickSpy).toHaveBeenCalled();
  });

  it('waits for framework updates before verifying', async () => {
    setHtml(`<form><label for="n">Name</label><input id="n" /></form>`);
    const field = byLabel(scan(), 'Name');
    await fillField(field, 'Ada');
    await settle();
    const results = await verifyFields([field], 0);
    expect(results.get(field.id)?.verified).toBe(true);
  });
});