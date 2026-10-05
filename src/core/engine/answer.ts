import type { AnswerValue, DetectedField } from '../types';
import { matchOption, normalizeText, toSingleLine } from '../text';
import type { AnswerType } from '../ai/plan-parse';

export interface NormalizedAnswer {
  value: AnswerValue;
  answerType: AnswerType;
  problems: string[];
  /** True when the value had to be changed to fit the control. */
  adjusted: boolean;
}

export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

/** Validates a value against the constraints we know about the control. */
export function validateValue(field: DetectedField, value: AnswerValue): ValidationResult {
  const problems: string[] = [];

  if (field.disabled) problems.push('This control is disabled.');
  if (field.visible === false) problems.push('This control is not visible on the page.');

  if (typeof value === 'string') {
    if (!value.trim()) problems.push('The answer is empty.');
    if (field.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
      problems.push('That does not look like an email address.');
    }
    if (field.kind === 'tel' && value.replace(/\D/g, '').length < 7) {
      problems.push('That does not look like a phone number.');
    }
    if (field.kind === 'url' && !/^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(value.trim())) {
      problems.push('That does not look like a URL.');
    }
    if (field.kind === 'number' && value.trim() && !/^-?\d+(\.\d+)?$/.test(value.trim())) {
      problems.push('That control expects a number.');
    }
    if (field.maxLength && value.length > field.maxLength) {
      problems.push(`The answer is longer than the ${field.maxLength} character limit.`);
    }
    if (field.kind === 'text' && /\n/.test(value)) {
      problems.push('This control accepts a single line only.');
    }
  }

  if (Array.isArray(value)) {
    if (!value.length) problems.push('No option was selected.');
    if (field.options?.length) {
      for (const entry of value) {
        if (!field.options.some((option) => normalizeText(option) === normalizeText(entry))) {
          problems.push(`"${entry}" is not one of the offered options.`);
        }
      }
    }
  }

  if (typeof value === 'boolean' && (field.kind === 'radio' || field.kind === 'checkbox')) {
    if (!value) problems.push('Nothing was selected.');
  }

  if (field.kind === 'file') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      problems.push('No matching document found to attach.');
    }
  }

  return { valid: problems.length === 0, problems };
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Normalises many date notations to YYYY-MM-DD, returning the input on failure. */
export function normalizeDate(input: string): string | null {
  const text = normalizeText(input);
  if (!text) return null;

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${pad(Number(m))}-${pad(Number(d))}`;
  }

  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (dmy) {
    const [, d, m, y] = dmy;
    const month = Number(m);
    if (month >= 1 && month <= 12) return `${y}-${pad(month)}-${pad(Number(d))}`;
  }

  const monthYear = /^([a-z]+)\s+(\d{4})$/i.exec(text);
  if (monthYear && MONTHS[monthYear[1].toLowerCase()]) {
    return `${monthYear[2]}-${pad(MONTHS[monthYear[1].toLowerCase()])}-01`;
  }

  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    const date = new Date(parsed);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  return null;
}

/** Turns any proposed answer into something the control can actually accept. */
export function normalizeAnswerForField(
  field: DetectedField,
  proposed: AnswerValue,
  answerType: AnswerType = 'short',
): NormalizedAnswer {
  const problems: string[] = [];
  let adjusted = false;
  let value: AnswerValue = proposed;

  switch (answerType) {
    case 'choice': {
      const candidate = typeof proposed === 'string' ? proposed : String(proposed ?? '');
      if (field.options?.length) {
        const match = matchOption(candidate, field.options, 0.55);
        if (match) {
          value = match.option;
          adjusted = match.option !== candidate;
        } else {
          problems.push(`"${candidate}" is not an offered option.`);
          value = null;
        }
      } else {
        value = toSingleLine(candidate);
      }
      break;
    }
    case 'multi_choice': {
      // Profile lists are stored as comma separated text, so a single string is
      // split before matching against the offered options.
      const list = (Array.isArray(proposed) ? proposed : [proposed ?? ''])
        .flatMap((entry) => String(entry).split(/[,;|]/))
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (field.options?.length) {
        const picked: string[] = [];
        for (const entry of list) {
          const match = matchOption(entry, field.options, 0.55);
          if (match) {
            if (!picked.includes(match.option)) picked.push(match.option);
            if (match.option !== entry) adjusted = true;
          } else if (entry.length > 1) {
            problems.push(`"${entry}" is not an offered option.`);
          }
        }
        value = picked;
      } else {
        value = list.map((entry) => toSingleLine(entry));
      }
      break;
    }
    case 'boolean': {
      value = typeof proposed === 'boolean' ? proposed : /^(yes|true|agree|accepted?|i agree)\b/i.test(String(proposed)) ;
      if (typeof proposed !== 'boolean') adjusted = true;
      break;
    }
    case 'number': {
      const candidate = typeof proposed === 'number' ? String(proposed) : String(proposed ?? '');
      const match = /-?\d+(\.\d+)?/.exec(candidate.replace(/,/g, ''));
      value = match ? match[0] : candidate.trim();
      if (!match) problems.push('No number was found in that answer.');
      adjusted = adjusted || match?.[0] !== candidate.trim();
      break;
    }
    case 'date': {
      const candidate = typeof proposed === 'string' ? proposed : String(proposed ?? '');
      const normalized = normalizeDate(candidate);
      if (normalized) {
        value = normalized;
        adjusted = normalized !== candidate;
      } else {
        problems.push('That date could not be understood.');
        value = toSingleLine(candidate);
      }
      break;
    }
    case 'long': {
      let text = typeof proposed === 'string' ? proposed : String(proposed ?? '');
      text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (field.maxLength && text.length > field.maxLength) {
        const cut = text.slice(0, field.maxLength);
        const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
        text = (lastStop > field.maxLength * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim();
        problems.push('The answer was shortened to fit the character limit.');
        adjusted = true;
      }
      value = text;
      break;
    }
    case 'file': {
      if (proposed && typeof proposed === 'object' && !Array.isArray(proposed)) {
        value = proposed;
      } else {
        value = null;
        problems.push('File uploads are always handled by the user.');
      }
      break;
    }
    case 'short':
    default: {
      let text = typeof proposed === 'string' ? proposed : String(proposed ?? '');
      text = toSingleLine(text);
      if (field.maxLength && text.length > field.maxLength) {
        text = text.slice(0, field.maxLength).trim();
        problems.push('The answer was shortened to fit the character limit.');
        adjusted = true;
      }
      value = text;
      break;
    }
  }

  return { value, answerType, problems, adjusted };
}

/** Answers that must never be written automatically. */
export function isBlockedField(field: DetectedField, hasMatchingDocument = false): string | null {
  if (field.kind === 'file') {
    if (hasMatchingDocument) return null;
    return 'You attach files yourself — Fillie never uploads documents.';
  }
  if (field.disabled) return 'This control is disabled on the page.';
  if (field.visible === false) return 'This control is hidden on the page.';
  // Set by the scanner from the control type, so this does not depend on the
  // field happening to be labelled "password".
  if (field.sensitive) {
    return 'Fillie never handles passwords, codes or payment details.';
  }
  const label = field.label.toLowerCase();
  if (/(password|passcode|otp|one[- ]time|cvv|card number|security answer|2fa|mfa)/i.test(label)) {
    return 'Fillie never handles passwords, codes or payment details.';
  }
  if (/(captcha|i am not a robot|verify you are human)/i.test(label)) {
    return 'CAPTCHAs are always handled by you.';
  }
  return null;
}