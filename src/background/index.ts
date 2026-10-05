import type { ApplicationContext, DetectedField } from '../core/types';
import {
  AIError,
  type AIProviderConfig,
  type AIRequest,
  type AIResponse,
  type AISettings,
  type FieldPlan,
  type KnowledgeItem,
  type KnowledgeRef,
  type LearnedAnswer,
  type SessionStats,
  type UserProfile,
} from '../core/types';
import { storage, STORAGE_KEYS } from '../core/storage';
import { rankResumes } from '../core/resume-select';
import { createProvider } from '../core/ai/factory';
import { buildProviderChain, FailoverProvider } from '../core/ai/chain';
import { getPreset } from '../core/ai/presets';
import { buildKnowledgeBundle, groundingCorpus, knowledgeItemToRef } from '../core/knowledge';
import { explainFields } from '../core/engine/planner';
import { generateAnswer, planFields, type PlannerDeps } from '../core/engine/planner';
import { createLearnedAnswer, recordMemoryUsage, upsertLearnedAnswer } from '../core/memory';
import { profileCompletion } from '../core/profile';
import { stableHash } from '../core/text';
import type {
  BackgroundMessage,
  GenerateRequest,
  GenerateResponse,
  PlanRequest,
  PlanResponse,
  RememberBatchRequest,
  RememberRequest,
  ResumeSuggestion,
  ServedBy,
  StatusResponse,
} from '../shared/messages';

/**
 * The service worker owns everything sensitive: the API key, storage, the AI
 * provider, response caching and rate limiting. No page or content script ever
 * sees the key.
 */

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

interface RateLimiter {
  minIntervalMs: number;
  lastStart: number;
  queue: Promise<unknown>;
  todayCount: number;
  day: string;
}

const rateLimiter: RateLimiter = {
  minIntervalMs: 900,
  lastStart: 0,
  queue: Promise.resolve(),
  todayCount: 0,
  day: new Date().toISOString().slice(0, 10),
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Serialises AI calls and enforces a minimum gap between them. */
function schedule<T>(task: () => Promise<T>): Promise<T> {
  const run = rateLimiter.queue.then(async () => {
    const now = Date.now();
    if (todayKey() !== rateLimiter.day) {
      rateLimiter.day = todayKey();
      rateLimiter.todayCount = 0;
    }
    rateLimiter.todayCount += 1;
    const wait = Math.max(0, rateLimiter.minIntervalMs - (now - rateLimiter.lastStart));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    rateLimiter.lastStart = Date.now();
    return task();
  });
  rateLimiter.queue = run.catch(() => undefined);
  return run;
}

export /** Explains what Fillie understood for a set of fields (diagnostics screen). */
async function explainPlan(
  payload: { fields: DetectedField[]; context: ApplicationContext },
  loadProfile: () => Promise<UserProfile>,
): Promise<unknown> {
  const bundle = buildKnowledgeBundle(await loadProfile());
  return explainFields({ fields: payload.fields, context: payload.context, bundle, memory: [], userFacts: [] }, {
    settings: await getSettings(),
  });
}

function aiCallsToday(): number {
  if (todayKey() !== rateLimiter.day) {
    rateLimiter.day = todayKey();
    rateLimiter.todayCount = 0;
  }
  return rateLimiter.todayCount;
}

/* ------------------------------------------------------------------ */
/* Settings / provider plumbing                                        */
/* ------------------------------------------------------------------ */

let cachedSettings: AISettings | null = null;
let cachedAt = 0;

async function getSettings(): Promise<AISettings> {
  if (cachedSettings && Date.now() - cachedAt < 2000) return cachedSettings;
  cachedSettings = await storage.getSettings();
  cachedAt = Date.now();
  return cachedSettings;
}

function invalidateSettingsCache(): void {
  cachedSettings = null;
  cachedAt = 0;
}

function isAiUsable(settings: AISettings): boolean {
  return buildProviderChain(settings).length > 0;
}

/** Builds the deps used by the planner, with caching + rate limiting layered in. */
async function plannerDeps(
  settings: AISettings,
  extra: Partial<PlannerDeps> = {},
  served: ServedBy[] = [],
): Promise<PlannerDeps> {
  const chain = buildProviderChain(settings);
  const provider = chain.length
    ? new FailoverProvider(chain, { maxRetries: settings.maxRetries, onSwitch: (entry) => noteSwitch(entry.label) })
    : null;
  const record = (response: AIResponse): AIResponse => {
    served.push({
      provider: response.provider,
      label: response.providerLabel ?? getPreset(response.provider).shortLabel,
      model: response.model,
      cached: response.cached,
    });
    return response;
  };
  const send = provider
    ? async (request: AIRequest): Promise<AIResponse> =>
        schedule(async () => {
          if (request.cacheKey) {
            // Keyed on the top-ranked provider so a switch mid-form still hits.
            const lead = chain[0].config;
            const cacheKey = `${lead.provider}:${lead.model}:${stableHash(request.cacheKey)}`;
            const cache = await storage.getCache();
            const hit = cache[cacheKey];
            if (hit) {
              await storage.bumpStats({ cacheHits: 1 });
              return record({ text: hit.text, model: lead.model, provider: lead.provider, providerLabel: chain[0].label, cached: true });
            }
            const response = await provider.complete(request);
            await storage.setCacheEntry(cacheKey, response.text);
            return record(response);
          }
          return record(await provider.complete(request));
        })
    : undefined;

  return { settings, provider, send, ...extra };
}

/** Providers skipped during the current request, surfaced as a note to the user. */
let switchedFrom: string[] = [];
function noteSwitch(label: string): void {
  if (!switchedFrom.includes(label)) switchedFrom.push(label);
}

/** Collapses repeated responses into one entry per provider+model. */
function uniqueServed(served: ServedBy[]): ServedBy[] {
  const seen = new Set<string>();
  return served.filter((entry) => {
    const key = `${entry.provider}:${entry.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function handlePlan(payload: PlanRequest): Promise<PlanResponse> {
  const settings = await getSettings();
  const profile = await storage.getProfile();
  const memory = await storage.getMemory();
  const bundle = buildKnowledgeBundle(profile, payload.userFacts ?? [], await storage.getResumeText(payload.resumeId));

  const served: ServedBy[] = [];
  switchedFrom = [];
  const deps = await plannerDeps(settings, {}, served);
  try {
    const result = await planFields(
      { fields: payload.fields, bundle, memory, context: payload.context, userFacts: payload.userFacts ?? [] },
      deps,
    );
    await storage.bumpStats({ aiCalls: result.aiCalls });
    if (result.usedMemoryIds.length) {
      // A reuse is real use of a learned answer, so the counter moves and the
      // user can see in Memory which answers earn their keep.
      let current = memory;
      for (const id of result.usedMemoryIds) current = recordMemoryUsage(current, id);
      await storage.saveMemory(current);
    }
    return {
      ok: true,
      plans: result.plans,
      stats: result.stats,
      aiCalls: result.aiCalls,
      memoryHits: result.memoryHits,
      problems: result.problems,
      servedBy: uniqueServed(served),
      switchedFrom: [...switchedFrom],
      profileCompleteness: profileCompletion(profile),
      aiEnabled: settings.enabled && settings.config.provider !== 'offline',
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof AIError ? error.message : 'Fillie could not analyse this form.',
    };
  }
}

async function handleGenerate(payload: GenerateRequest): Promise<GenerateResponse> {
  const settings = await getSettings();
  const profile = await storage.getProfile();
  const bundle = buildKnowledgeBundle(profile, [], await storage.getResumeText(payload.resumeId));
  const served: ServedBy[] = [];
  const deps = await plannerDeps(settings, {}, served);

  // The user picking "Trailhead" is an explicit instruction to use it: that fact
  // is always part of the prompt, whatever retrieval would have chosen.
  const chosenItems: KnowledgeItem[] = [];
  const choiceRefs = new Map<string, KnowledgeRef>();
  for (const choice of payload.choices ?? []) {
    if (!choice.refId) continue;
    const item = bundle.items.find((candidate) => candidate.id === choice.refId);
    if (!item) continue;
    if (!chosenItems.some((existing) => existing.id === item.id)) chosenItems.push(item);
    choiceRefs.set(choice.value, knowledgeItemToRef(item));
  }
  const resumeItems = groundingCorpus(bundle).filter((item) => item.id === 'resume.text');
  const knowledge = [...chosenItems, ...bundle.items].slice(0, 14).concat(resumeItems);

  try {
    const result = await generateAnswer(
      {
        question: payload.question,
        hint: payload.hint,
        contextText: payload.contextText,
        context: payload.context,
        knowledge,
        corpus: groundingCorpus(bundle),
        userFacts: [],
        notes: payload.notes,
        chosenRefs: payload.notes
          .map((note) => choiceRefs.get(note.answer))
          .filter((ref): ref is KnowledgeRef => Boolean(ref)),
        field: payload.field,
      },
      deps,
    );
    await storage.bumpStats({ aiCalls: result.usedAI ? 1 : 0 });
    return {
      ok: true,
      answer: result.answer,
      confidence: result.confidence,
      sources: result.sources,
      generic: result.generic,
      notes: result.notes,
      usedAI: result.usedAI,
      problems: result.problems,
      servedBy: uniqueServed(served),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Generation failed.' };
  }
}

/** Ranks the user's resumes against the job on the page, for the picker. */
async function handleSuggestResume(context: ApplicationContext): Promise<ResumeSuggestion> {
  const { resumes, defaultId } = await storage.getResumes();
  const jobText = [context.role, context.pageTitle, context.department, context.jobDescription].filter(Boolean).join(' ');
  const options = rankResumes(resumes, jobText);
  // With no signal from the page, fall back to the user's own default.
  const best = options[0];
  const suggestedId = best && best.score > 0 ? best.id : defaultId || best?.id || '';
  return { options, suggestedId };
}

/**
 * Learn-on-submit: stores what the user actually left in the form, edits
 * included. Question/answer pairs only; no element ids ever reach memory.
 */
async function handleRememberBatch(payload: RememberBatchRequest): Promise<{ ok: boolean; saved: number }> {
  let memory = await storage.getMemory();
  let saved = 0;
  for (const { question, answer } of payload.entries.slice(0, 200)) {
    if (!question.trim() || !answer.trim()) continue;
    const entry = createLearnedAnswer({
      question,
      intent: '',
      answer,
      sources: [],
      context: {
        company: payload.context.company,
        role: payload.context.role,
        host: payload.context.host,
        // Short factual answers travel between employers; long prose usually names one.
        isGeneric: answer.length <= 120,
      },
    });
    memory = upsertLearnedAnswer(memory, entry).memory;
    saved += 1;
  }
  if (saved) await storage.saveMemory(memory);
  return { ok: true, saved };
}

async function handleRemember(payload: RememberRequest): Promise<{ ok: boolean; count?: number }> {
  if (!payload.answer.trim()) return { ok: false };
  const memory = await storage.getMemory();
  const entry: LearnedAnswer = createLearnedAnswer({
    question: payload.question,
    intent: payload.intent ?? '',
    answer: payload.answer,
    sources: payload.sources ?? [],
    userFacts: payload.facts ?? [],
    context: {
      company: payload.context.company,
      role: payload.context.role,
      host: payload.context.host,
      isGeneric: payload.generic ?? true,
    },
  });
  const { memory: next } = upsertLearnedAnswer(memory, entry);
  await storage.saveMemory(next);
  if (payload.factMemory && payload.facts?.length) {
    const profile = await storage.getProfile();
    if (payload.factMemory === true) {
      // Facts the user typed are saved into the profile notes so future forms
      // can use them without asking again.
      profile.preferences.notes = mergeNotes(profile.preferences.notes, payload.facts);
      await storage.saveProfile(profile);
    }
  }
  return { ok: true, count: next.length };
}

function mergeNotes(existing: string | undefined, facts: Array<{ key: string; value: string }>): string {
  const lines = new Set<string>();
  for (const line of (existing ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed) lines.add(trimmed);
  }
  for (const fact of facts) {
    const entry = `${fact.key}: ${fact.value}`;
    if (![...lines].some((line) => line.toLowerCase().startsWith(fact.key.toLowerCase().split(':')[0].toLowerCase()))) {
      lines.add(entry);
    }
  }
  return [...lines].slice(-12).join('\n');
}

async function handleStatus(): Promise<StatusResponse> {
  const settings = await getSettings();
  const profile = await storage.getProfile();
  const memory = await storage.getMemory();
  const stored = await readLastSession();
  return {
    hasProfile: Boolean(profile.personal.fullName.trim() || profile.personal.email.trim()),
    profileCompleteness: profileCompletion(profile),
    aiConfigured: isAiUsable(settings),
    aiEnabled: settings.enabled && settings.config.provider !== 'offline',
    provider: settings.config.provider,
    model: settings.config.model,
    memoryCount: memory.length,
    lastSession: stored ?? undefined,
    debug: settings.debug,
    stats: await storage.getStats(),
  };
}

interface LastSessionRecord {
  url: string;
  host: string;
  at: number;
  stats: SessionStats;
}

let lastSession: LastSessionRecord | null = null;

async function readLastSession(): Promise<LastSessionRecord | null> {
  if (lastSession) return lastSession;
  const chromeApi = (globalThis as { chrome?: { storage?: { local?: { get(keys: string[]): Promise<Record<string, unknown>> } } } }).chrome;
  if (!chromeApi?.storage?.local) return null;
  try {
    const stored = await chromeApi.storage.local.get(['fillie:last-session']);
    lastSession = (stored['fillie:last-session'] as LastSessionRecord) ?? null;
  } catch {
    lastSession = null;
  }
  return lastSession;
}

async function handleReportSession(url: string, stats: SessionStats, aiCalls = 0): Promise<{ ok: boolean }> {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  const record: LastSessionRecord = { url, host, at: Date.now(), stats };
  lastSession = record;
  const chromeApi = (globalThis as { chrome?: { storage?: { local?: { set(items: Record<string, unknown>): Promise<void> } } } }).chrome;
  if (chromeApi?.storage?.local) {
    await chromeApi.storage.local.set({ 'fillie:last-session': record });
  }
  await storage.bumpStats({
    sessions: 1,
    fieldsFilled: stats.verified,
    aiCalls,
  });
  return { ok: true };
}

async function handleTestConnection(config?: AIProviderConfig): Promise<{ ok: boolean; message: string; model?: string }> {
  const settings = await getSettings();
  const raw = config ?? settings.config;
  const effective: AIProviderConfig = {
    ...raw,
    apiKey: raw.apiKey ? raw.apiKey.trim().replace(/^["']|["']$/g, '').trim() : '',
  };
  try {
    const provider = createProvider(effective, { maxRetries: 0 });
    const result = await provider.testConnection?.();
    if (!result) return { ok: false, message: 'This provider does not support connection tests.' };
    if (result.ok) await storage.bumpStats({ aiCalls: 1 });
    return result;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Connection failed.' };
  }
}

async function dispatch(message: BackgroundMessage): Promise<unknown> {
  switch (message.type) {
    case 'fillie:get-status':
      return handleStatus();
    case 'fillie:plan':
      return handlePlan(message.payload);
    case 'fillie:generate':
      return handleGenerate(message.payload);
    case 'fillie:remember':
      return handleRemember(message.payload);
    case 'fillie:get-profile':
      return storage.getProfile();
    case 'fillie:save-profile':
      return storage.saveProfile(message.profile);
    case 'fillie:get-settings': {
      const settings = await getSettings();
      return { ...settings, callsToday: aiCallsToday() };
    }
    case 'fillie:save-settings':
      invalidateSettingsCache();
      return storage.saveSettings(message.settings);
    case 'fillie:test-connection':
      return handleTestConnection(message.config);
    case 'fillie:get-resumes':
      return storage.getResumes();
    case 'fillie:save-resumes':
      return storage.saveResumes(message.state);
    case 'fillie:suggest-resume':
      return handleSuggestResume(message.context);
    case 'fillie:remember-batch':
      return handleRememberBatch(message.payload);
    case 'fillie:get-memory':
      return storage.getMemory();
    case 'fillie:save-memory':
      return storage.saveMemory(message.memory);
    case 'fillie:clear-cache':
      await storage.clearCache();
      return { ok: true };
    case 'fillie:report-session':
      return handleReportSession(message.url, message.stats, message.aiCalls);
    case 'fillie:explain':
      return explainPlan(message.payload, () => storage.getProfile());
    default:
      return { ok: false, error: 'Unknown message' };
  }
}

const chromeApi = (globalThis as { chrome?: typeof chrome }).chrome;
const runtime = chromeApi?.runtime;
const commands = chromeApi?.commands;

if (runtime?.onMessage) {
  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('fillie:')) return false;
    dispatch(message as BackgroundMessage)
      .then((result) => sendResponse(result))
      .catch((error: unknown) => {
        // Never leak a stack trace or an API key to the caller.
        const safe = error instanceof AIError ? error.message : 'Something went wrong inside Fillie.';
        sendResponse({ ok: false, error: safe });
      });
    return true; // keep the message channel open for the async response
  });
}

/** Keeps the worker alive long enough to answer a burst of messages. */
runtime?.onInstalled?.addListener(() => {
  storage.getSettings().catch(() => undefined);
});

/**
 * The manifest advertises an `Alt+Shift+F` shortcut. It is wired to the same
 * message the popup sends, so the keyboard and the button behave identically.
 */
commands?.onCommand?.addListener((command: string) => {
  if (command !== 'run-fillie') return;
  chromeApi!.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => {
      if (tab?.id === undefined) return;
      return chromeApi!.tabs.sendMessage(tab.id, { type: 'fillie:run' });
    })
    .catch(() => {
      /* no content script on this tab (a settings page, the store, …) */
    });
});

export { dispatch, STORAGE_KEYS, type FieldPlan, type KnowledgeItem, type UserProfile };