import { describe, expect, it } from 'vitest';
import {
  questionSignature,
  semanticSimilarity,
  matchOption,
  normalizeForMatch,
  editDistance,
  formatRelativeTime,
  tokenize,
} from '../../src/core/text';

describe('text utilities', () => {
  it('normalises for matching', () => {
    expect(normalizeForMatch('Full  Name — Ada!')).toBe('full name ada');
    expect(normalizeForMatch('  spaced\tout\ntext ')).toBe('spaced out text');
  });

  it('tokenises and drops stopwords', () => {
    expect(tokenize('What is your email address?')).toEqual(['email', 'address']);
  });

  it('scores identical and different questions', () => {
    expect(semanticSimilarity('What is your email?', 'What is your email address?'))
      .toBeGreaterThan(semanticSimilarity('What is your email?', 'Describe your leadership experience.'));
  });

  it('produces a stable, order-insensitive signature', () => {
    expect(questionSignature('What is your email?', 'contact')).toBe(
      questionSignature('contact', 'What is your email?'),
    );
  });

  it('matches option labels loosely but not wildly', () => {
    expect(matchOption('immediate', ['Available immediately', 'Not available'])).toMatchObject({
      option: 'Available immediately',
    });
    expect(matchOption('yes', ['No', 'Maybe'])).toBeNull();
  });

  it('computes edit distance with a ceiling', () => {
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('abc', 'abd')).toBe(1);
    expect(editDistance('short', 'a much longer string entirely')).toBeGreaterThan(12);
  });

  it('formats relative times', () => {
    const now = 1_700_000_000_000;
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2 days ago');
  });
});