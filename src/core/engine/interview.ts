import type {
  DetectedField,
  FieldPlan,
  InterviewOption,
  InterviewQuestion,
  InterviewSpec,
  KnowledgeItem,
} from '../types';
import { knowledgeItemToRef } from '../knowledge';
import { normalizeForMatch, truncate } from '../text';

export interface FallbackInterviewInput {
  field: DetectedField;
  knowledge: KnowledgeItem[];
  /** True when a saved answer existed but could not be reused (context mismatch). */
  blockedMemoryReason?: string;
}

/** Questions that always need a number from the user. */
const NUMERIC_INTENTS: Array<{ pattern: RegExp; label: string; help?: string }> = [
  {
    pattern: /\b(salary|ctc|compensation|pay expectation|expected package|stipend|compensation expectations)\b/i,
    label: 'What salary or stipend are you expecting?',
    help: 'Fillie never guesses pay. An approximate figure is fine.',
  },
  {
    pattern: /\b(years? of experience|how many years|experience (in|length|duration))\b/i,
    label: 'How many years of relevant experience do you have?',
    help: 'A number, for example 2.',
  },
  {
    pattern: /\b(cgpa|gpa|percentage|marks|aggregate)\b/i,
    label: 'What are your academic marks?',
    help: 'For example 8.6 CGPA or 82%.',
  },
  {
    pattern: /\b(percentage of|how many (projects|internships|awards)|rank)\b/i,
    label: 'What number should Fillie use?',
  },
];

/** Yes/no questions. */
const BOOLEAN_INTENTS: Array<{ pattern: RegExp; label: string; help?: string }> = [
  { pattern: /\b(willing|open) to (relocate|move|travel)\b/i, label: 'Are you willing to relocate?' },
  { pattern: /\b(relocate|relocation)\b/i, label: 'Are you willing to relocate?' },
  { pattern: /\b(available|availability|can you start|join(ing)? date|notice period)\b/i, label: 'When can you start?' },
  { pattern: /\b(work from home|remote|hybrid)\b/i, label: 'Are you open to this work arrangement?' },
  { pattern: /\b(18|above 18|adult)\b/i, label: 'Do you confirm you are 18 or older?' },
];

/** Questions where an example story is expected. */
const STORY_INTENTS: Array<{ pattern: RegExp; label: string; entityNoun: string }> = [
  { pattern: /\b(describe|tell us about|give (an )?example|walk us through|elaborate)\b/i, label: 'Which experience should Fillie use?', entityNoun: 'experience' },
  { pattern: /\b(challenge|difficult|hard problem|tough)\b/i, label: 'Which challenge should Fillie describe?', entityNoun: 'challenge' },
  { pattern: /\b(leadership|led|lead a team|managed a team|team lead)\b/i, label: 'Where did you show leadership?', entityNoun: 'example' },
  { pattern: /\b(achievement|accomplish|award|proud)\b/i, label: 'Which achievement should Fillie use?', entityNoun: 'achievement' },
  { pattern: /\b(why do you want|why this role|why are you interested|motivation)\b/i, label: 'What matters most to you about this role?', entityNoun: 'detail' },
  { pattern: /\b(conflict|disagree|feedback|difficult person)\b/i, label: 'What happened in that situation?', entityNoun: 'detail' },
];

/**
 * Builds a minimal user interview when the AI is unavailable or its answer was
 * not trustworthy. Deliberately small: only the facts actually missing.
 */
export function buildFallbackInterview(input: FallbackInterviewInput): InterviewSpec {
  const { field, knowledge } = input;
  const questionText = `${field.label} ${field.hint ?? ''} ${field.context ?? ''}`;
  const questions: InterviewQuestion[] = [];

  const entities = knowledge.filter((item) => item.kind === 'project' || item.kind === 'experience' || item.kind === 'achievement');
  // When the page offers a fixed list, the question is "which of these?" — the
  // page's own options are the right choices.
  const pageOptions = (field.options ?? []).filter((option) => option.trim().length > 0).slice(0, 8);

  // A tick-box consent is a decision, not a fact: ask, never assume.
  if (field.acknowledgement) {
    return {
      reason: 'Fillie will not tick a consent box on your behalf.',
      questions: [
        {
          id: 'q1',
          label: 'Do you agree?',
          help: truncate(field.label, 120),
          type: 'choice',
          options: [
            { label: 'Yes, tick it', value: 'yes' },
            { label: 'No, leave it unticked', value: 'no' },
          ],
          required: true,
        },
      ],
    };
  }

  // A question with a concrete missing fact (a salary figure, a yes/no) should
  // ask only that — never lead with "which experience is relevant".
  const numericOnly = NUMERIC_INTENTS.find((intent) => intent.pattern.test(questionText));
  if (numericOnly) {
    return {
      reason: 'Fillie never guesses this. Tell it and it will write the answer.',
      questions: [
        {
          id: 'q1',
          label: numericOnly.label,
          help: numericOnly.help,
          type: 'text',
          placeholder: 'e.g. 82,000 or €75k',
          required: true,
        },
      ],
    };
  }

  if (pageOptions.length > 1) {
    return {
      reason: 'Fillie needs you to choose here.',
      questions: [
        {
          id: 'q1',
          label: truncate(field.label, 160) || 'Which option is right?',
          type: 'choice',
          options: pageOptions.map((option) => ({ label: option, value: option })),
          required: true,
        },
      ],
    };
  }

  const storyIntent = STORY_INTENTS.find((intent) => intent.pattern.test(questionText));
  if (storyIntent) {
    questions.push({
      id: 'q1',
      label: storyIntent.label,
      type: entities.length ? 'choice' : 'longtext',
      options: entities.length
        ? entities.slice(0, 6).map((item) => toOption(item))
        : undefined,
      required: true,
    });
  }

  const booleanIntent = BOOLEAN_INTENTS.find((intent) => intent.pattern.test(questionText));
  if (booleanIntent) {
    questions.push({
      id: 'q2',
      label: booleanIntent.label,
      type: 'choice',
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
      required: true,
    });
  }

  if (questions.length < 2 && entities.length > 1) {
    questions.unshift({
      id: 'q0',
      label: 'Which of your experiences is most relevant here?',
      type: 'choice',
      options: entities.slice(0, 6).map((item) => toOption(item)),
      required: false,
    });
  }

  if (!questions.length) {
    const wantsLong = field.kind === 'textarea' || (field.maxLength ?? 0) > 200;
    questions.push({
      id: 'q1',
      label: truncate(field.label, 160) || 'What should Fillie answer here?',
      help: 'Answer in your own words — Fillie will polish it.',
      type: wantsLong ? 'longtext' : 'text',
      required: true,
    });
  }

  const reason = input.blockedMemoryReason
    ? `${input.blockedMemoryReason} Tell Fillie what to use instead.`
    : storyIntent
      ? `Fillie needs one detail to answer this honestly: ${storyIntent.entityNoun}.`
      : 'Fillie does not have enough verified information for this question yet.';

  return { reason, questions: questions.slice(0, 4) };
}

/**
 * Turns a knowledge item into a choice the user can pick. The label is what the
 * user recognises ("Trailhead"); the ref records which fact they chose so the
 * draft can be attributed to it.
 */
function toOption(item: KnowledgeItem): InterviewOption {
  // Knowledge labels look like "Project detail: Trailhead" or "Role: Backend
  // Engineer Intern" — the user should just see "Trailhead".
  const bare = item.label
    .replace(/^(Project detail|Detail|Summary|Project|Experience|Achievement|Organization|Role|Organisation):\s*/i, '')
    .trim();
  return {
    label: bare || item.value.slice(0, 80),
    value: item.id,
    ref: knowledgeItemToRef(item),
  };
}

/** User facing question index label used by the task-inbox UI. */
export function questionIndexLabel(index: number): string {
  return String(index + 1).padStart(2, '0');
}

export function shortQuestionLabel(plan: FieldPlan, max = 46): string {
  const text = plan.field.label.trim() || plan.field.context || 'Question';
  return truncate(text, max);
}

export function planSummaryLabel(plan: FieldPlan): string {
  const field = plan.field;
  const label = normalizeForMatch(field.label);
  if (!label) return field.kind;
  return label;
}