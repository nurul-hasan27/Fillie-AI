import type {
  AIProvider,
  AIRequest,
  AIResponse,
  AISettings,
  AnswerValue,
  ApplicationContext,
  DetectedField,
  FieldPlan,
  KnowledgeBundle,
  KnowledgeItem,
  KnowledgeRef,
  LearnedAnswer,
  SessionStats,
  UserProvidedFact,
} from '../types';
import { aliasKnowledgeIds, retrieveKnowledge } from '../retrieval';
import { buildCandidateContext, groundingCorpus, knowledgeItemToRef } from '../knowledge';
import { findMemoryMatches } from '../memory';
import { buildAnalysisMessages, buildGenerationMessages, desiredLengthForField, type PromptFieldInput } from '../ai/prompts';
import { parseGeneratedAnswer, parsePlanResponse, type ParsedFieldPlan } from '../ai/plan-parse';
import { isBlockedField, normalizeAnswerForField, validateValue } from './answer';
import { adjustConfidence, assessGrounding } from './grounding';
import { buildFallbackInterview } from './interview';
import { buildOfflineNarrative, resolveOffline } from './offline';
import { clamp01, truncate } from '../text';

export interface PlannerProgress {
  phase: 'retrieve' | 'offline' | 'ai' | 'ground' | 'assemble';
  completed: number;
  total: number;
  message?: string;
}

export interface PlannerDeps {
  settings: AISettings;
  provider?: AIProvider | null;
  /** Injected transport so caching / rate limiting can live above the planner. */
  send?: (request: AIRequest) => Promise<AIResponse>;
  onProgress?: (progress: PlannerProgress) => void;
  signal?: AbortSignal;
  now?: () => number;
}

export interface PlanFieldsInput {
  fields: DetectedField[];
  bundle: KnowledgeBundle;
  memory: LearnedAnswer[];
  context: ApplicationContext;
  userFacts: UserProvidedFact[];
}

export interface PlanFieldsResult {
  plans: FieldPlan[];
  stats: SessionStats;
  aiCalls: number;
  memoryHits: number;
  /** Ids of learned answers that were actually used, for usage counting. */
  usedMemoryIds: string[];
  problems: string[];
  usedAI: boolean;
}

const LEARNED_EXAMPLE_LIMIT = 3;

/**
 * The reasoning pipeline for one scan:
 * retrieve → safe deterministic answers → batched AI analysis → grounding →
 * confidence routing → interview for what is still unresolved.
 */
export async function planFields(input: PlanFieldsInput, deps: PlannerDeps): Promise<PlanFieldsResult> {
  const { fields, bundle, memory, context, userFacts } = input;
  const now = deps.now ?? (() => Date.now());
  const problems: string[] = [];

  const plans = new Map<string, FieldPlan>();
  const pending: DetectedField[] = [];
  const usedMemoryIds = new Set<string>();
  let aiCalls = 0;
  let memoryHits = 0;

  const knowledgeByField = new Map<string, KnowledgeItem[]>();
  const matchesByField = new Map<string, ReturnType<typeof findMemoryMatches>>();

  /* 1. Retrieve knowledge + memory for every question. */
  for (const [index, field] of fields.entries()) {
    deps.onProgress?.({ phase: 'retrieve', completed: index, total: fields.length, message: field.label });
    const question = questionText(field);
    const aliasIds = aliasKnowledgeIds(question);
    const retrieved = retrieveKnowledge(bundle, question, { includeIds: aliasIds, limit: 8, minScore: 0.1 });
    const docItems = field.kind === 'file' ? bundle.items.filter((item) => item.kind === 'document') : [];
    const combinedKnowledge = docItems.length ? [...retrieved.items, ...docItems] : retrieved.items;
    knowledgeByField.set(field.id, combinedKnowledge);

    const matches = findMemoryMatches(memory, field.label, '', {
      allowGenericReuse: true,
      company: context.company,
      role: context.role,
      host: context.host,
    });
    matchesByField.set(field.id, matches);

    // Checked before the blocked-field rules so a disabled password box is
    // reported as "not editable" rather than as a sensitive field.
    if (field.disabled || field.visible === false) {
      plans.set(field.id, {
        field,
        status: 'skipped',
        confidence: 0,
        sources: [],
        reason: field.disabled
          ? 'This control is disabled on the page.'
          : 'This control is hidden on the page.',
      });
      continue;
    }

    const hasMatchingDoc = field.kind === 'file' && bundle.items.some((item) => item.kind === 'document' && item.docRef);
    const blocked = isBlockedField(field, hasMatchingDoc);
    if (blocked) {
      plans.set(field.id, {
        field,
        status: 'manual',
        confidence: 0,
        sources: [],
        blockedReason: blocked,
        reason: blocked,
      });
      continue;
    }

    pending.push(field);
  }

  /* 2. Deterministic / offline layer — fast, free, and obviously safe. */
  for (const [index, field] of pending.entries()) {
    deps.onProgress?.({ phase: 'offline', completed: index, total: pending.length });
    const plan = planOffline(field, {
      knowledge: knowledgeByField.get(field.id) ?? [],
      memoryMatches: matchesByField.get(field.id) ?? [],
      company: context.company,
    });
    if (!plan) continue;
    if (plan.source === 'memory') {
      memoryHits += 1;
      // Counted here rather than at fill time: a reused answer has already been
      // matched and is about to be written.
      const used = (matchesByField.get(field.id) ?? []).find((match) => !match.blockedByContext);
      if (used) usedMemoryIds.add(used.answer.id);
    }
    if (plan.confidence >= deps.settings.autoFillThreshold) {
      plans.set(field.id, plan);
    } else if (!plan) {
      continue;
    } else {
      // Keep as a low-confidence candidate; the AI may do better.
      if (!plans.has(field.id)) plans.set(field.id, plan);
    }
  }

  /* 3. AI analysis for everything still unresolved. */
  const needsAI = pending.filter((field) => {
    const existing = plans.get(field.id);
    return !existing || existing.status === 'needs-attention' || (existing.confidence ?? 0) < deps.settings.autoFillThreshold;
  });

  const canUseAI = Boolean(deps.settings.enabled && deps.provider && deps.provider.id !== 'offline' && deps.send);
  if (needsAI.length && canUseAI) {
    const batchSize = Math.max(1, Math.min(20, deps.settings.batchSize));
    for (let offset = 0; offset < needsAI.length; offset += batchSize) {
      if (deps.signal?.aborted) break;
      const batch = needsAI.slice(offset, offset + batchSize);
      const promptFields: PromptFieldInput[] = batch.map((field) => ({
        field,
        facts: knowledgeByField.get(field.id) ?? [],
      }));

      const learnedExamples = memory
        .filter((entry) => entry.context.isGeneric)
        .slice(0, LEARNED_EXAMPLE_LIMIT)
        .map((entry) => ({ question: entry.question, answer: entry.answer }));

      deps.onProgress?.({
        phase: 'ai',
        completed: offset,
        total: needsAI.length,
        message: `Understanding ${batch.length} ${batch.length === 1 ? 'question' : 'questions'}`,
      });

      try {
        const candidateProfile = buildCandidateContext(bundle);
        const response = await deps.send!({
          messages: buildAnalysisMessages({
            fields: promptFields,
            context,
            userFacts,
            candidateProfile,
            learnedExamples,
          }),
          json: true,
          signal: deps.signal,
          cacheKey: `plan:${context.host}:${batch.map((f) => f.id).join(',')}:${now()}`,
        });
        aiCalls += 1;
        const parsed = parsePlanResponse(response.text);
        problems.push(...parsed.problems);
        if (parsed.ok) {
          for (const field of batch) {
            const raw = parsed.fields.find((candidate) => candidate.id === field.id);
            if (!raw) continue;
            const plan = planFromAI({
              field,
              raw,
              knowledge: knowledgeByField.get(field.id) ?? [],
              corpus: groundingCorpus(bundle),
              userFacts,
              context,
            }, deps);
            if (plan.source === 'memory') memoryHits += 1;
            plans.set(field.id, plan);
          }
        }
      } catch (error) {
        problems.push(describeError(error));
        // Fall through: unresolved fields get an interview instead.
      }
    }
  }

  /* 4. Anything still unresolved becomes a user task. */
  deps.onProgress?.({ phase: 'assemble', completed: 0, total: pending.length });
  for (const field of pending) {
    const existing = plans.get(field.id);
    // "Ready" only counts when it clears the auto-fill threshold; a weaker
    // candidate still needs the user even when no AI was available to improve it.
    if (existing && existing.status === 'ready' && existing.confidence >= deps.settings.autoFillThreshold) continue;
    if (existing && (existing.status === 'review' || existing.status === 'skipped' || existing.status === 'manual')) {
      continue;
    }
    // Already carrying a tailored interview (from the model) — keep it.
    if (existing?.interview?.questions.length) continue;
    const knowledge = knowledgeByField.get(field.id) ?? [];
    const matches = matchesByField.get(field.id) ?? [];
    const blockedMemory = matches.find((match) => match.blockedByContext);

    const interview = buildFallbackInterview({
      field,
      knowledge,
      blockedMemoryReason: blockedMemory?.reason,
    });

    plans.set(field.id, {
      field,
      status: 'needs-attention',
      confidence: existing?.confidence ?? 0,
      sources: existing?.sources ?? [],
      // Surface a blocked memory reuse as the reason — it explains why a
      // previously answered question is asking again.
      reason: blockedMemory?.reason ?? existing?.reason ?? interview.reason,
      interview,
    });
  }

  // Preserve the scanner's field order so the UI and the page agree.
  const orderedPlans: FieldPlan[] = [];
  for (const field of fields) {
    const plan = plans.get(field.id);
    if (plan) orderedPlans.push(plan);
  }
  // Anything planned but no longer in the field list (should not happen) is kept
  // so no work is silently dropped.
  for (const plan of plans.values()) {
    if (!orderedPlans.includes(plan)) orderedPlans.push(plan);
  }

  const result: PlanFieldsResult = {
    plans: orderedPlans,
    stats: computeStats(orderedPlans),
    aiCalls,
    memoryHits,
    usedMemoryIds: [...usedMemoryIds],
    problems,
    usedAI: aiCalls > 0,
  };
  return result;
}

function planOffline(
  field: DetectedField,
  input: {
    knowledge: KnowledgeItem[];
    memoryMatches: ReturnType<typeof findMemoryMatches>;
    company?: string;
  },
): FieldPlan | null {
  const resolution = resolveOffline({ field, ...input });
  if (resolution.answer === null || resolution.answer === undefined) return null;

  const normalized = normalizeAnswerForField(
    field,
    resolution.answer,
    answerTypeForField(field, Array.isArray(resolution.answer)),
  );
  const validation = validateValue(field, normalized.value);
  const value = Array.isArray(normalized.value) ? normalized.value : normalized.value;

  const plan: FieldPlan = {
    field,
    status: 'ready',
    answer: value ?? null,
    source:
      resolution.layer === 'memory'
        ? 'memory'
        : resolution.layer === 'alias' || resolution.layer === 'retrieval'
          ? 'profile'
          : 'deterministic',
    confidence: clamp01(resolution.confidence),
    reason: resolution.reason,
    sources: resolution.sources.map((item) => knowledgeItemToRef(item)),
  };

  if (!validation.valid && !Array.isArray(value)) {
    plan.status = 'needs-attention';
    plan.confidence = Math.min(plan.confidence, 0.5);
    plan.reason = validation.problems[0];
  }
  if (normalized.problems.length && plan.status === 'ready') {
    plan.confidence = Math.min(plan.confidence, 0.75);
    plan.reason = normalized.problems[0];
  }
  return plan;
}

interface PlanFromAIInput {
  field: DetectedField;
  raw: ParsedFieldPlan;
  /** Facts sent to the model for this question. */
  knowledge: KnowledgeItem[];
  /** The full local profile corpus, used for on-device grounding checks. */
  corpus: KnowledgeItem[];
  userFacts: UserProvidedFact[];
  context: ApplicationContext;
}

function planFromAI(input: PlanFromAIInput, deps: PlannerDeps): FieldPlan {
  const { field, raw, knowledge, corpus, userFacts } = input;
  

  // Sources shown to the user: the facts the model named, resolved against the
  // full corpus so a valid reference is never dropped just because retrieval
  // ranked it outside the sent subset.
  const resolvedRefs = raw.sources
    .map((id) => corpus.find((item) => item.id === id) ?? knowledge.find((item) => item.id === id))
    .filter((item): item is KnowledgeItem => Boolean(item))
    .map((item) => knowledgeItemToRef(item));

const sources: KnowledgeRef[] = resolvedRefs.length ? resolvedRefs : knowledge.slice(0, 3).map((item) => knowledgeItemToRef(item));

  if (raw.action === 'skip') {
    return {
      field,
      status: 'skipped',
      confidence: 1,
      sources: [],
      reason: raw.reason || 'Fillie deliberately left this field alone.',
    };
  }

  if (raw.action === 'ask' || (!raw.answer && raw.boolean === undefined)) {
    return {
      field,
      status: 'needs-attention',
      confidence: clamp01(raw.confidence * 0.5),
      sources,
      reason: raw.interview?.reason ?? raw.reason ?? 'Fillie needs one more detail.',
      interview:
        raw.interview && raw.interview.questions.length
          ? {
              reason: raw.interview.reason || 'Fillie needs one more detail.',
              questions: raw.interview.questions.map((question) => ({
                id: question.id,
                label: question.label,
                help: question.help,
                type: question.type,
                required: question.required,
                placeholder: question.type === 'longtext' ? 'Type it the way you would say it…' : undefined,
                options: question.options.map((option) => ({
                  label: option.label,
                  value: option.value,
                  ref: sources.find((source) => source.id === option.ref),
                })),
              })),
            }
          : buildFallbackInterview({ field, knowledge }),
    };
  }

  const answerType = raw.answerType === 'unknown' ? answerTypeForField(field, false) : raw.answerType;
  const proposed: AnswerValue = raw.boolean !== undefined ? raw.boolean : raw.option ? raw.option : raw.options.length ? raw.options : raw.answer;

  const normalized = normalizeAnswerForField(field, proposed, answerType);
  const answerText = Array.isArray(normalized.value)
    ? normalized.value.join(', ')
    : normalized.value === null || normalized.value === undefined
      ? ''
      : String(normalized.value);

  const grounding = assessGrounding({
    answer: answerText,
    // Grounding is checked against everything the user has stored, not only the
    // subset we sent to the model, so a real fact can never look fabricated.
    knowledge: corpus,
    userFacts,
    question: questionText(field),
    context: field.context,
    options: field.options,
    hint: field.hint,
  });

  const shape: 'short' | 'long' =
    answerType === 'long' || field.kind === 'textarea' ? 'long' : 'short';
  const adjustment = adjustConfidence(raw.confidence, grounding, shape);
  let confidence = clamp01(raw.confidence * adjustment.multiplier);
  const notes = [...raw.problems, ...normalized.problems, adjustment.note ?? ''].filter(Boolean);
  const reason = raw.reason || notes[0];

  const validation = validateValue(field, normalized.value);
  if (!validation.valid) {
    confidence = Math.min(confidence, 0.45);
  }

  const source: FieldPlan['source'] = sources.some((ref) => ref.kind === 'memory')
    ? 'memory'
    : resolvedRefs.length &&
        resolvedRefs.every((ref) => ref.kind === 'profile' || ref.kind === 'education' || ref.kind === 'preference')
      ? 'profile'
      : 'generated';

  if (adjustment.escalate) {
    return {
      field,
      status: 'needs-attention',
      confidence,
      sources,
      reason: adjustment.note ?? 'Fillie could not verify this answer from your profile.',
      interview: buildFallbackInterview({ field, knowledge }),
    };
  }

  let status: FieldPlan['status'] = 'ready';
  if (confidence < deps.settings.reviewThreshold) status = 'needs-attention';
  else if (confidence < deps.settings.autoFillThreshold) status = 'review';
  if (!validation.valid && status === 'ready') status = 'review';

  const plan: FieldPlan = {
    field,
    status,
    answer: normalized.value,
    source,
    confidence,
    reason: reason ? truncate(String(reason), 200) : undefined,
    sources,
  };

  if (status === 'needs-attention') {
    plan.interview = buildFallbackInterview({ field, knowledge });
  }
  return plan;
}

export function answerTypeForField(field: DetectedField, isList: boolean): 'short' | 'long' | 'choice' | 'multi_choice' | 'boolean' | 'number' | 'date' | 'file' {
  if (field.kind === 'file') return 'file';
  if (field.kind === 'radio') return 'choice';
  if (field.kind === 'checkbox') {
    if (field.acknowledgement && !field.options?.length) return 'boolean';
    return isList ? 'multi_choice' : 'boolean';
  }
  if (field.kind === 'select') return 'choice';
  if (field.kind === 'date') return 'date';
  if (field.kind === 'number') return 'number';
  if (field.kind === 'textarea') return 'long';
  if (field.kind === 'email') return 'short';
  return 'short';
}

export function questionText(field: DetectedField): string {
  return `${field.label} ${field.hint ?? ''} ${field.context ?? ''}`.trim();
}

export function computeStats(plans: FieldPlan[]): SessionStats {
  const stats: SessionStats = {
    total: plans.length,
    filledFromProfile: 0,
    filledFromMemory: 0,
    generated: 0,
    fromUser: 0,
    needsAttention: 0,
    skipped: 0,
    manual: 0,
    verified: 0,
  };
  for (const plan of plans) {
    switch (plan.status) {
      case 'ready':
      case 'review':
        if (plan.source === 'memory') stats.filledFromMemory += 1;
        else if (plan.source === 'profile' || plan.source === 'deterministic') stats.filledFromProfile += 1;
        else if (plan.source === 'user') stats.fromUser += 1;
        else stats.generated += 1;
        if (plan.fillResult?.verified) stats.verified += 1;
        break;
      case 'needs-attention':
        stats.needsAttention += 1;
        break;
      case 'skipped':
        stats.skipped += 1;
        break;
      case 'manual':
        stats.manual += 1;
        break;
    }
  }
  return stats;
}

export function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'kind' in error) {
    const kind = (error as { kind: string }).kind;
    switch (kind) {
      case 'rate-limit':
        return 'The AI provider is rate limiting requests. Fillie fell back to your profile for these questions.';
      case 'auth':
        return 'The AI provider rejected the API key. Fillie fell back to your profile.';
      case 'timeout':
        return 'The AI request timed out. Fillie fell back to your profile.';
      case 'network':
        return 'Could not reach the AI provider. Fillie fell back to your profile.';
      case 'not-configured':
        return 'No AI provider is configured, so Fillie answered from your profile only.';
      default:
        return error instanceof Error ? error.message : 'The AI request failed.';
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* Interview resolution → generated answer                            */
/* ------------------------------------------------------------------ */

export interface GenerateAnswerInput {
  question: string;
  hint?: string;
  contextText?: string;
  context: ApplicationContext;
  /** Facts sent to the model. */
  knowledge: KnowledgeItem[];
  /** Full local corpus for grounding; defaults to `knowledge`. */
  corpus?: KnowledgeItem[];
  userFacts: UserProvidedFact[];
  /** Answers the user just gave during the interview. `refId` ties a note to the profile fact it came from. */
  notes: Array<{ label: string; answer: string; refId?: string }>;
  /** Knowledge the user explicitly chose in the interview. */
  chosenRefs?: KnowledgeRef[];
  field?: DetectedField;
  memoryExamples?: LearnedAnswer[];
}

export interface GenerateAnswerResult {
  answer: string;
  confidence: number;
  sources: KnowledgeRef[];
  generic: boolean;
  notes: string[];
  usedAI: boolean;
  problems: string[];
}

export async function generateAnswer(
  input: GenerateAnswerInput,
  deps: PlannerDeps,
): Promise<GenerateAnswerResult> {
  const notes: string[] = [];
  const problems: string[] = [];

  if (deps.settings.enabled && deps.provider && deps.provider.id !== 'offline' && deps.send) {
    try {
      const response = await deps.send({
        messages: buildGenerationMessages({
          question: input.question,
          hint: input.hint,
          contextText: input.contextText,
          applicationContext: input.context,
          facts: input.knowledge,
          userFacts: input.userFacts,
          userNotes: input.notes,
          desiredLength: input.field ? desiredLengthForField(input.field) : 'medium',
        }),
        json: true,
        signal: deps.signal,
      });
      const parsed = parseGeneratedAnswer(response.text);
      problems.push(...parsed.problems);
      if (parsed.answer) {
        const grounding = assessGrounding({
          answer: parsed.answer,
          knowledge: input.corpus ?? input.knowledge,
          userFacts: input.userFacts,
          question: input.question,
          context: input.contextText,
        });
        const shape = input.field && input.field.kind !== 'textarea' ? 'short' : 'long';
        const adjustment = adjustConfidence(parsed.confidence || 0.6, grounding, shape);
        if (adjustment.note) notes.push(adjustment.note);
        const sources = parsed.sources
          .map((id) => input.knowledge.find((item) => item.id === id))
          .filter((item): item is KnowledgeItem => Boolean(item))
          .map((item) => knowledgeItemToRef(item));

        return {
          answer: parsed.answer,
          confidence: clamp01((parsed.confidence || 0.6) * (adjustment.multiplier || 0.7)),
          sources: sources.length ? sources : input.knowledge.slice(0, 3).map((item) => knowledgeItemToRef(item)),
          generic: parsed.generic,
          notes,
          usedAI: true,
          problems,
        };
      }
    } catch (error) {
      problems.push(describeError(error));
    }
  }

  // Offline composition — honest and modest. The draft is built only from what
  // the user typed or from a single stored fact, and always says which.
  const corpus = input.corpus ?? input.knowledge;
  const entityKnowledge = corpus.filter(
    (item) => item.kind === 'project' || item.kind === 'experience' || item.kind === 'achievement',
  );
  const narrativeSource = entityKnowledge
    .filter((item) => item.value.length > 120)
    .sort((a, b) => b.value.length - a.value.length)[0];

  // When the user picked a project or a role, that fact's own text is the basis
  // for the draft — not the option label they clicked on.
  const chosenFacts = (input.chosenRefs ?? [])
    .map((ref) => corpus.find((item) => item.id === ref.id))
    .filter((item): item is KnowledgeItem => item !== undefined && item.value.length > 80);
  const userNotes = input.notes
    .filter((note) => note.refId)
    .map((note) => note.answer)
    .join(' ')
    .trim();
  const freeTextNotes = input.notes
    .filter((note) => !note.refId)
    .map((note) => note.answer)
    .join(' ')
    .trim();

  const chosenNarrative = chosenFacts.sort((a, b) => b.value.length - a.value.length)[0];
  const narrativeField: DetectedField = input.field ?? {
    id: 'draft',
    kind: 'textarea',
    label: '',
    required: false,
    disabled: false,
    visible: true,
    source: 'native',
    fingerprint: 'draft',
  };
  // Precedence: what the user chose or typed always beats anything Fillie
  // could assemble by itself.
  const composed =
    freeTextNotes ||
    (chosenNarrative ? buildOfflineNarrative(chosenNarrative, narrativeField) : null) ||
    userNotes ||
    (narrativeSource ? buildOfflineNarrative(narrativeSource, narrativeField) : null) ||
    '';
  if (!composed) {
    return {
      answer: '',
      confidence: 0,
      sources: [],
      generic: false,
      notes,
      usedAI: false,
      problems: [...problems, 'Fillie could not draft an answer from your stored information.'],
    };
  }

  const sources: KnowledgeRef[] = [...(input.chosenRefs ?? [])];
  // Attribute the draft to the user's own words and, when used, the stored fact
  // it was drawn from — the review UI shows these.
  for (const note of input.notes.slice(0, 2)) {
    const match = corpus.find((item) => note.answer.length > 12 && item.value.includes(note.answer.slice(0, 12)));
    if (match && !sources.some((ref) => ref.id === match.id)) sources.push(knowledgeItemToRef(match));
  }
  if (narrativeSource && !sources.some((ref) => ref.id === narrativeSource.id)) {
    sources.push(knowledgeItemToRef(narrativeSource));
  }

  return {
    answer: composed,
    confidence: userNotes ? 0.6 : 0.5,
    sources,
    generic: false,
    notes: [
      ...notes,
      'Written from your own answers and profile — the AI provider was unavailable, so nothing was improvised.',
    ],
    usedAI: false,
    problems,
  };
}
/**
 * Diagnostic view of the pipeline: what the engine understood for each field
 * and why. Used by the extension's Advanced settings and by tests.
 */
export async function explainFields(
  input: PlanFieldsInput,
  deps: PlannerDeps,
): Promise<Array<Record<string, unknown>>> {
  const bundle = input.bundle;
  const rows: Array<Record<string, unknown>> = [];
  for (const field of input.fields) {
    const question = questionText(field);
    const aliasIds = aliasKnowledgeIds(question);
    const retrieved = retrieveKnowledge(bundle, question, { includeIds: aliasIds, limit: 8, minScore: 0.1 });
    const resolution = resolveOffline({
      field,
      knowledge: retrieved.items,
      memoryMatches: [],
      company: input.context.company,
    });
    rows.push({
      id: field.id,
      label: field.label,
      hint: field.hint,
      context: field.context,
      question,
      aliasIds,
      retrieved: retrieved.items.map((item) => item.id),
      layer: resolution.layer,
      answer: resolution.answer,
      confidence: resolution.confidence,
    });
  }
  void deps;
  return rows;
}
