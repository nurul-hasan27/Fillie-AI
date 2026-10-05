import type { DetectedField, FieldKind, ScanResult } from '../core/types';
import { normalizeForMatch } from '../core/text';

export interface OptionControl {
  /** Visible option text. */
  text: string;
  /** The clickable element (native input or ARIA widget). */
  element: HTMLElement;
  /** Native input for radio/checkbox, when there is one. */
  input?: HTMLInputElement;
  /** Current state at scan time. */
  checked?: boolean;
}

export interface FieldControl {
  kind: FieldKind;
  /** Primary element (the input itself, or the custom widget root). */
  element: HTMLElement | null;
  input?: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  options: OptionControl[];
  /** True when the widget opens a popup instead of holding a native value. */
  custom?: boolean;
}

export interface ScannedField extends DetectedField {
  control: FieldControl;
}

export interface ScanOptions {
  /** Only include fields inside this root (default: document). */
  root?: HTMLElement;
  /** Include controls that are not currently visible. */
  includeHidden?: boolean;
  /** Maximum number of fields returned. */
  maxFields?: number;
}

/** Types Fillie never touches. `file` is detected but always left to the user. */
const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image', 'search', 'color', 'range']);
const FORM_TAGS = new Set(['input', 'textarea', 'select', 'button']);

/**
 * Field ids are stable per DOM element for the lifetime of the page. Rescans
 * (dynamic forms, re-renders) therefore keep the same id for the same control,
 * which is what lets the runtime match plans to controls across scans.
 */
const fieldIds = new WeakMap<Element, string>();
let fieldCounter = 0;
let groupCounter = 0;

function idForField(element: Element): string {
  const existing = fieldIds.get(element);
  if (existing) return existing;
  fieldCounter += 1;
  const id = `f${fieldCounter}`;
  fieldIds.set(element, id);
  return id;
}

/** Is this element inside a Fillie surface? */
export function isFillieOwned(node: Element | null): boolean {
  let cursor: Element | null = node;
  while (cursor) {
    if (cursor.getAttribute?.('data-fillie') === 'ui') return true;
    cursor = cursor.parentElement;
  }
  return false;
}

export function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  const style = getComputedStyle(element);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  // Only treat a *parsed* opacity of 0 as hidden; some engines report "" here.
  const opacity = Number.parseFloat(style.opacity);
  if (Number.isFinite(opacity) && opacity === 0) return false;
  if (element.hasAttribute('hidden')) return false;
  const rects = element.getClientRects();
  if (rects.length) {
    const rect = rects[0];
    if (rect.width > 0 && rect.height > 0) return true;
  }
  // Fall back to layout boxes: many styled controls report zero rects in jsdom.
  return element.offsetParent !== null || element.getClientRects().length > 0;
}

/** Detects honeypot fields: visually hidden but present in the DOM. */
export function isHoneypot(element: HTMLElement): boolean {
  if (element.getAttribute('aria-hidden') === 'true') return true;
  if (element.tabIndex < 0 && !element.getAttribute('aria-label') && !element.getAttribute('name')) return true;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect?.();
  if (rect && (rect.left < -500 || rect.top < -500)) return true;
  if (style.position === 'absolute' && (style.left === '-9999px' || style.left === '-10000px')) return true;
  return false;
}

function textOf(node: Element | null, limit = 220): string {
  if (!node) return '';
  const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Detects opaque or auto-generated identifiers that are internal IDs rather than
 * human question titles (e.g. "i44", "i1", "entry.1002", "input_1", ":r0:").
 */
export function isOpaqueIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  // Single letter + digits (e.g. i44, i1, I44, c2, q3, f1, t4)
  if (/^[a-zA-Z]\d+$/i.test(trimmed)) return true;
  // Google Forms entry IDs: entry.123456
  if (/^entry\.\d+$/i.test(trimmed)) return true;
  // Generic input/field names: input_1, field-2, control_3, form_4, element-5, item-6, q123
  if (/^(input|field|control|element|el|form|item|q|question|opt|option|choice|param|data|text|val|value)[-_.]?\d+$/i.test(trimmed)) return true;
  // React 18 useId: :r0:, :r1:, etc.
  if (/^:r[0-9a-z]+:$/i.test(trimmed)) return true;
  // Pure numbers or hex IDs/UUIDs
  if (/^\d+$/.test(trimmed)) return true;
  if (/^[0-9a-f]{8,}$/i.test(trimmed)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return true;
  // Fewer than 2 letters remain when stripped of symbols/numbers
  const lettersOnly = trimmed.replace(/[^a-zA-Z]/g, '');
  if (lettersOnly.length < 2) return true;
  return false;
}

/** Identifies generic placeholders that describe input action rather than the question itself. */
export function isGenericPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /^(your answer|enter answer|type here|write here|enter text|enter your answer|type your answer|your response|type something|type|write|text|input|answer|select|choose|select one|select an option|choose one|choose an option|e\.?g\.?|eg\.?|example)\b/i.test(trimmed);
}

/** Removes decorative characters that end up inside auto-detected labels. */
export function cleanLabel(label: string): string {
  return label
    .replace(/^\s*[*•]\s*/, '')
    .replace(/\s*[*•]\s*$/, '')
    .replace(/\s*\(required\)\s*$/i, '')
    .replace(/^\s*\(required\)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Heuristic: does this text read like something a person is being asked? */
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  if (trimmed.length > 160) return false;
  return /[?？]\s*$/.test(trimmed) || /^(which|what|who|when|where|why|how|do|does|did|are|is|have|has|select|choose|pick|preferred|desired|indicate|specify|how many|how much)\b/i.test(trimmed);
}

/** Walks backwards through siblings looking for a heading-ish element. */
export function findPrecedingLabel(element: HTMLElement): string {
  let node: Element | null = element;
  for (let steps = 0; node && steps < 4; steps += 1) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.querySelector('input, textarea, select')) {
        sibling = sibling.previousElementSibling;
        continue;
      }
      const text = cleanLabel(textOf(sibling, 160));
      if (text && text.length < 200 && !isOpaqueIdentifier(text)) return text;
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return '';
}

/**
 * Searches enclosing question cards or form groups (e.g. Google Forms cards,
 * Bootstrap .form-group, Workday wrappers, fieldsets) to find the question title.
 */
function resolveQuestionFromAncestors(element: Element): string {
  // 1. Google Forms question card containers
  const googleRoot = element.closest(
    '.freebirdFormviewerComponentsQuestionBaseRoot, [role="listitem"], .geS5n, .QrPfOx, [data-qa-hh-form-id]'
  );
  if (googleRoot) {
    const titleEl = googleRoot.querySelector(
      '.freebirdFormviewerComponentsQuestionBaseTitle, [role="heading"], .M7eMe, .HoFDJf, .F9NWFb, .MocG8c'
    );
    if (titleEl && !titleEl.contains(element)) {
      const text = cleanLabel(textOf(titleEl, 220));
      if (text && !isOpaqueIdentifier(text) && text !== '*') return text;
    }
  }

  // 2. Standard form-group or question wrappers
  const group = element.closest(
    'fieldset, [role="group"], [role="radiogroup"], .form-group, .form-item, .form-row, .form-field, .field, .field-wrapper, .input-group, .input-wrapper, .form-control-wrapper, .question, .survey-question, .application-question, [data-qa*="question"], [data-testid*="question"], [data-automation-id*="formField"], [data-automation-id*="form-field"]'
  );
  if (group) {
    // If legend or heading reads like a question, that is ideal
    const heading = group.querySelector('legend, [role="heading"], h1, h2, h3, h4, h5, h6');
    if (heading && !heading.contains(element) && looksLikeQuestion(textOf(heading))) {
      const text = cleanLabel(textOf(heading, 220));
      if (text && !isOpaqueIdentifier(text)) return text;
    }
    // Check for <label> inside group
    const labels = Array.from(group.querySelectorAll('label'));
    for (const lbl of labels) {
      if (lbl.htmlFor && element.id && lbl.htmlFor !== element.id) continue;
      if (lbl.querySelector('input, textarea, select') && !lbl.contains(element)) continue;
      const clone = lbl.cloneNode(true) as HTMLElement;
      for (const ctrl of clone.querySelectorAll('input,textarea,select,button')) ctrl.remove();
      const text = cleanLabel(textOf(clone, 220));
      if (text && !isOpaqueIdentifier(text)) return text;
    }
    // Check for element with label/title/question class
    const titleLike = group.querySelector(
      '.field-label, .form-label, .control-label, .question-title, .question-text, [class*="label" i], [class*="title" i], [class*="question" i]'
    );
    if (titleLike && !titleLike.contains(element) && !titleLike.querySelector('input, textarea, select')) {
      const text = cleanLabel(textOf(titleLike, 220));
      if (text && !isOpaqueIdentifier(text)) return text;
    }
    // Fallback heading
    if (heading && !heading.contains(element)) {
      const text = cleanLabel(textOf(heading, 220));
      if (text && !isOpaqueIdentifier(text)) return text;
    }
  }

  // 3. Walk up ancestors (up to 5 levels) looking for sibling labels or headings
  let cursor: Element | null = element.parentElement;
  for (let depth = 0; cursor && depth < 5 && !/^(FORM|BODY|MAIN|HTML)$/i.test(cursor.tagName); depth += 1) {
    let prev = cursor.previousElementSibling;
    while (prev) {
      if (!prev.querySelector('input, textarea, select')) {
        const text = cleanLabel(textOf(prev, 200));
        if (
          text &&
          !isOpaqueIdentifier(text) &&
          (looksLikeQuestion(text) ||
            prev.matches('label, [role="heading"], h1, h2, h3, h4, h5, h6, legend, [class*="title" i], [class*="label" i]'))
        ) {
          return text;
        }
      }
      prev = prev.previousElementSibling;
    }

    const heading = cursor.querySelector(
      ':scope > legend, :scope > [role="heading"], :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > label, :scope > [class*="label" i], :scope > [class*="title" i]'
    );
    if (heading && heading !== element && !heading.contains(element)) {
      const text = cleanLabel(textOf(heading, 220));
      if (text && !isOpaqueIdentifier(text)) return text;
    }

    cursor = cursor.parentElement;
  }

  return '';
}

function ariaLabelledByText(element: Element): string {
  const ids = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  if (!ids.length) return '';
  return ids
    .filter((id) => id !== element.id)
    .map((id) => document.getElementById(id))
    .filter((node): node is HTMLElement => Boolean(node) && node !== element)
    .map((node) => textOf(node))
    .map((text) => cleanLabel(text))
    .filter((text) => text && text !== '*' && !isOpaqueIdentifier(text))
    .join(' ')
    .trim();
}

function ariaDescribedByText(element: Element): string {
  const ids = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  if (!ids.length) return '';
  return ids
    .map((id) => document.getElementById(id))
    .map((node) => textOf(node, 160))
    .filter(Boolean)
    .join(' ');
}

/** Finds the visible text that labels a control, using many strategies. */
export function resolveLabel(element: Element): string {
  // 1. Explicit aria-label (when meaningful)
  const aria = element.getAttribute('aria-label');
  if (aria && aria.trim() && !isGenericPlaceholder(aria) && !isOpaqueIdentifier(aria)) {
    return cleanLabel(aria.trim());
  }

  // 2. aria-labelledby
  const labelledBy = ariaLabelledByText(element);
  if (labelledBy && !isOpaqueIdentifier(labelledBy) && labelledBy !== '*') {
    return cleanLabel(labelledBy);
  }

  // 3. Direct <label for="..."> or wrapping <label>
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    const id = element.id;
    if (id) {
      const explicit = document.querySelector(`label[for="${cssEscape(id)}"]`);
      const explicitText = textOf(explicit, 220);
      if (explicitText && !isOpaqueIdentifier(explicitText)) return cleanLabel(explicitText);
    }
    const wrapping = element.closest('label');
    if (wrapping) {
      const clone = wrapping.cloneNode(true) as HTMLElement;
      for (const control of clone.querySelectorAll('input,textarea,select')) control.remove();
      const wrappingText = textOf(clone, 220);
      if (wrappingText && !isOpaqueIdentifier(wrappingText)) return cleanLabel(wrappingText);
    }
  }

  // 4. Enclosing question card or form group (Google Forms, Workday, etc.)
  const containerLabel = resolveQuestionFromAncestors(element);
  if (containerLabel) return cleanLabel(containerLabel);

  // 5. Preceding text or heading
  if (element instanceof HTMLElement) {
    const preceding = findPrecedingLabel(element);
    if (preceding && !isOpaqueIdentifier(preceding)) return cleanLabel(preceding);
  }

  // 6. Placeholder (if descriptive, not generic)
  const placeholder = element.getAttribute('placeholder');
  if (placeholder && placeholder.trim() && !isGenericPlaceholder(placeholder) && !isOpaqueIdentifier(placeholder)) {
    return cleanLabel(placeholder.trim());
  }

  // 7. Title attribute
  const title = element.getAttribute('title');
  if (title && title.trim() && !isOpaqueIdentifier(title)) return cleanLabel(title.trim());

  // 8. Fieldset legend
  const legend = element.closest('fieldset')?.querySelector('legend') ?? null;
  const legendText = textOf(legend, 160);
  if (legendText && !isOpaqueIdentifier(legendText)) return cleanLabel(legendText);

  // 9. Sibling text
  const parent = element.parentElement;
  if (parent) {
    const siblingText = Array.from(parent.children)
      .filter((child) => child !== element && !child.contains(element))
      .map((child) => textOf(child, 120))
      .filter((text) => text && text.length < 140 && !isOpaqueIdentifier(text))
      .join(' ');
    if (siblingText) return cleanLabel(siblingText);
  }

  // 10. Autocomplete attribute mapping
  const autocomplete = element.getAttribute('autocomplete');
  if (autocomplete && autocomplete !== 'off' && autocomplete !== 'on') {
    const autoMap: Record<string, string> = {
      'given-name': 'First Name',
      'family-name': 'Last Name',
      'tel-country-code': 'Phone Country Code',
      'tel-national': 'National Phone',
      'tel-extension': 'Phone Extension',
    };
    if (autoMap[autocomplete]) return autoMap[autocomplete];
  }

  // 11. Name attribute (only if human-readable, not opaque like "i44" or "entry.1001")
  const name = element.getAttribute('name');
  if (name && !isOpaqueIdentifier(name)) {
    const humanized = humanizeAttribute(name);
    if (humanized && !isOpaqueIdentifier(humanized)) return cleanLabel(humanized);
  }

  // 12. Id attribute (only if human-readable, NEVER opaque like "i44")
  const id = element.getAttribute('id');
  if (id && !isOpaqueIdentifier(id)) {
    const humanized = humanizeAttribute(id);
    if (humanized && !isOpaqueIdentifier(humanized)) return cleanLabel(humanized);
  }

  // 13. Context heading fallback
  const ctx = resolveContext(element);
  if (ctx && !isOpaqueIdentifier(ctx)) return cleanLabel(ctx);

  return '';
}

function humanizeAttribute(value: string): string {
  return value
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function cssEscape(value: string): string {
  const escape = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  if (escape) return escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * Nearest section heading for context.
 *
 * A legend belongs only to the fieldset that owns it — never to the whole form,
 * where a sibling question's legend would otherwise hijack every other field.
 */
export function resolveContext(element: Element): string {
  const legendText = textOf(element.closest('fieldset')?.querySelector(':scope > legend') ?? null, 160);
  if (legendText) return legendText;

  const scope: Element | null = element.closest('fieldset, section, form, [role="region"]') ?? element.parentElement;
  let cursor: Element | null = scope;
  while (cursor && cursor !== document.body) {
    const heading = Array.from(cursor.children).find(
      (child) => /^(H1|H2|H3|H4|H5|H6)$/.test(child.tagName) || child.getAttribute('role') === 'heading',
    );
    if (heading) {
      const headingText = textOf(heading, 140);
      if (headingText) return headingText;
    }
    cursor = cursor.parentElement;
  }
  return '';
}

export function isRequired(element: Element, label: string): boolean {
  if ((element as HTMLInputElement).required) return true;
  if (element.getAttribute('aria-required') === 'true') return true;
  if (element.getAttribute('data-required') === 'true') return true;
  if (/\*/.test(label) && /(required|mandatory)/i.test(label)) return true;
  // Google Forms marks required questions with a dedicated aria element.
  const parent = element.closest('[data-required], .freebirdFormviewerComponentsQuestionBaseRoot') as HTMLElement | null;
  if (parent?.querySelector?.('[aria-label*="Required" i], .freebirdFormviewerComponentsQuestionBaseTitle') && /\*/.test(textOf(parent, 200))) {
    return true;
  }
  return false;
}

export function detectSource(element: Element): 'native' | 'google-forms' | 'custom' {
  if (
    element.closest(
      'form.freebirdFormviewerViewForm, .freebirdFormviewerViewForm, [data-qa-hh-form-id], .freebirdFormviewerComponentsQuestionBaseRoot, .geS5n, .QrPfOx',
    )
  ) {
    return 'google-forms';
  }
  if (element instanceof HTMLInputElement && /^entry\.\d+$/.test(element.name ?? '')) return 'google-forms';
  return element.matches('input,textarea,select') ? 'native' : 'custom';
}

function kindForInput(input: HTMLInputElement): FieldKind | null {
  switch (input.type) {
    case 'text':
      return 'text';
    case 'email':
      return 'email';
    case 'tel':
      return 'tel';
    case 'url':
      return 'url';
    case 'number':
      return 'number';
    case 'date':
    case 'month':
    case 'week':
      return 'date';
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'file':
      return 'file';
    case 'password':
      // Kept so the field can be reported as "you handle this one" rather than
      // vanishing from the list without explanation.
      return 'text';
    default:
      return null;
  }
}

function hintFor(element: Element, label: string): string | undefined {
  const described = ariaDescribedByText(element);
  const placeholder = element.getAttribute('placeholder');
  const unit = findUnitSuffix(element);
  const parts = [described, placeholder, unit].filter(Boolean) as string[];
  const combined = parts.join(' · ');
  if (!combined) return undefined;
  if (combined.replace(/\s/g, '').toLowerCase() === label.replace(/\s/g, '').toLowerCase()) return undefined;
  return combined.slice(0, 200);
}

/** "Years of experience" style suffix labels often live right after the input. */
function findUnitSuffix(element: Element): string {
  const parent = element.parentElement;
  if (!parent) return '';
  const siblings = Array.from(parent.children).filter(
    (child) => child !== element && !child.contains(element) && child.tagName !== 'LABEL',
  );
  for (const sibling of siblings.slice(0, 2)) {
    const text = textOf(sibling, 40);
    // Only units, never a heading or question fragment.
    if (text && text.length <= 24 && /^(years?|months?|days?|hrs?|hours?|weeks?|%|[$£₹€]|per \w+)$/i.test(text)) {
      return text;
    }
  }
  return '';
}

/**
 * A lone checkbox with no option list is an acknowledgement ("I agree…"), not a
 * multi-select — Fillie treats those differently.
 */
function looksLikeAcknowledgement(label: string, options: ReadonlyArray<{ text?: string }> = []): boolean {
  if (options.length) return false;
  return /\b(i agree|agree to|terms|privacy policy|consent|declare|attest|certif(y|ied) that)\b/i.test(label);
}

function looksLikePasswordOrSecret(label: string, inputType: string): boolean {
  return (
    inputType === 'password' ||
    /\b(password|passcode|otp|one[- ]time|cvv|card number|security code|2fa|mfa|otp code)\b/i.test(label)
  );
}

interface ScanAccumulator {
  fields: ScannedField[];
  seen: Set<HTMLElement>;
  /** Element the field id is anchored to; null only for synthetic fields. */
  root: Element | null;
}

function addField(
  acc: ScanAccumulator,
  field: Omit<ScannedField, 'id' | 'fingerprint' | 'control'> & { control: FieldControl },
  label: string,
  anchor?: Element | null,
): ScannedField {
  const scanned: ScannedField = {
    ...field,
    id: anchor ? idForField(anchor) : `g${++groupCounter}`,
    fingerprint: label.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160),
    control: field.control,
  } as ScannedField;
  // Session-only handle for the filler and for reading values back on submit.
  // It is a live DOM attribute and is never stored in memory.
  if (anchor instanceof HTMLElement) anchor.dataset.fillieTag = scanned.id;
  acc.fields.push(scanned);
  return scanned;
}

/** Groups radio/checkbox inputs that belong to the same question. */
/**
 * A stable key for "which question does this option belong to", so a group is
 * emitted once. Native inputs share a `name`; ARIA widgets share their group
 * container.
 */
function groupKeyFor(input: Element): string | null {
  const name = input.getAttribute('name');
  if (name) return `name:${name}`;
  const labelledBy = input.getAttribute('aria-labelledby');
  if (labelledBy) return `aria:${labelledBy}`;

  const container = input.closest('fieldset, [role="radiogroup"], [role="group"], [role="list"]');
  if (container) {
    const heading = container.querySelector('legend, .legend, [role="heading"]');
    const text = textOf(heading, 80) || container.getAttribute('aria-label')?.trim() || '';
    if (text) return `container:${text}`;
    return null;
  }

  // No container: fall back to the nearest heading or label before the group.
  const preceding = findPrecedingLabel(input as HTMLElement);
  return preceding ? `preceding:${preceding}` : null;
}

interface OptionGroup {
  /** Every control that belongs to the question. */
  members: HTMLElement[];
  /** Nearest shared container, when one exists. */
  container: HTMLElement | null;
  /** The question that heads the group, if it could be found. */
  label: string;
  /** True when the options are custom ARIA widgets rather than native inputs. */
  custom: boolean;
}

/**
 * Resolves the set of controls that make up one radio/checkbox question plus the
 * label that heads it.
 *
 * Membership comes from the shared `name` attribute (the reliable signal).
 * The label is read from a real container (fieldset legend, role=heading), from
 * a `<label for>` pointing at an option, or from the closest preceding text
 * element — real forms lay option groups out as flat sibling lists.
 */
function findOptionGroup(element: HTMLElement, kind: 'radio' | 'checkbox'): OptionGroup {
  const selector = `input[type="${kind}"], [role="${kind}"]`;
  const isCustomGroup = (container: Element): boolean =>
    Boolean(container.querySelector(`[role="${kind}"]`)) && !container.querySelector(`input[type="${kind}"]`);

  // A real container (fieldset, role=radiogroup…) is the strongest signal and the
  // only one available for ARIA widgets, which carry no `name`.
  const explicit = element.closest('fieldset, [role="radiogroup"], [role="group"], [role="list"]');
  if (explicit) {
    const members = Array.from(explicit.querySelectorAll<HTMLElement>(selector));
    if (members.length > 1) {
      return {
        members,
        container: explicit as HTMLElement,
        label: groupQuestionFor(explicit, members),
        custom: isCustomGroup(explicit),
      };
    }
  }

  // Otherwise membership comes from the shared `name` attribute.
  const name = element.getAttribute('name');
  const named = name
    ? Array.from(document.querySelectorAll<HTMLElement>(`input[type="${kind}"][name="${cssEscape(name)}"]`))
    : [];
  const siblings = Array.from(element.parentElement?.querySelectorAll<HTMLElement>(selector) ?? []);
  const members = named.length > 1 ? named : siblings.length > 1 ? siblings : [element];

  if (members.length < 2) {
    // A single loose control (e.g. one acknowledgement checkbox).
    return {
      members,
      container: element.closest('label') ?? element.parentElement,
      label: '',
      custom: element.getAttribute('role') === kind,
    };
  }

  // Flat layout: the nearest text element that precedes the group is the
  // question. A `for=` label only counts when it points at *every* option —
  // per-option labels describe choices, not the question.
  const preceding = findPrecedingLabel(members[0]);
  const ids = members.map((member) => member.id).filter(Boolean);
  const coveringLabel =
    ids.length === members.length
      ? Array.from(document.querySelectorAll<HTMLLabelElement>('label'))
          .filter((label) => label.htmlFor && ids.includes(label.htmlFor))
          .map((label) => textOf(label, 160))
          .find(Boolean)
      : undefined;
  const forLabel = preceding ?? coveringLabel;

  return {
    members,
    container: element.parentElement,
    label: forLabel ?? '',
    custom: isCustomGroup(element.parentElement ?? element),
  };
}

/**
 * The question that heads an option group.
 *
 * A `<legend>` is the conventional place, but it is frequently decorative —
 * a company name, a product name, a step title — while the real question sits
 * elsewhere in the same fieldset. A legend that reads like a question is
 * preferred; when it does not, other heading-ish text in the container is used,
 * and only a container with nothing else falls back to the legend rather than
 * reporting a non-question as one.
 */
function groupQuestionFor(container: Element, members: HTMLElement[]): string {
  const optionSelector = 'input, [role="radio"], [role="checkbox"]';
  const legend = textOf(container.querySelector('legend, [role="heading"], .legend, .title'), 160);
  if (legend && looksLikeQuestion(legend) && !isOpaqueIdentifier(legend)) return cleanLabel(legend);

  // aria-labelledby (can have multiple IDs, e.g. "i41 i44")
  const labelledBy = ariaLabelledByText(container);
  if (labelledBy && !isOpaqueIdentifier(labelledBy) && labelledBy !== '*') return cleanLabel(labelledBy);

  const ariaLabel = container.getAttribute('aria-label')?.trim();
  if (ariaLabel && !isOpaqueIdentifier(ariaLabel)) return cleanLabel(ariaLabel);

  // A span, strong or heading inside the fieldset that is not one of the options.
  const optionIds = new Set(members.map((member) => member.id).filter(Boolean));
  const alternative = Array.from(container.children)
    .filter((child) => {
      if (child.querySelector(optionSelector)) return false;
      if (optionIds.has(child.id)) return false;
      return /^(SPAN|STRONG|B|P|DIV|H[1-6])$/.test(child.tagName);
    })
    .map((child) => textOf(child, 160))
    .find((text) => text && text.length < 200 && !isOpaqueIdentifier(text));

  if (alternative) return cleanLabel(alternative);

  // Check enclosing question container (Google Forms card, form group, etc.)
  if (container.parentElement) {
    const ancestorLabel = resolveQuestionFromAncestors(container.parentElement);
    if (ancestorLabel) return cleanLabel(ancestorLabel);
  }

  if (legend && !isOpaqueIdentifier(legend)) return cleanLabel(legend);

  if (container instanceof HTMLElement) {
    const preceding = findPrecedingLabel(container);
    if (preceding && !isOpaqueIdentifier(preceding)) return cleanLabel(preceding);
  }

  return '';
}

/** Builds the fillable option list from the controls that make up a group. */
function collectOptions(members: HTMLElement[]): OptionControl[] {
  const options: OptionControl[] = [];
  for (const element of members) {
    // ARIA widgets put the option name on the element itself; native inputs put
    // it in a wrapping <label> or a sibling.
    const aria = element.getAttribute('aria-label')?.trim();
    const text =
      aria ||
      textOf(element.closest('label') ?? element.parentElement, 120) ||
      textOf(element, 120) ||
      humanizeAttribute(element.getAttribute('value') ?? '');
    if (!text) continue;
    const input =
      element instanceof HTMLInputElement
        ? element
        : ((element.querySelector('input') as HTMLInputElement | null) ?? undefined);
    options.push({
      text,
      element,
      input,
      checked: input ? input.checked : element.getAttribute('aria-checked') === 'true',
    });
  }
  return dedupeOptions(options);
}

function findCustomWidget(element: Element): FieldControl | null {
  const listbox = element.closest('[role="listbox"]');
  if (listbox) {
    return { kind: 'select', element: listbox as HTMLElement, options: [], custom: true };
  }
  const combobox = element.closest('[role="combobox"]');
  if (combobox) {
    const options = Array.from(combobox.querySelectorAll('[role="option"]')).map((node) => ({
      text: textOf(node, 120),
      element: node as HTMLElement,
    }));
    return { kind: 'select', element: combobox as HTMLElement, options, custom: true };
  }
  return null;
}

function selectOptions(select: HTMLSelectElement): OptionControl[] {
  return Array.from(select.options)
    .filter((option) => option.value !== '' || option.text.trim().length > 0)
    .map((option) => ({
      text: option.text.trim(),
      element: option as unknown as HTMLElement,
    }));
}

/**
 * Scans a document for answerable controls. Returns structured fields plus the
 * control registry the filler uses to write values.
 */
export function scanDocument(doc: Document = document, options: ScanOptions = {}): ScannedField[] {
  const root = options.root ?? (doc.body as HTMLElement);
  const maxFields = options.maxFields ?? 120;
  const acc: ScanAccumulator = { fields: [], seen: new Set(), root };

  const groupElements = Array.from(root.querySelectorAll('input, textarea, select, [role="radio"], [role="checkbox"], [role="listbox"], [role="combobox"]'));
  const handledGroups = new Set<string>();

  for (const node of groupElements) {
    if (acc.fields.length >= maxFields) break;
    if (isFillieOwned(node)) continue;
    const element = node as HTMLElement;
    if (!FORM_TAGS.has(element.tagName.toLowerCase()) && !element.hasAttribute('role')) continue;

    if (element instanceof HTMLInputElement) {
      if (SKIP_INPUT_TYPES.has(element.type)) continue;
      if (acc.seen.has(element)) continue;

      const kind = kindForInput(element);
      if (!kind) continue;

      const label = resolveLabel(element);
      if (!label) continue;

      // A honeypot is bait for bots: touching it at all — even to report it —
      // is the wrong move, so it is dropped entirely and never mentioned.
      if (isHoneypot(element)) continue;
      if (!options.includeHidden && !isVisible(element)) continue;
      if (element.readOnly && kind !== 'file') continue;

      // Passwords, one-time codes and payment fields are reported as fields the
      // user must handle themselves. The planner marks them "manual" and never
      // writes them, so the user can see that Fillie noticed and declined
      // rather than wondering why the field was skipped.
      if (looksLikePasswordOrSecret(label, element.type)) {
        acc.seen.add(element);
        addField(
          acc,
          {
            kind: 'text',
            label: cleanLabel(label),
            hint: hintFor(element, label),
            context: resolveContext(element),
            required: isRequired(element, label),
            disabled: element.disabled,
            visible: options.includeHidden ? true : isVisible(element),
            source: detectSource(element),
            maxLength: element.maxLength > 0 ? element.maxLength : undefined,
            sensitive: true,
            control: { kind: 'text', element, input: element, options: [] },
          },
          cleanLabel(label),
          element,
        );
        continue;
      }

      if (kind === 'radio' || kind === 'checkbox') {
        const groupKey = groupKeyFor(element);
        if (groupKey && handledGroups.has(groupKey)) continue;
        const group = findOptionGroup(element, kind);
        const groupOptions = collectOptions(group.members);
        // A lone checkbox whose own label is the question is an acknowledgement,
        // not a one-item multi-select.
        const onlySelf =
          kind === 'checkbox' &&
          groupOptions.length <= 1 &&
          normalizeForMatch(groupOptions[0]?.text ?? '') === normalizeForMatch(label);
        const deduped = onlySelf ? [] : dedupeOptions(groupOptions);
        if (groupKey) handledGroups.add(groupKey);
        for (const option of groupOptions) if (option.input) acc.seen.add(option.input);

        const groupLabel = group.label || label;
        const control: FieldControl = {
          kind,
          element: deduped[0]?.element ?? element,
          input: (deduped[0]?.input ?? element) as HTMLInputElement,
          options: deduped,
          custom: Boolean(group.custom),
        };

        const acknowledgement = kind === 'checkbox' && looksLikeAcknowledgement(groupLabel, deduped);
        addField(
          acc,
          {
            kind: acknowledgement ? 'checkbox' : kind,
            label: cleanLabel(groupLabel),
            hint: hintFor(element, groupLabel),
            context: resolveContext(element),
            options: acknowledgement ? [] : deduped.map((option) => option.text),
            required: isRequired(element, groupLabel),
            // `.every()` on an empty list is true, which would wrongly mark a lone
            // checkbox as disabled.
            disabled: deduped.length
              ? deduped.every((option) => (option.input ?? (option.element as HTMLInputElement)).disabled)
              : element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
            visible: options.includeHidden ? true : isVisible(element),
            source: detectSource(element),
            maxLength: undefined,
            acknowledgement,
            control,
          },
          cleanLabel(groupLabel),
        );
        continue;
      }

      acc.seen.add(element);
      if (kind === 'file') {
        addField(
          acc,
          {
            kind: 'file',
            label: cleanLabel(label),
            hint: hintFor(element, label),
            context: resolveContext(element),
            required: isRequired(element, label),
            disabled: element.disabled,
            visible: options.includeHidden ? true : isVisible(element),
            source: detectSource(element),
            manualOnly: true,
            control: { kind: 'file', element, input: element, options: [] },
          },
          cleanLabel(label),
          element,
        );
        continue;
      }

      addField(
        acc,
        {
          kind,
          label: cleanLabel(label),
          hint: hintFor(element, label),
          context: resolveContext(element),
          required: isRequired(element, label),
          disabled: element.disabled,
          visible: options.includeHidden ? true : isVisible(element),
          source: detectSource(element),
          maxLength: element.maxLength > 0 ? element.maxLength : undefined,
          inputMode: element.inputMode || undefined,
          control: { kind, element, input: element, options: [] },
        },
        cleanLabel(label),
      );
      continue;
    }

    if (element instanceof HTMLTextAreaElement) {
      if (acc.seen.has(element)) continue;
      const label = resolveLabel(element);
      if (!label) continue;
      if (isHoneypot(element)) continue;
      if (!options.includeHidden && !isVisible(element)) continue;
      if (element.readOnly) continue;
      acc.seen.add(element);
      addField(
        acc,
        {
          kind: 'textarea',
          label: cleanLabel(label),
          hint: hintFor(element, label),
          context: resolveContext(element),
          required: isRequired(element, label),
          disabled: element.disabled,
          visible: options.includeHidden ? true : isVisible(element),
          source: detectSource(element),
          maxLength: element.maxLength > 0 ? element.maxLength : undefined,
          control: { kind: 'textarea', element, input: element, options: [] },
        },
        cleanLabel(label),
        element,
      );
      continue;
    }

    if (element instanceof HTMLSelectElement) {
      if (acc.seen.has(element)) continue;
      const label = resolveLabel(element) || element.getAttribute('name') || 'Select an option';
      if (isHoneypot(element)) continue;
      if (!options.includeHidden && !isVisible(element)) continue;
      if (element.disabled) {
        // Keep disabled selects visible to the user as "needs attention".
        acc.seen.add(element);
      }
      acc.seen.add(element);
      addField(
        acc,
        {
          kind: 'select',
          label: cleanLabel(label),
          hint: hintFor(element, label),
          context: resolveContext(element),
          options: selectOptions(element).map((option) => option.text),
          required: isRequired(element, label),
          disabled: element.disabled,
          visible: options.includeHidden ? true : isVisible(element),
          source: detectSource(element),
          control: { kind: 'select', element, input: element, options: selectOptions(element) },
        },
        cleanLabel(label),
        element,
      );
      continue;
    }

    // Custom / ARIA controls.
    const role = element.getAttribute('role');
    if (!role) continue;
    if (acc.seen.has(element)) continue;
    if (isHoneypot(element)) continue;
    if (!options.includeHidden && !isVisible(element)) continue;

    if (role === 'listbox' || role === 'combobox') {
      const widget = findCustomWidget(element);
      if (!widget) continue;
      const label = resolveLabel(element) || element.getAttribute('aria-label') || 'Choose an option';
      if (!label) continue;
      acc.seen.add(element);
      const optionNodes = Array.from(element.querySelectorAll('[role="option"]')).map((node) => ({
        text: textOf(node, 120),
        element: node as HTMLElement,
      }));
      addField(
        acc,
        {
          kind: 'select',
          label: cleanLabel(label),
          hint: hintFor(element, label),
          context: resolveContext(element),
          options: optionNodes.map((option) => option.text),
          required: element.getAttribute('aria-required') === 'true',
          disabled: element.getAttribute('aria-disabled') === 'true',
          visible: true,
          source: 'google-forms',
          control: { kind: 'select', element, options: optionNodes, custom: true },
        },
        cleanLabel(label),
        element,
      );
      continue;
    }

    if (role === 'radio' || role === 'checkbox') {
      const kind = role === 'radio' ? 'radio' : 'checkbox';
      const groupKey = groupKeyFor(element as unknown as HTMLInputElement);
      if (groupKey && handledGroups.has(groupKey)) continue;
      const group = findOptionGroup(element as HTMLElement, kind);
      const deduped = collectOptions(group.members);
      if (groupKey) handledGroups.add(groupKey);
      const ariaLabel = group.container?.getAttribute('aria-label')?.trim() ?? '';
      const label = group.label || ariaLabel || resolveLabel(element) || 'Option';
      const acknowledgement = kind === 'checkbox' && looksLikeAcknowledgement(label, deduped);
      addField(
        acc,
        {
          kind,
          label: cleanLabel(label),
          hint: hintFor(element, label),
          context: resolveContext(element),
          options: acknowledgement ? [] : deduped.map((option) => option.text),
          required: element.getAttribute('aria-required') === 'true',
          disabled: element.getAttribute('aria-disabled') === 'true',
          visible: true,
          source: detectSource(element),
          acknowledgement,
          control: {
            kind,
            element: deduped[0]?.element ?? element,
            input: deduped[0]?.input,
            options: deduped,
            custom: true,
          },
        },
        cleanLabel(label),
        deduped[0]?.element ?? element,
      );
    }
  }

  return acc.fields;
}

function dedupeOptions(options: OptionControl[]): OptionControl[] {
  const seen = new Set<string>();
  const out: OptionControl[] = [];
  for (const option of options) {
    const key = option.text.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(option);
  }
  return out;
}


export function fingerprintOf(label: string): string {
  return label.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Extracts readable page text for job-description mining. */
export function extractPageText(doc: Document = document, limit = 12_000): string {
  const parts: string[] = [];
  const candidates = doc.querySelectorAll(
    'h1, h2, h3, h4, p, li, legend, label, [role="heading"], [data-testid*="description"], [class*="description"], [class*="job"], [id*="description"]',
  );
  for (const node of Array.from(candidates).slice(0, 900)) {
    if (isFillieOwned(node)) continue;
    const text = textOf(node, 600);
    if (text.length < 25) continue;
    parts.push(text);
  }
  const meta = doc.querySelector('meta[name="description"], meta[property="og:description"]');
  const metaText = meta?.getAttribute('content')?.trim();
  const joined = [metaText ?? '', ...parts].filter(Boolean).join('\n');
  return joined.length > limit ? `${joined.slice(0, limit)}…` : joined;
}

export function toScanResult(fields: ScannedField[], doc: Document = document): ScanResult {
  const forms = doc.querySelectorAll('form');
  return {
    url: doc.location?.href ?? '',
    title: doc.title ?? '',
    fields: fields.map(stripControl),
    pageText: extractPageText(doc),
    formCount: forms.length,
    scannedAt: Date.now(),
  };
}

function stripControl(field: ScannedField): DetectedField {
  const { control: _control, ...rest } = field;
  return rest;
}

/** Re-scans and returns only fields that are new compared to `known`. */
export function scanForNewFields(known: Set<string>, options: ScanOptions = {}): ScannedField[] {
  const fields = scanDocument(document, options);
  return fields.filter((field) => !known.has(fingerprintOf(field.label)));
}
/**
 * Some widgets (Google Forms, ARIA comboboxes) only render their options once
 * the dropdown is open. Opening each one briefly lets Fillie read the real
 * option list instead of guessing — and it restores the widget afterwards.
 */
export async function hydrateCustomSelects(
  fields: ScannedField[],
  options: { openMs?: number } = {},
): Promise<void> {
  const openMs = options.openMs ?? 120;
  const targets = fields.filter((field) => field.control.custom && !field.control.options.length);
  for (const field of targets) {
    const root = field.control.element;
    if (!root) continue;
    const expandedBefore = root.getAttribute('aria-expanded');
    try {
      root.click();
    } catch {
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, openMs));
    const discovered = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
      .map((node) => ({ text: normalizeForMatch(node.textContent ?? ''), node }))
      .filter((entry) => entry.text.length > 0)
      .map((entry) => ({ text: textOf(entry.node, 120), element: entry.node }));

    if (discovered.length) {
      const unique = dedupeOptions(discovered);
      field.options = unique.map((option) => option.text);
      field.control.options = unique;
    }

    // Put the widget back the way the user found it.
    try {
      const selected = root.querySelector<HTMLElement>('[aria-selected="true"]');
      if (selected && !root.getAttribute('data-selected')) selected.click();
      else root.click();
    } catch {
      /* closing is best effort — the answer still gets written */
    }
    if (expandedBefore !== null) root.setAttribute('aria-expanded', expandedBefore);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
