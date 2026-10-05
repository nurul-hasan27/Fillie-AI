import {
  AIError,
  type AIChatMessage,
  type AIProvider,
  type AIProviderConfig,
  type AIProviderId,
  type AIRequest,
  type AIResponse,
} from '../types';
import {
  assertConfigured,
  classifyHttpError,
  connectionErrorMessage,
  describeMismatchedKey,
  readErrorBody,
  timedFetch,
  withRetries,
  type FetchLike,
} from './shared';
import { getPreset } from './presets';

/**
 * Adapter for any OpenAI-compatible `/chat/completions` endpoint. Covers Groq,
 * OpenRouter, Together, Cerebras and self-hosted gateways.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly id: AIProviderId;
  readonly label: string;
  readonly requiresKey = true;

  constructor(
    private readonly config: AIProviderConfig,
    private readonly deps: { fetchImpl?: FetchLike; maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.id = config.provider;
    this.label = getPreset(config.provider).label;
  }

  async complete(request: AIRequest): Promise<AIResponse> {
    const config = this.config;
    assertConfigured(config);
    // A key pasted from a console usually carries a trailing newline, space, or wrapping quotes.
    const apiKey = config.apiKey.trim().replace(/^["']|["']$/g, '').trim();
    if (!apiKey) {
      throw new AIError(`Add an API key for ${this.label} in Settings → AI.`, 'not-configured');
    }
    const foreign = describeMismatchedKey(this.id, apiKey);
    if (foreign) {
      throw new AIError(
        `That looks like a ${foreign} API key, not one for ${this.label}.`,
        'not-configured',
      );
    }

    const preset = getPreset(config.provider);
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const fetchImpl = this.deps.fetchImpl ?? ((input, init) => fetch(input, init));

    const body: Record<string, unknown> = {
      model: config.model,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: request.temperature ?? config.temperature,
      max_tokens: request.maxOutputTokens ?? config.maxOutputTokens,
      stream: false,
    };
    if (request.json && config.jsonMode && preset.jsonModeSupported) {
      body.response_format = { type: 'json_object' };
    }

    const response = await withRetries(
      () =>
        timedFetch(
          fetchImpl,
          url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              ...(preset.extraHeaders ?? {}),
            },
            body: JSON.stringify(body),
          },
          config.timeoutMs,
          request.signal,
        ).then(async (res) => {
          if (!res.ok) {
            // Only the body is kept: `readErrorBody` already falls back to the status
          // text, and prefixing it here corrupts the JSON the reason is parsed from.
          const detail = await readErrorBody(res);
          throw classifyHttpError(res.status, detail);
          }
          return res.json();
        }),
      { maxRetries: this.deps.maxRetries ?? 2, signal: request.signal, sleep: this.deps.sleep },
    );

    const parsed = response as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ text?: string }> | null;
          reasoning?: string;
          reasoning_content?: string;
        };
        finish_reason?: string | null;
      }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = parsed.choices?.[0];
    const rawContent = choice?.message?.content;
    const text = Array.isArray(rawContent)
      ? rawContent.map((part) => part.text ?? '').join('')
      : (rawContent ?? '');

    if (!text.trim()) {
      // A reasoning model (Groq's GPT-OSS and Qwen, DeepSeek, etc.) emits its chain of thought
      // first and returns the answer after it. Given a small `max_tokens` the
      // reasoning consumes the whole budget and `content` comes back empty —
      // a budget problem, not a broken connection, and saying "empty answer"
      // sends the user hunting for a fault that is not there.
      const reasoning = choice?.message?.reasoning?.trim() || choice?.message?.reasoning_content?.trim();
      const reasoned = Boolean(reasoning);
      if (reasoned) {
        throw new AIError(
          'The model used its whole reply on reasoning and returned no answer. Raise "Max answer length" and try again.',
          'bad-response',
          false,
          `finish_reason: ${choice?.finish_reason ?? 'unknown'}`,
        );
      }
      throw new AIError(
        choice?.finish_reason === 'length'
          ? 'The answer was cut short. Raise "Max answer length" and try again.'
          : 'The AI provider returned an empty answer.',
        'bad-response',
        true,
      );
    }

    return {
      text,
      model: parsed.model ?? config.model,
      provider: this.id,
      cached: false,
      usage: {
        inputTokens: parsed.usage?.prompt_tokens,
        outputTokens: parsed.usage?.completion_tokens,
      },
    };
  }

  async testConnection(): Promise<{ ok: boolean; message: string; model?: string }> {
    // Only use user role for connection tests: many open models (like Gemma or reasoning models)
    // reject system messages with HTTP 400.
    const messages: AIChatMessage[] = [
      { role: 'user', content: 'Reply with the single word: ready' },
    ];
    try {
      // A connection test must not judge answer quality — some models reason before
      // they answer, and a tiny budget would report a working provider as broken.
      // The budget is generous enough for the reasoning to finish and still leave
      // room for an answer; the response is only checked for a non-empty answer.
      const res = await this.complete({ messages, maxOutputTokens: 512, json: false });
      return { ok: true, message: `Connected to ${this.label}.`, model: res.model };
    } catch (error) {
      if (error instanceof AIError && error.message.includes('The model used its whole reply on reasoning')) {
        return { ok: true, message: `Connected to ${this.label} (model responded with reasoning).` };
      }
      return { ok: false, message: connectionErrorMessage(this, error) };
    }
  }
}