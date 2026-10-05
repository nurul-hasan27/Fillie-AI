import type { AnswerValue, FillVerification } from '../core/types';
import type { OptionControl, ScannedField } from './scanner';
import { matchOption, normalizeText } from '../core/text';

/**
 * Field filling. Direct `.value = x` does not work on React-controlled inputs,
 * so every write goes through the native property setter and then dispatches the
 * events the page's framework listens for.
 */

/**
 * React (and several other frameworks) install their own `value` property on
 * the element instance. Writing through the *prototype's* setter — called with
 * the element as the receiver — bypasses that shadowing so the framework's own
 * change handler is the one that runs.
 */
function nativeSetter(proto: object, property: string): (element: object, value: string) => void {
  const descriptor = Object.getOwnPropertyDescriptor(proto, property);
  if (descriptor?.set) {
    return (element, value) => descriptor.set!.call(element, value);
  }
  return (element, value) => {
    (element as Record<string, unknown>)[property] = value;
  };
}

const setInputValue = nativeSetter(HTMLInputElement.prototype, 'value');
const setTextAreaValue = nativeSetter(HTMLTextAreaElement.prototype, 'value');
const setSelectValue = nativeSetter(HTMLSelectElement.prototype, 'value');

function fireEvents(element: HTMLElement, events: string[], data?: string): void {
  for (const type of events) {
    try {
      if ((type === 'input' || type === 'beforeinput') && typeof InputEvent !== 'undefined') {
        element.dispatchEvent(
          new InputEvent(type, {
            bubbles: true,
            cancelable: true,
            data: data ?? undefined,
            inputType: 'insertText',
          }),
        );
        continue;
      }
      if (type === 'keydown' || type === 'keyup' || type === 'keypress') {
        element.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true }));
        continue;
      }
    } catch {
      // Fall through to standard Event
    }
    element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  }
}

/** Types into an input the way a user would, for pages that need key events. */
async function typeIntoInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  safeFocus(input);

  // React synthetic event tracker sync
  const tracker = (input as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker;
  if (tracker) {
    tracker.setValue('');
  }

  const setter = input instanceof HTMLTextAreaElement ? setTextAreaValue : setInputValue;
  setter(input, '');
  fireEvents(input, ['beforeinput', 'input', 'keydown', 'keyup'], '');

  if (tracker) {
    tracker.setValue('');
  }

  // Chunked writes with input events so frameworks observe intermediate states.
  const chunkSize = 24;
  for (let i = 0; i < value.length; i += chunkSize) {
    const chunk = value.slice(0, i + chunkSize);
    if (tracker) tracker.setValue(value.slice(0, i));
    setter(input, chunk);
    fireEvents(input, ['beforeinput', 'input'], chunk);
  }
  if (tracker) tracker.setValue(input.value);
  setter(input, value);
  fireEvents(input, ['beforeinput', 'input', 'keydown', 'keyup', 'change', 'blur'], value);
}

function safeFocus(element: HTMLElement): void {
  try {
    element.focus({ preventScroll: true });
  } catch {
    try {
      (element as HTMLElement & { focus(): void }).focus();
    } catch {
      /* a page that blocks focus must not break filling */
    }
  }
}

function currentText(field: ScannedField): string {
  const input = field.control.input;
  if (!input) return '';
  if (input instanceof HTMLInputElement && (input.type === 'checkbox' || input.type === 'radio')) {
    return input.checked ? 'true' : 'false';
  }
  if (input instanceof HTMLSelectElement) {
    const option = input.options[input.selectedIndex];
    return option ? option.text.trim() : input.value;
  }
  return input.value ?? '';
}

const VALIDATION_SELECTOR =
  '[aria-live="polite"], [aria-live="assertive"], [role="alert"], [class*="error" i], [class*="invalid" i], [aria-invalid="true"]';

/**
 * Looks for a validation message near the control: aria-describedby first, then
 * live regions / error classes in the control's own subtree and in a couple of
 * ancestors (form row wrappers are the usual layout).
 */
function findValidationMessage(field: ScannedField): string {
  const root = field.control.element ?? document.body;

  const describedBy = root
    .getAttribute('aria-describedby')
    ?.split(/\s+/)
    .map((id) => document.getElementById(id))
    .filter(Boolean)
    .map((node) => (node as HTMLElement).textContent ?? '')
    .join(' ');
  const described = normalizeText(describedBy ?? '');
  if (described && described.length < 300 && !isGenericValidityText(described)) return described;

  let scope: HTMLElement | null = root;
  for (let depth = 0; scope && depth < 3; depth += 1) {
    const message = scope.querySelector?.(VALIDATION_SELECTOR);
    const text = normalizeText(message?.textContent ?? '');
    if (text && text.length < 300 && !isGenericValidityText(text)) return text;
    scope = scope.parentElement;
  }

  const validity = (field.control.input as HTMLInputElement | undefined)?.validationMessage;
  return validity ? normalizeText(validity) : '';
}

/** Placeholder validity strings carry no information; prefer the page's own text. */
function isGenericValidityText(text: string): boolean {
  return /^(invalid value|constraint violation|please (fill|enter|provide)|this field is required)/i.test(text);
}

async function selectCustomOption(field: ScannedField, target: string, options: OptionControl[]): Promise<boolean> {
  const root = field.control.element;
  if (!root) return false;

  const available = options.length
    ? options
    : Array.from(root.querySelectorAll('[role="option"], li, [data-value]')).map((node) => ({
        text: normalizeText(node.textContent ?? ''),
        element: node as HTMLElement,
      }));

  const match = matchOption(target, available.map((option) => option.text), 0.5);
  if (!match) return false;

  // Many custom widgets only reveal options after opening the dropdown.
  if (!available.some((option) => option.element.isConnected && option.element.getClientRects().length)) {
    root.click();
    await wait(80);
  }

  const liveOptions = Array.from(document.querySelectorAll('[role="option"], li[data-value]'))
    .map((node) => ({ text: normalizeText(node.textContent ?? ''), element: node as HTMLElement }))
    .filter((option) => option.text.length > 0 && option.element.getClientRects().length);

  const best =
    liveOptions.length > 0
      ? liveOptions
          .map((option) => ({ option, score: optionSimilarity(match.option, option.text) }))
          .sort((a, b) => b.score - a.score)[0]
      : undefined;

  const target_ = best && best.score > 0.55 ? best.option : available.find((option) => option.text === match.option);
  if (!target_) return false;

  target_.element.scrollIntoView({ block: 'nearest' });
  target_.element.click();
  fireEvents(target_.element, ['change', 'click']);
  await wait(60);
  return true;
}

function optionSimilarity(a: string, b: string): number {
  return matchOption(b, [a], 0.0)?.score ?? 0;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fillSelect(field: ScannedField, answer: AnswerValue): Promise<FillVerification> {
  const select = field.control.input;
  const target = Array.isArray(answer) ? answer[0] : answer === null ? '' : String(answer);
  if (!target) return { filled: false, verified: false, error: 'No option was chosen.', method: 'select' };

  if (select instanceof HTMLSelectElement) {
    const match = matchOption(target, Array.from(select.options).map((option) => option.text.trim()), 0.5);
    if (!match) {
      return {
        filled: false,
        verified: false,
        error: `“${target}” is not one of the options.`,
        method: 'select',
      };
    }
    const optionValue = Array.from(select.options).find((option) => option.text.trim() === match.option)?.value ?? match.option;
    setSelectValue(select, optionValue);
    fireEvents(select, ['input', 'change']);
    await wait(30);
    const ok = select.value === optionValue;
    return { filled: ok, verified: ok, method: 'select' };
  }

  const ok = await selectCustomOption(field, target, field.control.options);
  await wait(40);
  const label = normalizeText(field.control.element?.textContent ?? '');
  return { filled: ok, verified: ok && (!label || label.toLowerCase().includes(matchOption(target, [label], 0)?.option?.toLowerCase() ?? '')), method: 'custom-select' };
}

async function fillBooleanGroup(field: ScannedField, answer: AnswerValue): Promise<FillVerification> {
  const wanted = (Array.isArray(answer) ? answer : answer === null ? [] : [String(answer)]).map(String);
  const options = field.control.options;

  if (!options.length) {
    // A standalone checkbox (e.g. "I agree to the terms").
    const element = field.control.element;
    if (!element) return { filled: false, verified: false, error: 'Control not found.', method: 'checkbox' };
    const shouldCheck =
      answer === true || wanted.some((value) => /^(true|yes|agree|accepted|i agree)\b/i.test(value.trim()));
    const candidate = field.control.input ?? (element instanceof HTMLInputElement ? element : undefined);
    const input = candidate instanceof HTMLInputElement ? candidate : undefined;
    const isChecked = (): boolean =>
      input ? input.checked : element.getAttribute('aria-checked') === 'true';

    if (isChecked() !== shouldCheck) {
      (input ?? element).click();
      await wait(40);
    }
    const after = isChecked() === shouldCheck;
    return {
      filled: after,
      verified: after,
      method: input ? 'checkbox' : 'aria-checkbox',
    };
  }

  for (const option of options) {
    const shouldCheck = wanted.some((value) => matchOption(value, [option.text], 0.55)?.option === option.text);
    const input = option.input;
    const current = input ? input.checked : option.element.getAttribute('aria-checked') === 'true';
    if (current === shouldCheck) continue;
    if (shouldCheck) {
      option.element.click();
      await wait(25);
    } else if (input) {
      // Only uncheck when explicitly asked; never clear user selections silently.
      input.click();
      await wait(25);
    }
  }

  const allMatch = options.every((option) => {
    const shouldCheck = wanted.some((value) => matchOption(value, [option.text], 0.55)?.option === option.text);
    const current = option.input ? option.input.checked : option.element.getAttribute('aria-checked') === 'true';
    return current === shouldCheck;
  });

  return {
    filled: allMatch,
    verified: allMatch,
    error: allMatch ? undefined : 'The page did not accept every selection.',
    method: options.some((option) => option.input) ? 'checkbox-group' : 'aria-checkbox-group',
  };
}

async function fillText(field: ScannedField, answer: AnswerValue): Promise<FillVerification> {
  let control = field.control.input;
  if (!control || control instanceof HTMLSelectElement) {
    const el = field.control.element;
    const found = el?.querySelector('input:not([type="hidden"]), textarea') as HTMLInputElement | HTMLTextAreaElement | null;
    if (found) {
      control = found;
    }
  }

  const value = Array.isArray(answer) ? answer.join(', ') : answer === null ? '' : String(answer);
  if (!value) return { filled: false, verified: false, error: 'Nothing to write.', method: 'text' };

  if (!control || control instanceof HTMLSelectElement) {
    const ce = field.control.element?.getAttribute('contenteditable') === 'true'
      ? field.control.element
      : (field.control.element?.querySelector('[contenteditable="true"]') as HTMLElement | null);
    if (ce) {
      safeFocus(ce);
      ce.textContent = value;
      fireEvents(ce, ['beforeinput', 'input', 'change', 'blur'], value);
      await wait(60);
      const ok = normalizeText(ce.textContent ?? '') === normalizeText(value);
      return { filled: ok, verified: ok, method: 'contenteditable' };
    }
    return { filled: false, verified: false, error: 'Control not found.', method: 'text' };
  }
  const input = control;

  const before = input.value;
  if (before === value) {
    return { filled: true, verified: true, method: 'already-set' };
  }

  await typeIntoInput(input, value);
  await wait(60);

  const after = input.value;
  const accepted = after === value || normalizeText(after) === normalizeText(value);
  let error: string | undefined;
  if (!accepted) {
    error = `The field rejected the value (kept “${after.slice(0, 40)}”).`;
  } else {
    // Prefer the page's own message (it is more specific), then fall back to
    // native constraint validation for frameworks that render no error node.
    error = findValidationMessage(field);
    if (!error) {
      const inputElement = input as HTMLInputElement;
      if (inputElement.validity && !inputElement.validity.valid) {
        error =
          normalizeText(inputElement.validationMessage ?? '') ||
          'The page rejected this value as invalid.';
      }
    }
  }

  return {
    filled: accepted,
    verified: accepted && !error,
    error,
    method: input instanceof HTMLTextAreaElement ? 'textarea' : 'input',
  };
}

function dataUrlToFile(dataUrl: string, fileName: string): File | null {
  try {
    const arr = dataUrl.split(',');
    if (arr.length < 2) return null;
    const mimeMatch = arr[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], fileName, { type: mime });
  } catch {
    return null;
  }
}

async function fillFileInput(field: ScannedField, answer: AnswerValue): Promise<FillVerification> {
  const input = field.control.input;
  if (!(input instanceof HTMLInputElement) || input.type !== 'file') {
    return { filled: false, verified: false, error: 'File input not found.', method: 'file' };
  }

  // Security guard: Never accept arbitrary string paths (like /etc/passwd)
  if (typeof answer !== 'object' || !answer || Array.isArray(answer)) {
    return { filled: false, verified: false, error: 'You attach files yourself.', method: 'file' };
  }

  const doc = answer as { dataUrl?: string; fileName?: string; name?: string };
  if (!doc.dataUrl || !doc.fileName) {
    return { filled: false, verified: false, error: 'No document data available to attach.', method: 'file' };
  }

  try {
    const file = dataUrlToFile(doc.dataUrl, doc.fileName);
    if (!file) {
      return { filled: false, verified: false, error: 'Failed to prepare file for upload.', method: 'file' };
    }

    if (typeof DataTransfer !== 'undefined') {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
    } else {
      Object.defineProperty(input, 'files', {
        value: [file],
        writable: true,
        configurable: true,
      });
    }

    fireEvents(input, ['input', 'change']);
    await wait(30);
    const ok = Boolean(input.files && input.files.length > 0);
    return { filled: ok, verified: ok, method: 'file' };
  } catch (err) {
    return { filled: false, verified: false, error: err instanceof Error ? err.message : 'Failed to attach file.', method: 'file' };
  }
}

/** Writes a single answer and reports what actually happened. */
export async function fillField(field: ScannedField, answer: AnswerValue): Promise<FillVerification> {
  if (!field.control.element && !field.control.input) {
    return { filled: false, verified: false, error: 'Control not found.', method: 'missing' };
  }
  // Never write to a control the page has disabled or hidden.
  if (field.disabled) {
    return { filled: false, verified: false, error: 'This control is disabled on the page.', method: 'disabled' };
  }
  if (field.kind === 'file') {
    return fillFileInput(field, answer);
  }
  switch (field.kind) {
    case 'select':
      return fillSelect(field, answer);
    case 'checkbox':
    case 'radio':
      return fillBooleanGroup(field, answer);
    default:
      return fillText(field, answer);
  }
}

export interface FillSummary {
  attempted: number;
  verified: number;
  failed: number;
}

/** Writes many answers with a small delay so pages can settle between fields. */
export async function fillFields(
  entries: Array<{ field: ScannedField; answer: AnswerValue }>,
  onResult?: (field: ScannedField, verification: FillVerification) => void,
  delayMs = 60,
): Promise<FillSummary> {
  const summary: FillSummary = { attempted: entries.length, verified: 0, failed: 0 };
  for (const { field, answer } of entries) {
    const result = await fillField(field, answer);
    summary.verified += result.verified ? 1 : 0;
    summary.failed += result.filled && !result.verified ? 1 : 0;
    onResult?.(field, result);
    if (delayMs) await wait(delayMs);
  }
  return summary;
}

/** Reads the live value of a field for verification/review purposes. */
export function readFieldValue(field: ScannedField): string {
  return currentText(field);
}

/** Re-checks fields after the page has settled — catches silent resets. */
export async function verifyFields(
  fields: ScannedField[],
  delayMs = 250,
): Promise<Map<string, FillVerification>> {
  if (delayMs) await wait(delayMs);
  const results = new Map<string, FillVerification>();
  for (const field of fields) {
    const value = readFieldValue(field).trim();
    const error = value.length === 0 ? 'The field was empty after filling.' : findValidationMessage(field);
    results.set(field.id, {
      filled: value.length > 0,
      verified: value.length > 0 && !error,
      error: error || undefined,
      method: field.kind,
    });
  }
  return results;
}

/** Highlights a control so the user can see exactly what Fillie touched. */
export function highlightField(field: ScannedField, state: 'filled' | 'attention' | 'error' = 'filled'): void {
  const element = field.control.element;
  if (!element) return;
  element.classList.add('fillie-highlight', `fillie-highlight--${state}`);
  element.setAttribute('data-fillie-marked', 'true');
  window.setTimeout(() => {
    element.classList.remove('fillie-highlight', `fillie-highlight--${state}`);
  }, 2600);
}

/** Focuses a control (used when the user clicks a field in the review list). */
export function focusField(field: ScannedField): void {
  const target = field.control.input ?? field.control.element;
  if (!target) return;
  try {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch {
    /* scrolling is a nicety, never a requirement */
  }
  safeFocus(target);
}