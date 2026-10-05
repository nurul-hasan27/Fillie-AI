import { describe, expect, it, vi } from 'vitest';
import { AIError, type AIProviderConfig } from '../../src/core/types';
import { OpenAICompatibleProvider } from '../../src/core/ai/openai-compatible';
import { GeminiProvider } from '../../src/core/ai/gemini';
import { createProvider } from '../../src/core/ai/factory';
import { backoffDelay, parseJsonLoose, withRetries, classifyHttpError, extractProviderReason } from '../../src/core/ai/shared';
import { applyPresetDefaults, getPreset, migrateRetiredModel, PROVIDER_PRESETS, SUGGESTED_MODELS } from '../../src/core/ai/presets';

function config(overrides: Partial<AIProviderConfig> = {}): AIProviderConfig {
  return {
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'test-key',
    temperature: 0.2,
    maxOutputTokens: 500,
    timeoutMs: 5000,
    jsonMode: true,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const request = { messages: [{ role: 'user' as const, content: 'hello' }] };

describe('provider factory', () => {
  it('builds a provider for every preset', () => {
    for (const preset of PROVIDER_PRESETS) {
      const provider = createProvider(
        config({ provider: preset.id, model: preset.defaultModel || 'm', baseUrl: preset.defaultBaseUrl || 'x' }),
        { fetchImpl: async () => jsonResponse({}), maxRetries: 0 },
      );
      expect(provider.id).toBe(preset.id);
      expect(provider.label).toBe(preset.label);
      expect(provider.requiresKey).toBe(preset.requiresKey);
    }
  });

  it('exposes free-tier notes for every keyed provider', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.freeTierNote.length).toBeGreaterThan(10);
    }
  });

  it('only offers free hosted services and an offline engine', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(ids).toContain('groq');
    expect(ids).toContain('gemini');
    expect(ids).toContain('openrouter');
    expect(ids).toContain('offline');
    expect(ids).not.toContain('openai');
    expect(ids).not.toContain('anthropic');
  });

  it('provides suggested models per provider', () => {
    expect(SUGGESTED_MODELS.groq.length).toBeGreaterThan(0);
    expect(getPreset('gemini').defaultModel).toContain('gemini');
  });

  /**
   * Google closed the Gemini 2.5 family to API keys issued after the
   * restriction. A fresh key that asks for `gemini-2.5-flash` gets
   * `404 This model models/gemini-2.5-flash is no longer available to new
   * users` — a 404 that looks like a bad endpoint but is really a gated model.
   *
   * https://ai.google.dev/gemini-api/docs/deprecations
   * says the 2.5 models "are not deprecated and will continue to be served…
   * For any new projects, use our latest models: 3.5 Flash-Lite or 3.8 Flash."
   */
  it('does not ship a Gemini model that is closed to new API keys', () => {
    // Every model Fillie offers must be one a key created today can actually
    // call, so the preset can never point a new user at a gated model.
    const GATED_OR_SHUT_DOWN = [
      /^gemini-2\.5-/,
      /^gemini-2\.0-/,
      /^imagen-4/,
      /preview-\d/,
      /^gemini-3-pro-preview/,
      /^gemini-3\.1-flash-lite-preview/,
    ];
    const offered = [getPreset('gemini').defaultModel, ...SUGGESTED_MODELS.gemini];
    for (const model of offered) {
      for (const pattern of GATED_OR_SHUT_DOWN) {
        expect(pattern.test(model), `${model} is not available to a newly issued API key`).toBe(false);
      }
    }
  });

  it('offers no Groq model that Groq has shut down', () => {
    // Shutdown dates from https://console.groq.com/docs/deprecations.
    const shutDown = [
      'llama-3.3-70b-versatile', // 08/16/26
      'llama-3.1-8b-instant', // 08/16/26
      'qwen/qwen3-32b', // 07/17/26
      'qwen/qwen3.6-27b', // 09/14/26
      'meta-llama/llama-4-scout-17b-16e-instruct', // 07/17/26
      'meta-llama/llama-4-maverick-17b-128e-instruct', // 03/09/26
    ];
    const offered = [getPreset('groq').defaultModel, ...SUGGESTED_MODELS.groq];
    for (const model of shutDown) expect(offered, `${model} is shut down on Groq`).not.toContain(model);
  });

  it('migrates a Groq model that Groq has shut down', () => {
    for (const dead of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen/qwen3-32b', 'qwen/qwen3.6-27b']) {
      expect(migrateRetiredModel({ ...config(), provider: 'groq', model: dead }).model).toBe(
        getPreset('groq').defaultModel,
      );
    }
    // A current production model is untouched.
    const live = { ...config(), provider: 'groq' as const, model: 'openai/gpt-oss-120b' };
    expect(migrateRetiredModel(live)).toBe(live);
  });

  it('does not claim Groq is free any more', () => {
    // Every free open model Groq hosted has been shut down, so the old
    // "free tier, no credit card" wording would be a false promise.
    const preset = getPreset('groq');
    expect(preset.freeTierNote.toLowerCase()).not.toMatch(/\bno credit card\b/);
    expect(preset.freeTierNote.toLowerCase()).toMatch(/no longer free|shut down/);
  });

  it('defaults Gemini to a model its own docs recommend for new projects', () => {
    const preset = getPreset('gemini');
    expect(preset.defaultModel).toBe('gemini-3.5-flash-lite');
    // The endpoint shape Google documents, unchanged.
    expect(preset.defaultBaseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  /**
   * The preset fix alone was not enough: settings persist per browser, so a
   * stored `gemini-2.5-flash` outlived the preset that named it. These cover the
   * migration that moves an existing installation onto a working model.
   */
  it('migrates a retired stored model to the current default', () => {
    for (const retired of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']) {
      expect(migrateRetiredModel({ ...config(), provider: 'gemini', model: retired }).model).toBe(
        getPreset('gemini').defaultModel,
      );
    }
  });

  it('leaves a live model and other providers alone', () => {
    const live = { ...config(), provider: 'gemini' as const, model: 'gemini-3.8-flash' };
    expect(migrateRetiredModel(live)).toBe(live);
    // A model still on the provider the user selected stays as they set it.
    const groq = { ...config(), provider: 'groq' as const, model: 'openai/gpt-oss-120b' };
    expect(migrateRetiredModel(groq)).toBe(groq);
  });

  /**
   * A model name belonging to one provider, sent to another, makes that
   * provider answer 404. Because the field is shared, one stale model made
   * *every* provider fail the same way.
   */
  it('repairs a model left behind from a different provider', () => {
    // The reported case: Groq selected, a Gemini model still in the field.
    expect(migrateRetiredModel({ ...config(), provider: 'groq', model: 'gemini-3.5-flash-lite' }).model).toBe(
      getPreset('groq').defaultModel,
    );
    // OpenRouter ids are unmistakable, in either direction.
    expect(migrateRetiredModel({ ...config(), provider: 'gemini', model: 'qwen/qwen3.8-27b:free' }).model).toBe(
      getPreset('gemini').defaultModel,
    );
    expect(migrateRetiredModel({ ...config(), provider: 'openrouter', model: 'gemini-3.5-flash-lite' }).model).toBe(
      getPreset('openrouter').defaultModel,
    );
  });

  it('leaves ambiguous llama-* names alone', () => {
    // Groq, Cerebras and Together all serve `llama-*` names, so ownership cannot
    // be decided from the shape alone. Only an explicit retired-model entry
    // rewrites one; the provider's own error message covers the rest.
    const cerebras = { ...config(), provider: 'cerebras' as const, model: 'llama-3.3-70b' };
    expect(migrateRetiredModel(cerebras)).toBe(cerebras);
  });

  it('migrates OpenRouter models that have left the free tier', () => {
    for (const retired of [
      'meta-llama/llama-3.3-70b-instruct:free',
      'google/gemma-3-27b-it:free',
      'deepseek/deepseek-chat-v3-0324:free',
      'mistralai/mistral-small-3.2-24b-instruct:free',
    ]) {
      expect(migrateRetiredModel({ ...config(), provider: 'openrouter', model: retired }).model).toBe(
        getPreset('openrouter').defaultModel,
      );
    }
    // A currently-listed free model is untouched.
    const live = { ...config(), provider: 'openrouter' as const, model: 'google/gemma-4-31b-it:free' };
    expect(migrateRetiredModel(live)).toBe(live);
  });

  it('offers no OpenRouter model that has left the free tier', () => {
    // Every model in this list was verified absent from
    // https://openrouter.ai/api/v1/models when this was written.
    const gone = [
      'meta-llama/llama-3.3-70b-instruct:free',
      'google/gemma-3-27b-it:free',
      'deepseek/deepseek-chat-v3-0324:free',
      'mistralai/mistral-small-3.2-24b-instruct:free',
    ];
    const offered = [getPreset('openrouter').defaultModel, ...SUGGESTED_MODELS.openrouter];
    for (const model of gone) expect(offered).not.toContain(model);
    for (const model of offered) expect(model.endsWith(':free')).toBe(true);
  });
});

describe('OpenAI-compatible provider', () => {
  it('sends a chat completion and returns the text', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        model: 'openai/gpt-oss-20b',
        choices: [{ message: { content: '{"fields":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const provider = new OpenAICompatibleProvider(config(), { fetchImpl, maxRetries: 0 });
    const response = await provider.complete({ ...request, json: true });
    expect(response.text).toBe('{"fields":[]}');
    expect(response.usage?.inputTokens).toBe(10);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(init.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('refuses to run without a key', async () => {
    const provider = new OpenAICompatibleProvider(config({ apiKey: '  ' }), { maxRetries: 0 });
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'not-configured' });
  });

  it('surfaces an authentication error without retrying', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'bad key' }, false, 401));
    const provider = new OpenAICompatibleProvider(config(), { fetchImpl, maxRetries: 3 });
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'auth' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a rate limit with backoff then gives up cleanly', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'slow down' }, false, 429));
    const sleeps: number[] = [];
    const provider = new OpenAICompatibleProvider(config(), {
      fetchImpl,
      maxRetries: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const error = await provider.complete(request).catch((caught: unknown) => caught as AIError);
    expect(error).toBeInstanceOf(AIError);
    expect((error as AIError).kind).toBe('rate-limit');
    // Two retries: three attempts in total, two backoff waits in between.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
  });

  it('reports an empty response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '   ' } }] }));
    const provider = new OpenAICompatibleProvider(config(), { fetchImpl, maxRetries: 0 });
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'bad-response' });
  });

  it('maps a server error to a retryable failure', () => {
    expect(classifyHttpError(500, 'boom').retryable).toBe(true);
    expect(classifyHttpError(429, '').retryable).toBe(true);
    expect(classifyHttpError(400, '').retryable).toBe(false);
  });
});

describe('Gemini provider', () => {
  it('calls generateContent and unwraps the parts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"answer":"hi"}' }] } }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 },
      }),
    );
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'AIza-test' }),
      { fetchImpl, maxRetries: 0 },
    );
    const response = await provider.complete({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ],
      json: true,
    });
    expect(response.text).toBe('{"answer":"hi"}');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('models/gemini-2.5-flash:generateContent');
    expect(url).toContain('key=AIza-test');
    const body = JSON.parse(String(init.body));
    expect(body.systemInstruction.parts[0].text).toBe('be brief');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('requires a key', async () => {
    const provider = new GeminiProvider(config({ provider: 'gemini', apiKey: '' }), { maxRetries: 0 });
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'not-configured' });
  });

  it('reports the missing key with the message the settings screen promises', async () => {
    // Requirement: an empty key must still produce this exact message, so the
    // two states (no key, rejected key) stay distinguishable to the user.
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '   ' }),
      { maxRetries: 0 },
    );
    const error = await provider.complete(request).catch((caught: unknown) => caught as AIError);
    expect((error as AIError).kind).toBe('not-configured');
    expect((error as AIError).message).toBe('Add a Google AI Studio API key in Settings → AI.');
  });

  it('reaches the HTTP layer once a key is configured', async () => {
    // A key saved through settings must arrive intact, or every request fails
    // locally and the user is told to add a key they already entered.
    const fetchImpl = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'ready' }] } }] }));
    const provider = createProvider(
      config({
        provider: 'gemini',
        model: 'gemini-3.5-flash-lite',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'saved-key',
      }),
      { fetchImpl, maxRetries: 0 },
    );

    const response = await provider.complete(request);
    expect(response.provider).toBe('gemini');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The key travels as the query parameter the Gemini v1beta API requires.
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent')).toBe(true);
    expect(url).toContain('key=saved-key');
  });

  /**
   * The 404 that made Test connection fail was a *gated model*, not a bad
   * endpoint: Google returns this body for a model a new key may not call. The
   * adapter must pass it through rather than swallow it, so the user can tell
   * "wrong model" from "wrong endpoint" and retry.
   */
  it('reports a gated model as an error that names the model', async () => {
    const gated = {
      error: {
        code: 404,
        message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use a newer model.',
        status: 'NOT_FOUND',
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse(gated, false, 404));
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'a-real-shaped-key' }),
      { fetchImpl, maxRetries: 0 },
    );

    const error = await provider.complete(request).catch((caught: unknown) => caught as AIError);
    expect(error).toBeInstanceOf(AIError);
    // 404 is not retryable: retrying a gated model can never succeed.
    expect((error as AIError).retryable).toBe(false);
    // Google's own reason is preserved in `detail` for the UI to show.
    expect((error as AIError).detail ?? '').toMatch(/no longer available to new users/i);
    // The key is not echoed anywhere in the error.
    expect((error as AIError).message).not.toContain('a-real-shaped-key');
    expect((error as AIError).detail ?? '').not.toContain('a-real-shaped-key');

    const health = await provider.testConnection!();
    expect(health.ok).toBe(false);
  });

  it('surfaces a rejected key as an auth error rather than a missing key', async () => {
    // Google said the key was wrong. That must reach the user as Google's
    // classified error, never as Fillie's local "add a key" message.
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'API key not valid' } }, false, 400));
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'wrong-key' }),
      { fetchImpl, maxRetries: 0 },
    );

    const error = await provider.complete(request).catch((caught: unknown) => caught as AIError);
    expect(error).toBeInstanceOf(AIError);
    expect((error as AIError).kind).not.toBe('not-configured');
    expect((error as AIError).message).not.toMatch(/add a google ai studio api key/i);
    // The key must not be echoed back inside the error message.
    expect((error as AIError).message).not.toContain('wrong-key');
    expect((error as AIError).detail ?? '').not.toContain('wrong-key');
  });

  /**
   * A key pasted from a browser or console almost always arrives with a trailing
   * newline. Sent verbatim it became `?key=AIza…%0A`, and Google answered
   * `API_KEY_INVALID` — indistinguishable from a genuinely wrong key, and
   * impossible to fix without knowing to delete a character you cannot see in a
   * password field.
   */
  it('trims whitespace a pasted key arrived with', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'ready' }] } }] }));
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-3.5-flash-lite', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '  AIza-real-key\n' }),
      { fetchImpl, maxRetries: 0 },
    );

    const response = await provider.complete(request);
    expect(response.text).toBe('ready');

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url.endsWith('?key=AIza-real-key')).toBe(true);
    expect(url).not.toContain('%0A');
    expect(url).not.toContain('%20');
  });

  it('trims a pasted key for OpenAI-compatible providers too', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'ready' } }] }));
    const provider = new OpenAICompatibleProvider(config({ apiKey: 'gsk-real-key \n' }), { fetchImpl, maxRetries: 0 });

    await provider.complete(request);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk-real-key');
  });

  it('still treats a whitespace-only key as missing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-3.5-flash-lite', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '  \n  ' }),
      { fetchImpl, maxRetries: 0 },
    );
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'not-configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a rejected key from testConnection instead of succeeding', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'API key not valid' } }, false, 400));
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'wrong-key' }),
      { fetchImpl, maxRetries: 0 },
    );

    const health = await provider.testConnection!();
    expect(health.ok).toBe(false);
    expect(health.message).not.toMatch(/add a google ai studio api key/i);
    expect(health.message).not.toContain('wrong-key');
  });

  it('reports a truncated answer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }));
    const provider = new GeminiProvider(config({ provider: 'gemini', apiKey: 'k' }), { fetchImpl, maxRetries: 0 });
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'bad-response' });
  });
});

/**
 * A bare "unexpected response (404)" gave the user nothing to act on, while the
 * provider's body said exactly what was wrong. These lock in that the reason
 * reaches the screen.
 */
describe('connection errors explain themselves', () => {
  const notFound = {
    error: { message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use a newer model.' },
  };

  it('shows the provider’s own reason for a 404', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(notFound, false, 404));
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'secret-key-value' }),
      { fetchImpl, maxRetries: 0 },
    );
    const health = await provider.testConnection!();
    expect(health.ok).toBe(false);
    // The actionable text, not just a status code.
    expect(health.message).toMatch(/no longer available to new users/i);
    expect(health.message).toContain('Google AI Studio');
    // And it must not leak the key back at the user.
    expect(health.message).not.toContain('secret-key-value');
  });

  it('shows which path a provider did not recognise', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'Unknown request URL: POST /openai/v1/wrong/path/chat/completions. Please check the URL for typos.' } }, false, 404),
    );
    const provider = createProvider(config({ provider: 'groq' }), { fetchImpl, maxRetries: 0 });
    const health = await provider.testConnection!();
    expect(health.ok).toBe(false);
    expect(health.message).toMatch(/unknown request url/i);
    expect(health.message).toContain('Groq');
  });

  it('still uses the plain wording when a provider gives no reason', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 404));
    const provider = createProvider(config({ provider: 'groq' }), { fetchImpl, maxRetries: 0 });
    const health = await provider.testConnection!();
    expect(health.ok).toBe(false);
    // Falls back to the status wording, still naming the provider.
    expect(health.message).toContain('Groq');
    expect(health.message).toMatch(/404/);
  });

  it('keeps the missing-key wording distinct and actionable', async () => {
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-3.5-flash-lite', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '' }),
      { maxRetries: 0 },
    );
    const health = await provider.testConnection!();
    expect(health.ok).toBe(false);
    expect(health.message).toBe('Add a Google AI Studio API key in Settings → AI.');
  });

  it('reads a plain-text error body as well as JSON', () => {
    expect(extractProviderReason('{"error":{"message":"Model not found"}}')).toBe('Model not found');
    expect(extractProviderReason('{"message":"nope"}')).toBe('nope');
    expect(extractProviderReason('{"error":"flat string"}')).toBe('flat string');
    expect(extractProviderReason('<html>gateway timeout</html>')).toBe('<html>gateway timeout</html>');
  });
});

/**
 * Groq's remaining models are all *reasoning* models: they emit a chain of
 * thought and only then the answer. With the old 12-token probe budget the
 * reasoning consumed the entire allowance, `content` came back empty, and a
 * perfectly working provider was reported as broken.
 */
describe('reasoning models', () => {
  const reasoningOnly = {
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '', reasoning: 'The user wants one word: ready.' },
        finish_reason: 'length',
      },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 12 },
  };

  it('gives the connection probe enough budget to finish reasoning', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'ready' } }] }));
    const provider = new OpenAICompatibleProvider(
      config({ provider: 'groq', model: 'openai/gpt-oss-20b' }),
      { fetchImpl, maxRetries: 0 },
    );
    await provider.testConnection!();
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    // 12 tokens left no room for an answer after the reasoning.
    expect(body.max_tokens).toBeGreaterThanOrEqual(256);
  });

  it('explains a budget problem instead of claiming an empty answer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(reasoningOnly));
    const provider = new OpenAICompatibleProvider(
      config({ provider: 'groq', model: 'openai/gpt-oss-20b' }),
      { fetchImpl, maxRetries: 0 },
    );
    const error = await provider.complete(request).catch((caught: unknown) => caught as AIError);
    expect((error as AIError).kind).toBe('bad-response');
    // Points at the real cause and the real fix.
    expect((error as AIError).message).toMatch(/max answer length/i);
    expect((error as AIError).message).toMatch(/reasoning/i);
    // Not retryable: repeating the same request cannot help.
    expect((error as AIError).retryable).toBe(false);
  });

  it('reports a truncated non-reasoning answer as a length problem', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }] }),
    );
    const provider = new OpenAICompatibleProvider(config({ provider: 'groq' }), { fetchImpl, maxRetries: 0 });
    const error = await provider.complete(request).catch((caught: unknown) => caught as AIError);
    expect((error as AIError).message).toMatch(/max answer length/i);
  });

  it('still reads the answer when the model returns one', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ index: 0, message: { role: 'assistant', content: 'ready', reasoning: 'thinking' } }],
      }),
    );
    const provider = new OpenAICompatibleProvider(config({ provider: 'groq' }), { fetchImpl, maxRetries: 0 });
    expect((await provider.complete(request)).text).toBe('ready');
  });
});

/**
 * Providers answer a malformed key, a revoked key and a key for the wrong product
 * identically, so the only case Fillie can catch locally is a key that clearly
 * belongs to another provider.
 */
describe('mismatched provider keys', () => {
  it('names the provider a pasted key actually belongs to', async () => {
    const gemini = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-3.5-flash-lite', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345' }),
      { maxRetries: 0 },
    );
    const error = await gemini.complete(request).catch((caught: unknown) => caught as AIError);
    expect((error as AIError).kind).toBe('not-configured');
    expect((error as AIError).message).toMatch(/groq api key/i);
    expect((error as AIError).message).toMatch(/aistudio\.google\.com/i);
    // Never echoes the key.
    expect((error as AIError).message).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz012345');
  });

  it('does not second-guess a key that matches the provider', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'ready' }] } }] }));
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-3.5-flash-lite', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'AIzaSyD-REALKEYVALUE123' }),
      { fetchImpl, maxRetries: 0 },
    );
    expect((await provider.complete(request)).text).toBe('ready');
  });

  it('ignores a key shape it does not recognise', async () => {
    // An unfamiliar key is not evidence of a mistake, so it is sent as-is.
    const fetchImpl = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'ready' }] } }] }));
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-3.5-flash-lite', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'some-self-hosted-key-value' }),
      { fetchImpl, maxRetries: 0 },
    );
    expect((await provider.complete(request)).text).toBe('ready');
  });

  it('does not reject keys for custom openai-compatible endpoints', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'ready' } }] }));
    const provider = new OpenAICompatibleProvider(
      config({ provider: 'openai-compatible', model: 'custom-model', baseUrl: 'https://custom.endpoint/v1', apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz012345' }),
      { fetchImpl, maxRetries: 0 },
    );
    expect((await provider.complete(request)).text).toBe('ready');
  });

  it('filters out thought parts in Gemini responses', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: 'Thinking about the user question...' },
                { text: 'Final Answer' },
              ],
            },
          },
        ],
      }),
    );
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-3.5-flash-lite', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'AIzaSyD-REALKEYVALUE123' }),
      { fetchImpl, maxRetries: 0 },
    );
    const res = await provider.complete(request);
    expect(res.text).toBe('Final Answer');
  });

  it('strips models/ prefix from Gemini model in URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'ready' }] } }] }));
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'models/gemini-3.5-flash-lite', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'AIzaSyD-REALKEYVALUE123' }),
      { fetchImpl, maxRetries: 0 },
    );
    await provider.complete(request);
    const url = String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[0]);
    expect(url).toContain('/models/gemini-3.5-flash-lite:generateContent');
    expect(url).not.toContain('models%2F');
  });

  it('gives Gemini connection probe enough budget to finish reasoning', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'ready' }] } }] }));
    const provider = new GeminiProvider(
      config({ provider: 'gemini', model: 'gemini-3.5-flash-lite', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'AIzaSyD-REALKEYVALUE123' }),
      { fetchImpl, maxRetries: 0 },
    );
    await provider.testConnection!();
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(256);
  });

  it('preserves keys per provider when switching presets', () => {
    const geminiConfig = config({ provider: 'gemini', apiKey: 'AIzaSy-GoogleKey' });
    const groqPreset = applyPresetDefaults(geminiConfig, 'groq');
    expect(groqPreset.provider).toBe('groq');
    expect(groqPreset.apiKey).toBe('');
    expect(groqPreset.apiKeys?.gemini).toBe('AIzaSy-GoogleKey');

    groqPreset.apiKey = 'gsk_GroqKey123';
    const backToGemini = applyPresetDefaults(groqPreset, 'gemini');
    expect(backToGemini.provider).toBe('gemini');
    expect(backToGemini.apiKey).toBe('AIzaSy-GoogleKey');
  });
});

describe('offline provider', () => {
  it('never touches the network and always succeeds', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('should never be called');
    });
    const provider = createProvider(config({ provider: 'offline', model: 'offline-v1', baseUrl: '', apiKey: '' }), { fetchImpl });
    const response = await provider.complete(request);
    expect(response.provider).toBe('offline');
    expect(fetchImpl).not.toHaveBeenCalled();
    const health = await provider.testConnection!();
    expect(health.ok).toBe(true);
    expect(health.message).toMatch(/no network/i);
  });
});

describe('shared AI helpers', () => {
  it('parses JSON with fences and prose around it', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here you go: {"a":2} — done')).toEqual({ a: 2 });
    expect(parseJsonLoose('not json at all')).toBeNull();
    expect(parseJsonLoose('[{"a":3}]')).toEqual([{ a: 3 }]);
  });

  it('backs off exponentially and stays capped', () => {
    const first = backoffDelay(0);
    const third = backoffDelay(3);
    const tenth = backoffDelay(10);
    expect(third).toBeGreaterThan(first);
    expect(tenth).toBeLessThanOrEqual(8000 * 1.25);
  });

  it('stops retrying non-retryable errors immediately', async () => {
    let calls = 0;
    const result = await withRetries(
      async () => {
        calls += 1;
        throw new AIError('nope', 'auth', false);
      },
      { maxRetries: 5, sleep: async () => {} },
    ).catch((error: unknown) => error as AIError);
    expect((result as AIError).kind).toBe('auth');
    expect(calls).toBe(1);
  });

  it('returns the value after a transient failure', async () => {
    let calls = 0;
    const value = await withRetries(
      async () => {
        calls += 1;
        if (calls < 3) throw new AIError('flaky', 'network', true);
        return 'ok';
      },
      { maxRetries: 5, sleep: async () => {} },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });
});