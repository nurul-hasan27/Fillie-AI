import type { KnowledgeBundle, KnowledgeItem, UserProfile } from './types';
import { normalizeText, uniqueBy } from './text';
import { formatFullPhone, parsePhoneNumberParts } from './profile';

/**
 * Flattens a profile into atomic knowledge items. Each item is independently
 * retrievable so the AI only ever receives the facts relevant to one question.
 */
export function buildKnowledgeBundle(
  profile: UserProfile,
  userFacts: KnowledgeBundle['userFacts'] = [],
  resumeText = '',
): KnowledgeBundle {
  const items: KnowledgeItem[] = [];
  const p = profile.personal;

  const add = (item: Omit<KnowledgeItem, 'tags'> & { tags?: string[] }) => {
    const value = normalizeText(item.value ?? '');
    if (!value) return;
    items.push({ ...item, tags: item.tags ?? [] });
  };

  const firstNameVal = p.firstName || firstName(p.fullName);
  const lastNameVal = p.lastName || lastName(p.fullName);
  const fullNameVal = p.fullName || [firstNameVal, lastNameVal].filter(Boolean).join(' ');

  add({ id: 'personal.fullName', kind: 'profile', label: 'Full name', value: fullNameVal });
  add({ id: 'personal.firstName', kind: 'profile', label: 'First name / Given name', value: firstNameVal, tags: ['first name', 'given name', 'forename', 'fname'] });
  add({ id: 'personal.lastName', kind: 'profile', label: 'Last name / Family name', value: lastNameVal, tags: ['last name', 'family name', 'surname', 'lname'] });
  add({ id: 'personal.email', kind: 'profile', label: 'Email', value: p.email });

  const phoneParts = parsePhoneNumberParts(p.phone);
  const countryCodeVal = p.phoneCountryCode || phoneParts.countryCode;
  const phoneNumberVal = p.phoneNumber || phoneParts.number;
  const phoneExtensionVal = p.phoneExtension || phoneParts.extension;
  const fullPhoneVal = p.phone || formatFullPhone(countryCodeVal, phoneNumberVal, phoneExtensionVal);

  add({ id: 'personal.phone', kind: 'profile', label: 'Phone', value: fullPhoneVal, tags: ['phone', 'mobile', 'telephone', 'contact number'] });
  add({ id: 'personal.phoneCountryCode', kind: 'profile', label: 'Phone country code', value: countryCodeVal, tags: ['country code', 'dial code', 'phone prefix', 'phone code', 'isd code'] });
  add({ id: 'personal.phoneNumber', kind: 'profile', label: 'Phone number', value: phoneNumberVal, tags: ['phone number', 'mobile number', 'national phone', 'primary phone'] });
  add({ id: 'personal.phoneExtension', kind: 'profile', label: 'Phone extension', value: phoneExtensionVal, tags: ['phone extension', 'extension', 'ext'] });
  add({ id: 'personal.location', kind: 'profile', label: 'Location / city', value: p.location });
  add({ id: 'personal.address', kind: 'profile', label: 'Address', value: p.address });
  add({ id: 'personal.city', kind: 'profile', label: 'City', value: p.city ?? '' });
  add({ id: 'personal.state', kind: 'profile', label: 'State / region', value: p.state ?? '' });
  add({ id: 'personal.country', kind: 'profile', label: 'Country', value: p.country ?? p.nationality });
  add({ id: 'personal.postalCode', kind: 'profile', label: 'Postal code', value: p.postalCode ?? '' });
  add({ id: 'personal.nationality', kind: 'profile', label: 'Nationality', value: p.nationality });
  add({ id: 'personal.gender', kind: 'profile', label: 'Gender', value: p.gender ?? '' });
  add({
    id: 'personal.languages',
    kind: 'profile',
    label: 'Languages',
    value: p.languages.join(', '),
    tags: ['language', 'languages', 'fluency', 'speak'],
  });
  if (p.dateOfBirth) {
    add({
      id: 'personal.dateOfBirth',
      kind: 'profile',
      label: 'Date of birth',
      value: p.dateOfBirth,
      detail: `Born ${formatDateForHumans(p.dateOfBirth)}`,
      tags: ['birth', 'dob', 'age', 'born'],
    });
  }

  const e = profile.education;
  const educationTags = ['education', 'degree', 'university', 'college', 'school', 'study'];
  add({ id: 'education.university', kind: 'education', label: 'University', value: e.university, tags: educationTags });
  add({ id: 'education.college', kind: 'education', label: 'College', value: e.college ?? '' });
  add({ id: 'education.degree', kind: 'education', label: 'Degree', value: e.degree, tags: ['degree', 'qualification', 'education'] });
  add({ id: 'education.branch', kind: 'education', label: 'Branch / field of study', value: e.branch ?? '', tags: [...educationTags, 'branch', 'major', 'discipline', 'field'] });
  add({ id: 'education.specialization', kind: 'education', label: 'Specialization', value: e.specialization ?? '' });
  add({ id: 'education.graduationYear', kind: 'education', label: 'Graduation year', value: e.graduationYear ?? '', tags: ['graduation', 'year', 'passing'] });
  add({ id: 'education.semester', kind: 'education', label: 'Current semester', value: e.currentSemester ?? '', tags: ['semester'] });
  add({ id: 'education.cgpa', kind: 'education', label: 'CGPA', value: e.cgpa ?? '', tags: ['cgpa', 'gpa', 'grade', 'marks'] });
  add({ id: 'education.percentage', kind: 'education', label: 'Percentage / marks', value: e.percentage ?? '', tags: ['percentage', 'marks', 'score'] });
  add({ id: 'education.schoolName', kind: 'education', label: 'School', value: e.schoolName ?? '', tags: ['school', 'high', 'secondary', 'tenth', 'twelfth'] });
  add({ id: 'education.board', kind: 'education', label: 'Board', value: e.board ?? '' });
  add({ id: 'education.twelfthSchool', kind: 'education', label: '12th School / Junior College', value: e.twelfthSchool ?? '', tags: ['12th', 'twelfth', 'hsc', 'intermediate', 'senior secondary', 'school'] });
  add({ id: 'education.twelfthBoard', kind: 'education', label: '12th Board', value: e.twelfthBoard ?? '', tags: ['12th', 'twelfth', 'hsc', 'board'] });
  add({ id: 'education.twelfthStream', kind: 'education', label: '12th Stream', value: e.twelfthStream ?? '', tags: ['12th', 'twelfth', 'stream', 'science', 'commerce', 'arts'] });
  add({ id: 'education.twelfthYear', kind: 'education', label: '12th Passing year', value: e.twelfthYear ?? '', tags: ['12th', 'twelfth', 'passing', 'year'] });
  add({ id: 'education.twelfthPercentage', kind: 'education', label: '12th Percentage / Marks', value: e.twelfthPercentage ?? '', tags: ['12th', 'twelfth', 'percentage', 'marks', 'score', 'cgpa'] });
  add({ id: 'education.tenthSchool', kind: 'education', label: '10th School', value: e.tenthSchool ?? '', tags: ['10th', 'tenth', 'ssc', 'matriculation', 'secondary', 'high school', 'school'] });
  add({ id: 'education.tenthBoard', kind: 'education', label: '10th Board', value: e.tenthBoard ?? '', tags: ['10th', 'tenth', 'ssc', 'board'] });
  add({ id: 'education.tenthYear', kind: 'education', label: '10th Passing year', value: e.tenthYear ?? '', tags: ['10th', 'tenth', 'passing', 'year'] });
  add({ id: 'education.tenthPercentage', kind: 'education', label: '10th Percentage / Marks', value: e.tenthPercentage ?? '', tags: ['10th', 'tenth', 'percentage', 'marks', 'score', 'cgpa'] });
  if (Array.isArray(e.schools)) {
    e.schools.forEach((sch, idx) => {
      const prefix = `education.schools.${sch.id || idx}`;
      add({ id: `${prefix}.schoolName`, kind: 'education', label: `School: ${sch.schoolName}`, value: sch.schoolName, tags: ['school', sch.level ?? '', 'institution'] });
      if (sch.board) add({ id: `${prefix}.board`, kind: 'education', label: `Board: ${sch.board}`, value: sch.board, tags: ['board', sch.level ?? ''] });
      if (sch.stream) add({ id: `${prefix}.stream`, kind: 'education', label: `Stream: ${sch.stream}`, value: sch.stream, tags: ['stream', sch.level ?? ''] });
      if (sch.year) add({ id: `${prefix}.year`, kind: 'education', label: `Passing year: ${sch.year}`, value: sch.year, tags: ['passing', 'year', sch.level ?? ''] });
      if (sch.percentage) add({ id: `${prefix}.percentage`, kind: 'education', label: `Marks: ${sch.percentage}`, value: sch.percentage, tags: ['percentage', 'marks', sch.level ?? ''] });
    });
  }
  add({
    id: 'education.coursework',
    kind: 'education',
    label: 'Coursework',
    value: e.coursework.join(', '),
    tags: ['course', 'subjects', 'syllabus', 'curriculum'],
  });

  profile.experience.forEach((item, index) => {
    const prefix = `experience.${item.id || index}`;
    const roleLine = `${item.role}${item.organisation ? ` at ${item.organisation}` : ''}`;
    add({
      id: `${prefix}.role`,
      kind: 'experience',
      label: `Role: ${roleLine}`,
      value: item.role,
      detail: [item.organisation, item.location, `${item.startDate} – ${item.endDate}`.trim()].filter(Boolean).join(' · '),
      tags: [item.role, item.organisation, item.type, 'role', 'position', 'title'].filter(Boolean),
    });
    add({
      id: `${prefix}.organisation`,
      kind: 'experience',
      label: `Organisation: ${item.organisation}`,
      value: item.organisation,
      detail: roleLine,
      tags: [item.organisation, item.type],
    });
    // Dates live on the summary so duration questions ("years of experience")
    // can be answered from retrieval without scanning the whole profile.
    const dates = `${item.startDate} – ${item.endDate}`.trim();
    add({
      id: `${prefix}.summary`,
      kind: 'experience',
      label: `Experience: ${roleLine}`,
      value: joinSentences([item.responsibilities.join(' '), item.achievements.join(' ')]),
      detail: joinSentences([roleLine, dates]),
      tags: [item.role, item.organisation, item.type, 'experience', 'work', 'responsibilities', 'achievements', 'professional', 'role', 'job'],
    });
    if (item.achievements.length) {
      add({
        id: `${prefix}.achievements`,
        kind: 'experience',
        label: `Achievements: ${roleLine}`,
        value: item.achievements.join('. '),
        tags: ['achievement', 'impact', 'results', 'accomplished'],
      });
    }
  });

  profile.projects.forEach((item, index) => {
    const prefix = `projects.${item.id || index}`;
    add({
      id: `${prefix}.name`,
      kind: 'project',
      label: `Project: ${item.name}`,
      value: item.name,
      detail: [item.description, item.technologies.join(', ')].filter(Boolean).join(' · '),
      tags: [item.name, ...item.technologies, 'project'],
    });
    add({
      id: `${prefix}.details`,
      kind: 'project',
      label: `Project detail: ${item.name}`,
      value: joinSentences([
        item.description,
        item.problem ? `Problem: ${item.problem}` : '',
        item.solution ? `Solution: ${item.solution}` : '',
        item.contribution ? `My contribution: ${item.contribution}` : '',
        item.challenges ? `Challenges: ${item.challenges}` : '',
        item.results ? `Results: ${item.results}` : '',
        item.metrics ? `Metrics: ${item.metrics}` : '',
        item.teamSize ? `Team size: ${item.teamSize}` : '',
        item.leadership ? `Leadership: ${item.leadership}` : '',
        item.technologies.length ? `Tech: ${item.technologies.join(', ')}` : '',
        item.github ? `Code: ${item.github}` : '',
        item.demo ? `Demo: ${item.demo}` : '',
      ]),
      detail: item.name,
      tags: [...item.technologies, item.name, 'project', 'built', 'developed', 'experience', 'skills'],
    });
  });

  profile.achievements.forEach((item, index) => {
    const prefix = `achievements.${item.id || index}`;
    add({
      id: `${prefix}.title`,
      kind: 'achievement',
      label: `${capitalize(item.type)}: ${item.title}`,
      value: item.title,
      detail: [item.organisation, item.date, item.detail].filter(Boolean).join(' · '),
      tags: [item.type, item.title, item.organisation ?? '', 'award', 'achievement', 'recognition', 'skills', 'experience'].filter(Boolean),
    });
    if (item.detail) {
      add({
        id: `${prefix}.detail`,
        kind: 'achievement',
        label: `Detail: ${item.title}`,
        value: `${item.title}${item.detail ? ` — ${item.detail}` : ''}`,
        tags: [item.type, item.title, 'achievement'],
      });
    }
  });

  const s = profile.skills;
  // Every skills item advertises the same concepts so a question like "which of
  // these do you have hands-on experience with?" retrieves it.
  const skillTags = ['skills', 'skill', 'stack', 'technologies', 'proficiency', 'experience'];
  add({ id: 'skills.programmingLanguages', kind: 'skills', label: 'Programming languages', value: s.programmingLanguages.join(', '), tags: [...skillTags, 'language', 'languages', 'programming', 'coding'] });
  add({ id: 'skills.frameworks', kind: 'skills', label: 'Frameworks', value: s.frameworks.join(', '), tags: [...skillTags, 'framework', 'frameworks', 'stack'] });
  add({ id: 'skills.databases', kind: 'skills', label: 'Databases', value: s.databases.join(', '), tags: [...skillTags, 'database', 'databases', 'db'] });
  add({ id: 'skills.cloud', kind: 'skills', label: 'Cloud & DevOps', value: s.cloud.join(', '), tags: [...skillTags, 'cloud', 'aws', 'azure', 'gcp', 'devops'] });
  add({ id: 'skills.tools', kind: 'skills', label: 'Tools', value: s.tools.join(', '), tags: [...skillTags, 'tools', 'tooling'] });
  add({ id: 'skills.technologies', kind: 'skills', label: 'Technologies', value: s.technologies.join(', '), tags: [...skillTags, 'technology', 'technologies', 'tech', 'stack'] });
  add({ id: 'skills.softSkills', kind: 'skills', label: 'Soft skills', value: s.softSkills.join(', '), tags: [...skillTags, 'soft', 'skills', 'leadership', 'communication', 'teamwork'] });

  add({ id: 'links.linkedin', kind: 'profile', label: 'LinkedIn', value: profile.links.linkedin, tags: ['linkedin', 'profile', 'social'] });
  add({ id: 'links.github', kind: 'profile', label: 'GitHub', value: profile.links.github, tags: ['github', 'git', 'code', 'repository'] });
  add({ id: 'links.portfolio', kind: 'profile', label: 'Portfolio', value: profile.links.portfolio, tags: ['portfolio', 'website', 'personal site'] });
  add({ id: 'links.website', kind: 'profile', label: 'Website', value: profile.links.website ?? '' });
  add({ id: 'links.other', kind: 'profile', label: 'Other links', value: profile.links.other.join(', ') });

  const pref = profile.preferences;
  add({ id: 'preferences.relocate', kind: 'preference', label: 'Willing to relocate', value: pref.willingToRelocate, tags: ['relocate', 'relocation', 'willing', 'mobility'] });
  add({ id: 'preferences.locations', kind: 'preference', label: 'Preferred locations', value: pref.preferredLocations.join(', '), tags: ['location', 'locations', 'city', 'relocation'] });
  add({ id: 'preferences.workMode', kind: 'preference', label: 'Preferred work mode', value: pref.workMode, tags: ['remote', 'hybrid', 'onsite', 'on-site', 'work mode'] });
  add({ id: 'preferences.availability', kind: 'preference', label: 'Availability', value: pref.availability, tags: ['availability', 'start', 'joining', 'immediately'] });
  add({ id: 'preferences.noticePeriod', kind: 'preference', label: 'Notice period', value: pref.noticePeriod, tags: ['notice', 'period', 'relieve'] });
  add({ id: 'preferences.salary', kind: 'preference', label: 'Salary expectation', value: pref.salaryExpectation, tags: ['salary', 'ctc', 'compensation', 'pay', 'expected'] });
  if (pref.notes) add({ id: 'preferences.notes', kind: 'preference', label: 'Preference notes', value: pref.notes });

  if (Array.isArray(profile.documents)) {
    profile.documents.forEach((doc, idx) => {
      const prefix = `documents.${doc.id || idx}`;
      const docTags = ['document', 'file', 'attachment', ...(doc.keywords ?? [])];
      add({
        id: `${prefix}.name`,
        kind: 'document',
        label: `Document: ${doc.name}`,
        value: doc.name,
        detail: `${doc.fileName} (${doc.category ?? 'document'})`,
        tags: docTags,
      });
      add({
        id: `${prefix}.file`,
        kind: 'document',
        label: `File: ${doc.fileName}`,
        value: doc.fileName,
        tags: [...docTags, doc.fileName],
        docRef: {
          id: doc.id,
          name: doc.name,
          fileName: doc.fileName,
          fileType: doc.fileType,
          dataUrl: doc.dataUrl,
          isDefault: doc.isDefault,
        },
      });
      if (doc.textContent) {
        add({
          id: `${prefix}.content`,
          kind: 'document',
          label: `${doc.name} content`,
          value: doc.textContent,
          tags: docTags,
        });
      }
    });
  }

  return {
    items: uniqueBy(items, (item) => item.id),
    userFacts: userFacts.map((fact) => ({
      id: fact.id,
      key: fact.key,
      value: fact.value,
    })),
    resumeText: resumeText.trim() || undefined,
  };
}

/**
 * Items the on-device grounding check verifies a generated answer against: the
 * structured profile plus the pasted resume, so a claim drawn from the resume
 * is not discarded as invented.
 */
export function groundingCorpus(bundle: KnowledgeBundle): KnowledgeItem[] {
  if (!bundle.resumeText) return bundle.items;
  return [
    ...bundle.items,
    { id: 'resume.text', kind: 'document', label: 'Resume', value: bundle.resumeText, tags: ['resume'] },
  ];
}

export function knowledgeItemToRef(item: KnowledgeItem): { id: string; label: string; kind: KnowledgeItem['kind']; path: string } {
  return { id: item.id, label: item.label, kind: item.kind, path: item.id };
}

/**
 * Formats the candidate profile and resume from the knowledge bundle into
 * a structured, comprehensive context for the AI reasoning engine.
 */
export function buildCandidateContext(bundle: KnowledgeBundle, maxChars = 10000, maxResumeChars = 12000): string {
  const sections: Record<string, string[]> = {
    'Personal Information': [],
    'Education': [],
    'Experience': [],
    'Projects': [],
    'Skills': [],
    'Preferences': [],
    'Links': [],
    'Resume Content & Documents': [],
    'User Facts': [],
  };

  for (const item of bundle.items) {
    if (!item.value?.trim()) continue;
    const detail = item.detail ? ` (${item.detail})` : '';
    const line = `- ${item.label}${detail}: ${item.value.trim()}`;

    if (item.kind === 'document') {
      sections['Resume Content & Documents'].push(`[${item.label}] ${item.value.trim()}`);
    } else if (item.kind === 'profile') {
      if (item.id.startsWith('links.')) sections['Links'].push(line);
      else sections['Personal Information'].push(line);
    } else if (item.kind === 'education') {
      sections['Education'].push(line);
    } else if (item.kind === 'experience') {
      sections['Experience'].push(line);
    } else if (item.kind === 'project') {
      sections['Projects'].push(line);
    } else if (item.kind === 'skills') {
      sections['Skills'].push(line);
    } else if (item.kind === 'preference') {
      sections['Preferences'].push(line);
    } else {
      sections['User Facts'].push(line);
    }
  }

  if (bundle.userFacts?.length) {
    for (const fact of bundle.userFacts) {
      if (fact.value?.trim()) {
        sections['User Facts'].push(`- ${fact.key}: ${fact.value.trim()}`);
      }
    }
  }

  const parts: string[] = [];
  for (const [title, lines] of Object.entries(sections)) {
    if (lines.length > 0) {
      parts.push(`### ${title}\n${lines.join('\n')}`);
    }
  }

  let text = parts.join('\n\n');
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n(additional profile details truncated)`;
  }
  // The pasted resume has its own budget so a long profile can never crowd out
  // the work history, skills and projects it is the source of truth for.
  const resume = bundle.resumeText?.trim();
  if (resume) {
    const clipped = resume.length > maxResumeChars ? `${resume.slice(0, maxResumeChars)}\n(resume truncated)` : resume;
    text = `${text}\n\n### Resume (full text, primary source for experience, skills and projects)\n${clipped}`.trim();
  }
  return text;
}

/** Joins fragments into sentences without doubling punctuation. */
function joinSentences(parts: string[]): string {
  return parts
    .map((part) => normalizeText(part))
    .filter(Boolean)
    .map((part) => `${part.replace(/[.!?;:,]+\s*$/, '')}.`)
    .join(' ');
}

function firstName(fullName: string): string {
  return normalizeText(fullName).split(/\s+/)[0] ?? '';
}

function lastName(fullName: string): string {
  const parts = normalizeText(fullName).split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

function capitalize(input: string): string {
  return input ? input[0].toUpperCase() + input.slice(1) : input;
}

/** Converts ISO / common date formats into something readable. */
export function formatDateForHumans(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoMatch) {
    const date = new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return new Date(parsed).toLocaleDateString();
  return trimmed;
}

export function calculateAge(dateOfBirth: string, now = new Date()): number | null {
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth.trim());
  if (!isoMatch) return null;
  const dob = new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
  if (Number.isNaN(dob.getTime())) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}