import { describe, expect, it } from 'vitest';
import { adjustConfidence, assessGrounding } from '../../src/core/engine/grounding';
import { conceptsOf, conceptSimilarity } from '../../src/core/text';
import { normalizeAnswerForField, isBlockedField, normalizeDate, validateValue } from '../../src/core/engine/answer';
import { buildFallbackInterview, questionIndexLabel } from '../../src/core/engine/interview';
import { buildOfflineNarrative, resolveOffline, totalExperienceYears } from '../../src/core/engine/offline';
import { buildKnowledgeBundle } from '../../src/core/knowledge';
import { field, testProfile } from './fixtures';

const bundle = buildKnowledgeBundle(testProfile());
const fact = (id: string) => bundle.items.find((item) => item.id === id)!;

describe('grounding', () => {
  it('accepts an answer made of stored facts', () => {
    const result = assessGrounding({
      answer: 'At Meridian Analytics I rebuilt the ingestion API in Python and cut p95 latency from 900ms to 180ms.',
      knowledge: bundle.items,
      userFacts: [],
      question: 'Tell us about your internship',
    });
    expect(result.verdict).toBe('grounded');
    expect(result.score).toBeGreaterThan(0.82);
    expect(adjustConfidence(0.9, result, 'long').escalate).toBe(false);
  });

  it('flags invented specifics in a short answer', () => {
    const result = assessGrounding({
      answer: 'I have led four teams at Google for twelve years.',
      knowledge: bundle.items,
      userFacts: [],
      question: 'How many years of experience do you have?',
    });
    expect(result.riskyUnsupported.length).toBeGreaterThan(0);
    const adjustment = adjustConfidence(0.95, result, 'short');
    expect(adjustment.escalate).toBe(true);
  });

  it('escalates a short answer that is mostly ungrounded', () => {
    const result = assessGrounding({
      answer: 'Kubernetes, Terraform, Rust, Kafka and Helm.',
      knowledge: bundle.items,
      userFacts: [],
      question: 'Which tools do you use?',
    });
    expect(adjustConfidence(0.9, result, 'short').escalate).toBe(true);
  });

  it('does not punish ordinary phrasing', () => {
    const result = assessGrounding({
      answer: 'I know Python and Go.',
      knowledge: bundle.items,
      userFacts: [],
      question: 'What would you say your strongest skill is?',
    });
    expect(result.score).toBeGreaterThan(0.7);
  });

  it('lets an answer echo the question wording', () => {
    const result = assessGrounding({
      answer: 'My relocation preference is Yes.',
      knowledge: bundle.items,
      userFacts: [],
      question: 'Are you willing to relocate?',
    });
    expect(result.verdict).not.toBe('ungrounded');
  });

  it('treats facts the user typed during the interview as verified', () => {
    const result = assessGrounding({
      answer: 'I would expect around £80,000 plus equity.',
      knowledge: bundle.items,
      userFacts: [{ id: 'u1', key: 'Expected salary', value: 'around £80,000 plus equity' }],
      question: 'What are your salary expectations?',
    });
    expect(result.score).toBeGreaterThanOrEqual(0.8);
  });

  it('handles an empty answer', () => {
    const result = assessGrounding({ answer: '', knowledge: bundle.items, userFacts: [], question: 'q' });
    expect(result.score).toBe(1);
  });

  it('escalates a long draft that is mostly invention', () => {
    const result = assessGrounding({
      answer: 'Aerospace, patents, patents, submarine, submarine, submarine, quantum.',
      knowledge: bundle.items,
      userFacts: [],
      question: 'Tell us about yourself.',
    });
    expect(adjustConfidence(0.9, result, 'long').escalate).toBe(true);
  });
});

describe('concept extraction', () => {
  it('groups paraphrases under the same concepts', () => {
    const a = conceptsOf('Tell us about a time you led a team');
    const b = conceptsOf('Describe a project where you showed leadership');
    expect(a.has('leadership')).toBe(true);
    expect(b.has('leadership')).toBe(true);
    expect(conceptSimilarity('Give an example of a project you led', 'Describe a project where you showed leadership')).toBeGreaterThan(0.5);
  });

  it('keeps unrelated questions apart', () => {
    expect(conceptSimilarity('What is your expected salary?', 'Describe your leadership experience')).toBeLessThan(0.2);
  });
});

describe('answer normalisation', () => {
  it('matches a choice to a real option', () => {
    const result = normalizeAnswerForField(
      field({ kind: 'select', options: ['Remote', 'Hybrid', 'On-site'] }),
      'hybrid working',
      'choice',
    );
    expect(result.value).toBe('Hybrid');
  });

  it('refuses a choice that is not on the list', () => {
    const result = normalizeAnswerForField(field({ kind: 'select', options: ['Remote', 'Hybrid'] }), 'On-site', 'choice');
    expect(result.value).toBeNull();
    expect(result.problems[0]).toMatch(/not an offered option/);
  });

  it('keeps only valid options from a multi-choice answer', () => {
    const result = normalizeAnswerForField(
      field({ kind: 'checkbox', options: ['Python', 'Go', 'Rust'] }),
      ['Python', 'Rust', 'COBOL'],
      'multi_choice',
    );
    expect(result.value).toEqual(['Python', 'Rust']);
    expect(result.problems[0]).toMatch(/COBOL/);
  });

  it('shortens an over-long answer to fit the limit', () => {
    const answer = 'One sentence. Two sentence. Three sentence. Four sentence.';
    const result = normalizeAnswerForField(field({ kind: 'textarea', maxLength: 40 }), answer, 'long');
    expect(String(result.value).length).toBeLessThanOrEqual(40);
    expect(result.problems[0]).toMatch(/character limit/);
  });

  it('collapses newlines in a single-line field', () => {
    const result = normalizeAnswerForField(field({ kind: 'text' }), 'line one\nline two', 'short');
    expect(String(result.value)).toBe('line one line two');
  });

  it('extracts a number from a messy answer', () => {
    const result = normalizeAnswerForField(field({ kind: 'number' }), 'about 900ms', 'number');
    expect(result.value).toBe('900');
  });

  it('marks file fields as user-handled', () => {
    const result = normalizeAnswerForField(field({ kind: 'file' }), 'resume.pdf', 'file');
    expect(result.value).toBeNull();
  });

  it('normalises dates', () => {
    expect(normalizeDate('10/12/1999')).toBe('1999-12-10');
    expect(normalizeDate('December 10, 1999')).toBe('1999-12-10');
    expect(normalizeDate('1999-12-10')).toBe('1999-12-10');
    expect(normalizeDate('sometime in spring')).toBeNull();
  });

  it('validates against the control', () => {
    expect(validateValue(field({ kind: 'email' }), 'ada@example.com').valid).toBe(true);
    expect(validateValue(field({ kind: 'email' }), 'nope').valid).toBe(false);
    expect(validateValue(field({ kind: 'number' }), 'twelve').valid).toBe(false);
    expect(validateValue(field({ disabled: true }), 'x').valid).toBe(false);
    expect(validateValue(field({ kind: 'textarea', maxLength: 5 }), 'far too long').valid).toBe(false);
  });

  it('blocks sensitive and automated fields', () => {
    expect(isBlockedField(field({ kind: 'file', label: 'Upload CV' }))).toMatch(/attach files/i);
    expect(isBlockedField(field({ label: 'Account password' }))).toMatch(/passwords/i);
    expect(isBlockedField(field({ label: 'Enter the OTP' }))).toMatch(/passwords|codes/i);
    expect(isBlockedField(field({ label: 'I am not a robot' }))).toMatch(/CAPTCHA/i);
    expect(isBlockedField(field({ label: 'Card number' }))).toMatch(/payment/i);
    expect(isBlockedField(field({ label: 'Email address' }))).toBeNull();
  });
});

describe('fallback interview', () => {
  it('asks for a salary figure when the profile has none', () => {
    const spec = buildFallbackInterview({
      field: field({ label: 'What is your expected salary?' }),
      knowledge: [],
    });
    // Free text, not a number input: people type "82,000" or "€75k".
    const question = spec.questions.find((q) => /salary/i.test(q.label));
    expect(question?.type).toBe('text');
    expect(question?.placeholder).toMatch(/82,000|75k/);
  });

  it('asks a yes/no question for relocation', () => {
    const spec = buildFallbackInterview({ field: field({ label: 'Are you willing to relocate?' }), knowledge: [] });
    const choice = spec.questions.find((q) => q.type === 'choice');
    expect(choice?.options?.map((option) => option.value)).toEqual(['yes', 'no']);
  });

  it('offers the user’s own projects for a story question', () => {
    const spec = buildFallbackInterview({
      field: field({ kind: 'textarea', label: 'Describe a project where you showed leadership.' }),
      knowledge: bundle.items,
    });
    const choice = spec.questions.find((q) => q.type === 'choice');
    expect(choice?.options?.some((option) => option.value === 'projects.proj-1.name')).toBe(true);
  });

  it('falls back to free text', () => {
    const spec = buildFallbackInterview({ field: field({ kind: 'textarea', label: 'Anything else we should know?' }), knowledge: [] });
    expect(spec.questions[0].type).toBe('longtext');
    expect(spec.reason.length).toBeGreaterThan(10);
  });

  it('explains a blocked memory reuse', () => {
    const spec = buildFallbackInterview({
      field: field({ kind: 'textarea', label: 'Tell us about your leadership.' }),
      knowledge: [],
      blockedMemoryReason: 'Saved for a different application.',
    });
    expect(spec.reason).toMatch(/different application/i);
  });

  it('numbers questions for the inbox', () => {
    expect(questionIndexLabel(0)).toBe('01');
    expect(questionIndexLabel(9)).toBe('10');
  });
});

describe('offline engine', () => {
  it('computes years of experience from dated roles', () => {
    const years = totalExperienceYears(bundle.items);
    expect(years).toBeGreaterThan(0);
  });

  it('builds a factual sentence from one knowledge item', () => {
    const item = fact('projects.proj-1.details');
    const narrative = buildOfflineNarrative(item, field({ kind: 'textarea' }));
    // Every sentence must come from the stored fact — no added wording.
    const stored = item.value.split(/(?<=\.)\s+/)[0];
    expect(narrative).toContain(stored);
    expect(narrative).not.toMatch(/I |my /i);
  });

  it('answers a knowledge question without any AI', () => {
    const result = resolveOffline({
      field: field({ id: 'f1', label: 'Which university did you attend?' }),
      knowledge: [fact('education.university'), fact('personal.email')],
      memoryMatches: [],
    });
    expect(result.answer).toBe('University of London');
    expect(result.layer).toBe('alias');
  });

  it('refuses rather than guessing', () => {
    const result = resolveOffline({
      field: field({ id: 'f1', kind: 'textarea', label: 'What is your favourite pizza topping?' }),
      knowledge: bundle.items,
      memoryMatches: [],
    });
    expect(result.answer).toBeNull();
    expect(result.layer).toBe('none');
  });

  it('answers a language question from the profile', () => {
    const result = resolveOffline({
      field: field({ id: 'f1', label: 'Which languages do you speak?' }),
      knowledge: bundle.items,
      memoryMatches: [],
    });
    expect(result.answer).toContain('English');
  });

  it('computes age when the question asks for it', () => {
    const result = resolveOffline({
      field: field({ id: 'f1', label: 'What is your age?' }),
      knowledge: bundle.items,
      memoryMatches: [],
    });
    expect(Number(result.answer)).toBeGreaterThan(20);
    expect(result.layer).toBe('alias');
  });
});