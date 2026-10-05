import { describe, expect, it } from 'vitest';
import { buildCandidateContext, buildKnowledgeBundle, groundingCorpus } from '../../src/core/knowledge';
import { createEmptyProfile } from '../../src/core/profile';
import { rankResumes } from '../../src/core/resume-select';
import { Storage } from '../../src/core/storage';
import { isPlanAnswered, isPlanDoubtful, isPlanUnanswered } from '../../src/content/overlay';
import type { FieldPlan } from '../../src/core/types';

describe('pasted resume text', () => {
  it('reaches the AI context with its own budget and the grounding corpus, but not retrieval', () => {
    const profile = createEmptyProfile();
    profile.personal.fullName = 'Ada Lovelace';
    const bundle = buildKnowledgeBundle(profile, [], '  Senior engineer. 4 years of React at Acme.  ');

    expect(bundle.items.some((item) => item.id === 'resume.text')).toBe(false);
    expect(buildCandidateContext(bundle)).toContain('4 years of React at Acme');
    expect(groundingCorpus(bundle).some((item) => item.id === 'resume.text')).toBe(true);
  });

  it('is omitted when empty', () => {
    const bundle = buildKnowledgeBundle(createEmptyProfile(), [], '   ');
    expect(bundle.resumeText).toBeUndefined();
    expect(buildCandidateContext(bundle)).not.toContain('Resume (full text');
  });

  it('stores several named resumes and resolves one by id', async () => {
    const storage = new Storage();
    expect(await storage.getResumeText()).toBe('');
    await storage.saveResumes({
      resumes: [
        { id: 'a', name: 'Frontend', text: 'react css', updatedAt: 1 },
        { id: 'b', name: 'Data', text: 'python sql', updatedAt: 2 },
      ],
      defaultId: 'a',
    });
    expect(await storage.getResumeText()).toBe('react css');
    expect(await storage.getResumeText('b')).toBe('python sql');
    expect(await storage.getResumeText('none')).toBe('');
  });

  it('adopts a single resume saved by an earlier version', async () => {
    const storage = new Storage();
    await (storage as unknown as { write(k: string, v: unknown): Promise<void> }).write('fillie:resume-text', 'old resume');
    const { resumes, defaultId } = await storage.getResumes();
    expect(resumes).toHaveLength(1);
    expect(resumes[0].name).toBe('Main');
    expect(defaultId).toBe(resumes[0].id);
  });

  it('suggests the resume whose tag and content match the job', () => {
    const ranked = rankResumes(
      [
        { id: 'a', name: 'Frontend', text: 'React TypeScript CSS design systems', updatedAt: 1 },
        { id: 'b', name: 'Data science', text: 'Python pandas SQL machine learning', updatedAt: 1 },
      ],
      'Senior Data Scientist — Python, SQL, machine learning models',
    );
    expect(ranked[0].id).toBe('b');
  });
});

describe('overlay buckets', () => {
  const plan = (status: FieldPlan['status']): FieldPlan => ({
    field: { id: 'f1', label: 'Q' } as FieldPlan['field'],
    status,
    confidence: 0.7,
    sources: [],
    answer: status === 'needs-attention' ? undefined : 'x',
  });

  it('puts every plan in exactly one of answered / doubtful / unanswered', () => {
    for (const status of ['ready', 'review', 'needs-attention'] as const) {
      const p = plan(status);
      const hits = [isPlanAnswered(p), isPlanDoubtful(p), isPlanUnanswered(p)].filter(Boolean);
      expect(hits).toHaveLength(1);
    }
    expect(isPlanDoubtful(plan('review'))).toBe(true);
  });
});
