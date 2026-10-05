import type { AIProviderConfig, AIProviderId } from '../types';

export interface ProviderPreset {
  id: AIProviderId;
  label: string;
  /** Compact name for chips, e.g. "Gemini". */
  shortLabel: string;
  /** Where the user obtains a free key. */
  signupUrl: string;
  docsUrl: string;
  defaultModel: string;
  defaultBaseUrl: string;
  requiresKey: boolean;
  /** Notes shown in the settings UI. */
  notes: string;
  freeTierNote: string;
  /** Placeholder hint for the API key field. */
  keyPlaceholder: string;
  jsonModeSupported: boolean;
  /** Optional override header, e.g. Groq/OpenRouter want extra headers. */
  extraHeaders?: Record<string, string>;
  openAiCompatible: boolean;
}

/**
 * All presets target permanently free hosted tiers. No paid fallback exists
 * anywhere in Fillie: if a key is missing or a quota is exhausted, Fillie falls
 * back to its offline deterministic engine instead of spending money.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'groq',
    label: 'Groq',
    shortLabel: 'Groq',
    signupUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs',
    // Groq shut down every free open model Fillie used to offer:
// `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` on 2026-08-16,
// `qwen/qwen3-32b` and `llama-4-scout` on 2026-07-17. See
// https://console.groq.com/docs/deprecations. What remains is priced per token,
// so this is no longer a free provider — GPT-OSS 20B is the cheapest and fastest
// of the survivors.
    defaultModel: 'openai/gpt-oss-20b',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    notes: 'Very fast hosted open models. Not free any more — see the note below.',
    freeTierNote: 'No longer free: Groq shut down its free open models. GPT-OSS 20B costs about $0.075 per 1M input tokens, so a typical form costs a fraction of a cent. Fillie never turns on billing for you.',
    keyPlaceholder: 'gsk_…',
    jsonModeSupported: true,
    openAiCompatible: true,
  },
  {
    id: 'gemini',
    label: 'Google AI Studio (Gemini)',
    shortLabel: 'Gemini',
    signupUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    // Gemini 2.5 is closed to new API keys: Google gates it to projects that
    // used it before the restriction, and a fresh key gets
    // 404 "This model models/gemini-2.5-flash is no longer available to new
    // users". 3.5 Flash-Lite is what Google's own docs recommend for new
    // projects, supports structured output, and is the cheapest Flash tier.
    defaultModel: 'gemini-3.5-flash-lite',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresKey: true,
    notes: 'Generous free quota and a 1M token context window.',
    freeTierNote: 'Free tier: rate limited (for example ~15 requests/min, ~1,500 requests/day). No credit card.',
    keyPlaceholder: 'AIza…',
    jsonModeSupported: true,
    openAiCompatible: false,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free models)',
    shortLabel: 'OpenRouter',
    signupUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs',
    // OpenRouter retires `:free` models often — every model Fillie used to ship
    // here was gone from the public catalog, and each 404s. Verified live
    // against https://openrouter.ai/api/v1/models.
    defaultModel: 'qwen/qwen3.8-27b:free',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    notes: 'Aggregates many free `:free` models behind one key.',
    freeTierNote: 'Free models: roughly 20 requests/min and 200 requests/day on the free tier. No credit card.',
    keyPlaceholder: 'sk-or-v1-…',
    jsonModeSupported: true,
    extraHeaders: {
      'HTTP-Referer': 'https://fillie.local',
      'X-Title': 'Fillie',
    },
    openAiCompatible: true,
  },
  {
    id: 'together',
    label: 'Together AI',
    shortLabel: 'Together',
    signupUrl: 'https://api.together.ai/settings/api-keys',
    docsUrl: 'https://docs.together.ai',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    requiresKey: true,
    notes: 'Free trial credits on new accounts, then pay-as-you-go.',
    freeTierNote: 'New accounts receive free credits. Set a spending limit if you continue past them.',
    keyPlaceholder: '…',
    jsonModeSupported: true,
    openAiCompatible: true,
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    shortLabel: 'Cerebras',
    signupUrl: 'https://cloud.cerebras.ai',
    docsUrl: 'https://inference-docs.cerebras.ai',
    defaultModel: 'llama-3.3-70b',
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    requiresKey: true,
    notes: 'Very fast hosted open models with a developer free tier.',
    freeTierNote: 'Developer tier: free for prototyping and low-volume use. No credit card to sign up.',
    keyPlaceholder: 'csk-…',
    jsonModeSupported: true,
    openAiCompatible: true,
  },
  {
    id: 'openai-compatible',
    label: 'Custom (OpenAI-compatible)',
    shortLabel: 'Custom',
    signupUrl: '',
    docsUrl: '',
    defaultModel: '',
    defaultBaseUrl: '',
    requiresKey: true,
    notes: 'Any OpenAI-compatible chat completions endpoint — self-hosted or otherwise.',
    freeTierNote: 'Bring your own endpoint. Fillie never ships a paid default here.',
    keyPlaceholder: 'API key',
    jsonModeSupported: true,
    openAiCompatible: true,
  },
  {
    id: 'offline',
    label: 'Offline engine (no AI)',
    shortLabel: 'Offline',
    signupUrl: '',
    docsUrl: '',
    defaultModel: 'offline-v1',
    defaultBaseUrl: '',
    requiresKey: false,
    notes: 'No network calls. Fills from your profile and learned answers only.',
    freeTierNote: 'Completely local. No questions are ever sent anywhere.',
    keyPlaceholder: '',
    jsonModeSupported: false,
    openAiCompatible: false,
  },
];

export function getPreset(id: AIProviderId): ProviderPreset {
  const found = PROVIDER_PRESETS.find((preset) => preset.id === id);
  if (!found) throw new Error(`Unknown provider preset: ${id}`);
  return found;
}

/** Models offered in the settings dropdown, purely a convenience list. */
export const SUGGESTED_MODELS: Record<AIProviderId, string[]> = {
  // Only models still listed as production on console.groq.com/docs/models.
  groq: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
  // Only current models. Anything Google has shut down or gated to legacy
  // projects is a dead end for a key obtained today.
  gemini: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.5-flash'],
  // Taken from the live OpenRouter catalog, which lists these as currently
  // available on the free tier.
  openrouter: [
    'qwen/qwen3.8-27b:free',
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
  ],
  together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'],
  cerebras: ['llama-3.3-70b', 'llama3.1-8b', 'qwen-3-32b'],
  'openai-compatible': [],
  offline: ['offline-v1'],
};

export function applyPresetDefaults(config: AIProviderConfig, id: AIProviderId): AIProviderConfig {
  const preset = getPreset(id);
  const currentProvider = config.provider;
  const currentKey = config.apiKey ? config.apiKey.trim().replace(/^["']|["']$/g, '').trim() : '';

  const apiKeys: Partial<Record<AIProviderId, string>> = { ...(config.apiKeys ?? {}) };
  if (currentKey) {
    apiKeys[currentProvider] = currentKey;
  }

  // Restore the saved key for the new provider, or start clean so foreign keys don't cause mismatch errors
  const newKey = apiKeys[id] ?? '';

  return {
    ...config,
    provider: id,
    model: preset.defaultModel,
    baseUrl: preset.defaultBaseUrl,
    jsonMode: preset.jsonModeSupported,
    apiKey: newKey,
    apiKeys,
  };
}

/**
 * Models that a newly issued API key can no longer call, per
 * https://ai.google.dev/gemini-api/docs/deprecations.
 *
 * `gemini-2.5-*` is gated to projects that used it before the restriction (a
 * valid key gets 404 "no longer available to new users"); `gemini-2.0-*` has
 * been shut down outright. Both used to be Fillie's default, so a stored
 * configuration can still name one long after the preset moved on.
 */
const RETIRED_MODELS: Record<string, RegExp[]> = {
  gemini: [/^gemini-2\.5-/, /^gemini-2\.0-/],
  // Every free open model Groq hosted is shut down; see their deprecation table.
  groq: [
    /^llama-3\.3-70b-versatile$/,
    /^llama-3\.1-8b-instant$/,
    /^qwen\/qwen3-32b$/,
    /^qwen\/qwen3\.6-27b$/,
    /^meta-llama\/llama-4-(scout|maverick)-/,
  ],
  openrouter: [/^meta-llama\/llama-3\.3-70b-instruct:free$/, /^google\/gemma-3-27b-it:free$/, /^deepseek\/deepseek-chat-v3-0324:free$/, /^mistralai\/mistral-small-3\.2-24b-instruct:free$/],
};

/**
 * Which provider each model-name shape belongs to.
 *
 * A model string is sent verbatim to whichever provider is selected, so a
 * `gemini-*` left in the Groq field makes Groq answer 404 — the user then sees
 * the same "unexpected response (404)" from every provider and concludes the
 * extension is broken. Repairing the mismatch on read is what stops one stale
 * field from poisoning the whole settings screen.
 */
const MODEL_OWNER: Array<{ pattern: RegExp; provider: AIProviderId }> = [
  { pattern: /^gemini-\d/i, provider: 'gemini' },
  // OpenRouter ids are `vendor/model:variant`; the `:free` suffix is what marks
  // them as OpenRouter's, since Cerebras and Together serve bare `llama-*` names.
  { pattern: /^[a-z0-9._-]+\/[a-z0-9._-]+:(free|beta|preview|think|online)$/i, provider: 'openrouter' },
];

/**
 * Upgrades a saved model that no longer exists to the provider's current
 * default.
 *
 * Settings are persisted per browser, so changing a preset's `defaultModel` only
 * helps a fresh install — anyone who already had the old model keeps it in
 * `chrome.storage.local` and gets a 404 forever, with no obvious cause. This
 * runs on every settings read so those users are moved onto a working model
 * automatically.
 *
 * Two repairs, in order of confidence:
 *  1. the model is known to be retired for this provider
 *  2. the model plainly belongs to a *different* provider
 *
 * A model the user chose that still exists on their provider is left untouched.
 */
export function migrateRetiredModel(config: AIProviderConfig): AIProviderConfig {
  const model = config.model.trim();
  if (!model) return { ...config, model: getPreset(config.provider).defaultModel };

  const retired = RETIRED_MODELS[config.provider]?.some((pattern) => pattern.test(model));
  const owner = MODEL_OWNER.find((entry) => entry.pattern.test(model))?.provider;
  const belongsElsewhere = owner !== undefined && owner !== config.provider;
  if (!retired && !belongsElsewhere) return config;

  const preset = getPreset(config.provider);
  return { ...config, model: preset.defaultModel };
}