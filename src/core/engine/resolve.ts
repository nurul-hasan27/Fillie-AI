import type {
  ApplicationContext,
  DetectedField,
  FieldPlan,
  FormSession,
  KnowledgeBundle,
  KnowledgeRef,
  LearnedAnswer,
  UserProvidedFact,
  UserProvidedFact as Fact,
} from '../types';
import { retrieveKnowledge, aliasKnowledgeIds } from '../retrieval';
import { createLearnedAnswer, findMemoryMatches, upsertLearnedAnswer } from '../memory';
import { generateAnswer, questionText, type GenerateAnswerResult, type PlannerDeps } from './planner';
import { normalizeText, truncate } from '../text';

export interface ResolveInterviewInput {
  plan: FieldPlan;
  /** Answers keyed by interview question id. */
  answers: Record<string, string>;
  bundle: KnowledgeBundle;
  memory: LearnedAnswer[];
  context: ApplicationContext;
  userFacts: UserProvidedFact[];
  deps: PlannerDeps;
}

export interface ResolveInterviewResult {
  draft: string;
  confidence: number;
  sources: KnowledgeRef[];
  generic: boolean;
  notes: string[];
  usedAI: boolean;
  problems: string[];
  /** Facts captured from the interview, ready to be persisted as memory. */
  facts: Fact[];
  memories: LearnedAnswer[];
}

/**
 * Turns the user's interview answers into a polished draft answer. Also records
 * the approved-answer candidate in memory so future similar questions reuse it.
 */
export async function resolveInterview(input: ResolveInterviewInput): Promise<ResolveInterviewResult> {
  const { plan, answers, bundle, memory, context, userFacts, deps } = input;
  const interview = plan.interview;
  const notes: Array<{ label: string; answer: string }> = [];
  /** Knowledge the user picked by name — shown as the basis for the draft. */
  const chosenRefs: KnowledgeRef[] = [];

  if (interview) {
    for (const question of interview.questions) {
      const value = (answers[question.id] ?? '').trim();
      if (!value) continue;
      if (question.type === 'choice') {
        const option = question.options?.find((candidate) => candidate.value === value);
        notes.push({ label: question.label, answer: option?.label ?? value });
        // Choosing "Trailhead" is an explicit instruction to use that project.
        if (option?.ref) chosenRefs.push(option.ref);
      } else {
        notes.push({ label: question.label, answer: value });
      }
    }
  }

  const knowledge = retrieveKnowledge(bundle, questionText(plan.field), {
    includeIds: aliasKnowledgeIds(questionText(plan.field)),
    limit: 10,
    minScore: 0.05,
  }).items;

  const result: GenerateAnswerResult = await generateAnswer(
    {
      question: plan.field.label || plan.field.context || 'This form question',
      hint: plan.field.hint,
      contextText: plan.field.context,
      context,
      knowledge,
      // Grounding checks against everything the user has stored.
      corpus: bundle.items,
      userFacts,
      notes,
      chosenRefs,
      field: plan.field,
      memoryExamples: memory.filter((entry) => entry.context.isGeneric).slice(0, 3),
    },
    deps,
  );

  const facts = notes.map((note, index) => ({
    id: `fact-${Date.now().toString(36)}-${index}`,
    key: note.label,
    value: note.answer,
  }));

  const memoryCandidate: LearnedAnswer = createLearnedAnswer({
    question: plan.field.label,
    intent: noteIntent(notes),
    answer: result.answer,
    sources: result.sources,
    userFacts: facts,
    context: {
      company: context.company,
      role: context.role,
      host: context.host,
      isGeneric: result.generic,
    },
  });

  const { memory: nextMemory } = upsertLearnedAnswer(memory, memoryCandidate);

  const sources = [...chosenRefs, ...result.sources].filter(
    (ref, index, list) => list.findIndex((other) => other.id === ref.id) === index,
  );

  return {
    draft: result.answer,
    confidence: result.confidence,
    sources,
    generic: result.generic,
    notes: result.notes,
    usedAI: result.usedAI,
    problems: result.problems,
    facts,
    memories: nextMemory,
  };
}

function noteIntent(notes: Array<{ label: string; answer: string }>): string {
  if (!notes.length) return 'freeform answer';
  return notes
    .slice(0, 2)
    .map((note) => normalizeText(note.label).toLowerCase().split(/\s+/).slice(0, 4).join(' '))
    .join(' + ');
}

export interface AcceptDraftInput {
  plan: FieldPlan;
  answer: string;
  memories: LearnedAnswer[];
  context: ApplicationContext;
  facts: Fact[];
  generic?: boolean;
  /**
   * Persist to memory. Defaults to true: approving an answer is the signal that
   * the user wants Fillie to remember it.
   */
  remember?: boolean;
}

export interface AcceptDraftResult {
  plan: FieldPlan;
  memories: LearnedAnswer[];
  savedToMemory: boolean;
}

/** Marks a generated answer as approved, optionally remembering it. */
export function acceptDraft(input: AcceptDraftInput): AcceptDraftResult {
  const answer = normalizeText(input.answer);
  const plan: FieldPlan = {
    ...input.plan,
    answer,
    status: answer ? 'ready' : 'needs-attention',
    source: 'generated',
    confidence: answer ? Math.max(input.plan.confidence, 0.85) : 0,
    reason: 'You approved this answer.',
  };

  if (input.remember === false || !answer) {
    return { plan, memories: input.memories, savedToMemory: false };
  }

  const entry: LearnedAnswer = createLearnedAnswer({
    question: input.plan.field.label,
    intent: answerSourceIntent(input.plan),
    answer,
    sources: input.plan.sources,
    userFacts: input.facts,
    context: {
      company: input.context.company,
      role: input.context.role,
      host: input.context.host,
      isGeneric: input.generic ?? true,
    },
  });

  const { memory } = upsertLearnedAnswer(input.memories, entry);
  return { plan, memories: memory, savedToMemory: true };
}

function answerSourceIntent(plan: FieldPlan): string {
  if (plan.sources.length) return plan.sources[0].label.toLowerCase();
  return truncate(normalizeText(plan.field.label).toLowerCase(), 60) || 'freeform answer';
}

/** Memory hit preview used by the "Fillie remembered" UI. */
export function describeMemoryMatch(matches: ReturnType<typeof findMemoryMatches>): string | undefined {
  if (!matches.length) return undefined;
  const best = matches[0];
  return best.blockedByContext ? best.reason : `Remembered from a question you approved earlier.`;
}

export function createSession(input: {
  id: string;
  context: ApplicationContext;
  plans: FieldPlan[];
  aiCalls: number;
  memoryHits: number;
  now?: number;
}): FormSession {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    url: input.context.url,
    startedAt: now,
    updatedAt: now,
    context: input.context,
    plans: input.plans,
    stats: computeSessionStats(input.plans),
    aiCalls: input.aiCalls,
    memoryHits: input.memoryHits,
    status: 'analysing',
  };
}

export function computeSessionStats(plans: FieldPlan[]) {
  return {
    total: plans.length,
    filledFromProfile: plans.filter((p) => (p.status === 'ready' || p.status === 'review') && p.source === 'profile').length,
    filledFromMemory: plans.filter((p) => (p.status === 'ready' || p.status === 'review') && p.source === 'memory').length,
    generated: plans.filter((p) => (p.status === 'ready' || p.status === 'review') && p.source === 'generated').length,
    fromUser: plans.filter((p) => (p.status === 'ready' || p.status === 'review') && p.source === 'user').length,
    needsAttention: plans.filter((p) => p.status === 'needs-attention').length,
    skipped: plans.filter((p) => p.status === 'skipped').length,
    manual: plans.filter((p) => p.status === 'manual').length,
    verified: plans.filter((p) => p.fillResult?.verified).length,
  };
}

export type { DetectedField };