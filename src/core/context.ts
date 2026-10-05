import type { ApplicationContext, DetectedField } from './types';
import { normalizeText, truncate, unique } from './text';

/**
 * Detects application context (company, role, job description) from page
 * metadata. Everything here is derived from the page — Fillie never invents
 * company facts, it only reports what the page says.
 */

const ROLE_PATTERNS: Array<{ pattern: RegExp; group: number }> = [
  { pattern: /\b(?:job title|position|role)\s*[:\-–]\s*([^\n|•]{3,80})/i, group: 1 },
  { pattern: /\b(?:hiring|looking for|we are hiring for)\s+(?:an?\s+)?([^\n.]{3,80})/i, group: 1 },
  { pattern: /\bapply (?:now )?for (?:an? )?([^\n.]{3,80})/i, group: 1 },
  { pattern: /\bcareer(?:s)?\s+(?:at|for)\s+([^\n.]{3,60})\s*[—–-]/i, group: 1 },
];

const COMPANY_PATTERNS: Array<{ pattern: RegExp; group: number }> = [
  { pattern: /\b(?:company|organisation|organization|employer)\s*[:\-–]\s*([^\n|•]{2,80})/i, group: 1 },
  { pattern: /\bat\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s+(?:we|is|are|has)\b/, group: 1 },
  { pattern: /\bjoin\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\b/, group: 1 },
  { pattern: /\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s+(?:is|are)\s+hiring\b/, group: 1 },
];

const LOCATION_PATTERNS: Array<{ pattern: RegExp; group: number }> = [
  { pattern: /\b(?:location|based in|office|work location)\s*[:\-–]\s*([^\n|•]{2,60})/i, group: 1 },
  { pattern: /\b(?:remote|hybrid|on-?site)\s*[-–—·]?\s*([A-Z][\w, .-]{2,40})/, group: 1 },
];

const DEPARTMENT_PATTERN = /\b(?:department|team|function)\s*[:\-–]\s*([^\n|•]{2,60})/i;

const JD_MARKERS = [
  'job description',
  'about the role',
  'about this role',
  'the role',
  'what you will do',
  "what you'll do",
  'responsibilities',
  'what you bring',
  'requirements',
  'qualifications',
  'your profile',
  'about you',
  'the opportunity',
];

export interface ContextInput {
  url: string;
  pageTitle: string;
  pageText: string;
  headings?: string[];
  fieldLabels?: string[];
}

function firstMatch(text: string, patterns: Array<{ pattern: RegExp; group: number }>): string | undefined {
  for (const { pattern, group } of patterns) {
    const match = pattern.exec(text);
    const value = match?.[group];
    if (value) {
      const cleaned = normalizeText(value).replace(/\s*[(\[{].*$/, '');
      if (cleaned.length >= 2 && cleaned.length <= 80) return cleaned;
    }
  }
  return undefined;
}

/** Pulls the most likely job description block out of the page text. */
export function extractJobDescription(text: string, limit = 3000): string | undefined {
  const lower = text.toLowerCase();
  let bestIndex = -1;
  for (const marker of JD_MARKERS) {
    const index = lower.indexOf(marker);
    if (index >= 0 && (bestIndex === -1 || index < bestIndex)) bestIndex = index;
  }
  if (bestIndex === -1) return undefined;
  const excerpt = normalizeText(text.slice(bestIndex, bestIndex + limit));
  if (excerpt.length < 120) return undefined;
  // Drop trailing navigation-ish noise.
  const cutoff = excerpt.search(/\b(cookie|privacy policy|all rights reserved|equal opportunit)/i);
  return truncate(cutoff > 200 ? excerpt.slice(0, cutoff) : excerpt, limit);
}

export function extractApplicationContext(input: ContextInput): ApplicationContext {
  const headingText = (input.headings ?? []).join('\n');
  const labelText = (input.fieldLabels ?? []).join('\n');
  const haystack = `${input.pageTitle}\n${headingText}\n${input.pageText.slice(0, 4000)}\n${labelText.slice(0, 1200)}`;

  const role = firstMatch(haystack, ROLE_PATTERNS) ?? guessRoleFromTitle(input.pageTitle) ?? guessRoleFromLabels(input.fieldLabels ?? []);
  const company =
    firstMatch(haystack, COMPANY_PATTERNS) ?? guessCompanyFromHost(input.url) ?? undefined;
  const location = firstMatch(haystack, LOCATION_PATTERNS);
  const departmentMatch = DEPARTMENT_PATTERN.exec(haystack);
  const department = departmentMatch?.[1] ? normalizeText(departmentMatch[1]).slice(0, 60) : undefined;
  const jobDescription = extractJobDescription(input.pageText);

  return {
    url: input.url,
    host: safeHost(input.url),
    pageTitle: normalizeText(input.pageTitle).slice(0, 200),
    company: company ? truncate(company, 80) : undefined,
    role: role ? truncate(role, 120) : undefined,
    location: location ? truncate(location, 60) : undefined,
    department,
    jobDescription,
    detectedAt: Date.now(),
  };
}

function guessRoleFromTitle(title: string): string | undefined {
  const cleaned = normalizeText(title)
    .replace(/\s*[|\-–—]\s*(careers|jobs|job openings|apply|application).*$/i, '')
    .replace(/\s*(careers?|jobs?|job openings?|apply now).*$/i, '')
    .trim();
  if (!cleaned || cleaned.length < 4 || cleaned.length > 120) return undefined;
  if (/\b(apply|application|form|survey|questionnaire)\b/i.test(cleaned)) return undefined;
  if (/\b(university|college|school|institute|academy)\b/i.test(cleaned)) return undefined;
  return cleaned;
}

function guessRoleFromLabels(labels: string[]): string | undefined {
  const match = /role|position|job title|department/i.test(labels.join(' '))
    ? labels.find((label) => /\b(role|position|job title|department)\b/i.test(label))
    : undefined;
  return match ? truncate(normalizeText(match.replace(/^\s*[*]?\s*/, '')), 80) : undefined;
}

/** Turns a hostname into a plausible company name. */
export function guessCompanyFromHost(url: string): string | undefined {
  const host = safeHost(url);
  if (!host) return undefined;
  if (/(^|\.)google\.(com|co\.[a-z]+)$/.test(host) && !/docs\.google/.test(host)) return 'Google';
  if (/(^|\.)forms\.gle$/.test(host) || /docs\.google\.com/.test(host)) return undefined;
  if (/github\.com$/.test(host)) return 'GitHub';
  if (/linkedin\.com$/.test(host)) return 'LinkedIn';
  if (/amazon|aws/.test(host)) return 'Amazon';
  if (/microsoft|bing/.test(host)) return 'Microsoft';
  if (/apple/.test(host)) return 'Apple';
  if (/netflix/.test(host)) return 'Netflix';
  if (/stripe/.test(host)) return 'Stripe';
  if (/naukri|shine|indiatimes|foundit/.test(host)) return 'India job portal';
  if (/indeed/.test(host)) return 'Indeed';
  if (/lever\.co/.test(host)) return 'A company using Lever';
  if (/greenhouse\.io/.test(host)) return 'A company using Greenhouse';
  if (/workday/.test(host)) return 'A company using Workday';
  if (/jobs\./.test(host) || /careers?\./.test(host)) {
    const label = host.replace(/^(jobs|careers)\./, '').split('.')[0];
    return label ? titleize(label) : undefined;
  }
  return undefined;
}

export function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function titleize(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

/** Builds a context object from scanned fields when page text is unavailable. */
export function contextFromFields(url: string, title: string, fields: DetectedField[]): ApplicationContext {
  return extractApplicationContext({
    url,
    pageTitle: title,
    pageText: unique(fields.map((field) => field.label).filter(Boolean)).join('\n'),
    fieldLabels: fields.map((field) => field.label),
  });
}