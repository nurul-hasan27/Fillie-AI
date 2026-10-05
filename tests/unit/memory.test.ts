import { describe, expect, it } from 'vitest';
import {
  createLearnedAnswer,
  deleteLearnedAnswer,
  findMemoryMatches,
  recordMemoryUsage,
  upsertLearnedAnswer,
} from '../../src/core/memory';
import type { LearnedAnswer } from '../../src/core/types';

function entry(overrides: Partial<LearnedAnswer> = {}): LearnedAnswer {
  return createLearnedAnswer({
    question: 'Describe a project where you showed leadership.',
    intent: 'leadership example',
    answer: 'I led a team of four building Trailhead, an indoor navigation app used by 4,200 students.',
    sources: [],
    context: { company: 'Northwind', host: 'jobs.northwind.com', isGeneric: false },
    ...overrides,
  });
}

describe('answer memory', () => {
  it('creates a signed entry', () => {
    const created = entry();
    expect(created.signature).not.toBe('');
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.useCount).toBe(0);
  });

  it('matches a semantically similar question', () => {
    const memory = [entry()];
    const matches = findMemoryMatches(memory, 'Tell us about a time you led a team', 'leadership example', {
      company: 'Northwind',
      host: 'jobs.northwind.com',
    });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].blockedByContext).toBe(false);
  });

  it('reuses a generic answer for any company', () => {
    const memory = [entry({ context: { company: 'Northwind', isGeneric: true } })];
    const matches = findMemoryMatches(memory, 'Describe a project where you showed leadership.', '', {
      company: 'Totally Different Co',
      host: 'careers.other.com',
    });
    expect(matches[0].blockedByContext).toBe(false);
    expect(matches[0].reason).toMatch(/approved/i);
  });

  it('refuses to reuse a company-specific answer elsewhere', () => {
    const memory = [entry({ context: { company: 'Northwind', isGeneric: false } })];
    const matches = findMemoryMatches(memory, 'Describe a project where you showed leadership.', '', {
      company: 'Contoso',
      host: 'jobs.contoso.com',
    });
    expect(matches[0].blockedByContext).toBe(true);
    expect(matches[0].reason).toMatch(/different application/i);
  });

  it('does not match unrelated questions', () => {
    const memory = [entry()];
    const matches = findMemoryMatches(memory, 'What is your expected salary?', 'salary');
    expect(matches).toHaveLength(0);
  });

  it('upserts instead of duplicating the same signature', () => {
    const first = entry();
    const second = createLearnedAnswer({
      question: first.question,
      intent: first.intent,
      answer: 'A better answer that I approved later.',
      sources: [],
      context: { isGeneric: false },
    });
    const result = upsertLearnedAnswer([first], second);
    expect(result.memory).toHaveLength(1);
    expect(result.replaced).toBe(true);
    expect(result.memory[0].answer).toBe('A better answer that I approved later.');
    expect(result.memory[0].createdAt).toBe(first.createdAt);
  });

  it('appends a genuinely new answer', () => {
    const first = entry();
    const other = createLearnedAnswer({
      question: 'What is your expected salary?',
      intent: 'salary',
      answer: '£75,000',
      sources: [],
      context: { isGeneric: true },
    });
    const result = upsertLearnedAnswer([first], other);
    expect(result.memory).toHaveLength(2);
    expect(result.replaced).toBe(false);
  });

  it('counts usage and deletes', () => {
    const created = entry();
    const used = recordMemoryUsage([created], created.id);
    expect(used[0].useCount).toBe(1);
    expect(deleteLearnedAnswer(used, created.id)).toHaveLength(0);
  });
});