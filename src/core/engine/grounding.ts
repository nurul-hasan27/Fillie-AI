import type { KnowledgeItem, UserProvidedFact } from '../types';
import { normalizeForMatch, STOP_WORDS, tokenize } from '../text';

/**
 * Grounding / hallucination guard.
 *
 * Fillie must never fabricate experience, education, certifications, salary or
 * other personal facts. After the model answers, every meaningful claim token in
 * the answer is checked against the retrieved knowledge, the facts the user
 * typed, and the page's own wording. Unsupported specifics (numbers, dates,
 * proper nouns) lower confidence or escalate the question to the user.
 */

export interface GroundingInput {
  answer: string;
  /**
   * The facts the answer is allowed to assert. This is the whole local profile
   * corpus, not just the subset sent to the model — the check happens on-device,
   * so being generous here costs nothing and avoids false accusations against
   * facts the user genuinely wrote.
   */
  knowledge: KnowledgeItem[];
  userFacts: UserProvidedFact[];
  /** Page text that the answer may legitimately echo (the question itself). */
  question: string;
  context?: string;
  options?: string[];
  hint?: string;
}

export interface GroundingResult {
  /** 0..1 — share of the answer's claims that are supported by facts. */
  score: number;
  /** Verbatim unsupported fragments, for debug display. */
  unsupported: string[];
  /** High-signal unsupported specifics (numbers, money, dates, proper nouns). */
  riskyUnsupported: string[];
  verdict: 'grounded' | 'partially-grounded' | 'ungrounded';
}

const RISKY_PATTERNS: RegExp[] = [
  /\b\d+\s*%/,
  /[$€£₹]\s?\d/,
  /\b\d{4}\b/, // years
  /\b\d+\s*\+?\s*(years?|months?)\b/,
  /\b\d+(st|nd|rd|th)\b/,
];

/**
 * Words that carry no factual claim — verbs, hedges and scaffolding a candidate
 * answer uses regardless of the truth. They are excluded from grounding so a
 * legitimate answer is not punished for saying "I led", "helped" or "know".
 */
const GENERIC_FILLER = new Set([
  'team', 'work', 'working', 'worked', 'role', 'project', 'projects', 'company', 'experience', 'skills',
  'leadership', 'manage', 'managed', 'managing', 'responsible', 'developed', 'build', 'built', 'created',
  'using', 'use', 'used', 'strong', 'good', 'great', 'able', 'help', 'helped', 'helps', 'support',
  'supported', 'ensure', 'ensured', 'improve', 'improved', 'achieve', 'achieved', 'drive', 'drove',
  'collaborate', 'collaborated', 'learn', 'learned', 'student', 'university', 'college', 'degree',
  'internship', 'full', 'time', 'task', 'tasks', 'problem', 'solution', 'process', 'people', 'new',
  'one', 'two', 'three', 'first', 'know', 'knew', 'want', 'wanted', 'like', 'make', 'makes', 'made',
  'take', 'took', 'get', 'got', 'give', 'gave', 'need', 'needs', 'required', 'prefer', 'preferred',
  'also', 'currently', 'recent', 'previous', 'including', 'include', 'part', 'across', 'within',
  'well', 'best', 'better', 'always', 'often', 'every', 'day', 'years', 'year', 'month', 'months',
  'able', 'willing', 'passionate', 'enthusiastic', 'dedicated', 'committed', 'motivated', 'enjoy',
  'enjoyed', 'like', 'love', 'interesting', 'variety', 'range', 'level', 'levels', 'familiar',
  'hands', 'proven', 'track', 'record', 'background', 'experience', 'expertise', 'specialist',
]);

/** Light suffix folding so "relocation" matches "relocate", "led"/"lead". */
function stem(word: string): string {
  return word
    .replace(/(ations?|ations)$/, 'ate')
    .replace(/isations?$/, 'ize')
    .replace(/ings?$/, '')
    .replace(/(edly|ed|ing|es|s)$/, '')
    .replace(/(ational|tional|ful|less|ness)$/, '');
}

function tokenAppears(token: string, haystack: string): boolean {
  const needle = normalizeForMatch(token);
  if (needle.length < 3) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack)) return true;

  const stemmed = stem(needle);
  if (stemmed.length >= 3 && stemmed !== needle) {
    const stemPattern = new RegExp(`(^|[^a-z0-9])${stemmed}[a-z]{0,4}([^a-z0-9]|$)`, 'i');
    if (stemPattern.test(haystack)) return true;
  }
  return false;
}

/** Spelled-out quantities are claims too ("twelve years", "four teams"). */
const NUMBER_WORDS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'dozen', 'hundred', 'thousand', 'million', 'billion', 'first', 'second', 'third', 'fourth',
  'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
]);

function isRiskyFragment(fragment: string): boolean {
  return RISKY_PATTERNS.some((pattern) => pattern.test(fragment)) || NUMBER_WORDS.has(fragment);
}

/**
 * A capitalised word that is not the first word of a sentence and does not
 * appear in the question or the corpus is likely an invented proper noun.
 */
function looksLikeProperNoun(fragment: string, answer: string, allowedText: string): boolean {
  if (!/^[A-Z][a-z]{2,}/.test(fragment)) return false;
  const index = answer.indexOf(fragment);
  if (index <= 0) return false;
  const previous = answer[index - 1];
  // Sentence starts are expected to be capitalised.
  if (!/[.!?;:,]\s$/.test(answer.slice(0, index))) return false;
  void previous;
  return !tokenAppears(fragment, allowedText);
}

export function assessGrounding(input: GroundingInput): GroundingResult {
  const answer = input.answer ?? '';
  // Numbers and dates are claims too: a bare "0.5" or "2000-05-01" has to be
  // traceable to a stored fact, otherwise any numeric answer would pass.
  const numericClaims = answer.match(/\d[\d.,:/-]*%?/g) ?? [];
  const tokens = tokenize(answer).filter((token) => token.length > 2);
  if (!tokens.length && !numericClaims.length) {
    return { score: 1, unsupported: [], riskyUnsupported: [], verdict: 'grounded' };
  }

  // Both sides are normalised the same way so punctuation and case never cause
  // a false mismatch (e.g. "80,000" against "£80,000").
  const knowledgeText = normalizeForMatch(
    [
      ...input.knowledge.map((item) => `${item.label} ${item.value} ${item.detail ?? ''}`),
      ...input.userFacts.map((fact) => `${fact.key} ${fact.value}`),
    ].join(' \n '),
  );
  const allowedText = normalizeForMatch(
    [input.question, input.context ?? '', input.hint ?? '', ...(input.options ?? [])].join(' '),
  );

  const unsupported: string[] = [];
  const riskyUnsupported: string[] = [];
  let checked = 0;
  let supported = 0;

  for (const token of new Set(tokens)) {
    if (GENERIC_FILLER.has(token) || STOP_WORDS.has(token)) continue;
    checked += 1;
    if (tokenAppears(token, knowledgeText)) {
      supported += 1;
      continue;
    }
    if (tokenAppears(token, allowedText)) {
      // Echoing the question's own wording is fine, it is slightly weaker.
      supported += 0.75;
      continue;
    }
    unsupported.push(token);
    if (isRiskyFragment(token) || /\d/.test(token) || looksLikeProperNoun(token, answer, allowedText)) {
      riskyUnsupported.push(token);
    }
  }

  // Numeric claims are checked separately: "8.6" matches no token but is a real
  // assertion. Comparison is digit-only, so units and separators never hide a
  // match ("900" against "900ms", "80,000" against "£80,000").
  const knowledgeDigits = knowledgeText.replace(/[^0-9.]/g, '');
  const allowedDigits = allowedText.replace(/[^0-9.]/g, '');
  for (const claim of numericClaims) {
    const bare = claim.replace(/[^0-9.]/g, '');
    if (bare.replace(/[^0-9]/g, '').length < 2) continue;
    checked += 1;
    if (knowledgeDigits.includes(bare) || allowedDigits.includes(bare)) {
      supported += 1;
      continue;
    }
    unsupported.push(claim);
    riskyUnsupported.push(claim);
  }

  if (!checked) {
    return { score: 0.9, unsupported, riskyUnsupported, verdict: 'grounded' };
  }

  const score = Math.max(0, Math.min(1, supported / checked));
  const verdict: GroundingResult['verdict'] =
    score >= 0.82 ? 'grounded' : score >= 0.5 ? 'partially-grounded' : 'ungrounded';

  return { score, unsupported, riskyUnsupported, verdict };
}

export interface GroundingAdjustment {
  /** Confidence multiplier derived from grounding. */
  multiplier: number;
  /** Extra note for the user / debug log. */
  note?: string;
  /** True when the answer is specific enough that it must not be auto-filled. */
  escalate: boolean;
}

/**
 * Combines model confidence with grounding evidence into a final confidence and
 * decides whether the field must go to the user instead of being filled.
 */
export function adjustConfidence(
  _confidence: number,
  grounding: GroundingResult,
  fieldKind: 'short' | 'long',
): GroundingAdjustment {
  const { score, riskyUnsupported } = grounding;

  if (fieldKind === 'short') {
    // Short factual answers must be traceable to a fact.
    if (score < 0.45 || riskyUnsupported.length > 0) {
      return {
        multiplier: 0,
        escalate: true,
        note: riskyUnsupported.length
          ? `The answer introduced details Fillie could not verify (${riskyUnsupported.slice(0, 3).join(', ')}).`
          : 'The answer was not grounded in your profile.',
      };
    }
    const multiplier = score < 0.7 ? 0.85 : 1;
    return { multiplier, escalate: false, note: score < 0.7 ? 'Partially verified against your profile.' : undefined };
  }

  // Long-form answers may paraphrase, but unverified specifics are risky.
  if (score < 0.28) {
    return {
      multiplier: 0.55,
      escalate: true,
      note: 'Most of this draft is not supported by your profile. It needs your review before it is used.',
    };
  }
  const multiplier = score < 0.6 ? 0.78 : score < 0.8 ? 0.9 : 1;
  return {
    multiplier,
    escalate: false,
    note: riskyUnsupported.length
      ? `Check the specifics Fillie could not verify (${riskyUnsupported.slice(0, 3).join(', ')}).`
      : score < 0.8
        ? 'Some wording goes beyond your stored facts.'
        : undefined,
  };
}