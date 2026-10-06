import type {
  ResumesState,
  AISettings,
  LearnedAnswer,
  UserProfile,
} from './types';
import { createEmptyProfile, normalizeProfile } from './profile';
import { getPreset, migrateRetiredModel } from './ai/presets';
import { DEFAULT_PROVIDER_ORDER, isProviderReady, normalizeProviderOrder } from './ai/chain';
import type { AIProviderId } from './types';

export interface StorageSchema {
  profile: UserProfile;
  memory: LearnedAnswer[];
  settings: AISettings;
  answerCache: Record<string, { text: string; createdAt: number }>;
  stats: { sessions: number; fieldsFilled: number; aiCalls: number; cacheHits: number };
}

export const DEFAULT_SETTINGS: AISettings = {
  enabled: true,
  config: {
    // Gemini, not Groq: Groq shut down every free model it used to host, so its
    // remaining ones are priced per token. Gemini still has a genuinely free
    // tier, which is what this extension is built around.
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    temperature: 0.2,
    maxOutputTokens: 2048,
    timeoutMs: 25_000,
    jsonMode: true,
  },
  batchSize: 16,
  maxRetries: 3,
  autoFillThreshold: 0.82,
  reviewThreshold: 0.62,
  debug: false,
  providerOrder: [...DEFAULT_PROVIDER_ORDER],
  providerModels: {},
  providerBaseUrls: {},
};

export const STORAGE_KEYS = {
  profile: 'fillie:profile',
  memory: 'fillie:memory',
  settings: 'fillie:settings',
  cache: 'fillie:answer-cache',
  stats: 'fillie:stats',
  resume: 'fillie:resume-text',
  resumes: 'fillie:resumes',
} as const;

type StorageArea = {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  clear(): Promise<void>;
};

/**
 * Storage abstraction: uses chrome.storage.local in the extension and an
 * in-memory implementation in tests / non-extension environments.
 */
export class Storage {
  private memoryArea: Record<string, unknown> = {};
  private listenerAttached = false;
  private listeners = new Set<(changes: Record<string, unknown>) => void>();

  private get area(): StorageArea | null {
    const chromeApi = (globalThis as { chrome?: { storage?: { local?: StorageArea } } }).chrome;
    return chromeApi?.storage?.local ?? null;
  }

  private async readAll(): Promise<StorageSchema> {
    const defaults: StorageSchema = {
      profile: createEmptyProfile(),
      memory: [],
      settings: DEFAULT_SETTINGS,
      answerCache: {},
      stats: { sessions: 0, fieldsFilled: 0, aiCalls: 0, cacheHits: 0 },
    };
    const area = this.area;
    if (!area) {
      return {
        profile: normalizeProfile(this.memoryArea[STORAGE_KEYS.profile]),
        memory: (this.memoryArea[STORAGE_KEYS.memory] as LearnedAnswer[]) ?? [],
        settings: { ...DEFAULT_SETTINGS, ...(this.memoryArea[STORAGE_KEYS.settings] as AISettings) },
        answerCache: (this.memoryArea[STORAGE_KEYS.cache] as StorageSchema['answerCache']) ?? {},
        stats: { ...defaults.stats, ...(this.memoryArea[STORAGE_KEYS.stats] as StorageSchema['stats']) },
      };
    }
    const stored = await area.get(Object.values(STORAGE_KEYS));
    return {
      profile: normalizeProfile(stored[STORAGE_KEYS.profile]),
      memory: (stored[STORAGE_KEYS.memory] as LearnedAnswer[]) ?? [],
      settings: mergeSettings(stored[STORAGE_KEYS.settings]),
      answerCache: (stored[STORAGE_KEYS.cache] as StorageSchema['answerCache']) ?? {},
      stats: { ...defaults.stats, ...(stored[STORAGE_KEYS.stats] as StorageSchema['stats']) },
    };
  }

  async getProfile(): Promise<UserProfile> {
    return (await this.readAll()).profile;
  }

  async saveProfile(profile: UserProfile): Promise<UserProfile> {
    const normalized = normalizeProfile({ ...profile, updatedAt: Date.now() });
    await this.write(STORAGE_KEYS.profile, normalized);
    return normalized;
  }

  async getMemory(): Promise<LearnedAnswer[]> {
    return (await this.readAll()).memory;
  }

  async saveMemory(memory: LearnedAnswer[]): Promise<LearnedAnswer[]> {
    await this.write(STORAGE_KEYS.memory, memory);
    return memory;
  }

  /** Generic keyed access for modules that own their own storage key. */
  async read<T>(key: string): Promise<T | undefined> {
    const area = this.area;
    const stored = area ? await area.get([key]) : { [key]: this.memoryArea[key] };
    return stored[key] as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.write(key, value);
  }

  async drop(key: string): Promise<void> {
    const area = this.area;
    if (area) await area.remove([key]);
    else delete this.memoryArea[key];
  }

  /**
   * Named resumes. A single resume saved by an earlier version (under
   * `fillie:resume-text`) is adopted as "Main" the first time this is read.
   */
  async getResumes(): Promise<ResumesState> {
    const area = this.area;
    const stored = area
      ? await area.get([STORAGE_KEYS.resumes, STORAGE_KEYS.resume])
      : { [STORAGE_KEYS.resumes]: this.memoryArea[STORAGE_KEYS.resumes], [STORAGE_KEYS.resume]: this.memoryArea[STORAGE_KEYS.resume] };
    const saved = stored[STORAGE_KEYS.resumes] as ResumesState | undefined;
    if (saved && Array.isArray(saved.resumes)) {
      const defaultId = saved.resumes.some((r) => r.id === saved.defaultId) ? saved.defaultId : saved.resumes[0]?.id ?? '';
      return { resumes: saved.resumes, defaultId };
    }
    const legacy = stored[STORAGE_KEYS.resume];
    if (typeof legacy === 'string' && legacy.trim()) {
      return { resumes: [{ id: 'resume-main', name: 'Main', text: legacy, updatedAt: Date.now() }], defaultId: 'resume-main' };
    }
    // The old Documents page is gone. Any resume uploaded there, with readable text, becomes a
    // resume here (and is kept for good the next time the user saves).
    const documents = (await this.getProfile()).documents ?? [];
    const imported = documents
      .filter((doc) => doc.category === 'resume' && doc.textContent?.trim())
      .map((doc) => ({ id: `doc:${doc.id}`, name: (doc.name || doc.fileName).slice(0, 40), text: doc.textContent as string, updatedAt: doc.updatedAt }));
    const first = documents.find((doc) => doc.isDefault && imported.some((r) => r.id === `doc:${doc.id}`));
    return { resumes: imported, defaultId: first ? `doc:${first.id}` : imported[0]?.id ?? '' };
  }

  async saveResumes(state: ResumesState): Promise<ResumesState> {
    const resumes = state.resumes.slice(0, 20).map((r) => ({
      id: r.id,
      name: (r.name || 'Untitled').trim().slice(0, 40),
      text: String(r.text ?? '').slice(0, 60_000),
      updatedAt: r.updatedAt || Date.now(),
    }));
    const defaultId = resumes.some((r) => r.id === state.defaultId) ? state.defaultId : resumes[0]?.id ?? '';
    const next = { resumes, defaultId };
    await this.write(STORAGE_KEYS.resumes, next);
    // The legacy single-resume key must not resurrect a resume the user deleted.
    await this.write(STORAGE_KEYS.resume, '');
    return next;
  }

  /** Everything the user can pick as "the resume for this application". */
  async getResumeChoices(): Promise<ResumesState> {
    return this.getResumes();
  }

  /** Text of the resume with this id; '' for 'none', the default when omitted. */
  async getResumeText(id?: string): Promise<string> {
    if (id === 'none') return '';
    const { resumes, defaultId } = await this.getResumeChoices();
    return (resumes.find((r) => r.id === (id || defaultId)) ?? resumes.find((r) => r.id === defaultId))?.text ?? '';
  }

  /** The display name of a resume choice ('' for none / unknown). */
  async getResumeName(id?: string): Promise<string> {
    if (id === 'none') return '';
    const { resumes, defaultId } = await this.getResumeChoices();
    return (resumes.find((r) => r.id === (id || defaultId)) ?? resumes.find((r) => r.id === defaultId))?.name ?? '';
  }

  async getSettings(): Promise<AISettings> {
    return (await this.readAll()).settings;
  }

  async saveSettings(settings: AISettings): Promise<AISettings> {
    const merged = mergeSettings(settings);
    await this.write(STORAGE_KEYS.settings, merged);
    return merged;
  }

  async getCache(): Promise<StorageSchema['answerCache']> {
    return (await this.readAll()).answerCache;
  }

  async setCacheEntry(key: string, text: string): Promise<void> {
    const cache = await this.getCache();
    cache[key] = { text, createdAt: Date.now() };
    this.pruneCache(cache);
    await this.write(STORAGE_KEYS.cache, cache);
  }

  async clearCache(): Promise<void> {
    await this.write(STORAGE_KEYS.cache, {});
  }

  async getStats(): Promise<StorageSchema['stats']> {
    return (await this.readAll()).stats;
  }

  /** Additive counter updates — callers pass deltas, never absolute totals. */
  async bumpStats(patch: Partial<StorageSchema['stats']>): Promise<void> {
    const stats = await this.getStats();
    const next: StorageSchema['stats'] = { ...stats };
    for (const [key, delta] of Object.entries(patch)) {
      const value = Number(delta);
      if (Number.isFinite(value)) next[key as keyof StorageSchema['stats']] += value;
    }
    await this.write(STORAGE_KEYS.stats, next);
  }

  async exportAll(): Promise<StorageSchema> {
    return this.readAll();
  }

  async importAll(data: Partial<StorageSchema>): Promise<StorageSchema> {
    if (data.profile) await this.write(STORAGE_KEYS.profile, normalizeProfile(data.profile));
    if (Array.isArray(data.memory)) await this.write(STORAGE_KEYS.memory, data.memory);
    if (data.settings) await this.write(STORAGE_KEYS.settings, mergeSettings(data.settings));
    if (data.stats) await this.write(STORAGE_KEYS.stats, data.stats);
    return this.readAll();
  }

  async clearAll(): Promise<void> {
    await this.write(STORAGE_KEYS.profile, createEmptyProfile());
    await this.write(STORAGE_KEYS.memory, []);
    await this.write(STORAGE_KEYS.resume, '');
    await this.write(STORAGE_KEYS.resumes, { resumes: [], defaultId: '' });
    await this.write(STORAGE_KEYS.cache, {});
    await this.write(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
    await this.write(STORAGE_KEYS.stats, { sessions: 0, fieldsFilled: 0, aiCalls: 0, cacheHits: 0 });
  }

  subscribe(listener: (changes: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    const chromeApi = (globalThis as { chrome?: { storage?: { onChanged?: { addListener: (cb: (changes: Record<string, unknown>) => void) => void } } } }).chrome;
    if (!this.listenerAttached && chromeApi?.storage?.onChanged) {
      this.listenerAttached = true;
      chromeApi.storage.onChanged.addListener((changes) => {
        for (const listener2 of this.listeners) listener2(changes);
      });
    }
    return () => this.listeners.delete(listener);
  }

  private async write(key: string, value: unknown): Promise<void> {
    const area = this.area;
    if (!area) {
      this.memoryArea[key] = value;
      for (const listener of this.listeners) listener({ [key]: { newValue: value } });
      return;
    }
    await area.set({ [key]: value });
  }

  private pruneCache(cache: StorageSchema['answerCache']): void {
    const entries = Object.entries(cache).sort((a, b) => b[1].createdAt - a[1].createdAt);
    for (const [key] of entries.slice(400)) delete cache[key];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [key, entry] of Object.entries(cache)) {
      if (entry.createdAt < cutoff) delete cache[key];
    }
  }
}

export function mergeSettings(input: unknown): AISettings {
  const raw = (input ?? {}) as Partial<AISettings> & { config?: Partial<AISettings['config']> };
  const rawConfig = (raw.config ?? {}) as Partial<AISettings['config']>;
  const clean = (value: unknown) =>
    typeof value === 'string' ? value.trim().replace(/^["']|["']$/g, '').trim() : '';
  const cleanApiKey = typeof rawConfig.apiKey === 'string' ? clean(rawConfig.apiKey) : DEFAULT_SETTINGS.config.apiKey;

  const mergedConfig = {
    ...DEFAULT_SETTINGS.config,
    ...rawConfig,
    apiKey: cleanApiKey,
  };

  // Keys are kept per provider. A key saved by an older version only lived in
  // `config.apiKey`, so it is adopted once; after that the map is authoritative
  // and an emptied entry stays empty.
  const apiKeys: Partial<Record<AIProviderId, string>> = {};
  for (const [id, value] of Object.entries(rawConfig.apiKeys ?? {})) apiKeys[id as AIProviderId] = clean(value);
  if (!(mergedConfig.provider in apiKeys) && cleanApiKey) apiKeys[mergedConfig.provider] = cleanApiKey;

  const providerOrder = normalizeProviderOrder(raw.providerOrder);
  const providerModels: Partial<Record<AIProviderId, string>> = {};
  const providerBaseUrls: Partial<Record<AIProviderId, string>> = {};
  for (const id of providerOrder) {
    const preset = getPreset(id);
    const legacyModel = id === mergedConfig.provider ? mergedConfig.model : '';
    const model = (raw.providerModels?.[id] ?? '').trim() || legacyModel.trim() || preset.defaultModel;
    providerModels[id] = migrateRetiredModel({ ...mergedConfig, provider: id, model }).model;
    const legacyUrl = id === mergedConfig.provider ? mergedConfig.baseUrl : '';
    providerBaseUrls[id] = (raw.providerBaseUrls?.[id] ?? '').trim() || legacyUrl.trim() || preset.defaultBaseUrl;
  }

  // `config` mirrors the highest-ranked provider that is ready to use, so the
  // single-provider fields the rest of the extension reads stay truthful.
  const primary = providerOrder.find((id) =>
    isProviderReady(id, apiKeys[id] ?? '', providerModels[id] ?? '', providerBaseUrls[id] ?? ''),
  );
  const active = primary ?? mergedConfig.provider;
  const config = migrateRetiredModel({
    ...mergedConfig,
    provider: active,
    model: primary ? (providerModels[primary] as string) : mergedConfig.model,
    baseUrl: primary ? (providerBaseUrls[primary] as string) : mergedConfig.baseUrl,
    apiKey: apiKeys[active] ?? '',
    apiKeys,
  });
  return {
    // The old "Offline engine" provider choice is now simply "hosted AI off".
    enabled: rawConfig.provider === 'offline' ? false : typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
    config,
    batchSize: clampNumber(raw.batchSize, 1, 20, DEFAULT_SETTINGS.batchSize),
    maxRetries: clampNumber(raw.maxRetries, 0, 6, DEFAULT_SETTINGS.maxRetries),
    autoFillThreshold: clampNumber(raw.autoFillThreshold, 0, 1, DEFAULT_SETTINGS.autoFillThreshold),
    reviewThreshold: clampNumber(raw.reviewThreshold, 0, 1, DEFAULT_SETTINGS.reviewThreshold),
    debug: typeof raw.debug === 'boolean' ? raw.debug : DEFAULT_SETTINGS.debug,
    providerOrder,
    providerModels,
    providerBaseUrls,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export const storage = new Storage();