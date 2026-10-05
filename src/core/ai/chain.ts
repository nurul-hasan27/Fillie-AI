import {
  AIError,
  type AIProvider,
  type AIProviderConfig,
  type AIProviderId,
  type AIRequest,
  type AIResponse,
  type AISettings,
} from '../types';
import { createProvider, type CreateProviderOptions } from './factory';
import { getPreset } from './presets';

/**
 * Ranking used until the user reorders it in Settings. It is a static snapshot,
 * not a live benchmark: strongest instruction-following free model first,
 * weighted by how generous the free quota is. Gemini 3.5 Flash-Lite leads on
 * both; Cerebras and OpenRouter's free models follow; Groq (now pay-per-token)
 * and Together (trial credits) come after; a self-hosted endpoint is last.
 */
export const DEFAULT_PROVIDER_ORDER: AIProviderId[] = [
  'gemini',
  'cerebras',
  'openrouter',
  'groq',
  'together',
  'openai-compatible',
];

const RANKABLE = new Set<AIProviderId>(DEFAULT_PROVIDER_ORDER);

/** Drops unknown/duplicate ids and appends any provider the saved order lacks. */
export function normalizeProviderOrder(input: unknown): AIProviderId[] {
  const seen = new Set<AIProviderId>();
  const order: AIProviderId[] = [];
  if (Array.isArray(input)) {
    for (const id of input as AIProviderId[]) {
      if (RANKABLE.has(id) && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }
  for (const id of DEFAULT_PROVIDER_ORDER) if (!seen.has(id)) order.push(id);
  return order;
}

export interface ChainEntry {
  id: AIProviderId;
  label: string;
  config: AIProviderConfig;
}

/** True when this provider has everything it needs to be called. */
export function isProviderReady(id: AIProviderId, apiKey: string, model: string, baseUrl: string): boolean {
  if (id === 'offline') return false;
  if (!apiKey.trim()) return false;
  if (id === 'openai-compatible') return Boolean(model.trim() && baseUrl.trim());
  return true;
}

/** The ranked providers that have a key, ready to be tried in order. */
export function buildProviderChain(settings: AISettings): ChainEntry[] {
  if (!settings.enabled) return [];
  const keys = settings.config.apiKeys ?? {};
  const entries: ChainEntry[] = [];
  for (const id of settings.providerOrder) {
    const preset = getPreset(id);
    const apiKey = (keys[id] ?? '').trim();
    const model = settings.providerModels[id] || preset.defaultModel;
    const baseUrl = settings.providerBaseUrls[id] || preset.defaultBaseUrl;
    if (!isProviderReady(id, apiKey, model, baseUrl)) continue;
    entries.push({
      id,
      label: preset.shortLabel,
      config: { ...settings.config, provider: id, apiKey, model, baseUrl, jsonMode: preset.jsonModeSupported },
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Failover                                                            */
/* ------------------------------------------------------------------ */

const MINUTE = 60_000;

/** How long a failing provider is skipped, by why it failed. */
const COOLDOWN_MS: Partial<Record<AIError['kind'], number>> = {
  'rate-limit': 15 * MINUTE, // quota used up; free tiers reset per minute or per day
  auth: 60 * MINUTE,
  'not-configured': 60 * MINUTE,
  server: MINUTE,
  timeout: MINUTE,
  network: MINUTE,
  'bad-response': 5 * MINUTE,
};

/** Shared across calls so a provider that just ran dry is not retried each batch. */
const cooldowns = new Map<string, number>();

export function resetProviderCooldowns(): void {
  cooldowns.clear();
}

const cooldownKey = (entry: ChainEntry) => `${entry.id}:${entry.config.apiKey.slice(-6)}:${entry.config.model}`;

export interface FailoverOptions extends CreateProviderOptions {
  now?: () => number;
  /** Called when a provider is skipped, so the UI can say why. */
  onSwitch?: (from: ChainEntry, error: AIError) => void;
}

/**
 * Tries each provider in rank order. A provider that is out of quota, has a bad
 * key or is failing is put on cooldown and the next one answers. Only the last
 * provider keeps the user's retry-with-backoff setting; earlier ones fail fast
 * so the switch is immediate.
 */
export class FailoverProvider implements AIProvider {
  readonly label = 'Auto (ranked providers)';
  readonly requiresKey = true;
  private readonly providers: Array<{ entry: ChainEntry; provider: AIProvider }>;
  private readonly now: () => number;

  constructor(
    private readonly entries: ChainEntry[],
    private readonly options: FailoverOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.providers = entries.map((entry, index) => ({
      entry,
      provider: createProvider(entry.config, {
        ...options,
        maxRetries: index === entries.length - 1 ? options.maxRetries : 0,
      }),
    }));
  }

  get id(): AIProviderId {
    return this.entries[0]?.id ?? 'offline';
  }

  async complete(request: AIRequest): Promise<AIResponse> {
    const ready = this.providers.filter(({ entry }) => (cooldowns.get(cooldownKey(entry)) ?? 0) <= this.now());
    // Everything cooling down: try the one that recovers soonest rather than give up.
    const order = ready.length
      ? ready
      : [...this.providers].sort(
          (a, b) => (cooldowns.get(cooldownKey(a.entry)) ?? 0) - (cooldowns.get(cooldownKey(b.entry)) ?? 0),
        ).slice(0, 1);

    let lastError: unknown;
    for (const { entry, provider } of order) {
      try {
        const response = await provider.complete(request);
        return { ...response, provider: entry.id, providerLabel: entry.label };
      } catch (error) {
        if (error instanceof AIError && error.kind === 'aborted') throw error;
        lastError = error;
        if (error instanceof AIError) {
          cooldowns.set(cooldownKey(entry), this.now() + (COOLDOWN_MS[error.kind] ?? MINUTE));
          this.options.onSwitch?.(entry, error);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new AIError('No AI provider could answer.', 'server');
  }
}
