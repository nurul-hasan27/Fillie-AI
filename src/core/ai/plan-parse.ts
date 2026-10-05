import { parseJsonLoose } from './shared';
import { clamp01, normalizeForMatch, toSingleLine } from '../text';

export type AnswerType =
  | 'short'
  | 'long'
  | 'choice'
  | 'multi_choice'
  | 'number'
  | 'date'
  | 'boolean'
  | 'file'
  | 'unknown';

export type PlanAction = 'fill' | 'ask' | 'skip';

export interface ParsedInterviewOption {
  label: string;
  value: string;
  ref?: string;
}

export interface ParsedInterviewQuestion {
  id: string;
  label: string;
  help?: string;
  type: 'choice' | 'text' | 'longtext' | 'number';
  options: ParsedInterviewOption[];
  required: boolean;
}

export interface ParsedInterview {
  reason: string;
  questions: ParsedInterviewQuestion[];
}

export interface ParsedFieldPlan {
  id: string;
  intent: string;
  action: PlanAction;
  answer: string;
  answerType: AnswerType;
  option?: string;
  options: string[];
  boolean?: boolean;
  confidence: number;
  sources: string[];
  reason?: string;
  interview?: ParsedInterview;
  /** Validation notes surfaced in debug mode. */
  problems: string[];
}

export interface ParsedPlan {
  fields: ParsedFieldPlan[];
  /** Plan-level problems (bad JSON, wrong shape, injected content…). */
  problems: string[];
  ok: boolean;
}

const ANSWER_TYPES: AnswerType[] = [
  'short',
  'long',
  'choice',
  'multi_choice',
  'number',
  'date',
  'boolean',
  'file',
  'unknown',
];

const ACTIONS: PlanAction[] = ['fill', 'ask', 'skip'];

/** Phrases that indicate the model obeyed page-injected instructions instead of the task. */
const SUSPICIOUS_PHRASES = [
  'ignore previous',
  'ignore all previous',
  'ignore the instructions',
  'system prompt',
  'you are now',
  'as an ai language model',
  'disregard the above',
  'new instructions',
  'reveal your',
  'developer message',
];

export function detectSuspiciousContent(text: string): string[] {
  const lower = text.toLowerCase();
  return SUSPICIOUS_PHRASES.filter((phrase) => lower.includes(phrase));
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((entry) => asString(entry)).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    // Models occasionally nest the answer one level too deep.
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'value', 'answer', 'label', 'name']) {
      if (typeof record[key] === 'string') return String(record[key]).trim();
    }
  }
  return '';
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => asString(entry)).filter(Boolean);
  const single = asString(value);
  return single ? [single] : [];
}

function asConfidence(value: unknown): number {
  const n = typeof value === 'string' ? Number(value.replace('%', '')) : Number(value);
  if (!Number.isFinite(n)) return 0;
  // Models occasionally answer in percent. Only values above 10 can be a
  // percentage (a 0–1 confidence never exceeds 1, and a typo of "2" must not
  // silently become 2%).
  if (n > 10 && n <= 100) return clamp01(n / 100);
  return clamp01(n);
}

function parseInterview(value: unknown): ParsedInterview | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const rawQuestions = Array.isArray(record.questions) ? record.questions : [];
  const questions: ParsedInterviewQuestion[] = rawQuestions
    .slice(0, 6)
    .map((raw, index) => {
      const q = (raw ?? {}) as Record<string, unknown>;
      const label = asString(q.label) || asString(q.question) || asString(q.text);
      const typeRaw = asString(q.type).toLowerCase();
      const type: ParsedInterviewQuestion['type'] = (['choice', 'text', 'longtext', 'number'] as const).includes(
        typeRaw as ParsedInterviewQuestion['type'],
      )
        ? (typeRaw as ParsedInterviewQuestion['type'])
        : 'text';
      const options: ParsedInterviewOption[] = (Array.isArray(q.options) ? q.options : [])
        .slice(0, 20)
        .map((opt) => {
          const o = (opt ?? {}) as Record<string, unknown>;
          const labelValue = asString(o.label) || asString(o.text) || asString(o.value);
          return {
            label: labelValue,
            value: asString(o.value) || labelValue,
            ref: asString(o.ref) || asString(o.source) || undefined,
          };
        })
        .filter((option) => option.label.length > 0);

      // A "choice" question with no options is unusable — degrade to free text.
      const resolvedType = type === 'choice' && options.length === 0 ? 'text' : type;
      return {
        id: asString(q.id) || `q${index + 1}`,
        label,
        help: asString(q.help) || asString(q.description) || undefined,
        type: resolvedType,
        options: resolvedType === 'choice' ? options : [],
        required: q.required === undefined ? true : Boolean(q.required),
      };
    })
    .filter((question) => question.label.length > 0);

  if (!questions.length) return undefined;
  return { reason: asString(record.reason) || asString(record.missing) || '', questions };
}

/**
 * Parses the model's plan response defensively. Any structural problem is
 * recorded in `problems` rather than thrown, so one bad field never takes down
 * the whole scan.
 */
export function parsePlanResponse(text: string): ParsedPlan {
  const problems: string[] = [];
  const suspicious = detectSuspiciousContent(text);
  if (suspicious.length) {
    problems.push(`Response contained instruction-like language (${suspicious.join(', ')}) and was discarded.`);
    return { fields: [], problems, ok: false };
  }

  const json = parseJsonLoose<unknown>(text);
  if (json === null || typeof json !== 'object') {
    return { fields: [], problems: ['The AI response was not valid JSON.'], ok: false };
  }

  const rawFields = Array.isArray((json as Record<string, unknown>).fields)
    ? ((json as Record<string, unknown>).fields as unknown[])
    : Array.isArray(json)
      ? (json as unknown[])
      : null;

  if (!rawFields) {
    return { fields: [], problems: ['The AI response did not contain a "fields" array.'], ok: false };
  }

  const fields: ParsedFieldPlan[] = [];
  rawFields.forEach((raw, index) => {
    const record = (raw ?? {}) as Record<string, unknown>;
    const id = asString(record.id) || asString(record.field_id) || asString(record.question_id);
    if (!id) {
      problems.push(`Entry ${index + 1} had no id and was skipped.`);
      return;
    }
    const actionRaw = asString(record.action).toLowerCase();
    const action: PlanAction = (ACTIONS as string[]).includes(actionRaw) ? (actionRaw as PlanAction) : 'ask';
    const typeRaw = asString(record.answer_type ?? record.answerType ?? record.type).toLowerCase().replace(/[\s-]+/g, '_');
    const answerType: AnswerType = (ANSWER_TYPES as string[]).includes(typeRaw)
      ? (typeRaw as AnswerType)
      : 'unknown';
    const interview = parseInterview(record.interview);

    const plan: ParsedFieldPlan = {
      id,
      intent: asString(record.intent) || asString(record.meaning),
      action,
      answer: asString(record.answer ?? record.value ?? (record.answer as Record<string, unknown> | undefined)?.text),
      answerType,
      options: asStringArray(record.options),
      confidence: asConfidence(record.confidence),
      sources: asStringArray(record.sources ?? record.source),
      reason: asString(record.reason ?? record.explanation) || undefined,
      interview,
      problems: [],
    };

    const optionValue = asString(record.option);
    if (optionValue) plan.option = optionValue;
    if (typeof record.boolean === 'boolean') plan.boolean = record.boolean;
    else if (typeof record.checked === 'boolean') plan.boolean = record.checked;

    if (plan.action === 'fill' && !plan.answer && plan.boolean === undefined && !plan.option && plan.options.length === 0) {
      plan.action = 'ask';
      plan.problems.push('Model marked the field as fillable but returned no answer.');
    }
    if (plan.action === 'ask' && !plan.interview) {
      plan.problems.push('Model asked the user a question but supplied no interview.');
    }
    fields.push(plan);
  });

  return { fields, problems, ok: fields.length > 0 };
}

export interface ParsedGeneratedAnswer {
  answer: string;
  confidence: number;
  sources: string[];
  generic: boolean;
  problems: string[];
}

export function parseGeneratedAnswer(text: string): ParsedGeneratedAnswer {
  const problems: string[] = [];
  const suspicious = detectSuspiciousContent(text);
  if (suspicious.length) {
    return {
      answer: '',
      confidence: 0,
      sources: [],
      generic: false,
      problems: [`The draft contained instruction-like language (${suspicious.join(', ')}) and was discarded.`],
    };
  }
  const json = parseJsonLoose<unknown>(text);
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const record = json as Record<string, unknown>;
    const answer = toSingleLine(asString(record.answer ?? record.text ?? record.value));
    if (!answer) {
      return { answer: '', confidence: 0, sources: [], generic: false, problems: ['The draft was empty.'] };
    }
    return {
      answer,
      confidence: asConfidence(record.confidence),
      sources: asStringArray(record.sources),
      generic: typeof record.generic === 'boolean' ? record.generic : false,
      problems,
    };
  }
  // Fallback: a bare answer string is acceptable.
  const bare = toSingleLine(text);
  if (bare.length > 2 && !bare.startsWith('{')) {
    return { answer: bare, confidence: 0.55, sources: [], generic: false, problems };
  }
  return { answer: '', confidence: 0, sources: [], generic: false, problems: ['Could not read the generated answer.'] };
}

/** True when two questions mean roughly the same thing (used for de-duplication). */
export function isSameIntent(a: string, b: string): boolean {
  const normA = normalizeForMatch(a);
  const normB = normalizeForMatch(b);
  if (!normA || !normB) return false;
  return normA === normB;
}