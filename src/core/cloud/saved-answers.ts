import { stableHash } from '../text';

/**
 * Answers the user hearted while filling a form, kept with that application so they can read
 * exactly what they wrote on the form again before the interview.
 */
export interface SavedAnswer {
  /** Stable for the same question, so hearting it twice never saves it twice. */
  id: string;
  question: string;
  answer: string;
  savedAt: number;
}

export const MAX_SAVED_ANSWERS = 80;
const MAX_QUESTION = 300;
const MAX_ANSWER = 3000;

const clean = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

/** The id of a question: the same wording, ignoring case and spacing, is the same question. */
export function savedAnswerId(question: string): string {
  return `q${stableHash(clean(question).toLowerCase()).toString(36)}`;
}

/** Cleans a list read from storage or the database: no blanks, no repeats, sensible lengths, newest last. */
export function normalizeSavedAnswers(list: unknown): SavedAnswer[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: SavedAnswer[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<SavedAnswer>;
    const question = clean(item.question).slice(0, MAX_QUESTION);
    // Line breaks in an answer are kept: a cover letter should still read as paragraphs.
    const answer = String(item.answer ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_ANSWER);
    if (!question || !answer) continue;
    const id = savedAnswerId(question);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, question, answer, savedAt: Number.isFinite(Number(item.savedAt)) ? Number(item.savedAt) : 0 });
  }
  return out.slice(-MAX_SAVED_ANSWERS);
}

/** Adds the answer, or replaces the earlier one for the same question. */
export function withSavedAnswer(list: SavedAnswer[], question: string, answer: string, now = Date.now()): SavedAnswer[] {
  const next = normalizeSavedAnswers([...list.filter((item) => item.id !== savedAnswerId(question)), { question, answer, savedAt: now }]);
  return next;
}

export function withoutSavedAnswer(list: SavedAnswer[], question: string): SavedAnswer[] {
  const id = savedAnswerId(question);
  return list.filter((item) => item.id !== id);
}
