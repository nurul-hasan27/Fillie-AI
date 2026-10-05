import type { UserProfile, ProfileSection } from './types';
import { normalizeText } from './text';

export const PROFILE_VERSION = 1;

export function parsePhoneNumberParts(raw: string): { countryCode: string; number: string; extension: string } {
  let text = (raw ?? '').trim();
  let extension = '';

  const extMatch = /(?:(?:ext|extension|ex|x|#)\.?\s*[:#-]?\s*(\d+))\s*$/i.exec(text);
  if (extMatch) {
    extension = extMatch[1];
    text = text.slice(0, extMatch.index).trim();
  }

  let countryCode = '';
  let number = text;

  const ccMatch = /^(\+\d{1,4}|\(\+\d{1,4}\))[\s.-]*/.exec(text);
  if (ccMatch) {
    countryCode = ccMatch[1].replace(/[()]/g, '');
    number = text.slice(ccMatch[0].length).trim();
  }

  return { countryCode, number, extension };
}

export function formatFullPhone(countryCode?: string, number?: string, extension?: string): string {
  const cc = (countryCode ?? '').trim();
  const num = (number ?? '').trim();
  const ext = (extension ?? '').trim();

  const parts: string[] = [];
  if (cc && num) {
    parts.push(cc.startsWith('+') ? `${cc} ${num}` : `+${cc} ${num}`);
  } else if (num) {
    parts.push(num);
  } else if (cc) {
    parts.push(cc);
  }

  if (ext && parts.length > 0) {
    parts.push(`ext. ${ext}`);
  }

  return parts.join(' ').trim();
}

export function createEmptyProfile(): UserProfile {
  return {
    personal: {
      fullName: '',
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      phoneCountryCode: '',
      phoneNumber: '',
      phoneExtension: '',
      location: '',
      address: '',
      dateOfBirth: '',
      nationality: '',
      languages: [],
    },
    education: {
      university: '',
      degree: '',
      twelfthSchool: '',
      twelfthBoard: '',
      twelfthStream: '',
      twelfthYear: '',
      twelfthPercentage: '',
      tenthSchool: '',
      tenthBoard: '',
      tenthYear: '',
      tenthPercentage: '',
      schools: [],
      coursework: [],
    },
    skills: {
      programmingLanguages: [],
      frameworks: [],
      databases: [],
      cloud: [],
      tools: [],
      technologies: [],
      softSkills: [],
    },
    experience: [],
    projects: [],
    achievements: [],
    links: { linkedin: '', github: '', portfolio: '', other: [] },
    documents: [],
    preferences: {
      willingToRelocate: '',
      preferredLocations: [],
      workMode: '',
      availability: '',
      noticePeriod: '',
      salaryExpectation: '',
    },
    updatedAt: 0,
    version: PROFILE_VERSION,
  };
}

const ARRAY_FIELDS = [
  'personal.languages',
  'education.coursework',
  'skills.programmingLanguages',
  'skills.frameworks',
  'skills.databases',
  'skills.cloud',
  'skills.tools',
  'skills.technologies',
  'skills.softSkills',
  'links.other',
  'preferences.preferredLocations',
] as const;

/** Merges a partial section over its defaults and trims every string. */
function cleanSection<T extends object>(defaults: T, input: Record<string, unknown>): T {
  const merged: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [key, value] of Object.entries(input)) {
    // Optional keys (cgpa, graduationYear…) are absent from the defaults object,
    // so presence is not the filter — validity is.
    if (key === 'schools') {
      continue;
    }
    if (typeof value === 'string') {
      merged[key] = normalizeText(value);
    } else if (Array.isArray(value)) {
      merged[key] = toStringList(value);
    } else if (value !== undefined && value !== null && typeof value === 'object') {
      merged[key] = value;
    }
  }
  return merged as T;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeText(String(entry ?? '')))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,;\n|]/)
      .map((entry) => normalizeText(entry))
      .filter((entry) => entry.length > 0);
  }
  return [];
}

/**
 * Normalises multi-line bullet lists (responsibilities, achievements).
 * Unlike toStringList, this splits ONLY on newlines so commas and semicolons
 * in long sentences and metrics are preserved intact.
 */
export function toLinesList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeText(String(entry ?? '')))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((entry) => normalizeText(entry.replace(/^[\s•*-]+/, '')))
      .filter((entry) => entry.length > 0);
  }
  return [];
}

/**
 * Normalises any (possibly partial / user-imported) profile object into a full,
 * well-shaped UserProfile. Unknown keys are dropped, missing keys defaulted.
 */
export function normalizeProfile(input: unknown): UserProfile {
  const empty = createEmptyProfile();
  if (!input || typeof input !== 'object') return empty;
  const raw = { ...(input as Record<string, unknown>) };

  for (const path of ARRAY_FIELDS) {
    const value = getPath(raw, path);
    if (value !== undefined) setPath(raw as Record<string, unknown>, path, toStringList(value));
  }

  const personal = (raw.personal ?? {}) as Record<string, unknown>;
  raw.personal = cleanSection(empty.personal, personal);

  const education = (raw.education ?? {}) as Record<string, unknown>;
  const rawSchools = Array.isArray(education.schools) ? education.schools : [];
  delete education.schools;
  raw.education = cleanSection(empty.education, education);
  const edu = raw.education as UserProfile['education'];
  edu.schools = rawSchools.map((s) => {
    const item = typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {};
    return {
      id: typeof item.id === 'string' && item.id ? item.id : `sch-${Math.random().toString(36).slice(2, 9)}`,
      level: typeof item.level === 'string' ? normalizeText(item.level) : 'School',
      schoolName: typeof item.schoolName === 'string' ? normalizeText(item.schoolName) : '',
      board: typeof item.board === 'string' ? normalizeText(item.board) : '',
      stream: typeof item.stream === 'string' ? normalizeText(item.stream) : '',
      year: typeof item.year === 'string' ? normalizeText(item.year) : '',
      percentage: typeof item.percentage === 'string' ? normalizeText(item.percentage) : '',
    };
  });
  if (!edu.schoolName && (edu.twelfthSchool || edu.tenthSchool)) {
    edu.schoolName = edu.twelfthSchool || edu.tenthSchool || '';
  }
  if (!edu.board && (edu.twelfthBoard || edu.tenthBoard)) {
    edu.board = edu.twelfthBoard || edu.tenthBoard || '';
  }

  const skills = (raw.skills ?? {}) as Record<string, unknown>;
  raw.skills = cleanSection(empty.skills, skills);

  const links = (raw.links ?? {}) as Record<string, unknown>;
  raw.links = cleanSection(empty.links, links);

  const preferences = (raw.preferences ?? {}) as Record<string, unknown>;
  raw.preferences = cleanSection(empty.preferences, preferences);

  raw.experience = Array.isArray(raw.experience) ? raw.experience : [];
  raw.projects = Array.isArray(raw.projects) ? raw.projects : [];
  raw.achievements = Array.isArray(raw.achievements) ? raw.achievements : [];
  raw.documents = Array.isArray(raw.documents) ? raw.documents : [];
  raw.updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0;
  raw.version = typeof raw.version === 'number' ? raw.version : PROFILE_VERSION;

  const merged = { ...empty, ...raw } as UserProfile;

  for (const item of merged.experience) {
    item.id ||= `exp-${Math.random().toString(36).slice(2, 10)}`;
    item.responsibilities = toLinesList(item.responsibilities);
    item.achievements = toLinesList(item.achievements);
  }
  for (const item of merged.projects) {
    item.id ||= `proj-${Math.random().toString(36).slice(2, 10)}`;
    item.technologies = toStringList(item.technologies);
  }
  for (const item of merged.achievements) {
    item.id ||= `ach-${Math.random().toString(36).slice(2, 10)}`;
  }
  merged.documents = (merged.documents ?? []).map((doc) => {
    const d = typeof doc === 'object' && doc !== null ? (doc as unknown as Record<string, unknown>) : {};
    return {
      id: typeof d.id === 'string' && d.id ? d.id : `doc-${Math.random().toString(36).slice(2, 9)}`,
      name: typeof d.name === 'string' ? normalizeText(d.name) : 'Document',
      fileName: typeof d.fileName === 'string' ? normalizeText(d.fileName) : 'document.pdf',
      fileType: typeof d.fileType === 'string' ? normalizeText(d.fileType) : 'application/pdf',
      fileSize: typeof d.fileSize === 'number' ? d.fileSize : 0,
      keywords: toStringList(d.keywords),
      category: typeof d.category === 'string' ? (d.category as UserProfile['documents'] extends (infer U)[] ? U extends { category?: infer C } ? C : never : never) : 'resume',
      dataUrl: typeof d.dataUrl === 'string' ? d.dataUrl : '',
      textContent: typeof d.textContent === 'string' ? normalizeText(d.textContent) : '',
      isDefault: Boolean(d.isDefault),
      updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : Date.now(),
    };
  });
  return merged;
}

export interface ProfileIssue {
  path: string;
  message: string;
  level: 'error' | 'warning';
}

export function validateProfile(profile: UserProfile): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const email = profile.personal.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    issues.push({ path: 'personal.email', message: 'That email address does not look valid.', level: 'error' });
  }
  const phone = (profile.personal.phone || profile.personal.phoneNumber || '').trim();
  if (phone && phone.replace(/\D/g, '').length < 7) {
    issues.push({ path: 'personal.phone', message: 'That phone number looks too short.', level: 'warning' });
  }
  const dob = profile.personal.dateOfBirth.trim();
  if (dob) {
    const parsed = Date.parse(dob);
    if (Number.isNaN(parsed)) {
      issues.push({ path: 'personal.dateOfBirth', message: 'Use a date Fillie can read (YYYY-MM-DD).', level: 'error' });
    } else if (parsed > Date.now()) {
      issues.push({ path: 'personal.dateOfBirth', message: 'Date of birth cannot be in the future.', level: 'error' });
    }
  }
  const hasName = Boolean(profile.personal.fullName.trim() || profile.personal.firstName?.trim());
  if (!hasName) {
    issues.push({ path: 'personal.fullName', message: 'Add your name so Fillie can answer name questions.', level: 'warning' });
  }
  const gradYear = Number(profile.education.graduationYear ?? '');
  if (profile.education.graduationYear && (!Number.isFinite(gradYear) || gradYear < 1950 || gradYear > 2100)) {
    issues.push({ path: 'education.graduationYear', message: 'Graduation year looks invalid.', level: 'warning' });
  }
  return issues;
}

export function profileCompletion(profile: UserProfile): number {
  const checks: boolean[] = [
    Boolean(profile.personal.fullName.trim() || (profile.personal.firstName?.trim() && profile.personal.lastName?.trim())),
    !!profile.personal.email.trim(),
    Boolean(profile.personal.phone.trim() || profile.personal.phoneNumber?.trim()),
    !!profile.personal.location.trim(),
    !!profile.personal.nationality.trim(),
    !!profile.education.degree.trim(),
    !!profile.education.university.trim(),
    profile.skills.programmingLanguages.length > 0,
    profile.skills.frameworks.length > 0,
    profile.experience.length > 0,
    profile.projects.length > 0,
    profile.achievements.length > 0,
    !!profile.links.linkedin.trim(),
    !!profile.links.github.trim(),
  ];
  const done = checks.filter(Boolean).length;
  return Math.round((done / checks.length) * 100);
}

export const PROFILE_SECTIONS: Array<{
  id: ProfileSection;
  label: string;
  description: string;
}> = [
  { id: 'personal', label: 'Personal', description: 'Your name and contact details.' },
  { id: 'education', label: 'Education', description: 'Degrees, marks and coursework.' },
  { id: 'skills', label: 'Skills', description: 'Languages, tools and strengths.' },
  { id: 'experience', label: 'Experience', description: 'Internships and roles.' },
  { id: 'projects', label: 'Projects', description: 'Work you have shipped.' },
  { id: 'achievements', label: 'Achievements', description: 'Awards, hackathons, certificates.' },
  { id: 'links', label: 'Links', description: 'Where people can find you.' },
  { id: 'documents', label: 'Documents', description: 'Resume, certificates and files tagged with keywords.' },
  { id: 'preferences', label: 'Preferences', description: 'Relocation, work mode, availability.' },
];

export function isProfileSection(value: string): value is ProfileSection {
  return PROFILE_SECTIONS.some((section) => section.id === value);
}