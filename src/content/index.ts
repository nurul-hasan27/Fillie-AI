import type {
  ApplicationContext,
  DetectedField,
  FieldPlan,
  SessionStats,
} from '../core/types';
import { extractApplicationContext } from '../core/context';
import { computeStats } from '../core/engine/planner';
import {
  sendMessage,
  type ContentPingResponse,
  type GenerateResponse,
  type PlanResponse,
  type ResumeSuggestion,
  type ServedBy,
} from '../shared/messages';
import { fingerprintOf, hydrateCustomSelects, scanDocument, type ScannedField } from './scanner';
import { computeHashes } from '../core/cloud/fingerprint';
import type { AccessState } from '../core/cloud/types';
import { fillField, focusField, highlightField, readFieldValue, verifyFields } from './filler';
import { FillieOverlay, type DraftState } from './overlay';
import { VERSION } from '../shared/version';

const MAX_RESCANS = 4;
const FILL_DELAY_MS = 55;

/**
 * Content script runtime: scan → plan → fill → resolve → verify.
 * It never clicks submit-like buttons; only answerable controls are touched.
 */

interface RuntimeState {
  fields: Map<string, ScannedField>;
  plans: FieldPlan[];
  context: ApplicationContext;
  scanning: boolean;
  activeQuestionId: string | null;
  aiCalls: number;
  memoryHits: number;
  /** Resume chosen for this application ('none' = profile only). */
  resumeId?: string;
}

const state: RuntimeState = {
  fields: new Map(),
  plans: [],
  context: { url: location.href, host: location.hostname, pageTitle: document.title, detectedAt: Date.now() },
  scanning: false,
  activeQuestionId: null,
  aiCalls: 0,
  memoryHits: 0,
};

function stripControls(fields: ScannedField[]): DetectedField[] {
  return fields.map(({ control: _control, ...rest }) => rest);
}

function buildContext(fields: ScannedField[]): ApplicationContext {
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
    .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 1 && text.length < 140)
    .slice(0, 40);

  const pageText = extractReadableText();
  const context = extractApplicationContext({
    url: location.href,
    pageTitle: document.title,
    pageText,
    headings,
    fieldLabels: fields.map((field) => field.label),
  });
  const formTitle = fields.find((field) => field.context)?.context;
  return { ...context, formTitle: formTitle || context.formTitle };
}

function extractReadableText(): string {
  const parts: string[] = [];
  const nodes = document.querySelectorAll(
    'h1, h2, h3, h4, p, li, legend, [role="heading"], [data-testid*="description"], [class*="description"], [class*="job"]',
  );
  for (const node of Array.from(nodes).slice(0, 700)) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > 30) parts.push(text);
  }
  const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
  return [meta?.getAttribute('content') ?? '', ...parts].join('\n').slice(0, 12000);
}

/* ------------------------------------------------------------------ */
/* Overlay wiring                                                      */
/* ------------------------------------------------------------------ */

const overlay = new FillieOverlay({
  onStart: () => void run(),
  onFillNow: () => void fillReadyFields(),
  onOpenQuestion: (plan) => openQuestion(plan),
  onBackFromResolve: () => {
    state.activeQuestionId = null;
    renderTasks();
  },
  onGenerate: (plan, answers) => void generateDraft(plan, answers),
  onAccept: (plan, value, generic, remember) => void acceptDraft(plan, value, generic, remember),
  onSkip: (plan) => void skipQuestion(plan),
  onRegenerate: (plan) => void regenerate(plan),
  onFocusField: (fieldId) => void focusById(fieldId),
  onOpenSettings: () => void chrome.runtime?.openOptionsPage?.(),
  onDismiss: () => {
    resolveResumePick(null);
    overlay.unmount();
    teardownObserver();
  },
  onMinimise: () => undefined,
  onOpenEdit: (plan) => renderEditView(plan),
  onEdit: (plan, value, saveToFillie) => void handleEditField(plan, value, saveToFillie),
  onSaveAnswers: () => void learnFromPage(),
  onPickResume: (id) => resolveResumePick(id),
  onUpgrade: () => void sendMessage({ type: 'fillie:open-account' }).catch(() => undefined),
});

function renderScanning(message: string, completed: number, total: number, indeterminate = false): void {
  overlay.mount();
  overlay.render({ kind: 'scanning', message, completed, total, indeterminate });
}

function renderTasks(): void {
  overlay.mount();
  const stats = computeStats(state.plans);
  const hasPending = state.plans.some((plan) => plan.status === 'needs-attention');
  if (!hasPending) {
    overlay.render({ kind: 'success', plans: state.plans, stats });
    return;
  }
  overlay.render({
    kind: 'tasks',
    plans: state.plans,
    stats,
    company: state.context.company,
    role: state.context.role,
  });
}

function renderReview(): void {
  overlay.mount();
  overlay.render({ kind: 'review', plans: state.plans, stats: computeStats(state.plans) });
}

function renderResolve(plan: FieldPlan, draft: DraftState): void {
  state.activeQuestionId = plan.field.id;
  overlay.mount();
  overlay.render({ kind: 'resolve', plan, draft });
}

function renderEditView(plan: FieldPlan): void {
  state.activeQuestionId = plan.field.id;
  overlay.mount();
  overlay.render({ kind: 'edit', plan });
}

function emptyDraft(generating = false): DraftState {
  return { text: '', generating, sources: [], notes: [], generic: true, usedAI: false };
}

function renderError(message: string, detail?: string, tone: 'danger' | 'neutral' = 'danger'): void {
  overlay.mount();
  overlay.render({ kind: 'error', message, detail, tone });
}

/* ------------------------------------------------------------------ */
/* Resume picker + AI attribution                                      */
/* ------------------------------------------------------------------ */

let pendingResumePick: ((id: string | null) => void) | null = null;

function resolveResumePick(id: string | null): void {
  const resolve = pendingResumePick;
  pendingResumePick = null;
  resolve?.(id);
}

/**
 * With two or more saved resumes, asks which one fits this posting before
 * anything is sent to the AI. Resolves undefined (use the default) when there is
 * nothing to choose, and null if the user closes Fillie instead.
 */
async function chooseResume(): Promise<string | undefined | null> {
  const suggestion = await sendMessage<ResumeSuggestion>({
    type: 'fillie:suggest-resume',
    context: state.context,
  }).catch(() => null);
  if (!suggestion || suggestion.options.length < 2) return undefined;

  overlay.mount();
  overlay.render({
    kind: 'choose-resume',
    options: suggestion.options.map((option) => ({
      id: option.id,
      name: option.name,
      preview: option.preview,
      suggested: option.id === suggestion.suggestedId,
    })),
  });
  return new Promise((resolve) => {
    pendingResumePick = resolve;
  });
}

/** "Gemini · gemini-3.5-flash-lite", or "Gemini + Cerebras" when quota forced a switch. */
function describeServed(served: ServedBy[] | undefined, switchedFrom: string[] | undefined): string {
  if (!served?.length) return '';
  const real = served.filter((entry) => !entry.cached) as ServedBy[];
  const list = real.length ? real : served;
  const text =
    list.length === 1
      ? `${list[0].label} · ${shortModel(list[0].model)}`
      : list.map((entry) => entry.label).join(' + ');
  return switchedFrom?.length ? `${text} (switched from ${switchedFrom.join(', ')})` : text;
}

function shortModel(model: string): string {
  const name = model.split('/').pop() ?? model;
  return name.replace(/:free$/, '');
}

/* ------------------------------------------------------------------ */
/* Main flow                                                           */
/* ------------------------------------------------------------------ */

async function run(): Promise<void> {
  if (state.scanning) return;
  state.scanning = true;
  overlay.unmount();
  try {
    renderScanning('Looking through this application…', 0, 0, true);

    const fields = scanDocument(document);
    if (!fields.length) {
      // Not a failure: this page simply has nothing for Fillie to do.
      renderError(
        'Fillie could not find any question fields on this page.',
        'Open the form fully — some forms load as you scroll — then run Fillie again.',
        'neutral',
      );
      return;
    }

    state.fields = new Map(fields.map((field) => [field.id, field]));
    state.context = buildContext(fields);

    // Straight after Alt+Shift+F: with several resumes, ask which one fits this role
    // before anything is spent or sent.
    const resumeId = await chooseResume();
    if (resumeId === null) return; // the user closed Fillie at the picker
    state.resumeId = resumeId;

    // Free users get a few fillings a week; the server counts them per device.
    const access = await checkAccess();
    if (!access.allowed) {
      overlay.mount();
      overlay.render({
        kind: 'paywall',
        message: access.reason ?? 'Sign in and unlock Fillie to keep filling forms.',
        price: PRICE_LABEL,
      });
      return;
    }
    overlay.setPlanNote(planNote(access));

    renderScanning('Identifying questions', fields.length, fields.length);

    // Read the real option list of dropdowns that only populate when opened.
    await hydrateCustomSelects(fields);

    renderScanning('Reading the form', fields.length, fields.length, true);
    const response = await sendMessage<PlanResponse>({
      type: 'fillie:plan',
      payload: { fields: stripControls(fields), context: state.context, resumeId },
    });

    if (!response.ok || !response.plans) {
      renderError('Fillie could not analyse this form.', response.error ?? 'Please try again in a moment.');
      return;
    }

    state.plans = response.plans;

    overlay.setAiSource(describeServed(response.servedBy, response.switchedFrom));
    state.aiCalls = response.aiCalls ?? 0;
    state.memoryHits = response.memoryHits ?? 0;

    renderScanning('Filling what it can confidently answer', state.plans.length, state.plans.length);
    await fillReadyFields({ silent: true });

    setupObserver();
    renderTasks();
  } catch (error) {
    renderError(
      'Fillie ran into a problem on this page.',
      error instanceof Error ? error.message : 'Unknown error.',
    );
  } finally {
    state.scanning = false;
  }
}

function fillablePlans(): FieldPlan[] {
  return state.plans.filter((plan) => plan.status === 'ready' || plan.status === 'review');
}

async function fillReadyFields(options: { silent?: boolean } = {}): Promise<void> {
  if (!options.silent) {
    renderScanning('Filling answers', 0, fillablePlans().length);
  }
  const targets = fillablePlans();
  let filled = 0;

  for (const plan of targets) {
    if (plan.fillResult?.filled && plan.fillResult.verified) continue;
    const field = state.fields.get(plan.field.id);
    if (!field) continue;
    const result = await fillField(field, plan.answer ?? null);
    plan.fillResult = result;
    if (result.filled) {
      filled += 1;
      highlightField(field, result.verified ? 'filled' : 'attention');
    }
    await sleep(FILL_DELAY_MS);
  }

  await verifyFilled();

  if (filled > 0) {
    void sendMessage({
      type: 'fillie:report-session',
      url: location.href,
      stats: computeStats(state.plans),
      aiCalls: state.aiCalls,
    }).catch(() => undefined);
  }

  if (state.activeQuestionId) {
    const active = state.plans.find((plan) => plan.field.id === state.activeQuestionId);
    if (active && active.status === 'ready' && active.fillResult?.verified) {
      state.activeQuestionId = null;
    }
  }
  renderTasks();
}

/** Re-reads every written control and marks unverified ones for review. */
async function verifyFilled(): Promise<void> {
  const targets = state.plans.filter((plan) => plan.status === 'ready' || plan.status === 'review');
  const pairs = targets
    .map((plan) => ({ plan, field: state.fields.get(plan.field.id) }))
    .filter((pair): pair is { plan: FieldPlan; field: ScannedField } => Boolean(pair.field));

  if (!pairs.length) return;
  const verifications = await verifyFields(
    pairs.map((pair) => pair.field),
    180,
  );

  for (const { plan, field } of pairs) {
    const verification = verifications.get(field.id);
    if (!verification) continue;
    // Keep the fill-time error when we have one; it is more specific.
    const merged = {
      ...verification,
      error: plan.fillResult?.error ?? verification.error,
      method: plan.fillResult?.method ?? verification.method,
    };
    plan.fillResult = merged;
    if (!merged.verified) {
      highlightField(field, 'attention');
    }
  }
}

function openQuestion(plan: FieldPlan): void {
  renderResolve(plan, emptyDraft());
}

async function generateDraft(plan: FieldPlan, answers: Record<string, string>): Promise<void> {
  const notes = toNotes(plan, answers);
  if (!notes.length) {
    renderResolve(plan, {
      ...emptyDraft(),
      notes: ['Fill in at least one answer so Fillie knows what to write.'],
    });
    return;
  }
  renderResolve(plan, emptyDraft(true));

  try {
    const response = await sendMessage<GenerateResponse>({
      type: 'fillie:generate',
      payload: {
        question: plan.field.label,
        hint: plan.field.hint,
        contextText: plan.field.context,
        field: plan.field,
        notes,
        choices: choiceRefs(plan),
        context: state.context,
        resumeId: state.resumeId,
      },
    });

    if (!response.ok || !response.answer) {
      renderResolve(plan, {
        ...emptyDraft(),
        notes: [response.error ?? 'Fillie could not draft an answer for this question.'],
      });
      return;
    }

    renderResolve(plan, {
      text: response.answer,
      generating: false,
      sources: response.sources ?? [],
      notes: response.notes ?? [],
      generic: response.generic ?? true,
      usedAI: response.usedAI ?? false,
      aiSource: describeServed(response.servedBy, undefined),
    });
  } catch (error) {
    renderResolve(plan, {
      ...emptyDraft(),
      notes: [error instanceof Error ? error.message : 'Generation failed.'],
    });
  }
}

async function regenerate(plan: FieldPlan): Promise<void> {
  const existing = plan.interview?.questions.length ?? 0;
  if (!existing) {
    renderResolve(plan, emptyDraft(true));
    try {
      const response = await sendMessage<GenerateResponse>({
        type: 'fillie:generate',
        payload: {
          question: plan.field.label,
          hint: plan.field.hint,
          contextText: plan.field.context,
          field: plan.field,
          notes: [{ label: plan.field.label, answer: plan.answer ?? '' }],
          choices: choiceRefs(plan),
          context: state.context,
          resumeId: state.resumeId,
        },
      });
      renderResolve(plan, {
        text: response.answer ?? '',
        generating: false,
        sources: response.sources ?? [],
        notes: response.notes ?? [],
        generic: response.generic ?? true,
        usedAI: response.usedAI ?? false,
        aiSource: describeServed(response.servedBy, undefined),
      });
    } catch {
      renderResolve(plan, emptyDraft());
    }
    return;
  }
  generateDraft(plan, {});
}

/**
 * The user approved a draft, so it is written to the page. Remembering it is a
 * separate decision the user makes with the checkbox under the draft — the
 * answer is written either way.
 */
async function acceptDraft(plan: FieldPlan, value: string, generic: boolean, remember: boolean): Promise<void> {
  const field = state.fields.get(plan.field.id);
  if (!field) return;

  plan.answer = value;
  plan.status = value.trim() ? 'ready' : 'needs-attention';
  plan.source = 'generated';
  plan.reason = 'You approved this answer.';
  plan.confidence = value.trim() ? 0.9 : 0;

  const result = await fillField(field, value);
  plan.fillResult = result;
  if (result.filled) highlightField(field, result.verified ? 'filled' : 'attention');

  if (value.trim() && remember) {
    try {
      await sendMessage({
        type: 'fillie:remember',
        payload: {
          question: plan.field.label,
          answer: value,
          intent: plan.sources[0]?.label ?? '',
          sources: plan.sources,
          context: state.context,
          generic,
          facts: [],
        },
      });
    } catch {
      // Remembering is best-effort; the answer is already written to the page.
    }
  }

  state.activeQuestionId = null;
  renderTasks();
  void verifyFilled();
}

async function handleEditField(plan: FieldPlan, newValue: string, saveToFillie: boolean): Promise<void> {
  const field = state.fields.get(plan.field.id);
  plan.answer = newValue;
  plan.status = newValue.trim() ? 'ready' : 'needs-attention';
  plan.source = 'user';
  plan.reason = 'Edited by you.';
  plan.confidence = newValue.trim() ? 1.0 : 0;

  if (field) {
    const result = await fillField(field, newValue);
    plan.fillResult = result;
    if (result.filled) highlightField(field, result.verified ? 'filled' : 'attention');
  }

  if (newValue.trim() && saveToFillie) {
    try {
      await sendMessage({
        type: 'fillie:remember',
        payload: {
          question: plan.field.label,
          answer: newValue,
          intent: plan.sources[0]?.label ?? '',
          sources: plan.sources,
          context: state.context,
          generic: true,
          facts: [],
        },
      });
    } catch {
      // Remembering is best-effort; the answer is already written to the page.
    }
  }

  state.activeQuestionId = null;
  renderTasks();
  void verifyFilled();
}

function skipQuestion(plan: FieldPlan): void {
  plan.status = 'skipped';
  plan.reason = 'You chose to skip this question.';
  plan.interview = undefined;
  state.activeQuestionId = null;
  renderTasks();
}

function focusById(fieldId: string): void {
  if (fieldId === '__all__') {
    renderReview();
    return;
  }
  const plan = state.plans.find((candidate) => candidate.field.id === fieldId);
  if (!plan) return;
  if (plan.status === 'needs-attention') {
    openQuestion(plan);
    return;
  }
  const field = state.fields.get(fieldId);
  if (field) focusField(field);
}

function toNotes(plan: FieldPlan, answers: Record<string, string>): Array<{ label: string; answer: string; refId?: string }> {
  const notes: Array<{ label: string; answer: string; refId?: string }> = [];
  for (const question of plan.interview?.questions ?? []) {
    const value = (answers[question.id] ?? '').trim();
    if (!value) continue;
    if (question.type === 'choice') {
      const option = question.options?.find((candidate) => candidate.value === value);
      notes.push({ label: question.label, answer: option?.label ?? value, refId: option?.ref?.id });
    } else {
      notes.push({ label: question.label, answer: value });
    }
  }
  if (answers['direct_answer'] && answers['direct_answer'].trim()) {
    notes.push({ label: plan.field.label || 'User input', answer: answers['direct_answer'].trim() });
  }
  const extra = (answers['__extra_notes__'] ?? '').trim();
  if (extra) {
    notes.push({ label: 'Additional context provided by user', answer: extra });
  }
  return notes;
}

/** Choice → knowledge id pairs, so the background can attribute the draft. */
function choiceRefs(plan: FieldPlan): Array<{ value: string; refId?: string }> {
  return (plan.interview?.questions ?? [])
    .flatMap((question) => question.options ?? [])
    .map((option) => ({ value: option.label, refId: option.ref?.id }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Dynamic forms                                                       */
/* ------------------------------------------------------------------ */

let observer: MutationObserver | null = null;
let rescanCount = 0;
let rescanTimer: number | null = null;

function setupObserver(): void {
  teardownObserver();
  observer = new MutationObserver(() => {
    if (rescanTimer !== null) return;
    rescanTimer = window.setTimeout(() => {
      rescanTimer = null;
      void handlePotentialNewFields();
    }, 450);
  });
  // Visibility changes count too: multi-step forms reveal a whole step by
  // toggling a class, with no new nodes being added.
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-expanded', 'aria-hidden', 'value'],
  });
}

function teardownObserver(): void {
  observer?.disconnect();
  observer = null;
  if (rescanTimer !== null) {
    window.clearTimeout(rescanTimer);
    rescanTimer = null;
  }
}

let lastPlanSignature = '';

async function handlePotentialNewFields(): Promise<void> {
  if (rescanCount >= MAX_RESCANS || state.scanning) return;

  // Ids are stable per DOM element, so a field that only became visible is
  // still recognised as new here.
  const known = new Set([...state.fields.keys()]);
  const candidates = scanDocument(document).filter((field) => !known.has(field.id));
  if (!candidates.length) return;

  rescanCount += 1;
  const signature = candidates.map((field) => fingerprintOf(field.label)).sort().join('|');
  if (signature === lastPlanSignature) return;
  lastPlanSignature = signature;

  for (const field of candidates) state.fields.set(field.id, field);

  try {
    const response = await sendMessage<PlanResponse>({
      type: 'fillie:plan',
      payload: { fields: stripControls(candidates), context: state.context },
    });
    if (!response.ok || !response.plans) return;
    const existing = new Set(state.plans.map((plan) => plan.field.label));
    const additions = response.plans.filter((plan) => !existing.has(plan.field.label));
    if (!additions.length) return;
    state.plans = [...state.plans, ...additions];
    state.aiCalls += response.aiCalls ?? 0;
    await fillReadyFields({ silent: true });
  } catch {
    // A failed rescan must never break the page or the current session.
  }
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcut                                                   */
/* ------------------------------------------------------------------ */

window.addEventListener('keydown', (event) => {
  // Option+Shift+F (Alt+Shift+F) or Ctrl+Shift+F / Cmd+Shift+F
  const isKeyF = event.key?.toLowerCase() === 'f' || event.code === 'KeyF';
  if (isKeyF && event.shiftKey && (event.altKey || event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void run();
  }
});

/* ------------------------------------------------------------------ */
/* Access + application tracking                                       */
/* ------------------------------------------------------------------ */

const PRICE_LABEL = '$5 one-time';

/** If the check itself fails (service worker asleep, offline), do not lock the user out. */
async function checkAccess(): Promise<AccessState> {
  try {
    return await sendMessage<AccessState>({ type: 'fillie:begin-run', url: location.href, device: await computeHashes() });
  } catch {
    return { allowed: true, plan: 'trial', remaining: 0, limit: 0, signedIn: false };
  }
}

function planNote(access: AccessState): string {
  if (access.plan === 'paid' || access.limit === 0) return '';
  const left = access.remaining;
  return `${left} free ${left === 1 ? 'filling' : 'fillings'} left this week`;
}

/**
 * Counts, not content: how many answers Fillie wrote and how many the user then
 * changed before submitting. It is the accuracy figure on the admin dashboard.
 */
async function reportQuality(): Promise<void> {
  let filled = 0;
  let edited = 0;
  for (const plan of state.plans) {
    const field = state.fields.get(plan.field.id);
    // Only free-text kinds: a select, radio or date is re-formatted by the page, which would look like an edit.
    if (!field || !plan.fillResult?.filled || field.sensitive || !['text', 'textarea', 'number', 'email', 'tel', 'url'].includes(field.kind)) continue;
    filled += 1;
    if (normaliseValue(readFieldValue(field)) !== normaliseValue(plan.answer)) edited += 1;
  }
  if (!filled) return;
  try {
    await sendMessage({ type: 'fillie:report-quality', filled, edited, device: await computeHashes() });
  } catch {
    /* analytics are best effort */
  }
}

let tracked = false;

/** Adds this application to the tracker, once per page. */
async function trackApplication(): Promise<void> {
  if (tracked || !state.plans.some((plan) => plan.fillResult?.filled)) return;
  tracked = true;
  try {
    await sendMessage({ type: 'fillie:apps-track', context: state.context, resumeId: state.resumeId });
    void reportQuality();
  } catch {
    tracked = false; // allow another try (e.g. from the button)
  }
}

/* ------------------------------------------------------------------ */
/* Learn on submit                                                     */
/* ------------------------------------------------------------------ */

const normaliseValue = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The final value of every field worth remembering, read from the live page so
 * edits and answers the user typed themselves are captured. Values Fillie took
 * straight from the profile and the user left alone are skipped: the profile is
 * already their source of truth, and copying them would only bloat memory.
 */
function collectAnswersToLearn(): Array<{ question: string; answer: string }> {
  const entries = new Map<string, string>();
  for (const plan of state.plans) {
    const field = state.fields.get(plan.field.id);
    if (!field) continue;
    if (field.sensitive || field.manualOnly || field.acknowledgement || field.kind === 'file') continue;
    if (plan.status === 'manual' || plan.status === 'skipped') continue;

    const answer = readFieldValue(field).trim().slice(0, 4000);
    const question = plan.field.label.trim();
    if (!answer || !question) continue;

    const fromProfile = plan.source === 'profile' || plan.source === 'deterministic' || plan.source === 'memory';
    if (fromProfile && normaliseValue(answer) === normaliseValue(plan.answer)) continue;
    entries.set(question, answer);
  }
  return [...entries].map(([question, answer]) => ({ question, answer }));
}

async function learnFromPage(): Promise<void> {
  void trackApplication();
  const entries = collectAnswersToLearn();
  if (!entries.length) return;
  try {
    await sendMessage({ type: 'fillie:remember-batch', payload: { entries, context: state.context } });
  } catch {
    // Learning is best-effort and must never get in the way of the user's submit.
  }
}

// Fires when the user submits; Fillie itself never submits anything.
document.addEventListener(
  'submit',
  () => {
    if (state.plans.length) void learnFromPage();
  },
  true,
);

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */

const runtime = chrome.runtime;

runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  if (message.type === 'fillie:ping') {
    sendResponse({ ok: true, version: VERSION, url: location.href } satisfies ContentPingResponse);
    return false;
  }
  if (message.type === 'fillie:run') {
    void run();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'fillie:toggle') {
    if (overlay.isOpen) {
      overlay.unmount();
      teardownObserver();
    } else {
      void run();
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'fillie:highlight') {
    const plan = state.plans.find((candidate) => candidate.field.id === message.fieldId);
    const field = state.fields.get(message.fieldId);
    if (field) highlightField(field, message.state);
    void plan;
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

export { run, state };
export type { SessionStats };