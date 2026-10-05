import { AIError, type AIChatMessage, type AIProvider, type AIProviderConfig, type AIProviderId, type AIRequest, type AIResponse } from '../types';

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface ProviderDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Exponential backoff with jitter, capped so the UI never hangs. */
export function backoffDelay(attempt: number, baseMs = 700, capMs = 8000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jitter = exp * 0.25 * Math.random();
  return Math.round(exp + jitter);
}

/**
 * Pulls the provider's own explanation out of an error body.
 *
 * A bare "unexpected response (404)" is useless: for a hosted provider a 404 is
 * nearly always a specific, fixable fact — the model was retired, the model is
 * closed to new keys, or the base URL is wrong — and the body says which. Groq
 * even names the exact path it did not recognise.
 */
export function extractProviderReason(body: string): string {
  const raw = body.trim();
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string') text = parsed.error;
    else if (parsed.error && typeof parsed.error === 'object') {
      const message = (parsed.error as { message?: unknown }).message;
      if (typeof message === 'string') text = message;
    } else if (typeof parsed.message === 'string') {
      text = parsed.message;
    } else {
      // A JSON body with no message carries nothing a user can act on.
      return '';
    }
  } catch {
    // Not JSON — a proxy or gateway may return plain text. Use it as-is.
  }
  const clean = text.replace(/\s+/g, ' ').trim();
  // `{}` or a bare status is not a reason.
  if (!clean || clean === '{}' || clean === '[]') return '';
  return clean.slice(0, 300);
}

export function classifyHttpError(status: number, statusText: string): AIError {
  if (status === 401 || status === 403) {
    return new AIError('The AI provider rejected your API key.', 'auth', false, statusText);
  }
  if (status === 429) {
    return new AIError('The AI provider is rate limiting requests.', 'rate-limit', true, statusText);
  }
  if (status >= 500) {
    return new AIError('The AI provider is temporarily unavailable.', 'server', true, statusText);
  }
  return new AIError(`The AI provider returned an unexpected response (${status}).`, 'bad-response', false, statusText);
}

/**
 * Shared retry loop used by every hosted provider: retries 429/5xx/network
 * errors with backoff, but never retries auth or configuration problems.
 */
export async function withRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: { maxRetries: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    if (options.signal?.aborted) throw new AIError('Request cancelled.', 'aborted', false);
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof AIError ? error.retryable : false;
      if (!retryable || attempt === options.maxRetries) break;
      await sleep(backoffDelay(attempt));
    }
  }
  if (lastError instanceof AIError) throw lastError;
  throw new AIError('The AI request failed.', 'server', false, String(lastError));
}

export async function timedFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw new AIError('Request cancelled.', 'aborted', false);
    const message = error instanceof Error ? error.message : String(error);
    if (/abort/i.test(message)) {
      throw new AIError('The AI request timed out.', 'timeout', true, message);
    }
    throw new AIError('Could not reach the AI provider.', 'network', true, message);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

export function assertConfigured(config: AIProviderConfig): void {
  if (!config.baseUrl.trim()) {
    throw new AIError('No API base URL is configured for this provider.', 'not-configured');
  }
  if (!config.model.trim()) {
    throw new AIError('No model is configured for this provider.', 'not-configured');
  }
}

export function messagesToPrompt(messages: AIChatMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === 'system') return `### Instructions\n${message.content}`;
      if (message.role === 'user') return `### Request\n${message.content}`;
      return `### Previous response\n${message.content}`;
    })
    .join('\n\n');
}

export function extractJsonCandidates(text: string): string[] {
  // Strip out <think>...</think> blocks common in reasoning models
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const trimmed = text.trim();
  const source = stripped || trimmed;
  const candidates: string[] = [source];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = source.indexOf('{');
  const lastBrace = source.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(source.slice(firstBrace, lastBrace + 1));
  }

  const firstBracket = source.indexOf('[');
  const lastBracket = source.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(source.slice(firstBracket, lastBracket + 1));
  }

  return [...new Set(candidates.filter((c) => c.length > 1))];
}

/** Parses a model response into JSON, tolerating fences and prose around it. */
export function parseJsonLoose<T = unknown>(text: string): T | null {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * What a provider's keys look like, so an obviously-wrong one is caught before
 * a request is made.
 *
 * Providers answer a malformed key, a revoked key, a key from the wrong product
 * and a key with API restrictions identically — the same "API key not valid" —
 * so Fillie cannot tell those cases apart. It can at least notice a key that is
 * not this provider's shape at all, which is the most common paste mistake (one
 * provider's key into another's field) and is otherwise untraceable.
 */
const KEY_SHAPES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^AIza[0-9A-Za-z_-]{10,}$/, label: 'Google AI Studio' },
  { pattern: /^gsk_[0-9A-Za-z_-]{20,}$/, label: 'Groq' },
  { pattern: /^sk-or-v1-[0-9A-Za-z_-]{20,}$/, label: 'OpenRouter' },
];

/**
 * Describes a key that clearly belongs to a different provider, or returns
 * `null` when it could not be judged. Never returns the key itself.
 */
export function describeMismatchedKey(providerId: AIProviderId, apiKey: string): string | null {
  // Custom endpoints and offline mode accept any or no key format.
  if (providerId === 'openai-compatible' || providerId === 'offline') return null;

  const key = apiKey.trim().replace(/^["']|["']$/g, '');
  if (key.length < 12) return null;
  const match = KEY_SHAPES.find((shape) => shape.pattern.test(key));
  // Only speak up when we recognise the shape *and* it is not this provider's.
  if (!match) return null;
  if (match.label === 'Google AI Studio' && providerId === 'gemini') return null;
  if (match.label === 'Groq' && (providerId === 'groq' || providerId === 'cerebras')) return null;
  if (match.label === 'OpenRouter' && providerId === 'openrouter') return null;
  return match.label;
}

export async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 400);
  } catch {
    return response.statusText;
  }
}

/**
 * Builds the message shown when Test connection fails.
 *
 * The provider's own words come first, because they name the actual problem
 * ("This model ... is no longer available to new users", "Unknown request URL:
 * POST /openai/v1/...") while a status code alone cannot. Redacted first: an
 * error body can echo the request, and the key must never reach the screen.
 */
export function connectionErrorMessage(provider: AIProvider, error: unknown): string {
  const label = provider.label;
  if (error instanceof AIError) {
    if (error.kind === 'not-configured') return error.message;
    const reason = error.detail ? extractProviderReason(error.detail) : '';
    return `${label}: ${reason || error.message}`;
  }
  return `${label}: ${error instanceof Error ? error.message : 'Connection failed.'}`;
}

export function trimTo(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max - 1)}…` : input;
}

export type { AIProvider, AIProviderConfig, AIRequest, AIResponse };