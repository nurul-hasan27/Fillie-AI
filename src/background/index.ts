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
import { CloudClient, CloudError } from '../core/cloud/client';
import { AccessService } from '../core/cloud/access';
import { ApplicationStore } from '../core/cloud/applications';
import { BackupService } from '../core/cloud/backup';
import { CLOUD, isCloudConfigured } from '../core/cloud/config';
import { readOffers, readQuote } from '../core/cloud/money';
import { checkReminders, NOTIFICATION_PREFIX, REMINDER_ALARM, REMINDERS_KEY, REMINDERS_SENT_KEY, type SentMap } from './reminders';
import type { DeviceSignals, OAuthProvider } from '../core/cloud/types';
import { extractDetails } from '../core/engine/intel';
import { createAuthWindow, type WindowsApi } from './popup-window';
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
  AccountStatus,
  ApplicationsRequest,
  DeviceHashes,
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
  // A cleared browser profile is repaired from the cloud backup on the next filling.
  await backups.restoreIfEmpty().catch(() => false);
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
      aiReady: isAiUsable(settings),
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
  const { resumes, defaultId } = await storage.getResumeChoices();
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

/* ------------------------------------------------------------------ */
/* Account, access, tracker, backup                                    */
/* ------------------------------------------------------------------ */

const cloud = new CloudClient(storage);
const access = new AccessService(storage, cloud);
const applications = new ApplicationStore(storage, cloud);
const backups = new BackupService(storage, cloud);

const INSTALL_KEY = 'fillie:install-id';
/** Bumped whenever something the popup displays may have changed (see the popup's cache). */
const POPUP_DIRTY_KEY = 'fillie:popup-dirty';
const POPUP_DIRTYING = new Set([
  'fillie:apps-save',
  'fillie:apps-delete',
  'fillie:apps-track',
  'fillie:save-settings',
  'fillie:save-profile',
  'fillie:sign-in',
  'fillie:sign-in-oauth',
  'fillie:sign-out',
  'fillie:refresh-payment',
  'fillie:restore-now',
]);
const BACKUP_AT_KEY = 'fillie:last-backup';

async function deviceSignals(hashes: DeviceHashes): Promise<DeviceSignals> {
  let install = await storage.read<string>(INSTALL_KEY);
  if (!install) {
    install = crypto.randomUUID();
    await storage.put(INSTALL_KEY, install);
  }
  return { install, hw: hashes.hw, br: hashes.br };
}

async function handleAccountStatus(device: DeviceHashes): Promise<AccountStatus> {
  return {
    cloudConfigured: isCloudConfigured(),
    access: await access.status(await deviceSignals(device)),
    pendingApplications: await applications.pendingCount(),
    priceLabel: CLOUD.priceLabel,
    priceInrLabel: CLOUD.priceInrLabel,
    shareOffers: await readShareOffers(),
    lastBackupAt: await storage.read<number>(BACKUP_AT_KEY),
  };
}

function authError(error: unknown): { ok: false; error: string } {
  if (error instanceof CloudError) return { ok: false, error: error.message };
  // Not one of ours (a browser or network error). Say what it was, so it can be fixed, and keep a stack in the worker console.
  console.error('Fillie sign-in failed', error);
  const detail = error instanceof Error ? error.message : String(error);
  return { ok: false, error: `Something went wrong: ${detail.slice(0, 200)}` };
}

async function afterSignIn(): Promise<void> {
  // Bring this device and the cloud in line: upload waiting rows, restore if empty.
  await applications.flush();
  await backups.restoreIfEmpty();
  const uploaded = await backups.upload();
  if (uploaded.ok) await storage.put(BACKUP_AT_KEY, Date.now());
}

async function handleSignIn(message: Extract<BackgroundMessage, { type: 'fillie:sign-in' }>) {
  try {
    if (message.mode === 'signup') {
      const session = await cloud.signUp(message.email.trim(), message.password);
      if (!session) return { ok: true, confirm: true };
    } else {
      await cloud.signInWithPassword(message.email.trim(), message.password);
    }
    await afterSignIn();
    return { ok: true };
  } catch (error) {
    return authError(error);
  }
}

/* ---- Sign-in popup ---------------------------------------------------- */

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingAuth {
  windowId: number;
  resolve(url: string): void;
  reject(error: Error): void;
}
let pendingAuth: PendingAuth | null = null;

/**
 * Opens the provider's sign-in page in a small window centred over the browser
 * (not a tab) and resolves with the address it ends on. The provider redirects
 * to the extension's own auth-callback page, which reports back here and lets us
 * close the window. Closing the window cancels the sign-in.
 */
async function openAuthPopup(url: string): Promise<string> {
  const api = (globalThis as { chrome?: typeof chrome }).chrome;
  if (!api?.windows) throw new CloudError('Sign-in is not available here.');
  pendingAuth?.reject(new CloudError('Sign-in was cancelled.'));

  const windowId = await createAuthWindow(api.windows as unknown as WindowsApi, url);

  return new Promise<string>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      api.windows.onRemoved.removeListener(onRemoved);
      if (pendingAuth?.windowId === windowId) pendingAuth = null;
    };
    const onRemoved = (id: number) => {
      if (id !== windowId) return;
      finish();
      reject(new CloudError('Sign-in was cancelled.'));
    };
    const timer = setTimeout(() => {
      finish();
      void api.windows.remove(windowId).catch(() => undefined);
      reject(new CloudError('Sign-in timed out. Please try again.'));
    }, AUTH_TIMEOUT_MS);
    api.windows.onRemoved.addListener(onRemoved);
    pendingAuth = {
      windowId,
      resolve: (redirected) => {
        finish();
        void api.windows.remove(windowId).catch(() => undefined);
        resolve(redirected);
      },
      reject: (error) => {
        finish();
        void api.windows.remove(windowId).catch(() => undefined);
        reject(error);
      },
    };
  });
}

/** Called by the extension's own auth-callback page. Anything else is ignored. */
function handleAuthCallback(url: string, sender: { id?: string; url?: string }): { ok: boolean } {
  const api = (globalThis as { chrome?: typeof chrome }).chrome;
  const callback = api?.runtime.getURL('pages/auth-callback.html') ?? '';
  if (sender.id !== api?.runtime.id || !sender.url?.startsWith(callback) || !url.startsWith(callback)) return { ok: false };
  pendingAuth?.resolve(url);
  return { ok: Boolean(pendingAuth) };
}

async function handleOAuth(provider: OAuthProvider) {
  const api = (globalThis as { chrome?: typeof chrome }).chrome;
  const callbackUrl = api?.runtime.getURL('pages/auth-callback.html') ?? '';
  try {
    const redirected = await openAuthPopup(cloud.oauthUrl(provider, callbackUrl));
    await cloud.completeOAuth(redirected, provider);
    await afterSignIn();
    return { ok: true };
  } catch (error) {
    const base = authError(error);
    // The most common setup mistake: this exact address is missing from Supabase's Redirect URLs.
    const hint = ` Make sure ${callbackUrl} is listed under Authentication > URL Configuration > Redirect URLs in Supabase.`;
    return /cancel|closed|timed out/i.test(base.error) ? base : { ok: false as const, error: base.error + hint };
  }
}

/** Cleans the codes a page sends: at most three, upper-case, plain letters and numbers. */
function cleanCodes(codes: unknown): string[] {
  if (!Array.isArray(codes)) return [];
  const out = new Set<string>();
  for (const raw of codes) {
    const code = typeof raw === 'string' ? raw.replace(/\s+/g, '').toUpperCase() : '';
    if (/^[A-Z0-9]{4,16}$/.test(code)) out.add(code);
    if (out.size === 3) break;
  }
  return [...out];
}

/** Prices both payment options with the buyer's codes. The server decides every amount. */
async function handleCheckoutQuote(codes: string[]) {
  try {
    const ask = (currency: 'INR' | 'USD') =>
      cloud.json<unknown>('/functions/v1/create-checkout', { method: 'POST', body: JSON.stringify({ currency, codes: cleanCodes(codes), quote: true }) });
    const [inr, usd] = await Promise.all([ask('INR'), ask('USD')]);
    const quotes = { INR: readQuote(inr), USD: readQuote(usd) };
    // An older checkout function does not know about codes; then there is simply nothing to show.
    if (!quotes.INR || !quotes.USD) return { ok: false as const, error: 'Codes are not available yet.', unsupported: true };
    return { ok: true as const, quotes };
  } catch (error) {
    return authError(error);
  }
}

/** The offers the admin chose to show customers. Creator codes are never in this list. */
async function handleListOffers() {
  try {
    const rows = await cloud.json<unknown>('/rest/v1/rpc/list_public_offers', { method: 'POST', body: '{}' });
    return { ok: true as const, offers: readOffers(rows) };
  } catch (error) {
    return authError(error);
  }
}

async function handleCheckout(currency: 'INR' | 'USD', codes: string[] = []) {
  try {
    const { url } = await cloud.json<{ url: string }>('/functions/v1/create-checkout', { method: 'POST', body: JSON.stringify({ currency, codes: cleanCodes(codes) }) });
    await (globalThis as { chrome?: typeof chrome }).chrome?.tabs?.create({ url });
    return { ok: true, url };
  } catch (error) {
    return authError(error);
  }
}

async function handleBackupNow() {
  const result = await backups.upload();
  if (result.ok) await storage.put(BACKUP_AT_KEY, Date.now());
  return result;
}

async function handleRestoreNow() {
  try {
    const backup = await backups.fetch();
    if (!backup) return { ok: false, reason: 'No backup found yet.' };
    await backups.apply(backup);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof CloudError ? error.message : 'Could not restore.' };
  }
}

/**
 * Records a submitted application once. Notes come from the posting and, when an
 * AI platform is configured, a short AI summary; a rating is only an AI guess
 * and stays editable.
 */
async function handleTrack(context: ApplicationContext, resumeId?: string, formText = '') {
  const resumeName = await storage.getResumeName(resumeId);
  const settings = await getSettings();
  const deps = await plannerDeps(settings);
  const heuristicCompany = context.company?.trim() || context.host;
  const heuristicRole = context.role?.trim() || '';
  const base = { company: heuristicCompany, role: heuristicRole, url: context.url, host: context.host, resumeName };

  const { app, created } = await applications.track(
    base,
    async () => {
      // The whole form goes to the model once, to read the details of this application.
      const details = await extractDetails(context, formText, deps.send);
      return {
        company: details.company || heuristicCompany,
        // When the role cannot be read, the resume used is shown in its place.
        role: details.role || heuristicRole || (resumeName ? '' : context.pageTitle.slice(0, 120) || 'Application'),
        offeredCtc: details.ctc,
        notes: details.notes,
        rating: details.rating,
        ratingSource: details.rating ? ('ai' as const) : null,
      };
    },
  );
  return { ok: true, created, app };
}

async function readShareOffers(): Promise<boolean> {
  try {
    const session = await cloud.getSession();
    if (!session) return false;
    const rows = await cloud.json<Array<{ share_offers: boolean }>>('/rest/v1/user_settings?select=share_offers&limit=1');
    return Boolean(rows[0]?.share_offers);
  } catch {
    return false;
  }
}

async function handleShareOffers(value: boolean) {
  try {
    const session = await cloud.getSession();
    if (!session) return { ok: false, error: 'Sign in first.' };
    await cloud.json('/rest/v1/user_settings?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: session.user.id, share_offers: value, updated_at: new Date().toISOString() }),
    });
    return { ok: true };
  } catch (error) {
    return authError(error);
  }
}

async function handleFeedback(message: Extract<BackgroundMessage, { type: 'fillie:feedback' }>) {
  try {
    const session = await cloud.getSession();
    if (!session) return { ok: false, error: 'Sign in to send feedback.' };
    const rating = Number.isInteger(message.rating) && message.rating! >= 1 && message.rating! <= 5 ? message.rating : null;
    const text = message.message.trim().slice(0, 2000);
    if (!rating && !text) return { ok: false, error: 'Add a rating or a few words.' };
    await cloud.json('/rest/v1/feedback', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: session.user.id, rating, kind: message.kind, message: text }),
    });
    return { ok: true };
  } catch (error) {
    return authError(error);
  }
}

/** How many answers Fillie wrote and how many the user then had to change. Counts only, no content. */
async function handleQuality(filled: number, edited: number, device: DeviceSignals) {
  const safeFilled = Math.min(Math.max(Math.trunc(filled) || 0, 0), 500);
  const safeEdited = Math.min(Math.max(Math.trunc(edited) || 0, 0), safeFilled);
  if (!safeFilled || !isCloudConfigured()) return { ok: true };
  try {
    const session = await cloud.getSession();
    if (session) {
      await cloud.json('/rest/v1/usage_events', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ user_id: session.user.id, kind: 'quality', filled: safeFilled, edited: safeEdited }),
      });
    } else {
      await cloud.json('/functions/v1/trial', { method: 'POST', body: JSON.stringify({ action: 'report', ...device, filled: safeFilled, edited: safeEdited }) }, { anonymous: true });
    }
  } catch {
    /* analytics must never get in the way */
  }
  return { ok: true };
}

let backupTimer: ReturnType<typeof setTimeout> | null = null;
/** Debounced upload after the user's data changes. Only runs when signed in. */
function scheduleBackup(): void {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    void backups
      .upload()
      .then(async (r) => {
        if (r.ok) await storage.put(BACKUP_AT_KEY, Date.now());
      })
      .catch(() => undefined);
  }, 20_000);
}

async function dispatch(message: BackgroundMessage, sender?: chrome.runtime.MessageSender): Promise<unknown> {
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
    case 'fillie:account-status':
      return handleAccountStatus(message.device);
    case 'fillie:begin-run': {
      const state = await access.begin(await deviceSignals(message.device), message.url);
      // Free fillings are logged by the trial function; paid ones are logged here.
      if (state.allowed && state.plan === 'paid' && state.signedIn && isCloudConfigured()) {
        const session = await cloud.getSession();
        if (session) {
          void cloud
            .json('/rest/v1/usage_events', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: session.user.id, kind: 'fill' }) })
            .catch(() => undefined);
        }
      }
      return state;
    }
    case 'fillie:sign-in':
      return handleSignIn(message);
    case 'fillie:sign-in-oauth':
      return handleOAuth(message.provider);
    case 'fillie:auth-popup':
      // Test/diagnostic entry point: only our own pages (not content scripts) and only trusted hosts.
      if (!sender?.url?.startsWith(`chrome-extension://${sender.id}/`) || !/^(https:\/\/[^/]+\.supabase\.co\/|http:\/\/127\.0\.0\.1[:/])/.test(message.url)) return { ok: false };
      return openAuthPopup(message.url).then((url) => ({ ok: true, url }), (e: Error) => ({ ok: false, error: e.message }));
    case 'fillie:auth-callback':
      return handleAuthCallback(message.url, { id: sender?.id, url: sender?.url });
    case 'fillie:sign-out':
      await cloud.signOut();
      return { ok: true };
    case 'fillie:checkout':
      return handleCheckout(message.currency, message.codes);
    case 'fillie:checkout-quote':
      return handleCheckoutQuote(message.codes);
    case 'fillie:list-offers':
      return handleListOffers();
    case 'fillie:feedback':
      return handleFeedback(message);
    case 'fillie:set-share-offers':
      return handleShareOffers(message.value);
    case 'fillie:report-quality':
      return handleQuality(message.filled, message.edited, await deviceSignals(message.device));
    case 'fillie:open-app': {
      const api = (globalThis as { chrome?: typeof chrome }).chrome;
      const hash = /^#\/[a-z0-9/_-]*$/i.test(message.hash) ? message.hash : '';
      await api?.tabs?.create({ url: api.runtime.getURL(`pages/app.html${hash}`) });
      return { ok: true };
    }
    case 'fillie:open-account': {
      const api = (globalThis as { chrome?: typeof chrome }).chrome;
      await api?.tabs?.create({ url: api.runtime.getURL('pages/app.html#/account') });
      return { ok: true };
    }
    case 'fillie:refresh-payment': {
      const session = await cloud.getSession();
      if (session) {
        // Ask the server to check with the payment provider first, so a payment still shows up
        // even if the provider's webhook never reached us. Best effort: the licence check below decides.
        await cloud.json('/functions/v1/confirm-payment', { method: 'POST', body: '{}' }, { timeoutMs: 8000 }).catch(() => undefined);
        await access.isPaid(session.user.id, { force: true });
      }
      return handleAccountStatus(message.device);
    }
    case 'fillie:backup-now':
      return handleBackupNow();
    case 'fillie:restore-now':
      return handleRestoreNow();
    case 'fillie:apps-list':
      return applications.list(message.query satisfies ApplicationsRequest);
    case 'fillie:apps-save':
      return applications.save(message.app);
    case 'fillie:apps-summary':
      return applications.summary();
    case 'fillie:apps-delete':
      await applications.remove(message.id);
      return { ok: true };
    case 'fillie:apps-track':
      return handleTrack(message.context, message.resumeId, message.formText);
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
    dispatch(message as BackgroundMessage, _sender)
      .then(async (result) => {
        // The popup shows cached numbers; anything that could change them marks the cache stale.
        if (POPUP_DIRTYING.has(message.type)) await storage.put(POPUP_DIRTY_KEY, Date.now()).catch(() => undefined);
        sendResponse(result);
      })
      .catch((error: unknown) => {
        // Never leak a stack trace or an API key to the caller.
        const safe = error instanceof AIError ? error.message : 'Something went wrong inside Fillie.';
        sendResponse({ ok: false, error: safe });
      });
    return true; // keep the message channel open for the async response
  });
}

/** Keeps the worker alive long enough to answer a burst of messages. */
chromeApi?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return;
  const watched = [STORAGE_KEYS.profile, STORAGE_KEYS.memory, 'fillie:resumes'];
  if (watched.some((key) => key in changes)) scheduleBackup();
});

/**
 * Interview reminders: every 15 minutes the worker looks at the saved interviews and, for any that
 * are a day or an hour away, shows a notification once. They can be switched off in Settings > Privacy.
 */
async function runReminders(): Promise<void> {
  const notifications = chromeApi?.notifications;
  if (!notifications) return;
  await checkReminders({
    enabled: async () => (await storage.read<boolean>(REMINDERS_KEY)) !== false,
    upcoming: async () => (await applications.summary()).upcoming,
    readSent: async () => (await storage.read<SentMap>(REMINDERS_SENT_KEY)) ?? {},
    writeSent: (sent) => storage.put(REMINDERS_SENT_KEY, sent),
    notify: (id, title, message) =>
      notifications.create(id, { type: 'basic', iconUrl: chromeApi!.runtime.getURL('assets/icon-128.png'), title, message, priority: 1 }),
  }).catch(() => undefined);
}

function scheduleReminders(): void {
  chromeApi?.alarms?.create(REMINDER_ALARM, { delayInMinutes: 1, periodInMinutes: 15 });
}
scheduleReminders();
chromeApi?.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === REMINDER_ALARM) void runReminders();
});
chromeApi?.notifications?.onClicked?.addListener((id) => {
  if (!id.startsWith(NOTIFICATION_PREFIX)) return;
  void chromeApi?.tabs?.create({ url: chromeApi.runtime.getURL('pages/app.html#/database') });
  chromeApi?.notifications?.clear(id);
});

runtime?.onInstalled?.addListener(() => {
  storage.getSettings().catch(() => undefined);
  scheduleReminders();
});
runtime?.onStartup?.addListener(() => void runReminders());

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