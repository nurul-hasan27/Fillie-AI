import type { AIProvider, AIProviderConfig, AIProviderId } from '../types';
import { GeminiProvider } from './gemini';
import { OpenAICompatibleProvider } from './openai-compatible';
import { OfflineProvider } from './mock';
import type { FetchLike } from './shared';

export interface CreateProviderOptions {
  fetchImpl?: FetchLike;
  maxRetries?: number;
  /** Injected so tests do not pay real backoff delays. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Factory for the configured provider. The form engine only ever talks to this
 * interface, so switching providers is a settings change — never a code change.
 */
export function createProvider(config: AIProviderConfig, options: CreateProviderOptions = {}): AIProvider {
  switch (config.provider) {
    case 'gemini':
      return new GeminiProvider(config, options);
    case 'offline':
      return new OfflineProvider();
    case 'groq':
    case 'openrouter':
    case 'together':
    case 'cerebras':
    case 'openai-compatible':
      return new OpenAICompatibleProvider(config, options);
    default:
      throw new Error(`Unsupported provider: ${config.provider as AIProviderId}`);
  }
}

export { GeminiProvider, OpenAICompatibleProvider, OfflineProvider };