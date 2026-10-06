import type {
  ResumesState,
  AIProviderConfig,
  AIProviderId,
  AISettings,
  DeepPartial,
  DocumentItem,
  LearnedAnswer,
  ProfileSection,
  UserProfile,
} from '../core/types';
import { applyPresetDefaults, getPreset } from '../core/ai/presets';
import { DEFAULT_SETTINGS, mergeSettings } from '../core/storage';
import { PROFILE_SECTIONS, createEmptyProfile, formatFullPhone, isProfileSection, parsePhoneNumberParts, profileCompletion } from '../core/profile';
import { sendMessage, type StatusResponse } from '../shared/messages';
import { deleteLearnedAnswer, updateLearnedAnswer } from '../core/memory';
import { extractResume, mergeSuggestions } from '../core/resume';
import { escapeHtml, html, setTheme, type TemplateResult } from '../ui/dom';
import { icon } from '../ui/icons';
import { VERSION } from '../shared/version';
import { createProfileStore, loadProfile, newId, type ProfileStore } from './store';
import { autoGrow, banner, getPath, setPath } from './controls';
import {
  PROFILE_VIEWS,
  importView,
  makeAchievement,
  makeExperience,
  makeProject,
  makeSchool,
} from './views/profile';
import { memoryEditor, memoryView } from './views/memory';
import { resumeView } from './views/resume';
import { applicationEditor, databaseView, type DatabaseState } from './views/database';
import { accountView, type AccountState } from './views/account';
import { computeHashes } from '../core/cloud/fingerprint';
import { newApplication } from '../core/cloud/applications';
import type { Application, ApplicationStatus, OAuthProvider } from '../core/cloud/types';
import type { AccountStatus } from '../shared/messages';
import type { ApplicationPage } from '../core/cloud/applications';
import {
  SETTINGS_SECTIONS,
  aiView,
  appearanceView,
  advancedView,
  memorySettingsView,
  privacyView,
  profileSettingsView,
  type SettingsSection,
} from './views/settings';

/**
 * Fillie app shell. Small enough to stay dependency-free: one render function,
 * one delegated event layer, autosave via a debounced store.
 */

type Route =
  | { kind: 'profile'; section: ProfileSection }
  | { kind: 'memory'; editing?: string }
  | { kind: 'resume' }
  | { kind: 'database' }
  | { kind: 'account' }
  | { kind: 'settings'; section: SettingsSection };

interface AppState {
  route: Route;
  profile: UserProfile;
  store: ProfileStore;
  settings: AISettings;
  callsToday: number;
  memory: LearnedAnswer[];
  resumes: ResumesState;
  activeResumeId: string;
  db: DatabaseState;
  editingApp?: { app: Application; isNew: boolean };
  account: AccountState;
  memoryQuery: string;
  theme: 'light' | 'dark' | 'system';
  importedFile?: string;
  importWarnings: string[];
  pendingSuggestions?: DeepPartial<UserProfile>;
  editingMemory?: LearnedAnswer;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  connections: Record<string, { testing?: boolean; message?: string; ok?: boolean }>;
  diagnostics: {
    aiCalls: number;
    sessions: number;
    fieldsFilled: number;
    cacheHits: number;
    memoryCount: number;
    lastErrors: string[];
  };
  toast?: { message: string; tone?: 'default' | 'danger' };
}

const app = document.getElementById('app')!;
const toastHost = document.getElementById('toast-host')!;

const state: AppState = {
  route: parseRoute(),
  profile: undefined as unknown as UserProfile,
  store: createProfileStore({} as UserProfile),
  settings: structuredClone(DEFAULT_SETTINGS),
  callsToday: 0,
  memory: [],
  resumes: { resumes: [], defaultId: '' },
  activeResumeId: '',
  db: { rows: [], hasMore: false, loading: false, loaded: false, localOnly: false, signedIn: false, search: '', status: 'all' },
  account: { status: null, mode: 'signin', busy: '', feedbackRating: 0 },
  memoryQuery: '',
  theme: (localStorage.getItem('fillie:theme') as AppState['theme']) ?? 'system',
  importWarnings: [],
  connections: {},
  saveState: 'idle',
  diagnostics: { aiCalls: 0, sessions: 0, fieldsFilled: 0, cacheHits: 0, memoryCount: 0, lastErrors: [] },
};

/**
 * Hash shapes:
 *   #/profile/<section>   #/memory   #/settings/<section>
 * A bare `#/<section>` is also accepted, so an old bookmark still lands on a
 * profile section.
 */
function parseRoute(): Route {
  const hash = location.hash.replace(/^#\/?/, '');
  const [head, section] = hash.split('/');

  if (head === 'memory') return { kind: 'memory' };
  if (head === 'resume') return { kind: 'resume' };
  if (head === 'database') return { kind: 'database' };
  if (head === 'account') return { kind: 'account' };

  if (head === 'settings') {
    const valid = SETTINGS_SECTIONS.some((entry) => entry.id === section);
    return { kind: 'settings', section: (valid ? section : 'ai') as SettingsSection };
  }

  if (head === 'profile') return { kind: 'profile', section: profileSection(section) };
  return { kind: 'profile', section: profileSection(head) };
}

function profileSection(id: string | undefined): ProfileSection {
  return isProfileSection(id ?? '') ? (id as ProfileSection) : PROFILE_SECTIONS[0].id;
}

function navigate(hash: string): void {
  if (location.hash === hash) {
    state.route = parseRoute();
    render();
    return;
  }
  location.hash = hash;
}

/* ------------------------------------------------------------------ */
/* Data access                                                         */
/* ------------------------------------------------------------------ */

interface SettingsWithUsage extends AISettings {
  callsToday: number;
}

async function refreshMemory(): Promise<void> {
  try {
    state.memory = (await sendMessage<LearnedAnswer[]>({ type: 'fillie:get-memory' })) ?? [];
  } catch {
    state.memory = [];
  }
  state.diagnostics.memoryCount = state.memory.length;
}

async function refreshSettings(): Promise<void> {
  try {
    const settings = (await sendMessage<SettingsWithUsage>({ type: 'fillie:get-settings' })) ?? DEFAULT_SETTINGS;
    state.settings = mergeSettings(settings);
    state.callsToday = settings.callsToday ?? 0;
  } catch {
    state.settings = structuredClone(DEFAULT_SETTINGS);
  }
}

/** Usage counters for the Advanced screen, read fresh each time it is shown. */
async function refreshDiagnostics(): Promise<void> {
  try {
    const status = await sendMessage<StatusResponse>({ type: 'fillie:get-status' });
    state.diagnostics = {
      ...state.diagnostics,
      ...status.stats,
      memoryCount: status.memoryCount,
    };
  } catch {
    /* diagnostics are optional */
  }
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function pageTitleFor(route: Route): { title: string; description: string } {
  if (route.kind === 'profile') {
    const section = PROFILE_SECTIONS.find((entry) => entry.id === route.section) ?? PROFILE_SECTIONS[0];
    return { title: section.label, description: section.description };
  }
  if (route.kind === 'database') return { title: 'Database', description: 'Every application, with status, notes and rating.' };
  if (route.kind === 'account') return { title: 'Account', description: 'Plan, sign-in and backup.' };
  if (route.kind === 'resume') {
    return { title: 'Resumes', description: 'One per kind of role. Fillie asks which to use.' };
  }
  if (route.kind === 'memory') {
    return { title: 'Memory', description: 'Answers Fillie has learned from you.' };
  }
  const section = SETTINGS_SECTIONS.find((entry) => entry.id === route.section) ?? SETTINGS_SECTIONS[0];
  return { title: `Settings · ${section.label}`, description: section.description };
}

function sidebar(): TemplateResult {
  const completion = profileCompletion(state.profile);
  const link = (href: string, label: string, iconName: Parameters<typeof icon>[0], current: boolean) => html`
    <button class="side-link" data-nav="${href}" type="button" ${current ? 'aria-current="page"' : ''}>
      <span data-icon="${iconName}"></span> ${escapeHtml(label)}
    </button>
  `;

  return html`
    <aside class="sidebar">
      <div class="side-brand">
        <span class="side-mark" aria-hidden="true"></span>
        <span class="side-brand-name">
          <strong>Fillie</strong>
          <span class="ff-meta">Personal form assistant</span>
        </span>
      </div>

      <nav class="side-group" aria-label="Profile sections">
        <span class="ff-label side-group-label">Profile</span>
        ${PROFILE_SECTIONS.map((section) =>
          link(`#/profile/${section.id}`, section.label, profileIcon(section.id), state.route.kind === 'profile' && state.route.section === section.id),
        )}
      </nav>

      <nav class="side-group" aria-label="Other sections">
        <span class="ff-label side-group-label">Fillie</span>
        ${link('#/database', 'Database', 'layers', state.route.kind === 'database')}
        ${link('#/resume', 'Resumes', 'upload', state.route.kind === 'resume')}
        ${link('#/memory', 'Memory', 'brain', state.route.kind === 'memory')}
        ${link('#/account', 'Account', 'user', state.route.kind === 'account')}
        ${SETTINGS_SECTIONS.map((section) =>
          link(`#/settings/${section.id}`, section.label, 'sliders', state.route.kind === 'settings' && state.route.section === section.id),
        )}
      </nav>

      <div class="side-foot">
        <div class="ff-row-between">
          <span class="ff-label">Profile</span>
          <span class="ff-meta">${completion}%</span>
        </div>
        <div class="completeness"><i style="width:${completion}%"></i></div>
        <span class="ff-meta">v${VERSION}</span>
      </div>
    </aside>
  `;
}

function profileIcon(section: string): Parameters<typeof icon>[0] {
  switch (section) {
    case 'personal':
      return 'user';
    case 'education':
      return 'cap';
    case 'skills':
      return 'layers';
    case 'experience':
      return 'briefcase';
    case 'projects':
      return 'folder';
    case 'achievements':
      return 'trophy';
    case 'links':
      return 'link';
    case 'documents':
      return 'upload';
    default:
      return 'sliders';
  }
}

function topbar(): TemplateResult {
  const page = pageTitleFor(state.route);
  const saved =
    state.saveState === 'saving'
      ? html`<span class="ff-meta">Saving…</span>`
      : state.saveState === 'saved'
        ? html`<span class="saved-flag"><span data-icon="check" data-size="13"></span> Saved</span>`
        : state.saveState === 'error'
          ? html`<span class="ff-error-text">Could not save</span>`
          : '';

  return html`
    <header class="topbar">
      <div class="topbar-titles">
        <h1>${escapeHtml(page.title)}</h1>
        <span class="ff-meta">${escapeHtml(page.description)}</span>
      </div>
      <div class="topbar-actions">
        <span id="topbar-save-status">${saved}</span>
        ${state.route.kind === 'profile'
          ? html`
              <button class="ff-btn ff-btn-secondary ff-btn-sm" data-action="import-resume" type="button">
                <span data-icon="upload" data-size="13"></span> Import resume
              </button>
              <button class="ff-btn ff-btn-primary ff-btn-sm" data-action="save-now" type="button">Save</button>
            `
          : ''}
      </div>
    </header>
  `;
}

function body(): TemplateResult {
  if (state.route.kind === 'profile') {
    const view = PROFILE_VIEWS[state.route.section as keyof typeof PROFILE_VIEWS] ?? PROFILE_VIEWS.personal;
    if (state.route.section === 'personal') {
      return view(state.profile, state.importedFile);
    }
    return view(state.profile);
  }

  if (state.route.kind === 'database') {
    return html`${databaseView(state.db)}${state.editingApp ? applicationEditor(state.editingApp.app, state.editingApp.isNew) : ''}`;
  }
  if (state.route.kind === 'account') return accountView(state.account);
  if (state.route.kind === 'resume') return resumeView(state.resumes, state.activeResumeId);

  if (state.route.kind === 'memory') {
    if (state.editingMemory) return memoryEditor(state.editingMemory);
    return memoryView(state.memory, state.memoryQuery);
  }

  switch (state.route.section) {
    case 'ai':
      return aiView(state.settings, state.callsToday, state.connections);
    case 'profile':
      return profileSettingsView(importView());
    case 'memory':
      return memorySettingsView(state.memory.length, state.diagnostics.cacheHits);
    case 'privacy':
      return privacyView(state.settings);
    case 'appearance':
      return appearanceView(state.theme);
    case 'advanced':
      return advancedView({ version: VERSION, ...state.diagnostics });
    default:
      return aiView(state.settings, state.callsToday, state.connections);
  }
}

function render(): void {
  const page = html`
    <div class="app">
      ${sidebar()}
      <div class="main">
        ${topbar()}
        <div class="content" data-role="content">${body()}</div>
      </div>
    </div>
  `;
  app.innerHTML = page.__html;
  hydrate(app);
  renderImportPreview();
  if (state.editingApp) syncEditor();
  watchLoadMore();
  const search = app.querySelector<HTMLInputElement>('#memory-search');
  if (search) {
    search.addEventListener('input', () => {
      state.memoryQuery = search.value;
      const position = search.selectionStart ?? search.value.length;
      render();
      const next = app.querySelector<HTMLInputElement>('#memory-search');
      if (next) {
        next.focus();
        try {
          next.setSelectionRange(position, position);
        } catch {
          /* search inputs on some platforms reject selection APIs */
        }
      }
    });
  }
  app.querySelectorAll('textarea').forEach((area) => autoGrow(area));
}

function hydrate(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((node) => {
    const name = node.dataset.icon as Parameters<typeof icon>[0];
    node.replaceChildren(icon(name, { size: Number(node.dataset.size ?? 15) }));
  });
  root.querySelectorAll<HTMLInputElement>('input[data-bind="range"]').forEach((input) => {
    input.addEventListener('input', () => {
      const out = app.querySelector(`#out-${CSS.escape(input.name)}`);
      if (out) out.textContent = Number(input.value).toFixed(2);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Profile mutation helpers                                            */
/* ------------------------------------------------------------------ */

function updateProfile(mutator: (profile: UserProfile) => UserProfile, options: { rerender?: boolean; save?: boolean } = {}): void {
  const next = mutator(state.profile);
  state.profile = next;
  state.store.set(next);
  if (options.rerender !== false) render();
  if (options.save !== false) scheduleSave();
}

function updateSaveIndicator(): void {
  const el = app.querySelector<HTMLElement>('#topbar-save-status');
  if (!el) return;
  const saved =
    state.saveState === 'saving'
      ? html`<span class="ff-meta">Saving…</span>`
      : state.saveState === 'saved'
        ? html`<span class="saved-flag"><span data-icon="check" data-size="13"></span> Saved</span>`
        : state.saveState === 'error'
          ? html`<span class="ff-error-text">Could not save</span>`
          : '';
  el.innerHTML = typeof saved === 'string' ? saved : saved.__html;
  hydrate(el);
}

function updateCompletenessIndicator(): void {
  const completion = profileCompletion(state.profile);
  const meter = app.querySelector<HTMLElement>('.completeness i');
  const label = app.querySelector<HTMLElement>('.side-foot .ff-row-between .ff-meta');
  if (meter) meter.style.width = `${completion}%`;
  if (label) label.textContent = `${completion}%`;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  state.saveState = 'saving';
  updateSaveIndicator();
  saveTimer = setTimeout(() => void saveNow(), 700);
}

async function saveNow(): Promise<void> {
  try {
    state.saveState = 'saving';
    updateSaveIndicator();
    state.profile = await state.store.save();
    state.saveState = 'saved';
    updateSaveIndicator();
    updateCompletenessIndicator();
    window.setTimeout(() => {
      if (state.saveState === 'saved') {
        state.saveState = 'idle';
        updateSaveIndicator();
      }
    }, 1600);
  } catch {
    state.saveState = 'error';
    updateSaveIndicator();
  }
}

let resumeTimer: ReturnType<typeof setTimeout> | null = null;

function activeResume() {
  return state.resumes.resumes.find((r) => r.id === state.activeResumeId);
}

/** Resumes autosave on their own debounce, separate from the profile store. */
function scheduleResumeSave(immediate = false): void {
  if (resumeTimer) clearTimeout(resumeTimer);
  state.saveState = 'saving';
  updateSaveIndicator();
  const save = async () => {
    try {
      state.resumes = await sendMessage<ResumesState>({ type: 'fillie:save-resumes', state: state.resumes });
      state.saveState = 'saved';
    } catch {
      state.saveState = 'error';
    }
    updateSaveIndicator();
  };
  if (immediate) void save();
  else resumeTimer = setTimeout(save, 700);
}

async function refreshResumes(): Promise<void> {
  try {
    state.resumes = (await sendMessage<ResumesState>({ type: 'fillie:get-resumes' })) ?? { resumes: [], defaultId: '' };
  } catch {
    state.resumes = { resumes: [], defaultId: '' };
  }
  if (!state.resumes.resumes.some((r) => r.id === state.activeResumeId)) {
    state.activeResumeId = state.resumes.defaultId || state.resumes.resumes[0]?.id || '';
  }
}

function addResume(name: string, text: string): void {
  const id = newId('resume');
  state.resumes = {
    resumes: [...state.resumes.resumes, { id, name, text, updatedAt: Date.now() }],
    defaultId: state.resumes.defaultId || id,
  };
  state.activeResumeId = id;
  scheduleResumeSave(true);
  render();
}

async function handleResumeFile(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  let text = '';
  if (file.type === 'text/plain' || /\.txt$/i.test(file.name)) {
    text = await file.text();
  } else {
    const extracted = await extractResume(file);
    text = extracted.text;
    if (!text.trim()) {
      toast(extracted.warnings[0] ?? 'Could not read that file.', 'danger');
      return;
    }
  }
  const active = activeResume();
  if (active) {
    active.text = text;
    active.updatedAt = Date.now();
    scheduleResumeSave(true);
    render();
  } else {
    addResume(file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Resume', text);
  }
  toast('Resume loaded');
}

function toast(message: string, tone: 'default' | 'danger' = 'default'): void {
  const node = document.createElement('div');
  node.className = 'toast';
  node.setAttribute('data-tone', tone);
  node.replaceChildren(icon(tone === 'danger' ? 'alert' : 'check', { size: 14 }), document.createTextNode(message));
  toastHost.appendChild(node);
  window.setTimeout(() => {
    node.style.transition = 'opacity 200ms ease, transform 200ms ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    window.setTimeout(() => node.remove(), 240);
  }, 2600);
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

/**
 * Settings controls are named `config.<key>` or with one of the top-level
 * settings keys. Profile fields are everything else. The two are told apart by
 * name rather than by element type, so a `<select>` bound to `personal.gender`
 * and one bound to `config.provider` both behave correctly.
 */
const TOP_LEVEL_SETTINGS = new Set([
  'enabled',
  'batchSize',
  'maxRetries',
  'autoFillThreshold',
  'reviewThreshold',
  'debug',
]);

function isSettingsBinding(name: string): boolean {
  return (
    name.startsWith('config.') ||
    name.startsWith('key.') ||
    name.startsWith('model.') ||
    name.startsWith('baseUrl.') ||
    TOP_LEVEL_SETTINGS.has(name)
  );
}

function renderTagInputContainer(container: HTMLElement, values: string[]): void {
  const input = container.querySelector<HTMLInputElement>('input[data-list-input]');
  container.querySelectorAll('.tag').forEach((node) => node.remove());

  values.forEach((value, index) => {
    const span = document.createElement('span');
    span.className = 'tag';
    span.appendChild(document.createTextNode(value));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-remove-tag', String(index));
    btn.setAttribute('aria-label', `Remove ${value}`);
    btn.appendChild(icon('close', { size: 11 }));

    span.appendChild(btn);
    if (input) {
      container.insertBefore(span, input);
    } else {
      container.appendChild(span);
    }
  });
}

function addTagFromInput(input: HTMLInputElement): void {
  const raw = input.value;
  if (!raw.trim()) return;
  const name = input.dataset.listInput!;
  const container = input.closest<HTMLElement>('.tag-input');
  const repeaterItem = input.closest<HTMLElement>('.repeater-item');
  const repeaterContext = repeaterItem
    ? {
        repeater: repeaterItem.closest<HTMLElement>('[data-repeater]')?.dataset.repeater ?? '',
        index: Number(repeaterItem.dataset.index),
      }
    : undefined;

  const newValues = raw
    .split(/[,;\n]/)
    .map((v) => v.trim())
    .filter(Boolean);

  if (!newValues.length) {
    input.value = '';
    return;
  }

  const updated = updateListField(
    name,
    (current) => {
      const lower = new Set(current.map((c) => c.toLowerCase()));
      const toAdd = newValues.filter((v) => !lower.has(v.toLowerCase()));
      return [...current, ...toAdd];
    },
    false,
    repeaterContext,
  );

  input.value = '';
  if (container) {
    renderTagInputContainer(container, updated);
  }
}

app.addEventListener('input', (event) => {
  const target = event.target as HTMLElement;

  if (target instanceof HTMLInputElement && target.hasAttribute('data-list-input')) {
    if (target.value.includes(',')) {
      addTagFromInput(target);
    }
    return;
  }

  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.id === 'db-search') {
    state.db.search = (target as HTMLInputElement).value;
    if (dbSearchTimer) clearTimeout(dbSearchTimer);
    dbSearchTimer = setTimeout(async () => {
      await loadApps(true);
      const next = app.querySelector<HTMLInputElement>('#db-search');
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    }, 300);
    return;
  }
  if (target.id === 'resume-text' || target.id === 'resume-name') {
    const active = activeResume();
    if (!active) return;
    if (target.id === 'resume-text') {
      active.text = target.value;
      const count = app.querySelector('#resume-count');
      if (count) count.textContent = `${target.value.length.toLocaleString()} characters`;
    } else {
      active.name = target.value;
      const label = app.querySelector(`[data-resume-tab-name="${active.id}"]`);
      if (label) label.textContent = target.value || 'Untitled';
    }
    active.updatedAt = Date.now();
    scheduleResumeSave();
    return;
  }
  if (!target.hasAttribute('data-bind')) return;

  if (isSettingsBinding(target.name)) {
    // Settings save as the user types or drags. Re-rendering on every keystroke
    // would move the caret and fight a slider drag, so this path never
    // re-renders; the view re-reads on the next explicit action.
    applySettingsBinding(target, { rerender: false });
    return;
  }

  const repeaterItem = target.closest<HTMLElement>('.repeater-item');
  if (repeaterItem) {
    const index = Number(repeaterItem.dataset.index);
    const repeater = repeaterItem.closest<HTMLElement>('[data-repeater]')?.dataset.repeater;
    if (repeater && !Number.isNaN(index)) {
      updateRepeaterItem(repeater, index, target.name, target.value);
      return;
    }
  }

  if (target.name.includes('.')) {
    updateProfile((profile) => {
      let next = setPath(profile, target.name, target.value);

      // Smart sync for names
      if (target.name === 'personal.firstName' || target.name === 'personal.lastName') {
        const first = (target.name === 'personal.firstName' ? target.value : next.personal.firstName) ?? '';
        const last = (target.name === 'personal.lastName' ? target.value : next.personal.lastName) ?? '';
        const combinedName = [first.trim(), last.trim()].filter(Boolean).join(' ');
        if (combinedName && (!next.personal.fullName || next.personal.fullName === profile.personal.fullName)) {
          next = setPath(next, 'personal.fullName', combinedName);
          const fullInput = app.querySelector<HTMLInputElement>('input[name="personal.fullName"]');
          if (fullInput && document.activeElement !== fullInput) fullInput.value = combinedName;
        }
      } else if (target.name === 'personal.fullName') {
        if (!next.personal.firstName && !next.personal.lastName) {
          const parts = target.value.trim().split(/\s+/);
          const first = parts[0] ?? '';
          const last = parts.slice(1).join(' ');
          if (first) {
            next = setPath(next, 'personal.firstName', first);
            const firstInput = app.querySelector<HTMLInputElement>('input[name="personal.firstName"]');
            if (firstInput && document.activeElement !== firstInput) firstInput.value = first;
          }
          if (last) {
            next = setPath(next, 'personal.lastName', last);
            const lastInput = app.querySelector<HTMLInputElement>('input[name="personal.lastName"]');
            if (lastInput && document.activeElement !== lastInput) lastInput.value = last;
          }
        }
      }

      // Smart sync for phone numbers
      if (target.name === 'personal.phoneCountryCode' || target.name === 'personal.phoneNumber' || target.name === 'personal.phoneExtension') {
        const cc = (target.name === 'personal.phoneCountryCode' ? target.value : next.personal.phoneCountryCode) ?? '';
        const num = (target.name === 'personal.phoneNumber' ? target.value : next.personal.phoneNumber) ?? '';
        const ext = (target.name === 'personal.phoneExtension' ? target.value : next.personal.phoneExtension) ?? '';
        const combinedPhone = formatFullPhone(cc, num, ext);
        if (combinedPhone) {
          next = setPath(next, 'personal.phone', combinedPhone);
          const phoneInput = app.querySelector<HTMLInputElement>('input[name="personal.phone"]');
          if (phoneInput && document.activeElement !== phoneInput) phoneInput.value = combinedPhone;
        }
      } else if (target.name === 'personal.phone') {
        const { countryCode, number, extension } = parsePhoneNumberParts(target.value);
        if (countryCode && !next.personal.phoneCountryCode) {
          next = setPath(next, 'personal.phoneCountryCode', countryCode);
          const ccInput = app.querySelector<HTMLInputElement>('input[name="personal.phoneCountryCode"]');
          if (ccInput && document.activeElement !== ccInput) ccInput.value = countryCode;
        }
        if (number && !next.personal.phoneNumber) {
          next = setPath(next, 'personal.phoneNumber', number);
          const numInput = app.querySelector<HTMLInputElement>('input[name="personal.phoneNumber"]');
          if (numInput && document.activeElement !== numInput) numInput.value = number;
        }
        if (extension && !next.personal.phoneExtension) {
          next = setPath(next, 'personal.phoneExtension', extension);
          const extInput = app.querySelector<HTMLInputElement>('input[name="personal.phoneExtension"]');
          if (extInput && document.activeElement !== extInput) extInput.value = extension;
        }
      }

      return next;
    }, { rerender: false });
  }
});

app.addEventListener('change', (event) => {
  const target = event.target as HTMLElement;

  if (target instanceof HTMLInputElement && target.type === 'file') {
    if (target.id === 'resume-upload') void handleResumeFile(target);
    else void handleFileInput(target);
    return;
  }

  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (!target.hasAttribute('data-bind')) return;

  // Text fields are already committed on `input`; committing them again here
  // would re-render the form on blur, out from under the user. A `<select>` and
  // a switch only have a settled value at `change` time, and a select or switch
  // change is worth re-rendering because it changes the shape of the screen
  // (a new provider fills in new defaults, the offline banner appears).
  const isSelect = target instanceof HTMLSelectElement;
  const isSwitch = target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio');
  if (!isSelect && !isSwitch) return;

  if (isSettingsBinding(target.name)) {
    applySettingsBinding(target);
    return;
  }

  const repeaterItem = target.closest<HTMLElement>('.repeater-item');
  if (repeaterItem) {
    const index = Number(repeaterItem.dataset.index);
    const repeater = repeaterItem.closest<HTMLElement>('[data-repeater]')?.dataset.repeater;
    if (repeater && !Number.isNaN(index)) {
      updateRepeaterItem(repeater, index, target.name, target.value);
      return;
    }
  }

  if (target.name.includes('.')) {
    updateProfile((profile) => setPath(profile, target.name, target.value));
  }
});

app.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (target instanceof HTMLInputElement && target.hasAttribute('data-list-input')) {
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (target.value.trim()) {
        event.preventDefault();
        addTagFromInput(target);
      }
    } else if (event.key === 'Backspace' && target.value === '') {
      const container = target.closest<HTMLElement>('.tag-input');
      const name = target.dataset.listInput!;
      const repeaterItem = target.closest<HTMLElement>('.repeater-item');
      const repeaterContext = repeaterItem
        ? {
            repeater: repeaterItem.closest<HTMLElement>('[data-repeater]')?.dataset.repeater ?? '',
            index: Number(repeaterItem.dataset.index),
          }
        : undefined;
      const updated = updateListField(name, (current) => current.slice(0, -1), false, repeaterContext);
      if (container) {
        renderTagInputContainer(container, updated);
      }
    }
  }
});

app.addEventListener('focusout', (event) => {
  const target = event.target as HTMLElement;
  if (target instanceof HTMLInputElement && target.hasAttribute('data-list-input')) {
    if (target.value.trim()) {
      addTagFromInput(target);
    }
  }
});

app.addEventListener('click', async (event) => {
  const rawTarget = event.target as HTMLElement;
  const tagContainer = rawTarget.closest<HTMLElement>('.tag-input');
  if (tagContainer && !rawTarget.closest('button')) {
    tagContainer.querySelector<HTMLInputElement>('input[data-list-input]')?.focus();
  }

  const target = rawTarget.closest<HTMLElement>('[data-action], [data-nav], [data-remove-tag]');
  if (!target) return;

  if (target.hasAttribute('data-nav')) {
    navigate(target.getAttribute('data-nav')!);
    return;
  }

  if (target.hasAttribute('data-remove-tag')) {
    const container = target.closest<HTMLElement>('.tag-input');
    const listName = container?.dataset.list;
    const index = Number(target.getAttribute('data-remove-tag'));
    const repeaterItem = target.closest<HTMLElement>('.repeater-item');
    const repeaterContext = repeaterItem
      ? {
          repeater: repeaterItem.closest<HTMLElement>('[data-repeater]')?.dataset.repeater ?? '',
          index: Number(repeaterItem.dataset.index),
        }
      : undefined;
    if (listName) {
      const updated = updateListField(listName, (current) => current.filter((_, i) => i !== index), false, repeaterContext);
      if (container) {
        renderTagInputContainer(container, updated);
      }
    }
    return;
  }

  const action = target.getAttribute('data-action');
  if (!action) return;

  switch (action) {
    case 'save-now':
      await saveNow();
      toast('Profile saved');
      return;

    case 'derive-location': {
      const address = state.profile.personal.address.trim();
      if (!address) return toast('Add an address first', 'danger');
      const guess = address.split(',').slice(-2).map((part) => part.trim()).filter(Boolean).join(', ');
      updateProfile((profile) => ({ ...profile, personal: { ...profile.personal, city: guess } }));
      return;
    }

    case 'add-school':
      updateProfile((profile) => ({
        ...profile,
        education: {
          ...profile.education,
          schools: [...(profile.education.schools ?? []), makeSchool()],
        },
      }));
      return;
    case 'remove-school': {
      const index = Number(target.getAttribute('data-index'));
      updateProfile((profile) => ({
        ...profile,
        education: {
          ...profile.education,
          schools: (profile.education.schools ?? []).filter((_, i) => i !== index),
        },
      }));
      return;
    }
    case 'duplicate-school': {
      const index = Number(target.getAttribute('data-index'));
      updateProfile((profile) => {
        const schools = profile.education.schools ?? [];
        const source = schools[index];
        if (!source) return profile;
        return {
          ...profile,
          education: {
            ...profile.education,
            schools: [...schools, { ...source, id: newId('sch') }],
          },
        };
      });
      return;
    }

    case 'add-experience':
      updateProfile((profile) => ({ ...profile, experience: [...profile.experience, makeExperience()] }));
      return;
    case 'remove-experience': {
      const index = Number(target.getAttribute('data-index'));
      updateProfile((profile) => ({ ...profile, experience: profile.experience.filter((_, i) => i !== index) }));
      return;
    }
    case 'duplicate-experience': {
      const index = Number(target.getAttribute('data-index'));
      updateProfile((profile) => {
        const source = profile.experience[index];
        if (!source) return profile;
        return { ...profile, experience: [...profile.experience, { ...source, id: newId('exp'), responsibilities: [...source.responsibilities], achievements: [...source.achievements] }] };
      });
      return;
    }

    case 'add-project':
      updateProfile((profile) => ({ ...profile, projects: [...profile.projects, makeProject()] }));
      return;
    case 'remove-project': {
      const index = Number(target.getAttribute('data-index'));
      updateProfile((profile) => ({ ...profile, projects: profile.projects.filter((_, i) => i !== index) }));
      return;
    }
    case 'duplicate-project': {
      const index = Number(target.getAttribute('data-index'));
      updateProfile((profile) => {
        const source = profile.projects[index];
        if (!source) return profile;
        return { ...profile, projects: [...profile.projects, { ...source, id: newId('proj'), technologies: [...source.technologies] }] };
      });
      return;
    }

    case 'add-achievement':
      updateProfile((profile) => ({ ...profile, achievements: [...profile.achievements, makeAchievement()] }));
      return;
    case 'remove-achievement': {
      const index = Number(target.getAttribute('data-index'));
      updateProfile((profile) => ({ ...profile, achievements: profile.achievements.filter((_, i) => i !== index) }));
      return;
    }
    case 'upload-document-btn': {
      const fileInput = app.querySelector<HTMLInputElement>('#doc-upload-file');
      if (!fileInput?.files?.[0]) {
        fileInput?.click();
        return;
      }
      void handleFileInput(fileInput);
      return;
    }
    case 'set-default-document': {
      const id = target.getAttribute('data-id');
      updateProfile((profile) => ({
        ...profile,
        documents: (profile.documents ?? []).map((d) => ({
          ...d,
          isDefault: d.id === id,
        })),
      }), { rerender: true });
      toast('Default document updated');
      return;
    }
    case 'download-document': {
      const id = target.getAttribute('data-id');
      const doc = (state.profile.documents ?? []).find((d) => d.id === id);
      if (!doc || !doc.dataUrl) return toast('Document content not available', 'danger');
      const anchor = document.createElement('a');
      anchor.href = doc.dataUrl;
      anchor.download = doc.fileName || `${doc.name}.pdf`;
      anchor.click();
      return;
    }
    case 'remove-document': {
      const id = target.getAttribute('data-id');
      if (!confirm('Delete this document?')) return;
      updateProfile((profile) => ({
        ...profile,
        documents: (profile.documents ?? []).filter((d) => d.id !== id),
      }), { rerender: true });
      toast('Document removed');
      return;
    }

    case 'import-resume':
      navigate('#/settings/profile');
      window.setTimeout(() => app.querySelector<HTMLInputElement>('#resume-file')?.click(), 60);
      return;

    case 'apply-import': {
      if (!state.pendingSuggestions) return;
      updateProfile((profile) => mergeSuggestions(profile, state.pendingSuggestions!), { rerender: true });
      state.pendingSuggestions = undefined;
      state.importedFile = undefined;
      navigate('#/profile/personal');
      toast('Imported values merged into your profile');
      return;
    }

    case 'discard-import':
      state.pendingSuggestions = undefined;
      state.importedFile = undefined;
      state.importWarnings = [];
      render();
      return;

    case 'add-app':
      state.editingApp = { app: newApplication({ company: '', role: '' }), isNew: true };
      render();
      app.querySelector<HTMLInputElement>('#af-company')?.focus();
      return;
    case 'edit-app': {
      const found = state.db.rows.find((row) => row.id === target.getAttribute('data-id'));
      if (found) {
        state.editingApp = { app: found, isNew: false };
        render();
      }
      return;
    }
    case 'close-editor':
      // A click inside the dialog bubbles here too; only the backdrop or Cancel closes it.
      if (target.classList.contains('modal-backdrop') && rawTarget.closest('.modal')) return;
      state.editingApp = undefined;
      render();
      return;
    case 'clear-rating': {
      app.querySelectorAll<HTMLInputElement>('#app-form input[name="rating"]').forEach((input) => (input.checked = false));
      syncEditor();
      return;
    }
    case 'delete-app': {
      const id = target.getAttribute('data-id') ?? '';
      if (!confirm('Delete this application?')) return;
      dbMutations += 1;
      await sendMessage({ type: 'fillie:apps-delete', id });
      state.db.rows = state.db.rows.filter((row) => row.id !== id);
      render();
      return;
    }
    case 'rate-app': {
      const id = target.getAttribute('data-id') ?? '';
      const value = Number(target.getAttribute('data-value'));
      const row = state.db.rows.find((entry) => entry.id === id);
      if (!row) return;
      // Tapping the current rating clears it; the user always has the last word.
      const rating = row.rating === value ? null : value;
      dbMutations += 1;
      const saved = await sendMessage<Application>({
        type: 'fillie:apps-save',
        app: { ...row, rating, ratingSource: rating ? 'user' : null },
      });
      state.db.rows = state.db.rows.map((entry) => (entry.id === id ? saved : entry));
      render();
      return;
    }
    case 'toggle-share-offers': {
      const value = (target as HTMLInputElement).checked;
      const result = await sendMessage<{ ok: boolean; error?: string }>({ type: 'fillie:set-share-offers', value });
      if (!result.ok) toast(result.error ?? 'Could not save.', 'danger');
      await loadAccount();
      return;
    }
    case 'feedback-star': {
      state.account.feedbackRating = Number(target.getAttribute('data-value'));
      render();
      app.querySelector<HTMLTextAreaElement>('#fb-message')?.focus();
      return;
    }
    case 'send-feedback': {
      const message = app.querySelector<HTMLTextAreaElement>('#fb-message')?.value ?? '';
      const kind = (app.querySelector<HTMLSelectElement>('#fb-kind')?.value as 'review' | 'bug' | 'idea') ?? 'review';
      const result = await sendMessage<{ ok: boolean; error?: string }>({ type: 'fillie:feedback', rating: state.account.feedbackRating || null, kind, message });
      if (result.ok) {
        state.account.feedbackRating = 0;
        toast('Thank you for the feedback!');
        render();
      } else toast(result.error ?? 'Could not send.', 'danger');
      return;
    }
    case 'filter-status':
      state.db.status = (target.getAttribute('data-status') as ApplicationStatus | 'all') ?? 'all';
      void loadApps(true);
      return;
    case 'load-more':
      void loadApps(false);
      return;
    case 'toggle-auth':
      state.account.mode = state.account.mode === 'signin' ? 'signup' : 'signin';
      render();
      return;
    case 'oauth':
      await runAuth('oauth', () => sendMessage({ type: 'fillie:sign-in-oauth', provider: target.getAttribute('data-provider') as OAuthProvider }));
      return;
    case 'sign-out':
      await sendMessage({ type: 'fillie:sign-out' });
      state.account.status = null;
      state.db = { ...state.db, rows: [], loaded: false, signedIn: false };
      await loadAccount();
      return;
    case 'checkout': {
      const provider = (target.getAttribute('data-provider') as 'stripe' | 'razorpay') ?? 'stripe';
      const result = await sendMessage<{ ok: boolean; error?: string }>({ type: 'fillie:checkout', provider });
      if (!result.ok) toast(result.error ?? 'Could not start checkout.', 'danger');
      return;
    }
    case 'refresh-payment':
      state.account.status = await sendMessage<AccountStatus>({ type: 'fillie:refresh-payment', device: await computeHashes() });
      render();
      toast(state.account.status.access.plan === 'paid' ? 'Payment confirmed. Fillie is unlocked!' : 'No payment found yet. It can take a minute.');
      return;
    case 'backup-now': {
      const result = await sendMessage<{ ok: boolean; reason?: string }>({ type: 'fillie:backup-now' });
      toast(result.ok ? 'Backed up' : (result.reason ?? 'Backup failed'), result.ok ? 'default' : 'danger');
      await loadAccount();
      return;
    }
    case 'restore-now': {
      if (!confirm('Replace the data on this device with your last backup?')) return;
      const result = await sendMessage<{ ok: boolean; reason?: string }>({ type: 'fillie:restore-now' });
      if (result.ok) {
        state.profile = await loadProfile();
        state.store.set(state.profile);
        await Promise.all([refreshMemory(), refreshResumes(), refreshSettings()]);
        render();
      }
      toast(result.ok ? 'Restored from backup' : (result.reason ?? 'Could not restore'), result.ok ? 'default' : 'danger');
      return;
    }
    case 'select-resume':
      state.activeResumeId = target.getAttribute('data-id') ?? '';
      render();
      return;
    case 'new-resume':
      addResume(`Resume ${state.resumes.resumes.length + 1}`, '');
      return;
    case 'default-resume':
      state.resumes = { ...state.resumes, defaultId: target.getAttribute('data-id') ?? '' };
      scheduleResumeSave(true);
      render();
      return;
    case 'delete-resume': {
      const id = target.getAttribute('data-id') ?? '';
      if (!confirm('Delete this resume? This cannot be undone.')) return;
      state.resumes = { ...state.resumes, resumes: state.resumes.resumes.filter((r) => r.id !== id) };
      state.activeResumeId = state.resumes.resumes[0]?.id ?? '';
      scheduleResumeSave(true);
      render();
      return;
    }
    case 'edit-memory': {
      const id = target.getAttribute('data-id')!;
      state.editingMemory = state.memory.find((entry) => entry.id === id);
      render();
      return;
    }
    case 'cancel-memory-edit':
      state.editingMemory = undefined;
      render();
      return;
    case 'save-memory': {
      const id = target.getAttribute('data-id')!;
      const answer = app.querySelector<HTMLTextAreaElement>('#memory-answer')?.value ?? '';
      const generic = app.querySelector<HTMLInputElement>('#memory-generic')?.checked ?? true;
      if (!answer.trim()) return toast('That answer is empty', 'danger');
      await sendMessage({ type: 'fillie:save-memory', memory: updateLearnedAnswer(state.memory, id, { answer, context: { ...(state.memory.find((e) => e.id === id)?.context ?? { isGeneric: true }), isGeneric: generic } }) });
      await refreshMemory();
      state.editingMemory = undefined;
      render();
      toast('Answer updated');
      return;
    }
    case 'delete-memory': {
      const id = target.getAttribute('data-id')!;
      if (!confirm('Delete this learned answer?')) return;
      await sendMessage({ type: 'fillie:save-memory', memory: deleteLearnedAnswer(state.memory, id) });
      await refreshMemory();
      render();
      toast('Answer deleted');
      return;
    }
    case 'clear-memory': {
      if (!confirm('Delete every learned answer? Your profile stays intact.')) return;
      await sendMessage({ type: 'fillie:save-memory', memory: [] });
      await refreshMemory();
      render();
      toast('Learned answers cleared');
      return;
    }
    case 'goto-memory':
      navigate('#/memory');
      return;
    case 'clear-cache':
      await sendMessage({ type: 'fillie:clear-cache' });
      state.diagnostics.cacheHits = 0;
      render();
      toast('Cached answers cleared');
      return;

    case 'set-theme': {
      const theme = target.getAttribute('data-theme') as AppState['theme'];
      state.theme = theme;
      localStorage.setItem('fillie:theme', theme);
      try {
        void chrome.storage?.local?.set?.({ 'fillie:theme': theme });
      } catch {
        // In environments without chrome.storage
      }
      setTheme(theme);
      render();
      return;
    }

    case 'move-provider': {
      const id = target.getAttribute('data-id') as AIProviderId;
      const dir = Number(target.getAttribute('data-dir'));
      updateSettings((settings) => {
        const order = [...settings.providerOrder];
        const from = order.indexOf(id);
        const to = from + dir;
        if (from < 0 || to < 0 || to >= order.length) return settings;
        [order[from], order[to]] = [order[to], order[from]];
        return { ...settings, providerOrder: order };
      });
      return;
    }

    case 'test-provider': {
      const id = target.getAttribute('data-id') as AIProviderId;
      state.connections[id] = { testing: true };
      render();
      try {
        const settings = state.settings;
        const preset = getPreset(id);
        const result = await sendMessage<{ ok: boolean; message: string }>({
          type: 'fillie:test-connection',
          config: {
            ...settings.config,
            provider: id,
            apiKey: settings.config.apiKeys?.[id] ?? '',
            model: settings.providerModels[id] || preset.defaultModel,
            baseUrl: settings.providerBaseUrls[id] || preset.defaultBaseUrl,
          },
        });
        state.connections[id] = { ok: result.ok, message: result.message };
      } catch (error) {
        state.connections[id] = { ok: false, message: error instanceof Error ? error.message : 'Failed' };
      }
      render();
      return;
    }

    case 'reset-ai':
      updateSettings(() => mergeSettings(structuredClone(DEFAULT_SETTINGS)));
      toast('AI settings reset');
      return;

    case 'export-data': {
      // The API key is deliberately left out: a backup is a file the user may
      // email or commit, and a secret should never travel inside one.
      const settings = structuredClone(state.settings);
      settings.config.apiKey = '';
      if (settings.config.apiKeys) settings.config.apiKeys = {};
      const payload = {
        profile: state.profile,
        memory: state.memory,
        settings,
        note: 'Your API key is not included. Re-enter it in Settings after importing.',
        exportedAt: new Date().toISOString(),
      };
      downloadJson('fillie-backup.json', payload);
      toast('Export downloaded');
      return;
    }

    case 'erase-all': {
      if (!confirm('This erases your profile, learned answers and settings from this browser. Continue?')) return;
      if (!confirm('Last chance — this cannot be undone.')) return;
      await sendMessage({ type: 'fillie:save-memory', memory: [] });
      state.resumes = await sendMessage<ResumesState>({ type: 'fillie:save-resumes', state: { resumes: [], defaultId: '' } });
      state.activeResumeId = '';
      await sendMessage({ type: 'fillie:save-profile', profile: emptyProfile() });
      await sendMessage({ type: 'fillie:clear-cache' });
      state.diagnostics.cacheHits = 0;
      state.profile = emptyProfile();
      state.store.set(state.profile);
      await refreshMemory();
      await refreshSettings();
      render();
      toast('All Fillie data erased');
      return;
    }

    default:
      return;
  }
});

/* ------------------------------------------------------------------ */
/* Helpers used by the event layer                                     */
/* ------------------------------------------------------------------ */

function emptyProfile(): UserProfile {
  return createEmptyProfile();
}

function updateRepeaterItem(repeater: string, index: number, field: string, value: string): void {
  updateProfile(
    (profile) => {
      const next = structuredClone(profile);
      let targetList: Record<string, unknown>[];
      if (repeater === 'experience') targetList = next.experience as unknown as Record<string, unknown>[];
      else if (repeater === 'projects') targetList = next.projects as unknown as Record<string, unknown>[];
      else if (repeater === 'achievements') targetList = next.achievements as unknown as Record<string, unknown>[];
      else if (repeater === 'schools') {
        if (!Array.isArray(next.education.schools)) next.education.schools = [];
        targetList = next.education.schools as unknown as Record<string, unknown>[];
      } else if (repeater === 'documents') {
        if (!Array.isArray(next.documents)) next.documents = [];
        targetList = next.documents as unknown as Record<string, unknown>[];
      } else {
        return profile;
      }

      if (!targetList[index]) return profile;

      if (repeater === 'experience' && (field === 'responsibilities' || field === 'achievements')) {
        targetList[index][field] = value
          .split('\n')
          .map((line) => line.replace(/^[\s•*-]+/, '').trim())
          .filter(Boolean);
      } else if (repeater === 'documents' && field === 'keywords') {
        targetList[index][field] = value
          .split(/[,;\n]/)
          .map((k) => k.trim().toLowerCase())
          .filter(Boolean);
      } else {
        targetList[index][field] = value;
      }

      return next;
    },
    { rerender: false },
  );

  const repeaterItem = app.querySelector(`.repeater[data-repeater="${repeater}"] .repeater-item[data-index="${index}"]`);
  if (repeaterItem) {
    const title = repeaterItem.querySelector<HTMLElement>('.repeater-head strong');
    if (title) {
      if (repeater === 'experience') {
        const role = (repeaterItem.querySelector<HTMLInputElement>('input[name="role"]')?.value ?? '').trim();
        const org = (repeaterItem.querySelector<HTMLInputElement>('input[name="organisation"]')?.value ?? '').trim();
        title.textContent = `${role || 'New role'} — ${org || 'Organisation'}`;
      } else if (repeater === 'projects') {
        const name = (repeaterItem.querySelector<HTMLInputElement>('input[name="name"]')?.value ?? '').trim();
        title.textContent = name || 'New project';
      } else if (repeater === 'schools') {
        const schoolName = (repeaterItem.querySelector<HTMLInputElement>('input[name="schoolName"]')?.value ?? '').trim();
        const level = (repeaterItem.querySelector<HTMLInputElement>('input[name="level"]')?.value ?? '').trim();
        title.textContent = `${level ? `${level}: ` : ''}${schoolName || 'School / Institution'}`;
      } else if (repeater === 'documents') {
        const name = (repeaterItem.querySelector<HTMLInputElement>('input[name="name"]')?.value ?? '').trim();
        title.textContent = name || 'Document';
      }
    }
  }
}

function updateListField(
  path: string,
  mutate: (current: string[]) => string[],
  rerender = true,
  repeaterContext?: { repeater: string; index: number },
): string[] {
  let updatedValues: string[] = [];
  updateProfile(
    (profile) => {
      if (repeaterContext) {
        const next = structuredClone(profile);
        let list: Record<string, unknown>[] | undefined;
        if (repeaterContext.repeater === 'documents') {
          list = next.documents as unknown as Record<string, unknown>[];
        } else if (repeaterContext.repeater === 'schools') {
          list = next.education.schools as unknown as Record<string, unknown>[];
        } else {
          list = (next as unknown as Record<string, Record<string, unknown>[]>)[repeaterContext.repeater];
        }
        if (list && list[repeaterContext.index]) {
          const item = list[repeaterContext.index];
          const current = (item[path] as string[] | undefined) ?? [];
          updatedValues = mutate(current).filter((value) => value.trim().length > 0);
          item[path] = updatedValues;
        }
        return next;
      }
      const current = (getPath(profile, path) as string[] | undefined) ?? [];
      updatedValues = mutate(current).filter((value) => value.trim().length > 0);
      return setPath(profile, path, updatedValues);
    },
    { rerender },
  );
  return updatedValues;
}

/**
 * Commits a settings control. `rerender: false` is used while a slider or number
 * field is being dragged, so the control the user is holding stays in the DOM.
 */
function applySettingsBinding(
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  options: { rerender?: boolean } = {},
): void {
  const name = input.name;
  const isCheckbox = input instanceof HTMLInputElement && input.type === 'checkbox';
  const isText =
    input instanceof HTMLTextAreaElement ||
    (input instanceof HTMLInputElement && ['text', 'password', 'url', 'email', 'search'].includes(input.type));
  const raw = isCheckbox ? input.checked : input.value;
  // Numeric settings stay numbers; everything else keeps its natural type. A
  // `data-scale` converts a value the UI shows in friendlier units (seconds)
  // back to the unit it is stored in (milliseconds).
  const scale = input instanceof HTMLInputElement ? Number(input.dataset.scale ?? 1) || 1 : 1;
  const value = isCheckbox ? Boolean(raw) : isText ? String(raw) : Number(raw) * scale;

  updateSettings((settings) => {
    const next = structuredClone(settings) as unknown as Record<string, unknown> & {
      config: Record<string, unknown>;
    };

    // Per-platform fields: key.<id>, model.<id>, baseUrl.<id>.
    const perProvider = /^(key|model|baseUrl)\.(.+)$/.exec(name);
    if (perProvider && typeof value === 'string') {
      const [, field, id] = perProvider;
      const providerId = id as AIProviderId;
      if (field === 'key') {
        const apiKeys = { ...((next.config.apiKeys as Record<string, string>) ?? {}) };
        apiKeys[providerId] = value.trim().replace(/^["']|["']$/g, '').trim();
        next.config.apiKeys = apiKeys;
        // Typing does not re-render, so the row's Test button and badge are updated in place.
        const row = app.querySelector<HTMLElement>(`.provider-row[data-provider="${providerId}"]`);
        if (row) {
          const hasKey = Boolean(apiKeys[providerId]);
          row.setAttribute('data-ready', String(hasKey));
          row.querySelector<HTMLButtonElement>('[data-action="test-provider"]')?.toggleAttribute('disabled', !hasKey);
          const chip = row.querySelector('.provider-head .ff-chip');
          if (chip) {
            chip.textContent = hasKey ? 'Key added' : 'No key';
            chip.classList.toggle('ff-chip-accent', hasKey);
          }
        }
      } else if (field === 'model') {
        next.providerModels = { ...(next.providerModels as object), [providerId]: value.trim() };
      } else {
        next.providerBaseUrls = { ...(next.providerBaseUrls as object), [providerId]: value.trim() };
      }
      return next as unknown as AISettings;
    }

    if (name.startsWith('config.')) {
      // Switching provider also swaps in that provider's free-tier defaults, so
      // the user never has to know a model id or base URL by heart.
      if (name === 'config.provider' && typeof raw === 'string') {
        next.config = applyPresetDefaults(next.config as unknown as AIProviderConfig, raw as AIProviderId) as unknown as Record<string, unknown>;
        return next as unknown as AISettings;
      }
      if (name === 'config.apiKey' && typeof value === 'string') {
        const cleanKey = value.trim().replace(/^["']|["']$/g, '').trim();
        next.config.apiKey = cleanKey;
        const apiKeys = { ...((next.config.apiKeys as Record<string, string>) ?? {}) };
        apiKeys[next.config.provider as string] = cleanKey;
        next.config.apiKeys = apiKeys;
        return next as unknown as AISettings;
      }
      next.config[name.slice('config.'.length)] = value;
      return next as unknown as AISettings;
    }

    next[name] = value;
    return next as unknown as AISettings;
  }, options);
}

function updateSettings(mutator: (settings: AISettings) => AISettings, options: { rerender?: boolean } = {}): void {
  state.settings = mergeSettings(mutator(state.settings));
  if (options.rerender !== false) render();
  void sendMessage({ type: 'fillie:save-settings', settings: state.settings }).catch(() => {
    state.diagnostics.lastErrors = ['Could not save settings.'];
  });
}

async function handleFileInput(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;

  if (input.id === 'doc-upload-file') {
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      const titleInput = app.querySelector<HTMLInputElement>('#doc-upload-name');
      const categorySelect = app.querySelector<HTMLSelectElement>('#doc-upload-category');
      const keywordsInput = app.querySelector<HTMLInputElement>('#doc-upload-keywords');

      const fileName = file.name;
      const baseName = fileName.replace(/\.[^/.]+$/, '');
      const name = titleInput?.value.trim() || baseName;
      const category = (categorySelect?.value as DocumentItem['category']) || 'resume';
      const rawKeywords = keywordsInput?.value || '';
      const parsedKeywords = rawKeywords
        .split(/[,;\n]/)
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);

      if (!parsedKeywords.includes(category)) parsedKeywords.push(category);
      if (category === 'resume' && !parsedKeywords.includes('cv')) parsedKeywords.push('cv');

      let textContent: string | undefined;
      try {
        if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
          textContent = await file.text();
        } else if (file.name.endsWith('.pdf') || file.name.endsWith('.docx')) {
          const extracted = await extractResume(file);
          textContent = extracted.text?.slice(0, 10000);
        }
      } catch {
        /* text extraction is optional */
      }

      const isFirst = (state.profile.documents ?? []).length === 0;
      const newDoc: DocumentItem = {
        id: newId('doc'),
        name,
        fileName,
        fileType: file.type || 'application/octet-stream',
        fileSize: file.size,
        category,
        keywords: parsedKeywords,
        dataUrl,
        textContent,
        isDefault: isFirst,
        updatedAt: Date.now(),
      };

      updateProfile(
        (profile) => ({
          ...profile,
          documents: [...(profile.documents ?? []), newDoc],
        }),
        { rerender: true },
      );
      toast(`Document “${name}” uploaded`);
    };
    reader.readAsDataURL(file);
    return;
  }

  if (input.id === 'import-data') {
    try {
      const payload = JSON.parse(await file.text());
      await sendMessage({ type: 'fillie:save-profile', profile: payload.profile ?? emptyProfile() });
      await sendMessage({ type: 'fillie:save-memory', memory: payload.memory ?? [] });
      if (payload.settings) {
        // An export never contains a key, so an empty one here means "leave the
        // key I already have" rather than "erase it".
        const incoming = mergeSettings(payload.settings);
        if (!incoming.config.apiKey.trim()) {
          incoming.config.apiKey = state.settings.config.apiKey;
        }
        await sendMessage({ type: 'fillie:save-settings', settings: incoming });
      }
      state.profile = await loadProfile();
      state.store.set(state.profile);
      await refreshMemory();
      await refreshSettings();
      render();
      toast('Backup imported');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Import failed', 'danger');
    }
    return;
  }

  const result = await extractResume(file);
  state.importedFile = result.fileName;
  state.importWarnings = result.warnings;
  state.pendingSuggestions = Object.keys(result.suggestions).length ? result.suggestions : undefined;
  // Warnings live in the import panel, so a file that could not be read has to
  // keep the user on that panel rather than navigating away from the message.
  if (!state.pendingSuggestions && state.importWarnings.length) {
    navigate('#/settings/profile');
    render();
    return;
  }
  if (result.matchedFields.length) {
    navigate('#/settings/profile');
  } else {
    navigate('#/profile/personal');
  }
  render();
}

function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* Import preview                                                      */
/* ------------------------------------------------------------------ */

/**
 * Fills the resume-import slot after every render. Called from `render()` so the
 * preview survives any navigation while an import is pending, rather than only
 * appearing once on boot.
 */
function renderImportPreview(): void {
  const host = app.querySelector('#import-result');
  if (!host) return;
  // Nothing was picked, or the user discarded it: leave the slot empty.
  if (!state.pendingSuggestions && !state.importWarnings.length) {
    host.replaceChildren();
    return;
  }

  // Warnings matter even with nothing to apply — an unreadable file has to say
  // so rather than appearing to have done nothing.
  const warnings = state.importWarnings.length
    ? banner({ tone: 'warning', title: 'Heads up', body: state.importWarnings.join(' ') })
    : '';

  if (!state.pendingSuggestions) {
    host.innerHTML = html`${warnings}`.__html;
    hydrate(host);
    return;
  }

  const rows: string[] = [];
  for (const [section, value] of Object.entries(state.pendingSuggestions)) {
    const summary = summariseSuggestion(section, value);
    if (summary) rows.push(summary);
  }
  host.innerHTML = html`
    ${warnings}
    <div class="stack-md">
      <div>
        <span class="ff-label">What was found</span>
        <ul class="ff-list" style="margin-top:6px">
          ${rows.map((row) => html`<li class="ff-list-item"><span class="ff-body">${escapeHtml(row)}</span></li>`)}
        </ul>
      </div>
      <div class="row-wrap">
        <button class="ff-btn ff-btn-primary" data-action="apply-import" type="button">
          <span data-icon="check" data-size="14"></span> Apply to my profile
        </button>
        <button class="ff-btn ff-btn-ghost" data-action="discard-import" type="button">Discard</button>
      </div>
    </div>
  `.__html;
  hydrate(host);
}

function summariseSuggestion(section: string, value: unknown): string {
  const record = value as Record<string, unknown>;
  const count = (input: unknown) => (Array.isArray(input) ? input.length : 0);
  switch (section) {
    case 'personal': {
      const bits = Object.entries(record)
        .filter(([, entry]) => typeof entry === 'string' && entry.trim())
        .map(([key, entry]) => `${key}: ${String(entry).slice(0, 40)}`);
      return bits.join(' · ');
    }
    case 'education':
      return ['degree', 'university', 'cgpa', 'percentage', 'graduationYear']
        .filter((key) => record[key])
        .map((key) => `${key}: ${String(record[key])}`)
        .join(' · ');
    case 'skills':
      return Object.entries(record)
        .map(([key, entry]) => `${key} (${count(entry)})`)
        .join(' · ');
    case 'experience':
      return `${count(value)} role${count(value) === 1 ? '' : 's'} found`;
    case 'projects':
      return `${count(value)} project${count(value) === 1 ? '' : 's'} found`;
    case 'achievements':
      return `${count(value)} achievement${count(value) === 1 ? '' : 's'} found`;
    case 'links':
      return Object.entries(record)
        .filter(([, entry]) => typeof entry === 'string' && entry.trim())
        .map(([key, entry]) => `${key}: ${String(entry).slice(0, 36)}`)
        .join(' · ');
    default:
      return section;
  }
}


/* ------------------------------------------------------------------ */
/* Database + account                                                  */
/* ------------------------------------------------------------------ */

let dbObserver: IntersectionObserver | null = null;
let dbSearchTimer: ReturnType<typeof setTimeout> | null = null;
let dbRequest = 0;
/** Bumped whenever the user changes a row, so a slower, older list can never overwrite that change. */
let dbMutations = 0;

/** Loads one page (100 rows) of applications; `reset` starts again from the top. */
async function loadApps(reset: boolean): Promise<void> {
  const db = state.db;
  if (db.loading) return;
  db.loading = true;
  db.error = undefined;
  const ticket = (dbRequest += 1);
  const mutationsAtStart = dbMutations;
  if (reset) {
    db.rows = [];
    db.loaded = false;
  }
  // Never redraw under an open Add/Edit dialog: it would wipe what is being typed.
  if (!state.editingApp) render();
  try {
    const page = await sendMessage<ApplicationPage>({
      type: 'fillie:apps-list',
      query: { offset: reset ? 0 : db.rows.length, search: db.search, status: db.status },
    });
    if (ticket !== dbRequest) return; // a newer search superseded this one
    if (mutationsAtStart !== dbMutations) {
      // The user saved, rated or deleted something while this was loading; this list is out of date.
      db.loading = false;
      return void loadApps(reset);
    }
    db.rows = reset ? page.rows : [...db.rows, ...page.rows];
    db.hasMore = page.hasMore;
    db.localOnly = page.localOnly;
  } catch (error) {
    db.error = error instanceof Error ? error.message : 'Please try again.';
  } finally {
    if (ticket === dbRequest && db.loading) {
      db.loading = false;
      db.loaded = true;
      if (!state.editingApp) render();
    }
  }
}

/** Fetches the next page when the "Load more" button scrolls into view. */
function watchLoadMore(): void {
  dbObserver?.disconnect();
  const button = app.querySelector('#db-more');
  if (!button || !('IntersectionObserver' in window)) return;
  dbObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && state.db.hasMore && !state.db.loading) void loadApps(false);
  }, { rootMargin: '240px' });
  dbObserver.observe(button);
}

async function loadAccount(): Promise<void> {
  try {
    state.account.status = await sendMessage<AccountStatus>({ type: 'fillie:account-status', device: await computeHashes() });
    state.db.signedIn = state.account.status.access.signedIn;
  } catch {
    state.account.message = { tone: 'danger', text: 'Could not load your account.' };
  }
  // Not while a dialog is open: a redraw would wipe what is being typed in it.
  if (!state.editingApp) render();
}

function applyRouteData(): void {
  if (state.route.kind === 'database') {
    if (!state.db.loaded && !state.db.loading) void loadApps(true);
    if (state.account.status === null) void loadAccount();
    watchLoadMore();
  } else if (state.route.kind === 'account' && !state.account.status) {
    void loadAccount();
  }
}

function readEditor(form: HTMLFormElement, base: Application): Application {
  const data = new FormData(form);
  const status = (data.get('status') as ApplicationStatus) || base.status;
  const rating = Number(data.get('rating')) || null;
  const lpa = String(data.get('offerLpa') ?? '').trim();
  return {
    ...base,
    company: String(data.get('company') ?? '').trim(),
    role: String(data.get('role') ?? '').trim(),
    status,
    interviewAt: String(data.get('interviewAt') ?? '') || null,
    offerLpa: lpa === '' ? null : Number(lpa),
    appliedAt: String(data.get('appliedAt') ?? '') || base.appliedAt,
    notes: String(data.get('notes') ?? '').split('\n'),
    rating,
    // A rating the user touched is theirs from then on.
    ratingSource: rating ? (rating === base.rating ? base.ratingSource : 'user') : null,
  };
}

/** Shows only the fields that apply to the chosen status, and highlights it. */
function syncEditor(): void {
  const form = app.querySelector<HTMLFormElement>('#app-form');
  if (!form) return;
  const status = (new FormData(form).get('status') as string) || 'applied';
  form.querySelectorAll<HTMLElement>('[data-only]').forEach((node) => {
    node.hidden = node.getAttribute('data-only') !== status;
  });
  form.querySelectorAll<HTMLElement>('label.tag').forEach((label) => {
    label.classList.toggle('is-on', Boolean(label.querySelector<HTMLInputElement>('input')?.checked));
  });
  const rating = Number(new FormData(form).get('rating')) || 0;
  form.querySelectorAll<HTMLElement>('.rating-edit .star').forEach((star, index) => star.setAttribute('data-on', String(index < rating)));
}

app.addEventListener('change', (event) => {
  if ((event.target as HTMLElement).closest('#app-form')) syncEditor();
});

app.addEventListener('submit', async (event) => {
  const form = event.target as HTMLFormElement;
  if (form.id === 'app-form' && state.editingApp) {
    event.preventDefault();
    const app = readEditor(form, state.editingApp.app);
    if (!app.company || (!app.role && !app.resumeName)) return;
    dbMutations += 1;
    const saved = await sendMessage<Application>({ type: 'fillie:apps-save', app });
    const rows = state.db.rows.filter((row) => row.id !== saved.id);
    state.db.rows = [saved, ...rows].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
    state.editingApp = undefined;
    render();
    toast('Saved');
    return;
  }
  if (form.id === 'auth-form') {
    event.preventDefault();
    const email = (form.querySelector('#auth-email') as HTMLInputElement).value;
    const password = (form.querySelector('#auth-password') as HTMLInputElement).value;
    await runAuth('password', () => sendMessage({ type: 'fillie:sign-in', mode: state.account.mode, email, password }));
  }
});

async function runAuth(busy: string, call: () => Promise<unknown>): Promise<void> {
  state.account.busy = busy;
  state.account.message = undefined;
  render();
  try {
    const result = (await call()) as { ok: boolean; error?: string; confirm?: boolean };
    if (!result.ok) state.account.message = { tone: 'danger', text: result.error ?? 'Sign-in failed.' };
    else if (result.confirm) state.account.message = { tone: 'info', text: 'Check your email and confirm your address, then sign in.' };
    else toast('Signed in');
  } catch (error) {
    state.account.message = { tone: 'danger', text: error instanceof Error ? error.message : 'Sign-in failed.' };
  }
  state.account.busy = '';
  state.account.status = null;
  state.db.loaded = false;
  await loadAccount();
  // Signing in changes what the Database shows (cloud rows) and what is backed up.
  await Promise.all([refreshMemory(), refreshResumes()]);
  state.profile = await loadProfile();
  state.store.set(state.profile);
  render();
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

// Coming back from a payment page: re-check the licence so the plan updates by itself.
window.addEventListener('focus', () => {
  if (state.route.kind !== 'account' || !state.account.status || state.account.status.access.plan === 'paid') return;
  void (async () => {
    state.account.status = await sendMessage<AccountStatus>({ type: 'fillie:refresh-payment', device: await computeHashes() });
    render();
  })().catch(() => undefined);
});

window.addEventListener('hashchange', () => {
  state.route = parseRoute();
  state.editingMemory = undefined;
  if (state.route.kind === 'settings' && state.route.section === 'advanced') {
    void refreshDiagnostics().then(render);
  }
  render();
  applyRouteData();
  window.scrollTo({ top: 0 });
});

async function boot(): Promise<void> {
  setTheme(state.theme);
  try {
    void chrome.storage?.local?.set?.({ 'fillie:theme': state.theme });
  } catch {
    // In environments without chrome.storage
  }
  state.profile = await loadProfile();
  state.store.set(state.profile);
  await Promise.all([refreshSettings(), refreshMemory(), refreshDiagnostics(), refreshResumes()]);
  render();
  applyRouteData();
}

void boot();

export { render, state };