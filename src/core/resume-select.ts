import type { ResumeVariant } from './types';
import { tokenize } from './text';

export interface ResumeOption {
  id: string;
  name: string;
  /** First line or two, so the user recognises it in the picker. */
  preview: string;
  score: number;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'our', 'are', 'will', 'your', 'have', 'that', 'this', 'from', 'work', 'team', 'role', 'experience']);

/**
 * Ranks resumes against the job text on the page. The tag counts most (a
 * resume called "Backend" for a "Backend Engineer" posting is the obvious
 * pick), then how many of the posting's distinctive words the resume contains.
 */
export function rankResumes(variants: ResumeVariant[], jobText: string): ResumeOption[] {
  const jobTokens = new Set(tokenize(jobText).filter((token) => token.length > 2 && !STOP.has(token)));
  return variants
    .map((variant) => {
      const nameHits = tokenize(variant.name).filter((token) => jobTokens.has(token)).length;
      const bodyTokens = new Set(tokenize(variant.text));
      let bodyHits = 0;
      for (const token of jobTokens) if (bodyTokens.has(token)) bodyHits += 1;
      const coverage = jobTokens.size ? bodyHits / jobTokens.size : 0;
      return {
        id: variant.id,
        name: variant.name,
        preview: variant.text.replace(/\s+/g, ' ').trim().slice(0, 140),
        score: nameHits * 3 + coverage,
      };
    })
    .sort((a, b) => b.score - a.score);
}
