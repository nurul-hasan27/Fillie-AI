import {
  AIError,
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

interface GeminiPart {
  text: string;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Adapter for Google's Gemini `generateContent` API (free AI Studio tier). */
export class GeminiProvider implements AIProvider {
  readonly id: AIProviderId = 'gemini';
  readonly label = 'Google AI Studio (Gemini)';
  readonly requiresKey = true;

  constructor(
    private readonly config: AIProviderConfig,
    private readonly deps: { fetchImpl?: FetchLike; maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  async complete(request: AIRequest): Promise<AIResponse> {
    const config = this.config;
    assertConfigured(config);
    // A key pasted from a browser or a console usually arrives with a trailing
    // newline, space, or wrapping quotes. Trimming and sanitizing names the real problem.
    const apiKey = config.apiKey.trim().replace(/^["']|["']$/g, '').trim();
    if (!apiKey) {
      throw new AIError('Add a Google AI Studio API key in Settings → AI.', 'not-configured');
    }
    // A Groq or OpenRouter key pasted into this field produces Google's
    // "API key not valid", which is indistinguishable from a genuinely wrong
    // Google key. Catching the obvious mismatch locally names the real problem.
    const foreign = describeMismatchedKey('gemini', apiKey);
    if (foreign) {
      throw new AIError(
        `That looks like a ${foreign} API key. Google AI Studio needs a key from aistudio.google.com/apikey.`,
        'not-configured',
      );
    }

    const base = config.baseUrl.replace(/\/+$/, '');
    const modelName = config.model.trim().replace(/^models\//, '');
    const url = `${base}/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const fetchImpl = this.deps.fetchImpl ?? ((input, init) => fetch(input, init));

    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));

    const generationConfig: Record<string, unknown> = {
      temperature: request.temperature ?? config.temperature,
      maxOutputTokens: request.maxOutputTokens ?? config.maxOutputTokens,
    };
    if (request.json && config.jsonMode) {
      generationConfig.responseMimeType = 'application/json';
    }

    const payload: Record<string, unknown> = { contents, generationConfig };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
    if (typeof request.signal !== 'undefined') {
      // Gemini does not accept cancellation; nothing to send.
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
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify(payload),
          },
          config.timeoutMs,
          request.signal,
        ).then(async (res) => {
          if (!res.ok) {
            // Only the body is kept: `readErrorBody` already falls back to the
            // status text, and prefixing it here corrupts the JSON the reason is
            // parsed from.
            const detail = await readErrorBody(res);
            throw classifyHttpError(res.status, detail);
          }
          return (await res.json()) as GeminiResponse;
        }),
      { maxRetries: this.deps.maxRetries ?? 2, signal: request.signal, sleep: this.deps.sleep },
    );

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    // Separate actual answer text from internal thought parts (which have thought: true on Gemini 2.5/3.x)
    const nonThoughtParts = parts.filter((part) => !(part as { thought?: boolean }).thought);
    const textParts = nonThoughtParts.length > 0 ? nonThoughtParts : parts;
    const text = textParts
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    if (!text) {
      const finishReason = response.candidates?.[0]?.finishReason;
      throw new AIError(
        finishReason === 'MAX_TOKENS'
          ? 'The answer was cut short by the model length limit. Raise "Max answer length" and try again.'
          : 'The AI provider returned an empty answer.',
        'bad-response',
        finishReason === 'MAX_TOKENS',
      );
    }

    return {
      text,
      model: config.model,
      provider: this.id,
      cached: false,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
      },
    };
  }

  async testConnection(): Promise<{ ok: boolean; message: string; model?: string }> {
    try {
      const res = await this.complete({
        messages: [
          { role: 'user', content: 'Reply with the single word: ready' },
        ],
        maxOutputTokens: 512,
        json: false,
      });
      return { ok: true, message: `Connected to ${getPreset('gemini').label}.`, model: res.model };
    } catch (error) {
      return { ok: false, message: connectionErrorMessage(this, error) };
    }
  }
}