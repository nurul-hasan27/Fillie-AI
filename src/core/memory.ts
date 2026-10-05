import type { LearnedAnswer, UserProvidedFact } from './types';
import {
  conceptSimilarity,
  normalizeForMatch,
  questionSignature,
  semanticSimilarity,
  stableHash,
} from './text';

export interface MemoryMatch {
  answer: LearnedAnswer;
  score: number;
  /** True when the stored answer is company-specific and must not be reused. */
  blockedByContext: boolean;
  reason: string;
}

export interface MemoryLookupOptions {
  /** Minimum semantic similarity for a reuse. */
  threshold?: number;
  /** When true, generic answers may be reused across different companies. */
  allowGenericReuse?: boolean;
  company?: string;
  role?: string;
  host?: string;
}

/**
 * Semantic (lexical, deterministic) matching of a question against previously
 * approved answers. No embeddings are used — keeps the extension small and lets
 * matching run offline.
 */
export function findMemoryMatches(
  memory: LearnedAnswer[],
  question: string,
  intent: string,
  options: MemoryLookupOptions = {},
): MemoryMatch[] {
  // Tuned so paraphrases match while genuinely different questions do not
  // (measured scores: same intent ≈ 0.52–0.75, different intent ≈ 0.01–0.37).
  const threshold = options.threshold ?? 0.5;
  const allowGeneric = options.allowGenericReuse ?? true;

  const matches = memory.map((entry) => {
    const queryText = `${question} ${intent}`;
    const storedText = `${entry.question} ${entry.intent}`;
    // Weighted so concept-level agreement ("led a team" ≈ "showed leadership")
    // can carry a match on its own, while an identical signature dominates.
    const lexical = semanticSimilarity(queryText, storedText);
    const concepts = conceptSimilarity(queryText, storedText);
    const identical = questionSignature(question, intent) === entry.signature;
    const score = Math.min(
      1,
      identical
        ? Math.max(0.92, lexical)
        : lexical * 0.4 + concepts * 0.5 + scoreOverlapBoost(queryText, storedText),
    );
    return { entry, score };
  });

  return matches
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map(({ entry, score }) => {
      const sameCompany =
        !!entry.context.company &&
        !!options.company &&
        normalizeForMatch(entry.context.company) === normalizeForMatch(options.company);
      const sameHost =
        !!entry.context.host &&
        !!options.host &&
        normalizeForMatch(entry.context.host) === normalizeForMatch(options.host);

      if (entry.context.isGeneric && allowGeneric) {
        return {
          answer: entry,
          score,
          blockedByContext: false,
          reason: 'Reusing an answer you approved for a similar question.',
        };
      }
      if (sameCompany || sameHost) {
        return {
          answer: entry,
          score,
          blockedByContext: false,
          reason: `Reusing your approved answer for ${entry.context.company ?? entry.context.host}.`,
        };
      }
      return {
        answer: entry,
        score,
        blockedByContext: true,
        reason: 'Saved for a different application — regenerate instead of copying company-specific wording.',
      };
    });
}

function scoreOverlapBoost(a: string, b: string): number {
  const normA = normalizeForMatch(a).split(' ').filter(Boolean);
  const normB = new Set(normalizeForMatch(b).split(' ').filter(Boolean));
  if (!normA.length || !normB.size) return 0;
  let hits = 0;
  for (const token of normA) if (normB.has(token)) hits += 1;
  return (hits / normA.length) * 0.12;
}

export interface CreateLearnedAnswerInput {
  question: string;
  intent: string;
  answer: string;
  sources: LearnedAnswer['sources'];
  userFacts?: UserProvidedFact[];
  context: LearnedAnswer['context'];
  id?: string;
}

export function createLearnedAnswer(input: CreateLearnedAnswerInput): LearnedAnswer {
  const now = Date.now();
  return {
    id: input.id ?? `mem-${stableHash(input.question + input.answer + now).toString(36)}`,
    question: input.question.trim(),
    intent: input.intent.trim(),
    answer: input.answer.trim(),
    sources: input.sources,
    userFacts: input.userFacts ?? [],
    context: input.context,
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    signature: questionSignature(input.question, input.intent),
  };
}

/**
 * Saves an approved answer. When an equivalent entry already exists it is
 * updated in place so memory does not grow with duplicates.
 */
export function upsertLearnedAnswer(
  memory: LearnedAnswer[],
  entry: LearnedAnswer,
): { memory: LearnedAnswer[]; saved: LearnedAnswer; replaced: boolean } {
  const signatureIndex = memory.findIndex(
    (existing) => existing.signature === entry.signature && existing.context.isGeneric === entry.context.isGeneric,
  );
  if (signatureIndex >= 0) {
    const merged: LearnedAnswer = {
      ...memory[signatureIndex],
      answer: entry.answer,
      intent: entry.intent || memory[signatureIndex].intent,
      sources: entry.sources.length ? entry.sources : memory[signatureIndex].sources,
      userFacts: entry.userFacts.length ? entry.userFacts : memory[signatureIndex].userFacts,
      context: { ...memory[signatureIndex].context, ...entry.context },
      updatedAt: Date.now(),
    };
    const next = [...memory];
    next[signatureIndex] = merged;
    return { memory: next, saved: merged, replaced: true };
  }
  return { memory: [entry, ...memory], saved: entry, replaced: false };
}

/**
 * Counts a reuse. Called when a learned answer is actually written to a field,
 * so `useCount` reflects real use rather than how often a question was asked.
 */
export function recordMemoryUsage(memory: LearnedAnswer[], id: string): LearnedAnswer[] {
  return memory.map((entry) => (entry.id === id ? { ...entry, useCount: entry.useCount + 1 } : entry));
}

export function deleteLearnedAnswer(memory: LearnedAnswer[], id: string): LearnedAnswer[] {
  return memory.filter((entry) => entry.id !== id);
}

export function updateLearnedAnswer(
  memory: LearnedAnswer[],
  id: string,
  patch: Partial<Pick<LearnedAnswer, 'answer' | 'intent' | 'question' | 'context'>>,
): LearnedAnswer[] {
  return memory.map((entry) => {
    if (entry.id !== id) return entry;
    const updated: LearnedAnswer = { ...entry, ...patch, updatedAt: Date.now() };
    updated.signature = questionSignature(updated.question, updated.intent);
    return updated;
  });
}