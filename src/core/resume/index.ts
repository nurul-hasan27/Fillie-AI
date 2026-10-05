import type {
  AchievementItem,
  DeepPartial,
  ExperienceItem,
  ProjectItem,
  UserProfile,
} from '../types';
import { createEmptyProfile, parsePhoneNumberParts } from '../profile';
import { normalizeText, uniqueBy } from '../text';
import { extractDocxText, looksLikeDocx } from './docx';
import { extractPdfText, looksLikePdf } from './pdf';

/**
 * Resume import. Extraction produces *suggestions* only — nothing is written to
 * the profile until the user reviews and applies them, and Fillie never invents
 * facts that are not present in the file.
 */

export interface ResumeExtraction {
  fileName: string;
  kind: 'pdf' | 'docx' | 'unsupported';
  text: string;
  suggestions: DeepPartial<UserProfile>;
  warnings: string[];
  /** Fields that look fillable, so the UI can highlight them. */
  matchedFields: string[];
}

const SECTION_PATTERNS = {
  experience: /(experience|employment|work history|internship)/i,
  projects: /(projects?|personal projects|academic projects)/i,
  education: /(education|academics|qualifications)/i,
  skills: /(skills|technical skills|technologies|competencies)/i,
  achievements: /(achievements|awards|honors|honours|certifications|activities|extracurriculars)/i,
  links: /(links?|profiles?|contact)/i,
};

function findSection(text: string, pattern: RegExp, nextPatterns: RegExp[]): string {
  const lines = text.split('\n').map((line) => line.trim());
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length <= 60 && pattern.test(line)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index >= start && line.length <= 60 && nextPatterns.some((p) => p.test(line)));
  return lines.slice(start, end === -1 ? undefined : end).join('\n').trim();
}

function splitBullets(section: string): string[] {
  return section
    .split('\n')
    .map((line) => line.replace(/^[•·▪◦*\-–—]+\s*/, '').trim())
    .filter((line) => line.length > 2 && line.length < 400);
}

export function extractSuggestions(text: string): DeepPartial<UserProfile> {
  const profile = createEmptyProfile();
  const matched: string[] = [];
  const normalized = normalizeText(text);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);

  const email = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(text)?.[0];
  if (email) {
    profile.personal.email = email;
    matched.push('personal.email');
  }

  const phone = /(\+?\d[\d\s().-]{7,17}\d)/.exec(normalized.replace(/\s+/g, ' '))?.[1]?.replace(/\s{2,}/g, ' ').trim();
  if (phone && phone.replace(/\D/g, '').length >= 8) {
    profile.personal.phone = phone;
    matched.push('personal.phone');
    const { countryCode, number, extension } = parsePhoneNumberParts(phone);
    if (countryCode) {
      profile.personal.phoneCountryCode = countryCode;
      matched.push('personal.phoneCountryCode');
    }
    if (number) {
      profile.personal.phoneNumber = number;
      matched.push('personal.phoneNumber');
    }
    if (extension) {
      profile.personal.phoneExtension = extension;
      matched.push('personal.phoneExtension');
    }
  }

  const linkedin = /(https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w-]+\/?|linkedin\.com\/in\/[\w-]+)/i.exec(text)?.[0];
  if (linkedin) {
    profile.links.linkedin = linkedin.startsWith('http') ? linkedin : `https://${linkedin}`;
    matched.push('links.linkedin');
  }
  const github = /(https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/?|github\.com\/[\w.-]+)/i.exec(text)?.[0];
  if (github) {
    profile.links.github = github.startsWith('http') ? github : `https://${github}`;
    matched.push('links.github');
  }
  const portfolio = /(https?:\/\/(?:www\.)?(?!linkedin|github)[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?)/i.exec(text)?.[0];
  if (portfolio) {
    profile.links.portfolio = portfolio;
    matched.push('links.portfolio');
  }

  // Name: the first short line that is not a heading/label and has 2+ words.
  const nameLine = lines.find(
    (line) =>
      line.length > 3 &&
      line.length < 48 &&
      /^[A-Za-z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+){1,3}$/.test(line) &&
      !SECTION_PATTERNS.experience.test(line) &&
      !SECTION_PATTERNS.projects.test(line) &&
      !/resume|curriculum|vitae/i.test(line),
  );
  if (nameLine) {
    profile.personal.fullName = nameLine;
    matched.push('personal.fullName');
    const parts = nameLine.split(/\s+/);
    const first = parts[0] ?? '';
    const last = parts.slice(1).join(' ');
    if (first) {
      profile.personal.firstName = first;
      matched.push('personal.firstName');
    }
    if (last) {
      profile.personal.lastName = last;
      matched.push('personal.lastName');
    }
  }

  const degreeMatch = /\b(B\.?Tech|B\.?E|B\.?Sc|B\.?Com|B\.?A|B\.?FA|M\.?Tech|M\.?E|M\.?Sc|M\.?A|MBA|Ph\.?D|BCA|MCA|BSc|MSc|MA|MS)\b/i.exec(text);
  if (degreeMatch) {
    profile.education.degree = degreeMatch[0].replace(/\./g, '');
    matched.push('education.degree');
  }

  const cgpa = /\b(cgpa|gpa)\s*[:\-–]?\s*(\d{1,2}(?:\.\d{1,2})?)(?:\s*\/\s*\d{1,2}(?:\.\d{1,2})?)?/i.exec(text);
  if (cgpa) {
    profile.education.cgpa = cgpa[2];
    matched.push('education.cgpa');
  }

  const percentage = /\b(\d{2}(?:\.\d{1,2})?)\s*%/.exec(text);
  if (percentage) {
    profile.education.percentage = percentage[1];
    matched.push('education.percentage');
  }

  const gradYear = /\b(20[0-4]\d)\b/.exec(text);
  if (gradYear) {
    profile.education.graduationYear = gradYear[1];
    matched.push('education.graduationYear');
  }

  // Institution names appear in both orders: "University of Cambridge" and
  // "Yale University". The trailing part is optional, and the leading part can
  // only be capitalised words, so a section heading on the previous line is
  // never swallowed in.
  const university =
    /\b((?:[A-Z][A-Za-z.'&]+[ \t]+){0,2}(?:University|College|Institute|School|Academy|Polytechnic)(?:[ \t]+(?:of[ \t]+)?[A-Z][A-Za-z.'&-]*(?:[ \t]+[A-Z][A-Za-z.'&-]*){0,2})?)\b/.exec(
      text,
    )?.[1];
  if (university) {
    profile.education.university = university;
    matched.push('education.university');
  }

  const languageLine = /\blanguages?\b\s*[:\-–]?\s*([^\n]{3,80})/i.exec(text)?.[1];
  if (languageLine) {
    profile.personal.languages = uniqueBy(
      languageLine.split(/[,;|]/).map((entry) => entry.trim()).filter((entry) => entry.length < 30),
      (entry) => entry.toLowerCase(),
    );
    if (profile.personal.languages.length) matched.push('personal.languages');
  }

  const skillsSection = findSection(
    text,
    SECTION_PATTERNS.skills,
    [SECTION_PATTERNS.experience, SECTION_PATTERNS.projects, SECTION_PATTERNS.education, SECTION_PATTERNS.achievements],
  );
  if (skillsSection) {
    const items = splitBullets(skillsSection).flatMap((line) => line.split(/[,;|•]/)).map((item) => item.trim()).filter((item) => item.length > 1 && item.length < 32);
    if (items.length) {
      // Frameworks are classified first: "React" is both a library name and a
      // word in many language allowlists, and calling it a language would lose
      // the more accurate bucket.
      const frameworks = items.filter((item) =>
        /(react|next\.?js|nuxt|vue|svelte|angular|spring|django|flask|fastapi|express|rails|laravel|\.net|dotnet|tailwind|redux|bootstrap)/i.test(
          item,
        ),
      );
      // A conservative allowlist: a word is only called a language if it is one
      // of the names a resume would actually list. Everything else is kept in
      // the generic technologies list rather than guessed at.
      const known = new Set(
        [
          'python', 'java', 'javascript', 'typescript', 'c++', 'c', 'c#', 'go', 'golang', 'rust', 'ruby', 'php',
          'scala', 'kotlin', 'swift', 'r', 'matlab', 'perl', 'haskell', 'elixir', 'lua', 'bash', 'shell',
          'sql', 'html', 'css', 'sass', 'objective-c', 'cobol', 'fortran', 'pascal', 'lisp', 'julia',
          'node', 'mongodb', 'mysql', 'postgresql', 'sqlite', 'redis', 'cassandra', 'dynamodb', 'elasticsearch',
          'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'jenkins', 'git', 'linux', 'unix',
          'figma', 'jira', 'graphql', 'kafka', 'rabbitmq', 'spark', 'hadoop', 'pandas', 'numpy', 'pytorch',
          'tensorflow', 'scikit-learn', 'sklearn', 'machine learning', 'deep learning', 'nlp', 'llm',
        ].map((value) => value.toLowerCase()),
      );
      const languages = items.filter(
        (item) =>
          !frameworks.includes(item) && known.has(item.toLowerCase().replace(/[^a-z+#]/g, '')),
      );
      const rest = items.filter((item) => !languages.includes(item) && !frameworks.includes(item));
      profile.skills.programmingLanguages = uniqueBy(languages, (item) => item.toLowerCase());
      profile.skills.frameworks = uniqueBy(frameworks, (item) => item.toLowerCase());
      profile.skills.technologies = uniqueBy(rest, (item) => item.toLowerCase()).slice(0, 24);
      matched.push('skills');
    }
  }

  const experienceSection = findSection(text, SECTION_PATTERNS.experience, [SECTION_PATTERNS.projects, SECTION_PATTERNS.education, SECTION_PATTERNS.achievements, SECTION_PATTERNS.skills]);
  const experience = parseExperience(experienceSection);
  if (experience.length) {
    profile.experience = experience;
    matched.push('experience');
  }

  const projectsSection = findSection(text, SECTION_PATTERNS.projects, [SECTION_PATTERNS.education, SECTION_PATTERNS.achievements, SECTION_PATTERNS.skills, SECTION_PATTERNS.experience]);
  const projects = parseProjects(projectsSection);
  if (projects.length) {
    profile.projects = projects;
    matched.push('projects');
  }

  const achievementsSection = findSection(text, SECTION_PATTERNS.achievements, [SECTION_PATTERNS.experience, SECTION_PATTERNS.projects, SECTION_PATTERNS.education]);
  const achievements = parseAchievements(achievementsSection);
  if (achievements.length) {
    profile.achievements = achievements;
    matched.push('achievements');
  }

  const suggestions: DeepPartial<UserProfile> = stripEmpty(profile);
  if (matched.length) return suggestions;
  return suggestions;
}

function stripEmpty(profile: UserProfile): DeepPartial<UserProfile> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (key === 'updatedAt' || key === 'version') continue;
    if (isEmptyValue(value)) continue;
    result[key] = value;
  }
  return result as DeepPartial<UserProfile>;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every((entry) => isEmptyValue(entry));
  return false;
}

function parseExperience(section: string): ExperienceItem[] {
  if (!section) return [];
  const lines = splitBullets(section);
  const items: ExperienceItem[] = [];
  const datePattern = /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{4}|20\d{2}|present|current)\s*(?:[–\-—to]+\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{4}|20\d{2}|present|current))?/i;

  let current: ExperienceItem | null = null;
  for (const line of lines) {
    const dateMatch = datePattern.exec(line);
    if (dateMatch) {
      const beforeDate = line.slice(0, dateMatch.index).trim().replace(/[|·•\-–—,]+$/, '').trim();
      const organisation = beforeDate.split(/\s*[|·•]\s*|\s+at\s+/i).pop() ?? beforeDate;
      const role = beforeDate.split(/\s*[|·•]\s*|\s+at\s+/i)[0] ?? beforeDate;
      current = {
        id: `exp-${items.length + 1}-${Math.random().toString(36).slice(2, 6)}`,
        type: /intern/i.test(line) ? 'internship' : 'job',
        organisation: cleanOrganisation(organisation),
        role: cleanRole(role),
        startDate: dateMatch[1] ?? '',
        endDate: dateMatch[2] ?? '',
        responsibilities: [],
        achievements: [],
      };
      items.push(current);
      continue;
    }
    if (current && line.length > 24) current.responsibilities.push(line);
  }

  return items.filter((item) => item.role || item.organisation).slice(0, 6);
}

function parseProjects(section: string): ProjectItem[] {
  if (!section) return [];
  const lines = splitBullets(section);
  const items: ProjectItem[] = [];
  let current: ProjectItem | null = null;

  for (const line of lines) {
    const isHeading = line.length < 70 && !/[.]$/.test(line) && !/^(technologies|tech stack|stack|tools|built with)\b/i.test(line);
    if (isHeading) {
      current = {
        id: `proj-${items.length + 1}-${Math.random().toString(36).slice(2, 6)}`,
        name: line.replace(/[•·*]+/g, '').trim(),
        description: '',
        technologies: [],
      };
      items.push(current);
      continue;
    }
    if (!current) continue;
    const techLine = /^(technologies|tech stack|stack|tools|built with)\s*[:\-–]/i.exec(line);
    if (techLine) {
      current.technologies = line
        .slice(line.indexOf(':') + 1)
        .split(/[,;|]/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      continue;
    }
    if (line.length > 40 && !current.description) current.description = line;
  }

  return items.filter((item) => item.name).slice(0, 8);
}

function parseAchievements(section: string): AchievementItem[] {
  if (!section) return [];
  return splitBullets(section)
    .filter((line) => line.length > 4)
    .slice(0, 12)
    .map((line, index) => ({
      id: `ach-${index + 1}-${Math.random().toString(36).slice(2, 6)}`,
      type: /award|won|winner|rank/i.test(line) ? ('award' as const) : /certif/i.test(line) ? ('certification' as const) : /hackathon/i.test(line) ? ('hackathon' as const) : ('competition' as const),
      title: line.slice(0, 160),
    }));
}

function cleanOrganisation(value: string): string {
  return value.replace(/[|·•]+$/, '').trim().slice(0, 80);
}

function cleanRole(value: string): string {
  return value.replace(/[|·•]+$/, '').trim().slice(0, 80);
}

export async function extractResume(file: File): Promise<ResumeExtraction> {
  const warnings: string[] = [];
  const isPdf = looksLikePdf(file.name) || file.type === 'application/pdf';
  const isDocx = looksLikeDocx(file.name) || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  if (!isPdf && !isDocx) {
    return {
      fileName: file.name,
      kind: 'unsupported',
      text: '',
      suggestions: {},
      warnings: ['Fillie reads PDF and DOCX files. Convert other formats to PDF first.'],
      matchedFields: [],
    };
  }

  let text = '';
  try {
    const buffer = await file.arrayBuffer();
    text = isPdf ? await extractPdfText(buffer) : await extractDocxText(buffer);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : 'Could not read that file.');
  }

  if (!text.trim()) {
    warnings.push(
      isPdf
        ? 'No text was found in that PDF. Scanned or image-only resumes need manual entry.'
        : 'No text was found in that DOCX file.',
    );
    return { fileName: file.name, kind: isPdf ? 'pdf' : 'docx', text: '', suggestions: {}, warnings, matchedFields: [] };
  }

  const suggestions = extractSuggestions(text);
  const matchedFields = Object.keys(suggestions).filter((key) => !isEmptyValue((suggestions as Record<string, unknown>)[key]));

  return {
    fileName: file.name,
    kind: isPdf ? 'pdf' : 'docx',
    text,
    suggestions,
    warnings,
    matchedFields,
  };
}

/**
 * Merges extracted suggestions into an existing profile without overwriting
 * values the user has already filled in.
 */
export function mergeSuggestions(profile: UserProfile, suggestions: DeepPartial<UserProfile>): UserProfile {
  const merged = structuredCloneish(profile) as unknown as Record<string, unknown>;
  for (const [section, value] of Object.entries(suggestions)) {
    if (value === undefined || value === null) continue;
    const current = merged[section];
    if (Array.isArray(value)) {
      const existing = Array.isArray(current) ? current : [];
      merged[section] = existing.length
        ? uniqueBy([...existing, ...value], (entry) => JSON.stringify(entry).toLowerCase())
        : value;
      continue;
    }
    if (value && typeof value === 'object') {
      const target: Record<string, unknown> =
        current && typeof current === 'object' ? { ...(current as Record<string, unknown>) } : {};
      for (const [key, entry] of Object.entries(value)) {
        // A list the user already has entries in gains the new ones rather than
        // being replaced — a resume's skill list is a superset, not a rewrite.
        if (Array.isArray(entry)) {
          const existing = Array.isArray(target[key]) ? (target[key] as unknown[]) : [];
          target[key] = existing.length
            ? uniqueBy([...existing, ...entry], (item) =>
                (typeof item === 'string' ? item : JSON.stringify(item)).toLowerCase(),
              )
            : entry;
          continue;
        }
        if (isEmptyValue(target[key])) target[key] = entry;
      }
      merged[section] = target;
      continue;
    }
    if (isEmptyValue(current)) merged[section] = value;
  }
  return merged as unknown as UserProfile;
}

function structuredCloneish<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}