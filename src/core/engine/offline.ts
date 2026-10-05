import type { AnswerValue, DetectedField, KnowledgeItem, LearnedAnswer } from '../types';
import { calculateAge, formatDateForHumans } from '../knowledge';
import { aliasKnowledgeIds, scoreKnowledgeItem } from '../retrieval';
import { normalizeForMatch, semanticSimilarity, toSingleLine } from '../text';
import { normalizeAnswerForField } from './answer';

/**
 * The offline engine: answers strictly from stored facts with no model call.
 * Used when no AI provider is configured, when the provider fails, and as the
 * fast path for obviously-safe factual questions.
 */

export interface OfflineResolution {
  answer: AnswerValue;
  confidence: number;
  sources: KnowledgeItem[];
  reason: string;
  /** Which layer produced the answer. */
  layer: 'alias' | 'retrieval' | 'memory' | 'none';
}

export interface OfflineInput {
  field: DetectedField;
  knowledge: KnowledgeItem[];
  /** All learned answers, used only for context labels. */
  memory?: LearnedAnswer[];
  memoryMatches: Array<{ answer: LearnedAnswer; score: number; blockedByContext: boolean; reason: string }>;
  company?: string;
}

const DATE_INTENTS = /\b(date of birth|dob|birth ?date|when (were you|was) (you )?born|age)\b/i;
const EXPERIENCE_YEARS = /\byears?\b[^.?!]{0,30}\bexperience|\bhow many years\b|\btotal experience\b|\bexperience (in|length|duration)\b/i;

export function matchDocumentForField(field: DetectedField, knowledge: KnowledgeItem[]): KnowledgeItem | undefined {
  const docItems = knowledge.filter((item) => item.kind === 'document' && item.docRef);
  if (!docItems.length) return undefined;

  const q = questionText(field).toLowerCase();
  let bestItem: KnowledgeItem | undefined;
  let bestScore = -1;

  for (const item of docItems) {
    let score = 0;
    const docRef = item.docRef!;
    const name = (docRef.name || '').toLowerCase();
    const fileName = (docRef.fileName || '').toLowerCase();
    const tags = item.tags.map((t) => t.toLowerCase());

    // 1. Tag / keyword matching
    for (const tag of tags) {
      if (tag && q.includes(tag)) {
        score += 35;
      }
    }

    // 2. Intent-based matching
    const isResume = /\b(resume|cv|curriculum vitae)\b/i.test(q);
    const isCoverLetter = /\b(cover[- ]?letter)\b/i.test(q);
    const isTranscript = /\b(transcript|mark ?sheet|academic record)\b/i.test(q);
    const isCertificate = /\b(certificate|certification)\b/i.test(q);

    if (isResume && (tags.includes('resume') || tags.includes('cv') || name.includes('resume') || fileName.includes('resume'))) {
      score += 50;
    }
    if (isCoverLetter && (tags.includes('cover-letter') || tags.includes('cover letter') || name.includes('cover'))) {
      score += 50;
    }
    if (isTranscript && (tags.includes('transcript') || name.includes('transcript') || fileName.includes('transcript'))) {
      score += 50;
    }
    if (isCertificate && (tags.includes('certificate') || name.includes('certificate') || fileName.includes('cert'))) {
      score += 50;
    }

    // Default document bonus
    if (docRef.isDefault) {
      score += 15;
    }

    const similarity = semanticSimilarity(q, `${item.label} ${item.detail ?? ''} ${tags.join(' ')}`);
    score += similarity * 20;

    // For file input with resume intent or generic upload
    if (field.kind === 'file' && (isResume || score === 0) && (tags.includes('resume') || tags.includes('cv'))) {
      score += 25;
    }

    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  if (field.kind === 'file' && (!bestItem || bestScore <= 0) && docItems.length) {
    bestItem = docItems.find((d) => d.docRef?.isDefault) ?? docItems[0];
  }

  return bestItem;
}

export function resolveOffline(input: OfflineInput): OfflineResolution {
  const { field, knowledge, memoryMatches } = input;

  if (field.kind === 'file') {
    const docItem = matchDocumentForField(field, knowledge);
    if (docItem && docItem.docRef) {
      return {
        answer: docItem.docRef as unknown as AnswerValue,
        confidence: 0.95,
        sources: [docItem],
        reason: `Matched document “${docItem.docRef.name || docItem.docRef.fileName}” for file upload.`,
        layer: 'retrieval',
      };
    }
    return {
      answer: null,
      confidence: 0,
      sources: [],
      reason: 'No matching document found in your profile to attach.',
      layer: 'none',
    };
  }

  const isDocText = /\b(cover[- ]?letter|resume text|statement of purpose|sop)\b/i.test(questionText(field));
  if (isDocText && (field.kind === 'textarea' || field.kind === 'text')) {
    const docItem = matchDocumentForField(field, knowledge);
    if (docItem) {
      const contentItem = knowledge.find(
        (k) => k.kind === 'document' && k.id.startsWith(docItem.id.split('.').slice(0, 2).join('.')) && k.id.endsWith('.content'),
      );
      if (contentItem && contentItem.value) {
        return {
          answer: contentItem.value.slice(0, field.maxLength ?? 4000),
          confidence: 0.92,
          sources: [contentItem],
          reason: `From document “${docItem.docRef?.name || docItem.label}”.`,
          layer: 'retrieval',
        };
      }
    }
  }

  if (memoryMatches.length) {
    const best = memoryMatches[0];
    if (!best.blockedByContext) {
      const source = memoryMatches.find((match) => match.answer.id === best.answer.id) ?? best;
      return {
        answer: source.answer.answer,
        confidence: Math.min(0.97, 0.8 + source.score * 0.2),
        sources: [],
        reason: best.reason,
        layer: 'memory',
      };
    }
  }

  const byId = new Map(knowledge.map((item) => [item.id, item]));
  /** Alias ids are kind-level (`experience.role`); real ids are
   *  `experience.<id>.role`, so match on kind + trailing key. */
  const lookup = (id: string): KnowledgeItem | undefined => {
    const exact = byId.get(id);
    if (exact) return exact;
    const parts = id.split('.');
    if (parts.length !== 2) return undefined;
    const [kind, key] = parts;
    return knowledge.find((item) => item.kind === kind && item.id.split('.').pop() === key);
  };

  // Age questions need computation, not just retrieval.
  if (EXPERIENCE_YEARS.test(questionText(field))) {
    const years = totalExperienceYears(knowledge);
    if (years !== null) {
      return {
        answer: `${years}`,
        confidence: 0.86,
        sources: knowledge.filter((item) => item.kind === 'experience').slice(0, 3),
        reason: 'Calculated from the roles in your profile.',
        layer: 'retrieval',
      };
    }
  }

  if (DATE_INTENTS.test(questionText(field))) {
    const dob = byId.get('personal.dateOfBirth');
    if (dob) {
      const age = calculateAge(dob.value);
      const wantsAge = /\bage\b/i.test(questionText(field));
      return {
        answer: wantsAge && age !== null ? `${age}` : formatDateForHumans(dob.value) || dob.value,
        confidence: 0.95,
        sources: [dob],
        reason: 'From your date of birth.',
        layer: 'alias',
      };
    }
  }

  // Alias matches are exactly the cases where we know the mapping is safe, so
  // they are allowed to feed dropdowns too (with option matching applied).
  const aliasIds = aliasKnowledgeIds(questionText(field));
  for (const id of aliasIds) {
    const item = lookup(id);
    if (!item) continue;
    if (!field.options?.length) {
      // A list of experiences/projects is a choice, not an answer: the user picks
      // which one the question is about.
      const isEntityList = item.id.endsWith('.summary') || item.id.endsWith('.details');
      if (isEntityList && (item.kind === 'experience' || item.kind === 'project')) continue;
      return {
        answer: item.value,
        confidence: 0.95,
        sources: [item],
        reason: `From your profile: ${item.label}.`,
        layer: 'alias',
      };
    }
    const isMulti = field.kind === 'checkbox';
    const normalized = normalizeAnswerForField(field, item.value, isMulti ? 'multi_choice' : 'choice');
    const picked = Array.isArray(normalized.value) ? normalized.value : normalized.value ? [normalized.value] : [];
    if (picked.length > 0) {
      return {
        answer: normalized.value,
        confidence: 0.92,
        sources: [item],
        reason: `Matched “${item.label}” to ${isMulti ? 'the options' : 'an option'} on the page.`,
        layer: 'alias',
      };
    }
  }

  // Scalars only: a long text field should not receive a bare value.
  const ranked = knowledge
    .map((item) => ({ item, score: scoreKnowledgeItem(questionText(field), item) }))
    .filter((entry) => entry.score > 0.4)
    .sort((a, b) => b.score - a.score);

  if (ranked.length && field.kind !== 'textarea' && (field.options?.length ?? 0) > 0) {
    const best = ranked[0];
    // A checkbox group asks "select all that apply", so a comma separated
    // profile list maps to several options rather than one.
    const answerType = field.kind === 'checkbox' ? 'multi_choice' : 'choice';
    if (best.item.value.length <= 200) {
      const normalized = normalizeAnswerForField(field, best.item.value, answerType);
      const picked = Array.isArray(normalized.value) ? normalized.value : normalized.value ? [String(normalized.value)] : [];
      if (picked.length > 0) {
        // Confidence blends how well the question matched the fact with how
        // cleanly each option matched.
        const quality = picked.length / Math.max(1, picked.length + normalized.problems.length);
        return {
          answer: normalized.value,
          confidence: Math.min(0.93, 0.62 + best.score * 0.28 + quality * 0.12),
          sources: [best.item],
          reason: `Matched to “${best.item.label}” in your profile.`,
          layer: 'retrieval',
        };
      }
    }
  }

  const shortlist = knowledge.filter(
    (item) => item.value.length > 120 && (item.kind === 'project' || item.kind === 'experience'),
  );
  if (shortlist.length && field.kind === 'textarea') {
    const scored = shortlist
      .map((item) => ({ item, score: semanticSimilarity(questionText(field), `${item.label} ${item.value} ${item.tags.join(' ')}`) }))
      .sort((a, b) => b.score - a.score)[0];
    if (scored && scored.score > 0.12) {
      const answer = buildOfflineNarrative(scored.item, field);
      if (answer) {
        return {
          answer,
          confidence: Math.min(0.72, 0.45 + scored.score * 0.4),
          sources: [scored.item],
          reason: `Assembled from “${scored.item.label}”. Check the wording.`,
          layer: 'retrieval',
        };
      }
    }
  }

  return { answer: null, confidence: 0, sources: [], reason: '', layer: 'none' };
}

/**
 * Builds a readable paragraph from one knowledge item. Nothing is added — only
 * the item's own words, tidied into sentences and trimmed to the field.
 */
export function buildOfflineNarrative(item: KnowledgeItem, field: DetectedField): string | null {
  // Knowledge values pack labelled clauses ("Results: …, Metrics: …"); those read
  // as separate sentences, so they are split before trimming.
  const sentences = item.value
    .split(/(?<=\.)\s+(?=[A-Z][a-z]+(?: [a-z]+){0,2}:)|,\s+(?=[A-Z][a-z]+(?: [a-z]+){0,2}:)/)
    .map((sentence) => sentence.trim().replace(/\s+/g, ' ').replace(/[.:,]\s*$/, ''))
    .filter((sentence) => sentence.length > 12);

  if (!sentences.length) return null;

  const maxSentences = (field.maxLength ?? 0) > 800 ? 5 : 3;
  const body = sentences.slice(0, maxSentences).join('. ');
  const text = `${body.replace(/\.+$/, '')}.`;
  return toSingleLine(text).slice(0, field.maxLength ?? 2000);
}

function questionText(field: DetectedField): string {
  return `${field.label} ${field.hint ?? ''} ${field.context ?? ''}`.trim();
}

/** Estimates years of experience from dated roles (months, not just years). */
export function totalExperienceYears(knowledge: KnowledgeItem[]): number | null {
  const ranges: Array<[number, number]> = [];
  const nowYear = new Date().getFullYear();

  // Handles "2020-06 – 2020-12", "June 2020 – December 2020" and "Present".
  const rangePattern =
    /(\d{4})(?:-(\d{2}))?\s*(?:[–\-—to]+\s*)(present|current|now|(\d{4})(?:-(\d{2}))?)?/i;

  for (const item of knowledge) {
    if (item.kind !== 'experience') continue;
    // Look at every place the dates may appear on the item.
    const detail = `${item.detail ?? ''} ${item.value ?? ''}`;
    const match = rangePattern.exec(detail);
    if (!match) continue;
    const startYear = Number(match[1]);
    const startMonth = match[2] ? Number(match[2]) : 1;
    const openEnded = /present|current|now/i.test(match[3] ?? '');
    const endYear = openEnded ? nowYear : Number(match[4]);
    const endMonth = openEnded ? new Date().getMonth() + 1 : match[5] ? Number(match[5]) : 12;
    if (!Number.isFinite(startYear) || !Number.isFinite(endYear) || endYear < startYear) continue;
    ranges.push([startYear * 12 + startMonth - 1, endYear * 12 + endMonth - 1]);
  }

  if (!ranges.length) return null;

  // Merge overlapping ranges so concurrent roles are not double counted.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [ranges[0]];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const monthsTotal = merged.reduce((acc, [start, end]) => acc + (end - start), 0);
  const years = Math.round((monthsTotal / 12) * 10) / 10;
  return years > 0 ? years : null;
}

/** True when the question clearly maps to one profile key — used to explain "why". */
export function explainConfidence(question: string, item: KnowledgeItem): string {
  const score = semanticSimilarity(question, `${item.label} ${item.value}`);
  if (score > 0.7) return `Strong match with “${item.label}”.`;
  if (score > 0.4) return `Related to “${item.label}”.`;
  return `Loosely related to “${item.label}”.`;
}

export function isFactualQuestion(field: DetectedField): boolean {
  const text = normalizeForMatch(`${field.label} ${field.hint ?? ''}`);
  return /\b(what|which|when|where|who|how much|how many|email|phone|name|year|number)\b/.test(text);
}