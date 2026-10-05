import type { AIProvider, AIProviderId, AIRequest, AIResponse } from '../types';

/**
 * The offline engine. It performs no network calls at all: Fillie falls back to
 * profile retrieval + learned answers, and anything that would need genuine
 * generation is escalated to the user instead.
 */
export class OfflineProvider implements AIProvider {
  readonly id: AIProviderId = 'offline';
  readonly label = 'Offline engine (no AI)';
  readonly requiresKey = false;

  async complete(_request: AIRequest): Promise<AIResponse> {
    return {
      text: JSON.stringify({
        fields: [],
        note: 'Offline engine: no hosted AI is configured, so nothing is generated.',
      }),
      model: 'offline-v1',
      provider: this.id,
      cached: false,
    };
  }

  async testConnection(): Promise<{ ok: boolean; message: string; model?: string }> {
    return { ok: true, message: 'Offline engine active. No network requests are made.', model: 'offline-v1' };
  }
}

export interface MockResponsePlan {
  /** Matched by a substring of the last user message. */
  when?: string;
  /** Text to return verbatim. */
  text: string;
  /** Optional delay in ms before resolving. */
  delayMs?: number;
  throw?: Error;
}

export interface MockProviderOptions {
  plans?: MockResponsePlan[];
  /** Used when no plan matches. */
  fallback?: MockResponsePlan;
  /** Records every request for assertions. */
  calls?: AIRequest[];
}

/**
 * Deterministic provider used by automated tests. Never used at runtime.
 */
export class MockAIProvider implements AIProvider {
  readonly id: AIProviderId = 'groq';
  readonly label = 'MockAIProvider';
  readonly requiresKey = true;
  calls: AIRequest[] = [];

  constructor(private options: MockProviderOptions = {}) {}

  setPlans(plans: MockResponsePlan[]): void {
    this.options.plans = plans;
  }

  async complete(request: AIRequest): Promise<AIResponse> {
    this.calls.push(request);
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    const haystack = lastUser?.content ?? '';
    const plan =
      this.options.plans?.find((candidate) => candidate.when && haystack.includes(candidate.when)) ??
      this.options.fallback ?? { text: '{}' };
    if (plan.delayMs) await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
    if (plan.throw) throw plan.throw;
    return {
      text: plan.text,
      model: 'mock-model',
      provider: 'groq',
      cached: false,
    };
  }

  async testConnection(): Promise<{ ok: boolean; message: string; model?: string }> {
    return { ok: true, message: 'Mock provider ready.', model: 'mock-model' };
  }
}