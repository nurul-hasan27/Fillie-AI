import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractDocxText } from '../../src/core/resume/docx';
import { extractPdfText } from '../../src/core/resume/pdf';
import { extractResume, extractSuggestions, mergeSuggestions } from '../../src/core/resume';
import { createEmptyProfile } from '../../src/core/profile';
import type { UserProfile } from '../../src/core/types';

const RESUMES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'resumes');

describe('resume text extraction', () => {
  it('reads the text out of a DOCX archive', async () => {
    const text = await extractDocxText(await readFile(path.join(RESUMES, 'resume.docx')));
    expect(text).toContain('Grace Hopper');
    expect(text).toContain('Compiler Engineer at Navy Electronics');
    // Paragraphs become lines, which is what the section splitter needs.
    expect(text.split('\n').length).toBeGreaterThan(10);
  });

  it('reads the text out of a PDF content stream', async () => {
    const text = await extractPdfText(await readFile(path.join(RESUMES, 'resume.pdf')));
    expect(text).toContain('Alan Turing');
    expect(text).toContain('Bombe');
  });

  it('keeps camelCase product names whole', async () => {
    const text = await extractPdfText(await readFile(path.join(RESUMES, 'resume.pdf')));
    // A resume's most valuable words are technology names; splitting them into
    // "Type Script" makes them unmatchable against form questions.
    expect(text).toContain('TypeScript');
    expect(text).toContain('PostgreSQL');
    expect(text).not.toMatch(/Type Script|Postgre SQL/);
  });

  it('extracts fields from a PDF resume', async () => {
    const file = new File(
      [new Uint8Array(await readFile(path.join(RESUMES, 'resume.pdf')))],
      'resume.pdf',
      { type: 'application/pdf' },
    );
    const result = await extractResume(file);
    const suggestions = result.suggestions;

    expect(suggestions.personal?.email).toBe('alan.turing@example.com');
    expect(suggestions.personal?.fullName).toBe('Alan Turing');
    // "University of Cambridge" has no leading institution word.
    expect(suggestions.education?.university).toBe('University of Cambridge');
    expect(suggestions.skills?.programmingLanguages).toContain('TypeScript');
    expect(suggestions.skills?.frameworks).toContain('React');
  });

  it('returns nothing for a file that is neither', async () => {
    const junk = new File([new Uint8Array([1, 2, 3, 4])], 'notes.txt', { type: 'text/plain' });
    const result = await extractResume(junk);
    expect(result.kind).toBe('unsupported');
    expect(result.suggestions).toEqual({});
    expect(result.warnings.join(' ')).toMatch(/PDF and DOCX/i);
  });

  it('explains an unreadable file rather than failing silently', async () => {
    const empty = new File([new Uint8Array(0)], 'empty.pdf', { type: 'application/pdf' });
    const result = await extractResume(empty);
    expect(result.warnings.join(' ')).toMatch(/No text was found/i);
  });

  it('refuses an encrypted PDF instead of decoding noise', async () => {
    // Decoding a scrambled stream would yield bytes that look like text, and
    // the field extractor would report values the file never contained.
    const scrambled = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const header = '4 0 obj\n<< /Length 12 /Filter /FlateDecode >>\nstream\n';
    const footer = '\nendstream\nendobj\ntrailer\n<< /Encrypt 9 0 R >>\n%%EOF\n';
    const parts = [
      new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n' + header),
      scrambled,
      new TextEncoder().encode(footer),
    ];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      buffer.set(part, offset);
      offset += part.length;
    }

    expect(await extractPdfText(buffer.buffer)).toBe('');

    const result = await extractResume(new File([buffer], 'locked.pdf', { type: 'application/pdf' }));
    expect(result.text).toBe('');
    expect(result.suggestions).toEqual({});
  });
});

describe('resume field suggestions', () => {
  const text = [
    'Grace Hopper',
    'grace.hopper@example.com',
    '+1 202 555 0143',
    'https://linkedin.com/in/gracehopper',
    'https://github.com/gracehopper',
    'EXPERIENCE',
    'Compiler Engineer at Navy Electronics | Jan 1952 - Dec 1959',
    'Designed the first compiler for the COBOL language and led the team that shipped it on schedule.',
    'EDUCATION',
    'Yale University',
    'BSc',
    'SKILLS',
    'COBOL, Fortran, Python, React, PostgreSQL, Docker',
  ].join('\n');

  const suggestions = extractSuggestions(text);

  it('pulls contact details', () => {
    expect(suggestions.personal?.email).toBe('grace.hopper@example.com');
    expect(suggestions.personal?.fullName).toBe('Grace Hopper');
    expect(suggestions.personal?.phone).toMatch(/202 555 0143/);
    expect(suggestions.links?.linkedin).toBe('https://linkedin.com/in/gracehopper');
    expect(suggestions.links?.github).toBe('https://github.com/gracehopper');
  });

  it('pulls education and sorts skills into buckets', () => {
    expect(suggestions.education?.university).toBe('Yale University');
    expect(suggestions.education?.degree).toBe('BSc');
    expect(suggestions.skills?.programmingLanguages).toContain('Python');
    expect(suggestions.skills?.programmingLanguages).toContain('COBOL');
    expect(suggestions.skills?.frameworks).toContain('React');
  });

  it('reads one role with its dates and responsibilities', () => {
    expect(suggestions.experience).toHaveLength(1);
    const role = suggestions.experience![0];
    expect(role.role).toBe('Compiler Engineer');
    expect(role.organisation).toBe('Navy Electronics');
    expect(role.startDate).toMatch(/1952/);
    expect(role.responsibilities.join(' ')).toMatch(/COBOL/);
  });

  it('never invents a section the file does not contain', () => {
    const sparse = extractSuggestions('Just a name\nSomeone Example\n\nNothing else here.');
    expect(sparse.experience).toBeUndefined();
    expect(sparse.projects).toBeUndefined();
    expect(sparse.achievements).toBeUndefined();
  });
});

describe('merging suggestions into an existing profile', () => {
  it('fills empty fields and never overwrites what the user typed', () => {
    const profile: UserProfile = {
      ...createEmptyProfile(),
      personal: { ...createEmptyProfile().personal, fullName: 'Ada Lovelace', email: 'ada@example.com' },
    };

    const merged = mergeSuggestions(profile, {
      personal: { fullName: 'Grace Hopper', email: 'grace@example.com', phone: '+1 202 555 0143' },
      links: { linkedin: 'https://linkedin.com/in/gracehopper' },
    });

    // The user's own value wins; the missing one is filled in.
    expect(merged.personal.fullName).toBe('Ada Lovelace');
    expect(merged.personal.email).toBe('ada@example.com');
    expect(merged.personal.phone).toBe('+1 202 555 0143');
    expect(merged.links.linkedin).toBe('https://linkedin.com/in/gracehopper');
  });

  it('appends arrays without duplicating entries', () => {
    const profile: UserProfile = {
      ...createEmptyProfile(),
      skills: { ...createEmptyProfile().skills, programmingLanguages: ['Python'] },
    };
    const merged = mergeSuggestions(profile, { skills: { programmingLanguages: ['Python', 'Go'] } });
    expect(merged.skills.programmingLanguages).toEqual(['Python', 'Go']);
  });
});
