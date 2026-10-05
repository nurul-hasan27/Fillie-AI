import { describe, expect, it } from 'vitest';
import { createEmptyProfile, normalizeProfile, profileCompletion, validateProfile, toStringList, toLinesList } from '../../src/core/profile';
import { buildKnowledgeBundle, calculateAge, formatDateForHumans } from '../../src/core/knowledge';
import { testProfile } from './fixtures';

describe('profile', () => {
  it('creates a well-shaped empty profile', () => {
    const profile = createEmptyProfile();
    expect(profile.personal.fullName).toBe('');
    expect(profile.skills.programmingLanguages).toEqual([]);
    expect(profile.experience).toEqual([]);
    expect(profile.version).toBe(1);
  });

  it('normalises partial or malformed input', () => {
    const normalized = normalizeProfile({
      personal: { fullName: '  Ada  ', email: 'ada@example.com' },
      skills: { programmingLanguages: 'Python, Go' },
      links: { other: ['https://a.dev', ''] },
      experience: [{ role: 'Dev', responsibilities: 'Did things. Also others.' }],
    });
    expect(normalized.personal.fullName).toBe('Ada');
    expect(normalized.skills.programmingLanguages).toEqual(['Python', 'Go']);
    expect(normalized.links.other).toEqual(['https://a.dev']);
    expect(normalized.experience[0].id).toMatch(/^exp-/);
    // A single bullet stays one entry; only delimited strings are split.
    expect(normalized.experience[0].responsibilities).toEqual(['Did things. Also others.']);
    expect(normalized.education.degree).toBe('');
  });

  it('tolerates junk input', () => {
    expect(normalizeProfile(null).personal.fullName).toBe('');
    expect(normalizeProfile('nonsense').projects).toEqual([]);
    expect(normalizeProfile({ skills: 42 }).skills.tools).toEqual([]);
  });

  it('splits string lists', () => {
    expect(toStringList('A; B, C|D')).toEqual(['A', 'B', 'C', 'D']);
    expect(toStringList(['x', '', 'y'])).toEqual(['x', 'y']);
    expect(toStringList(undefined)).toEqual([]);
  });

  it('splits multiline lists while preserving punctuation and commas inside lines', () => {
    const input = 'Built core API in Python, cutting p95 latency by 35%.\n• Added contract tests; covered 42 endpoints.\n- Led team of 4 engineers, shipped on time.';
    expect(toLinesList(input)).toEqual([
      'Built core API in Python, cutting p95 latency by 35%.',
      'Added contract tests; covered 42 endpoints.',
      'Led team of 4 engineers, shipped on time.',
    ]);
    expect(toLinesList(['Line 1, with comma', 'Line 2; with semicolon'])).toEqual([
      'Line 1, with comma',
      'Line 2; with semicolon',
    ]);
  });

  it('normalises 10th, 12th, and multiple schools in education', () => {
    const normalized = normalizeProfile({
      education: {
        degree: 'B.Tech',
        university: 'State University',
        twelfthSchool: 'Delhi Public School',
        twelfthBoard: 'CBSE',
        twelfthYear: '2022',
        twelfthPercentage: '88%',
        tenthSchool: 'St. Xavier School',
        tenthBoard: 'ICSE',
        tenthYear: '2020',
        tenthPercentage: '92%',
        schools: [
          { level: '10th', schoolName: 'St. Xavier School', board: 'ICSE', year: '2020', percentage: '92%' },
          { level: '12th', schoolName: 'Delhi Public School', board: 'CBSE', year: '2022', percentage: '88%' },
        ],
      },
    });
    expect(normalized.education.twelfthSchool).toBe('Delhi Public School');
    expect(normalized.education.twelfthBoard).toBe('CBSE');
    expect(normalized.education.tenthSchool).toBe('St. Xavier School');
    expect(normalized.education.tenthBoard).toBe('ICSE');
    expect(normalized.education.schools?.length).toBe(2);
    expect(normalized.education.schools?.[0].id).toMatch(/^sch-/);
    expect(normalized.education.schools?.[0].schoolName).toBe('St. Xavier School');
    // Backward compatibility: schoolName and board fallback
    expect(normalized.education.schoolName).toBe('Delhi Public School');
    expect(normalized.education.board).toBe('CBSE');
  });

  it('validates obvious mistakes', () => {
    const profile = testProfile();
    expect(validateProfile(profile)).toEqual([]);
    profile.personal.email = 'not-an-email';
    profile.personal.dateOfBirth = '2030-01-01';
    const issues = validateProfile(profile);
    expect(issues.some((issue) => issue.path === 'personal.email')).toBe(true);
    expect(issues.some((issue) => issue.path === 'personal.dateOfBirth')).toBe(true);
  });

  it('computes completion as a percentage', () => {
    expect(profileCompletion(createEmptyProfile())).toBe(0);
    expect(profileCompletion(testProfile())).toBe(100);
    const partial = testProfile();
    partial.projects = [];
    partial.achievements = [];
    // 12 of the 14 signals are present.
    expect(profileCompletion(partial)).toBe(86);
  });
});

describe('knowledge bundle', () => {
  it('flattens the profile into retrievable facts', () => {
    const bundle = buildKnowledgeBundle(testProfile());
    const ids = bundle.items.map((item) => item.id);
    expect(ids).toContain('personal.email');
    expect(ids).toContain('education.cgpa');
    expect(ids).toContain('skills.programmingLanguages');
    expect(ids).toContain('projects.proj-1.name');
    expect(ids).toContain('achievements.ach-1.title');
    expect(ids).toContain('experience.exp-1.role');
    expect(bundle.items.every((item) => item.value.trim().length > 0)).toBe(true);
  });

  it('includes project detail so generation has substance', () => {
    const bundle = buildKnowledgeBundle(testProfile());
    const detail = bundle.items.find((item) => item.id === 'projects.proj-1.details');
    expect(detail?.value).toContain('4.2k users');
    expect(detail?.value).toContain('Team size: 4');
  });

  it('computes age from a date of birth', () => {
    expect(calculateAge('2000-01-01', new Date('2026-01-01T00:00:00Z'))).toBe(26);
    expect(calculateAge('2000-06-01', new Date('2026-01-01T00:00:00Z'))).toBe(25);
    expect(calculateAge('not a date')).toBeNull();
  });

  it('formats dates for humans', () => {
    expect(formatDateForHumans('1999-12-10')).toBe('December 10, 1999');
    expect(formatDateForHumans('')).toBe('');
  });

  it('omits empty values so prompts stay small', () => {
    const empty = createEmptyProfile();
    empty.personal.fullName = 'Ada';
    const bundle = buildKnowledgeBundle(empty);
    // Only the full name and the first name derived from it.
    expect(bundle.items.map((item) => item.id)).toEqual(['personal.fullName', 'personal.firstName']);
  });
});
describe('profile regression: optional fields survive normalisation', () => {
  it('keeps optional fields that are absent from the empty profile', () => {
    const normalized = normalizeProfile({
      personal: { fullName: 'Ada' },
      education: {
        cgpa: '8.6',
        graduationYear: '2021',
        currentSemester: '6',
        branch: 'Computer Science',
        specialization: 'Distributed Systems',
        schoolName: 'Northgate',
        board: 'CBSE',
        percentage: '82',
      },
      experience: [{ id: 'e1', startDate: '2020-06', endDate: '2020-12', role: 'Intern', organisation: 'Meridian', type: 'internship', responsibilities: [], achievements: [] }],
    });
    expect(normalized.education.cgpa).toBe('8.6');
    expect(normalized.education.graduationYear).toBe('2021');
    expect(normalized.education.currentSemester).toBe('6');
    expect(normalized.education.schoolName).toBe('Northgate');
    expect(normalized.education.percentage).toBe('82');
    expect(normalized.experience[0].startDate).toBe('2020-06');
  });

  it('keeps optional preferences and links', () => {
    const normalized = normalizeProfile({
      preferences: { salaryExpectation: '£75,000', currency: 'GBP', notes: 'note' },
      links: { website: 'https://ada.dev', linkedin: 'https://linkedin.com/in/ada' },
      personal: { gender: 'Female', city: 'London', state: 'Greater London', postalCode: 'NW1 5LA' },
    });
    expect(normalized.preferences.currency).toBe('GBP');
    expect(normalized.preferences.notes).toBe('note');
    expect(normalized.links.website).toBe('https://ada.dev');
    expect(normalized.personal.gender).toBe('Female');
    expect(normalized.personal.postalCode).toBe('NW1 5LA');
  });
});
