import { describe, expect, it } from 'vitest';
import { scanDocument, cleanLabel, fingerprintOf, type ScannedField } from '../../src/content/scanner';
import { setHtml } from './fixtures';

function labels(fields: ScannedField[]): string[] {
  return fields.map((f) => f.label);
}

describe('form scanner', () => {
  it('detects labelled text, textarea and select controls', () => {
    setHtml(`
      <form>
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" required />
        <label for="about">About you</label>
        <textarea id="about" name="about"></textarea>
        <label for="country">Country</label>
        <select id="country" name="country">
          <option value="">Select</option>
          <option>United Kingdom</option>
          <option>Germany</option>
        </select>
      </form>
    `);
    const fields = scanDocument(document);
    expect(labels(fields)).toEqual(expect.arrayContaining(['Email address', 'About you', 'Country']));
    const email = fields.find((f) => f.label === 'Email address')!;
    expect(email.kind).toBe('email');
    expect(email.required).toBe(true);
    const country = fields.find((f) => f.label === 'Country')!;
    expect(country.kind).toBe('select');
    expect(country.options).toEqual(['Select', 'United Kingdom', 'Germany']);
  });

  it('groups radio buttons into a single question with options', () => {
    setHtml(`
      <form>
        <fieldset>
          <legend>Preferred work mode</legend>
          <label><input type="radio" name="mode" value="remote" /> Remote</label>
          <label><input type="radio" name="mode" value="hybrid" /> Hybrid</label>
          <label><input type="radio" name="mode" value="onsite" /> On-site</label>
        </fieldset>
      </form>
    `);
    const fields = scanDocument(document);
    const group = fields.find((f) => f.kind === 'radio');
    expect(group).toBeDefined();
    expect(group!.label).toBe('Preferred work mode');
    expect(group!.options).toEqual(['Remote', 'Hybrid', 'On-site']);
    expect(fields.filter((f) => f.kind === 'radio')).toHaveLength(1);
  });

  it('groups checkboxes into a multi-select question', () => {
    setHtml(`
      <div>
        <p id="lbl">Which of these do you know?</p>
        <label><input type="checkbox" name="skills" value="js" aria-describedby="lbl" /> JavaScript</label>
        <label><input type="checkbox" name="skills" value="py" aria-describedby="lbl" /> Python</label>
        <label><input type="checkbox" name="skills" value="go" aria-describedby="lbl" /> Go</label>
      </div>
    `);
    const fields = scanDocument(document);
    expect(fields.filter((f) => f.kind === 'checkbox')).toHaveLength(1);
    expect(fields[0].options).toEqual(['JavaScript', 'Python', 'Go']);
  });

  it('detects a lone agreement checkbox as an acknowledgement', () => {
    setHtml(`
      <form>
        <label><input type="checkbox" name="terms" /> I agree to the terms and privacy policy</label>
      </form>
    `);
    const fields = scanDocument(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].acknowledgement).toBe(true);
    expect(fields[0].options).toEqual([]);
  });

  it('reports passwords as sensitive but drops honeypots, hidden fields and submit buttons', () => {
    setHtml(`
      <form>
        <label for="pw">Password</label><input id="pw" type="password" />
        <label for="h">Honeypot</label><input id="h" type="text" style="position:absolute;left:-9999px" />
        <input type="hidden" name="csrf" value="x" />
        <label for="q">Real question</label><input id="q" />
        <button type="submit">Submit</button>
      </form>
    `);
    const fields = scanDocument(document);

    // A password is reported so the user can see it was noticed and declined…
    expect(labels(fields)).toEqual(['Password', 'Real question']);
    expect(fields[0].sensitive).toBe(true);
    expect(fields[1].sensitive).toBeUndefined();

    // …while a honeypot is dropped entirely: mentioning it would be pointless
    // and writing to it would flag the submission as automated.
    expect(labels(fields)).not.toContain('Honeypot');
  });

  it('flags a password field whose label is innocuous', () => {
    setHtml(`<form><label for="s">Secret</label><input id="s" type="password" /></form>`);
    const [field] = scanDocument(document);
    // Detection must not rely on the label saying "password".
    expect(field.sensitive).toBe(true);
  });

  it('captures Google Forms style ARIA controls', () => {
    setHtml(`
      <form class="freebirdFormviewerViewForm">
        <div class="freebirdFormviewerQuestionHeader">
          <div role="heading" aria-level="1">Which department do you want to join?</div>
        </div>
        <div role="listbox" aria-label="Which department do you want to join?">
          <div role="option">Engineering</div>
          <div role="option">Design</div>
        </div>
        <div class="freebirdFormviewerQuestionHeader">
          <div role="heading" aria-level="1">Why do you want this role?</div>
        </div>
        <textarea aria-label="Why do you want this role?"></textarea>
      </form>
    `);
    const fields = scanDocument(document);
    const select = fields.find((f) => f.kind === 'select');
    expect(select).toBeDefined();
    expect(select!.label).toBe('Which department do you want to join?');
    expect(select!.options).toEqual(['Engineering', 'Design']);
    expect(select!.source).toBe('google-forms');
    const textarea = fields.find((f) => f.kind === 'textarea');
    expect(textarea!.label).toBe('Why do you want this role?');
  });

  it('records section context from headings', () => {
    setHtml(`
      <section>
        <h3>Education</h3>
        <label for="cgpa">CGPA</label>
        <input id="cgpa" />
      </section>
    `);
    const fields = scanDocument(document);
    expect(fields[0].context).toBe('Education');
  });

  it('picks up unit suffixes as hints (e.g. "Years")', () => {
    setHtml(`
      <div>
        <label for="yrs">Years of experience</label>
        <input id="yrs" /><span>Years</span>
      </div>
    `);
    const fields = scanDocument(document);
    expect(fields[0].label).toBe('Years of experience');
    expect(fields[0].hint).toContain('Years');
  });

  it('marks file inputs as manual-only', () => {
    setHtml(`<form><label for="cv">Upload your CV</label><input id="cv" type="file" /></form>`);
    const fields = scanDocument(document);
    expect(fields[0].kind).toBe('file');
    expect(fields[0].manualOnly).toBe(true);
  });

  it('ignores Fillie’s own UI', () => {
    setHtml(`
      <div data-fillie="ui"><label for="x">Question</label><input id="x" /></div>
      <form><label for="y">Real question</label><input id="y" /></form>
    `);
    const fields = scanDocument(document);
    expect(labels(fields)).toEqual(['Real question']);
  });

  it('resolves real question title from Google Forms question card instead of opaque id i44', () => {
    setHtml(`
      <div class="freebirdFormviewerViewForm">
        <div class="freebirdFormviewerComponentsQuestionBaseRoot" role="listitem">
          <div class="freebirdFormviewerQuestionHeader">
            <div class="freebirdFormviewerComponentsQuestionBaseTitle">
              <span class="M7eMe" aria-hidden="true">*</span>
              <div role="heading" aria-level="3" class="MocG8c">
                <span class="MocG8c">What is your current notice period?</span>
              </div>
            </div>
          </div>
          <div class="freebirdTextinput">
            <input type="text" id="i44" class="whsOnd zHQkBf" placeholder="Your answer" />
          </div>
        </div>
      </div>
    `);
    const fields = scanDocument(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe('What is your current notice period?');
    expect(fields[0].label).not.toBe('I44');
    expect(fields[0].label).not.toBe('Your answer');
    expect(fields[0].required).toBe(true);
  });

  it('resolves question in modern Google Forms with .geS5n and .M7eMe', () => {
    setHtml(`
      <div role="listitem" class="QrPfOx">
        <div class="geS5n">
          <div class="MocG8c">
            <div role="heading" aria-level="3" class="M7eMe">What is your full name?</div>
          </div>
          <div class="AgroD">
            <div class="Xb9hP">
              <input type="text" id="i1" class="whsOnd" />
            </div>
          </div>
        </div>
      </div>
    `);
    const fields = scanDocument(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe('What is your full name?');
    expect(fields[0].label).not.toBe('I1');
  });

  it('resolves label from container in standard form-group where label has no for attribute', () => {
    setHtml(`
      <div class="form-group">
        <label class="field-label">Current Location</label>
        <div class="input-wrapper">
          <input type="text" id="i44" />
        </div>
      </div>
    `);
    const fields = scanDocument(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe('Current Location');
    expect(fields[0].label).not.toBe('I44');
  });

  it('ignores opaque generated identifiers and generic placeholders', () => {
    setHtml(`
      <form>
        <p>Where are you based?</p>
        <input id="i44" name="entry.1002" placeholder="Type here..." />
      </form>
    `);
    const fields = scanDocument(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe('Where are you based?');
    expect(fields[0].label).not.toBe('I44');
    expect(fields[0].label).not.toBe('Entry 1002');
    expect(fields[0].label).not.toBe('Type here...');
  });

  it('cleans decorative label noise including leading asterisks and bullets', () => {
    expect(cleanLabel('* Email address *')).toBe('Email address');
    expect(cleanLabel('• Full name (required)')).toBe('Full name');
    expect(cleanLabel('Full name (required)')).toBe('Full name');
    expect(fingerprintOf('  Email   Address ')).toBe('email address');
  });
});