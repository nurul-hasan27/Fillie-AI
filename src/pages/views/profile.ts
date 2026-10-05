import type {
  AchievementItem,
  DocumentItem,
  EducationProfile,
  EducationSchoolItem,
  ExperienceItem,
  LinksProfile,
  PersonalProfile,
  PreferencesProfile,
  ProjectItem,
  SkillsProfile,
  UserProfile,
} from '../../core/types';
import { escapeHtml, html, type TemplateResult } from '../../ui/dom';
import {
  banner,
  card,
  emptyState,
  listField,
  sectionIntro,
  selectField,
  textAreaField,
  textField,
} from '../controls';
import { newId } from '../store';

/**
 * Profile views. Each returns markup; the shell binds events generically by
 * reading `data-bind` / `data-path` attributes, which keeps the wiring in one
 * place.
 */

function grid(body: TemplateResult[], columns: 2 | 3 = 2): TemplateResult {
  return html`<div class="${columns === 3 ? 'grid-3' : 'grid-2'}">${body as never}</div>`;
}

/* ------------------------------------------------------------------ */

export function personalView(profile: UserProfile, extracted?: string): TemplateResult {
  const p = profile.personal;
  return html`
    ${sectionIntro('Personal', 'How you introduce yourself. Fillie uses these answers for contact and identity questions.')}
    ${extracted
      ? banner({
          tone: 'warning',
          title: `Draft imported from ${extracted}`,
          body: 'Check every field. Imported text is never trusted until you confirm it here.',
        })
      : ''}
    ${card(
      'Identity',
      grid([
        textField({ name: 'personal.firstName', label: 'First name / Given name', value: p.firstName ?? '', placeholder: 'Ada', autocomplete: 'given-name' }),
        textField({ name: 'personal.lastName', label: 'Last name / Family name', value: p.lastName ?? '', placeholder: 'Lovelace', autocomplete: 'family-name' }),
        textField({ name: 'personal.fullName', label: 'Full name', value: p.fullName, placeholder: 'Ada Lovelace', autocomplete: 'name', hint: 'Full legal name used for single-field name questions.' }),
        textField({ name: 'personal.email', label: 'Email', value: p.email, type: 'email', placeholder: 'ada@example.com', autocomplete: 'email' }),
        textField({ name: 'personal.dateOfBirth', label: 'Date of birth', value: p.dateOfBirth, type: 'date', hint: 'Used for age questions and eligibility checks.' }),
        textField({ name: 'personal.nationality', label: 'Nationality', value: p.nationality, placeholder: 'Indian' }),
        selectField({
          name: 'personal.gender',
          label: 'Gender',
          value: p.gender ?? '',
          placeholder: '',
          options: [
            { label: 'Prefer not to say', value: '' },
            { label: 'Female', value: 'Female' },
            { label: 'Male', value: 'Male' },
            { label: 'Non-binary', value: 'Non-binary' },
            { label: 'Self-describe', value: 'Self-describe' },
          ],
        }),
      ]),
    )}
    ${card(
      'Phone & Contact',
      grid([
        textField({ name: 'personal.phoneCountryCode', label: 'Country code / Dial code', value: p.phoneCountryCode ?? '', placeholder: '+1 or +91', autocomplete: 'tel-country-code', hint: 'e.g. +1, +91, +44' }),
        textField({ name: 'personal.phoneNumber', label: 'Phone number (national)', value: p.phoneNumber ?? '', type: 'tel', placeholder: '555 0100', autocomplete: 'tel-national', hint: 'Number without country code' }),
        textField({ name: 'personal.phoneExtension', label: 'Extension', value: p.phoneExtension ?? '', placeholder: '123', autocomplete: 'tel-extension', hint: 'Optional extension (e.g. 101)' }),
        textField({ name: 'personal.phone', label: 'Full phone number', value: p.phone, type: 'tel', placeholder: '+1 555 0100', autocomplete: 'tel', hint: 'Full number with country code for single-field forms' }),
      ]),
    )}
    ${card(
      'Location',
      grid([
        textField({ name: 'personal.address', label: 'Address', value: p.address, span: 2, placeholder: 'Street and number' }),
        textField({ name: 'personal.city', label: 'City', value: p.city ?? '', autocomplete: 'address-level2' }),
        textField({ name: 'personal.state', label: 'State / region', value: p.state ?? '', autocomplete: 'address-level1' }),
        textField({ name: 'personal.country', label: 'Country', value: p.country ?? '', autocomplete: 'country-name' }),
        textField({ name: 'personal.postalCode', label: 'Postal code', value: p.postalCode ?? '', autocomplete: 'postal-code' }),
      ]),
      html`
        <button class="ff-btn ff-btn-ghost ff-btn-sm" data-action="derive-location" type="button">
          <span data-icon="layers"></span> Fill city from address
        </button>
      `,
    )}
    ${card('Languages', grid([listField({ name: 'personal.languages', label: 'Languages you speak', values: p.languages, placeholder: 'English, Hindi…', hint: 'Include the level, e.g. “English (fluent)”.' })]))}
  `;
}

/* ------------------------------------------------------------------ */

const COURSEWORK_HINT = 'Comma separated, e.g. “Data Structures, Operating Systems, DBMS”.';

export function educationView(profile: UserProfile): TemplateResult {
  const e = profile.education;
  const schools = e.schools ?? [];
  return html`
    ${sectionIntro('Education', 'Degrees, school history, marks and coursework. Fillie matches these to academic questions automatically.')}
    ${card(
      'Degree & Higher Education',
      grid([
        textField({ name: 'education.degree', label: 'Degree', value: e.degree, placeholder: 'B.Tech' }),
        textField({ name: 'education.branch', label: 'Branch / field', value: e.branch ?? '', placeholder: 'Computer Science' }),
        textField({ name: 'education.specialization', label: 'Specialization', value: e.specialization ?? '', placeholder: 'Data Science' }),
        textField({ name: 'education.university', label: 'University', value: e.university, placeholder: 'University of Example' }),
        textField({ name: 'education.college', label: 'College', value: e.college ?? '' }),
        textField({ name: 'education.graduationYear', label: 'Graduation year', value: e.graduationYear ?? '', placeholder: '2026' }),
        textField({ name: 'education.currentSemester', label: 'Current semester', value: e.currentSemester ?? '', placeholder: '6' }),
        textField({ name: 'education.cgpa', label: 'CGPA', value: e.cgpa ?? '', placeholder: '8.6', hint: 'Out of 10 unless stated otherwise.' }),
        textField({ name: 'education.percentage', label: 'Percentage / marks', value: e.percentage ?? '', placeholder: '82' }),
      ]),
    )}
    ${card(
      'Class 12 / Higher Secondary (10+2)',
      grid([
        textField({ name: 'education.twelfthSchool', label: 'School / Junior College', value: e.twelfthSchool ?? e.schoolName ?? '', span: 2, placeholder: 'Delhi Public School' }),
        textField({ name: 'education.twelfthBoard', label: 'Board', value: e.twelfthBoard ?? e.board ?? '', placeholder: 'CBSE / ISC / State Board' }),
        textField({ name: 'education.twelfthStream', label: 'Stream', value: e.twelfthStream ?? '', placeholder: 'Science / Commerce / Arts' }),
        textField({ name: 'education.twelfthYear', label: 'Year of passing', value: e.twelfthYear ?? '', placeholder: '2022' }),
        textField({ name: 'education.twelfthPercentage', label: 'Percentage / CGPA', value: e.twelfthPercentage ?? '', placeholder: '88%' }),
      ]),
    )}
    ${card(
      'Class 10 / Secondary (10th)',
      grid([
        textField({ name: 'education.tenthSchool', label: 'School name', value: e.tenthSchool ?? '', span: 2, placeholder: 'St. Xavier High School' }),
        textField({ name: 'education.tenthBoard', label: 'Board', value: e.tenthBoard ?? '', placeholder: 'CBSE / ICSE / State Board' }),
        textField({ name: 'education.tenthYear', label: 'Year of passing', value: e.tenthYear ?? '', placeholder: '2020' }),
        textField({ name: 'education.tenthPercentage', label: 'Percentage / CGPA', value: e.tenthPercentage ?? '', placeholder: '92%' }),
      ]),
    )}
    ${card(
      'Additional Schools & Institutions',
      html`
        <div class="repeater" data-repeater="schools">
          ${schools.map((item, index) => schoolItem(item, index))}
        </div>
        <div class="row-wrap" style="margin-top:var(--ff-space-4)">
          <button class="ff-btn ff-btn-secondary ff-btn-sm" data-action="add-school" type="button">
            <span data-icon="plus" data-size="13"></span> Add another school
          </button>
        </div>
      `,
    )}
    ${card('Coursework', grid([listField({ name: 'education.coursework', label: 'Subjects', values: e.coursework, placeholder: 'Data Structures…', hint: COURSEWORK_HINT })]))}
  `;
}

function schoolItem(item: EducationSchoolItem, index: number): TemplateResult {
  return html`
    <div class="repeater-item" data-index="${index}" data-item-id="${escapeHtml(item.id)}">
      <div class="repeater-head">
        <strong>${escapeHtml(item.level ? `${item.level}: ` : '')}${escapeHtml(item.schoolName || 'School / Institution')}</strong>
        <div class="ff-row">
          <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" data-action="duplicate-school" data-index="${index}" type="button" title="Duplicate">
            <span data-icon="layers" data-size="13"></span>
          </button>
          <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" data-action="remove-school" data-index="${index}" type="button" title="Remove">
            <span data-icon="trash" data-size="13"></span>
          </button>
        </div>
      </div>
      <div class="repeater-body">
        ${grid([
          textField({ name: 'schoolName', label: 'School / Institution', value: item.schoolName, span: 2, placeholder: 'Modern School' }),
          textField({ name: 'level', label: 'Level / Standard', value: item.level, placeholder: '10th / 12th / Diploma / Other' }),
          textField({ name: 'board', label: 'Board / Affiliation', value: item.board ?? '', placeholder: 'CBSE / State Board' }),
          textField({ name: 'stream', label: 'Stream / Field', value: item.stream ?? '', placeholder: 'General / Science' }),
          textField({ name: 'year', label: 'Year of completion', value: item.year ?? '', placeholder: '2020' }),
          textField({ name: 'percentage', label: 'Percentage / CGPA', value: item.percentage ?? '', placeholder: '85%' }),
        ])}
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ */

const SKILL_GROUPS: Array<{ key: keyof SkillsProfile; label: string; placeholder: string }> = [
  { key: 'programmingLanguages', label: 'Programming languages', placeholder: 'Python, TypeScript…' },
  { key: 'frameworks', label: 'Frameworks', placeholder: 'React, Django…' },
  { key: 'databases', label: 'Databases', placeholder: 'PostgreSQL, MongoDB…' },
  { key: 'cloud', label: 'Cloud & DevOps', placeholder: 'AWS, Docker…' },
  { key: 'tools', label: 'Tools', placeholder: 'Git, Figma…' },
  { key: 'technologies', label: 'Other technologies', placeholder: 'Kafka, Redis…' },
  { key: 'softSkills', label: 'Soft skills', placeholder: 'Mentoring, communication…' },
];

export function skillsView(profile: UserProfile): TemplateResult {
  return html`
    ${sectionIntro('Skills', 'The vocabulary Fillie matches against. More detail means better retrieved context.')}
    ${card(
      'Technical skills',
      grid(
        SKILL_GROUPS.map((group) =>
          listField({ name: `skills.${group.key}`, label: group.label, values: profile.skills[group.key], placeholder: group.placeholder }),
        ),
      ),
    )}
  `;
}

/* ------------------------------------------------------------------ */

export function experienceView(profile: UserProfile): TemplateResult {
  return html`
    ${sectionIntro('Experience', 'Internships and roles. Add responsibilities as short sentences — Fillie reuses them in essays.')}
    ${card(
      'Roles',
      html`
        <div class="repeater" data-repeater="experience">
          ${profile.experience.map((item, index) => experienceItem(item, index))}
        </div>
        <div class="row-wrap" style="margin-top:var(--ff-space-4)">
          <button class="ff-btn ff-btn-secondary ff-btn-sm" data-action="add-experience" type="button">
            <span data-icon="plus" data-size="13"></span> Add internship or role
          </button>
        </div>
      `,
    )}
  `;
}

function experienceItem(item: ExperienceItem, index: number): TemplateResult {
  return html`
    <div class="repeater-item" data-index="${index}" data-item-id="${escapeHtml(item.id)}">
      <div class="repeater-head">
        <strong>${escapeHtml(item.role || 'New role')} — ${escapeHtml(item.organisation || 'Organisation')}</strong>
        <div class="ff-row">
          <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" data-action="duplicate-experience" data-index="${index}" type="button" title="Duplicate">
            <span data-icon="layers" data-size="13"></span>
          </button>
          <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" data-action="remove-experience" data-index="${index}" type="button" title="Remove">
            <span data-icon="trash" data-size="13"></span>
          </button>
        </div>
      </div>
      <div class="repeater-body">
        ${grid([
          textField({ name: 'role', label: 'Role', value: item.role, placeholder: 'Backend Engineering Intern' }),
          textField({ name: 'organisation', label: 'Organisation', value: item.organisation, placeholder: 'Acme Corp' }),
          selectField({
            name: 'type',
            label: 'Type',
            value: item.type,
            options: [
              { label: 'Internship', value: 'internship' },
              { label: 'Full-time role', value: 'job' },
              { label: 'Volunteering', value: 'volunteer' },
              { label: 'Other', value: 'other' },
            ],
          }),
          textField({ name: 'location', label: 'Location', value: item.location ?? '' }),
          textField({ name: 'startDate', label: 'Start', value: item.startDate, placeholder: '2024-06' }),
          textField({ name: 'endDate', label: 'End', value: item.endDate, placeholder: 'Present' }),
        ])}
        ${textAreaField({
          name: 'responsibilities',
          label: 'Responsibilities & key contributions (one per line)',
          value: item.responsibilities.join('\n'),
          rows: 4,
          placeholder: 'Architected and built backend microservices in Node.js\nOptimized database indexing, cutting p95 response time by 35%\nMentored junior developers and led code reviews',
          hint: 'Write each responsibility on a new line. You can write long answers, sentences with commas, and detailed descriptions.',
        })}
        ${textAreaField({
          name: 'achievements',
          label: 'Key achievements & impact (one per line)',
          value: item.achievements.join('\n'),
          rows: 3,
          placeholder: 'Awarded Top Performer of Q3\nShipped MVP 2 weeks ahead of schedule',
          hint: 'Write each achievement on a new line.',
        })}
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ */

export function projectsView(profile: UserProfile): TemplateResult {
  return html`
    ${sectionIntro('Projects', 'Fillie draws on these for “describe a project” questions. Detail here beats adjectives.')}
    ${card(
      'Projects',
      html`
        <div class="repeater" data-repeater="projects">
          ${profile.projects.map((item, index) => projectItem(item, index))}
        </div>
        <div class="row-wrap" style="margin-top:var(--ff-space-4)">
          <button class="ff-btn ff-btn-secondary ff-btn-sm" data-action="add-project" type="button">
            <span data-icon="plus" data-size="13"></span> Add project
          </button>
        </div>
      `,
    )}
  `;
}

function projectItem(item: ProjectItem, index: number): TemplateResult {
  return html`
    <div class="repeater-item" data-index="${index}" data-item-id="${escapeHtml(item.id)}">
      <div class="repeater-head">
        <strong>${escapeHtml(item.name || 'New project')}</strong>
        <div class="ff-row">
          <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" data-action="duplicate-project" data-index="${index}" type="button" title="Duplicate">
            <span data-icon="layers" data-size="13"></span>
          </button>
          <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" data-action="remove-project" data-index="${index}" type="button" title="Remove">
            <span data-icon="trash" data-size="13"></span>
          </button>
        </div>
      </div>
      <div class="repeater-body">
        ${grid([
          textField({ name: 'name', label: 'Project name', value: item.name, span: 2, placeholder: 'Campus Navigation App' }),
          textField({ name: 'github', label: 'Repository', value: item.github ?? '', placeholder: 'github.com/…' }),
          textField({ name: 'demo', label: 'Live demo', value: item.demo ?? '', placeholder: 'myapp.vercel.app' }),
        ])}
        ${textAreaField({ name: 'description', label: 'What it does', value: item.description, rows: 2, placeholder: 'One or two sentences a recruiter would understand.' })}
        ${grid([
          textAreaField({ name: 'problem', label: 'Problem', value: item.problem ?? '', rows: 2 }),
          textAreaField({ name: 'solution', label: 'Your solution', value: item.solution ?? '', rows: 2 }),
        ])}
        ${grid([
          textAreaField({ name: 'contribution', label: 'Your contribution', value: item.contribution ?? '', rows: 2 }),
          textAreaField({ name: 'challenges', label: 'Challenges', value: item.challenges ?? '', rows: 2 }),
        ])}
        ${grid([
          textAreaField({ name: 'results', label: 'Results', value: item.results ?? '', rows: 2 }),
          textField({ name: 'metrics', label: 'Metrics', value: item.metrics ?? '', placeholder: '4.2k users, p95 180ms' }),
        ])}
        ${grid([
          textField({ name: 'teamSize', label: 'Team size', value: item.teamSize ?? '', placeholder: '4' }),
          textField({ name: 'leadership', label: 'Leadership role', value: item.leadership ?? '', placeholder: 'Team lead' }),
        ])}
        ${listField({ name: 'technologies', label: 'Technologies', values: item.technologies, placeholder: 'React, Node, Postgres…' })}
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ */

export function achievementsView(profile: UserProfile): TemplateResult {
  return html`
    ${sectionIntro('Achievements', 'Awards, hackathons and certifications. Dates and organisations help Fillie cite them accurately.')}
    ${card(
      'Achievements',
      html`
        <div class="repeater" data-repeater="achievements">
          ${profile.achievements.map((item, index) => achievementItem(item, index))}
        </div>
        <div class="row-wrap" style="margin-top:var(--ff-space-4)">
          <button class="ff-btn ff-btn-secondary ff-btn-sm" data-action="add-achievement" type="button">
            <span data-icon="plus" data-size="13"></span> Add achievement
          </button>
        </div>
      `,
    )}
  `;
}

function achievementItem(item: AchievementItem, index: number): TemplateResult {
  return html`
    <div class="repeater-item" data-index="${index}" data-item-id="${escapeHtml(item.id)}">
      <div class="repeater-head">
        <strong>${escapeHtml(item.title || 'New achievement')}</strong>
        <div class="ff-row">
          <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" data-action="remove-achievement" data-index="${index}" type="button" title="Remove">
            <span data-icon="trash" data-size="13"></span>
          </button>
        </div>
      </div>
      <div class="repeater-body">
        ${grid([
          textField({ name: 'title', label: 'Title', value: item.title, span: 2, placeholder: 'Winner — Smart India Hackathon 2024' }),
          selectField({
            name: 'type',
            label: 'Type',
            value: item.type,
            options: [
              { label: 'Hackathon', value: 'hackathon' },
              { label: 'Award', value: 'award' },
              { label: 'Certification', value: 'certification' },
              { label: 'Competition', value: 'competition' },
              { label: 'Ranking', value: 'ranking' },
              { label: 'Publication', value: 'publication' },
            ],
          }),
          textField({ name: 'organisation', label: 'Organisation', value: item.organisation ?? '' }),
          textField({ name: 'date', label: 'Date', value: item.date ?? '', placeholder: '2024-03' }),
          textField({ name: 'credentialId', label: 'Credential ID', value: item.credentialId ?? '' }),
          textField({ name: 'url', label: 'Link', value: item.url ?? '' }),
        ])}
        ${textAreaField({ name: 'detail', label: 'Detail', value: item.detail ?? '', rows: 2 })}
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ */

export function linksView(profile: UserProfile): TemplateResult {
  const l = profile.links;
  return html`
    ${sectionIntro('Links', 'Where people can verify your work. Paste the full URL so Fillie can reuse it verbatim.')}
    ${card(
      'Profiles',
      grid([
        textField({ name: 'links.linkedin', label: 'LinkedIn', value: l.linkedin, placeholder: 'linkedin.com/in/you', span: 2 }),
        textField({ name: 'links.github', label: 'GitHub', value: l.github, placeholder: 'github.com/you' }),
        textField({ name: 'links.portfolio', label: 'Portfolio', value: l.portfolio, placeholder: 'yourname.dev' }),
        textField({ name: 'links.website', label: 'Other website', value: l.website ?? '' }),
      ]),
    )}
    ${card('Additional links', grid([listField({ name: 'links.other', label: 'Other links', values: l.other, placeholder: 'https://…' })]))}
  `;
}

/* ------------------------------------------------------------------ */

export function preferencesView(profile: UserProfile): TemplateResult {
  const p = profile.preferences;
  return html`
    ${sectionIntro('Preferences', 'What you want from a job. Fillie will never invent these — if a field is blank it will ask you.')}
    ${card(
      'Work preferences',
      grid([
        selectField({
          name: 'preferences.willingToRelocate',
          label: 'Willing to relocate',
          value: p.willingToRelocate,
          options: [
            { label: 'Not set', value: '' },
            { label: 'Yes', value: 'Yes' },
            { label: 'No', value: 'No' },
            { label: 'Open to it', value: 'Open to it' },
          ],
        }),
        selectField({
          name: 'preferences.workMode',
          label: 'Preferred work mode',
          value: p.workMode,
          options: [
            { label: 'Not set', value: '' },
            { label: 'Remote', value: 'Remote' },
            { label: 'Hybrid', value: 'Hybrid' },
            { label: 'On-site', value: 'On-site' },
          ],
        }),
        textField({ name: 'preferences.availability', label: 'Availability', value: p.availability, placeholder: 'Immediately' }),
        textField({ name: 'preferences.noticePeriod', label: 'Notice period', value: p.noticePeriod, placeholder: '30 days' }),
        textField({
          name: 'preferences.salaryExpectation',
          label: 'Salary expectation',
          value: p.salaryExpectation,
          placeholder: '₹12 LPA',
          hint: 'Leave blank if you would rather be asked.',
        }),
        textField({ name: 'preferences.currency', label: 'Currency', value: p.currency ?? '', placeholder: 'INR' }),
      ]),
    )}
    ${card('Location & notes', grid([listField({ name: 'preferences.preferredLocations', label: 'Preferred locations', values: p.preferredLocations, placeholder: 'Bengaluru, Remote…' }), textAreaField({ name: 'preferences.notes', label: 'Notes Fillie can use', value: p.notes ?? '', rows: 3, placeholder: 'Facts you want Fillie to know, one per line.' })]))}
  `;
}

/* ------------------------------------------------------------------ */

export function importView(): TemplateResult {
  return html`
    ${sectionIntro('Import a resume', 'Fillie reads the file and suggests values for you to review. Nothing is saved until you apply it.')}
    ${card(
      'Upload',
      html`
        <div class="stack-md">
          <label class="ff-field" for="resume-file">
            <span class="ff-field-label">PDF or DOCX</span>
            <input class="ff-input" id="resume-file" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
          </label>
          <p class="ff-hint">
            Parsing happens entirely in your browser. Fillie reads the text of the file and proposes values — it does not
            upload it anywhere.
          </p>
          <div id="import-result"></div>
        </div>
      `,
    )}
  `;
}

export function profileEmptyState(): TemplateResult {
  return emptyState({
    iconName: 'user',
    title: 'Your profile is empty',
    body: 'Fillie answers form questions from this data. Add at least a name, email and one experience or project.',
  });
}

export function makeExperience(): ExperienceItem {
  return {
    id: newId('exp'),
    type: 'internship',
    organisation: '',
    role: '',
    startDate: '',
    endDate: '',
    responsibilities: [],
    achievements: [],
  };
}

export function makeProject(): ProjectItem {
  return { id: newId('proj'), name: '', description: '', technologies: [] };
}

export function makeAchievement(): AchievementItem {
  return { id: newId('ach'), type: 'award', title: '' };
}

export function makeSchool(): EducationSchoolItem {
  return {
    id: newId('sch'),
    level: 'School',
    schoolName: '',
    board: '',
    stream: '',
    year: '',
    percentage: '',
  };
}

/* ------------------------------------------------------------------ */

export function documentsView(profile: UserProfile): TemplateResult {
  const docs = profile.documents ?? [];
  return html`
    ${sectionIntro(
      'Documents & Resumes',
      'Upload your resumes, cover letters, transcripts and other documents with custom keywords. Fillie automatically attaches the matching document when forms ask for file uploads.',
    )}
    ${card(
      'Upload new document',
      html`
        <div style="display:flex; flex-direction:column; gap:var(--ff-space-3);">
          <div class="grid-2">
            <div>
              <label class="ff-field" for="doc-upload-file">
                <span class="ff-label">Document file (PDF, DOCX, TXT, etc.)</span>
                <input
                  class="ff-input"
                  id="doc-upload-file"
                  type="file"
                  accept=".pdf,.doc,.docx,.txt,.rtf,.png,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                />
              </label>
            </div>
            <div>
              <label class="ff-field" for="doc-upload-category">
                <span class="ff-label">Document category</span>
                <select class="ff-input" id="doc-upload-category">
                  <option value="resume">Resume / CV</option>
                  <option value="cover-letter">Cover Letter</option>
                  <option value="transcript">Academic Transcript</option>
                  <option value="certificate">Certificate</option>
                  <option value="id">ID Proof</option>
                  <option value="other">Other Document</option>
                </select>
              </label>
            </div>
          </div>
          <div class="grid-2">
            <div>
              <label class="ff-field" for="doc-upload-name">
                <span class="ff-label">Document label / title</span>
                <input class="ff-input" id="doc-upload-name" placeholder="e.g. SDE Resume 2026, Frontend CV" />
                <span class="ff-hint">A friendly name to identify this document.</span>
              </label>
            </div>
            <div>
              <label class="ff-field" for="doc-upload-keywords">
                <span class="ff-label">Matching keywords (comma-separated)</span>
                <input class="ff-input" id="doc-upload-keywords" placeholder="e.g. resume, cv, frontend, react, sde" />
                <span class="ff-hint">When a job form has these words, Fillie picks this document.</span>
              </label>
            </div>
          </div>
          <div style="margin-top:var(--ff-space-2);">
            <button class="ff-btn ff-btn-primary" data-action="upload-document-btn" type="button">
              <span data-icon="upload" data-size="14"></span> Upload Document
            </button>
          </div>
        </div>
      `,
    )}
    ${card(
      'Document library',
      html`
        ${docs.length === 0
          ? emptyState({
              title: 'No documents uploaded yet',
              body: 'Upload your resume or other documents above. Add keywords so Fillie knows which document to attach for each job application form.',
            })
          : html`
              <div class="repeater" data-repeater="documents">
                ${docs.map((doc, index) => documentItem(doc, index))}
              </div>
            `}
      `,
    )}
  `;
}

function documentItem(doc: DocumentItem, index: number): TemplateResult {
  const sizeFormatted = doc.fileSize ? `${Math.round(doc.fileSize / 1024)} KB` : '';
  const categoryLabel: Record<string, string> = {
    resume: 'Resume / CV',
    'cover-letter': 'Cover Letter',
    transcript: 'Transcript',
    certificate: 'Certificate',
    id: 'ID Proof',
    other: 'Other',
  };

  return html`
    <div class="repeater-item" data-index="${index}" data-item-id="${escapeHtml(doc.id)}">
      <div class="repeater-head">
        <div style="display:flex; align-items:center; gap:var(--ff-space-2); flex-wrap:wrap;">
          <strong>${escapeHtml(doc.name || doc.fileName)}</strong>
          <span class="ff-chip" style="text-transform:capitalize;">${escapeHtml(categoryLabel[doc.category ?? 'resume'] ?? doc.category ?? 'document')}</span>
          ${doc.isDefault ? html`<span class="saved-flag"><span data-icon="check" data-size="12"></span> Default</span>` : ''}
          ${sizeFormatted ? html`<span class="ff-meta">(${sizeFormatted})</span>` : ''}
        </div>
        <div class="ff-row">
          ${!doc.isDefault
            ? html`
                <button class="ff-btn ff-btn-ghost ff-btn-sm" data-action="set-default-document" data-id="${escapeHtml(doc.id)}" type="button" title="Set as default">
                  Set default
                </button>
              `
            : ''}
          ${doc.dataUrl
            ? html`
                <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" data-action="download-document" data-id="${escapeHtml(doc.id)}" type="button" title="Download">
                  <span data-icon="download" data-size="13"></span>
                </button>
              `
            : ''}
          <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" data-action="remove-document" data-id="${escapeHtml(doc.id)}" type="button" title="Delete">
            <span data-icon="trash" data-size="13"></span>
          </button>
        </div>
      </div>
      <div class="repeater-body">
        ${grid([
          textField({ name: 'name', label: 'Title / Label', value: doc.name }),
          selectField({
            name: 'category',
            label: 'Category',
            value: doc.category ?? 'resume',
            options: [
              { label: 'Resume / CV', value: 'resume' },
              { label: 'Cover Letter', value: 'cover-letter' },
              { label: 'Transcript', value: 'transcript' },
              { label: 'Certificate', value: 'certificate' },
              { label: 'ID Proof', value: 'id' },
              { label: 'Other', value: 'other' },
            ],
          }),
        ])}
        ${grid([
          textField({
            name: 'fileName',
            label: 'Original File Name',
            value: doc.fileName,
            readonly: true,
          }),
          textField({
            name: 'keywords',
            label: 'Keywords (comma-separated)',
            value: (doc.keywords ?? []).join(', '),
            hint: 'E.g. resume, frontend, react, sde',
          }),
        ])}
      </div>
    </div>
  `;
}

export type ProfileSectionView = {
  personal: (p: UserProfile, extracted?: string) => TemplateResult;
  education: (p: UserProfile) => TemplateResult;
  skills: (p: UserProfile) => TemplateResult;
  experience: (p: UserProfile) => TemplateResult;
  projects: (p: UserProfile) => TemplateResult;
  achievements: (p: UserProfile) => TemplateResult;
  links: (p: UserProfile) => TemplateResult;
  documents: (p: UserProfile) => TemplateResult;
  preferences: (p: UserProfile) => TemplateResult;
};

export const PROFILE_VIEWS: ProfileSectionView = {
  personal: personalView,
  education: educationView,
  skills: skillsView,
  experience: experienceView,
  projects: projectsView,
  achievements: achievementsView,
  links: linksView,
  documents: documentsView,
  preferences: preferencesView,
};

export type { DocumentItem, EducationProfile, EducationSchoolItem, LinksProfile, PersonalProfile, PreferencesProfile, SkillsProfile };