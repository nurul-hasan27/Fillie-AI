import { beforeEach, describe, expect, it } from 'vitest';
import { buildProviderChain, FailoverProvider, normalizeProviderOrder, resetProviderCooldowns } from '../../src/core/ai/chain';
import { mergeSettings } from '../../src/core/storage';
import type { AIRequest } from '../../src/core/types';

const request: AIRequest = { messages: [{ role: 'user', content: 'hi' }] };

function settingsWith(keys: Record<string, string>, order?: string[]) {
  return mergeSettings({ providerOrder: order, config: { apiKeys: keys } });
}

/** A fetch that answers per host, so each platform can succeed or fail on demand. */
function fetchByHost(handlers: Record<string, () => Response>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const host = new URL(url).host;
    calls.push(host);
    const handler = Object.entries(handlers).find(([key]) => host.includes(key));
    if (!handler) throw new Error(`unexpected host ${host}`);
    return handler[1]();
  }) as typeof fetch;
  return { impl, calls };
}

const ok = (text: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
const quota = () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 });

describe('provider chain', () => {
  beforeEach(resetProviderCooldowns);

  it('only includes platforms that have a key, in rank order', () => {
    const chain = buildProviderChain(settingsWith({ groq: 'k1', gemini: 'k2' }));
    expect(chain.map((entry) => entry.id)).toEqual(['gemini', 'groq']);
  });

  it('follows a user-chosen order', () => {
    const chain = buildProviderChain(settingsWith({ groq: 'k1', gemini: 'k2' }, ['groq']));
    expect(chain.map((entry) => entry.id)).toEqual(['groq', 'gemini']);
  });

  it('repairs a bad saved order', () => {
    expect(normalizeProviderOrder(['groq', 'groq', 'nope', 'gemini'])).toEqual([
      'groq', 'gemini', 'cerebras', 'openrouter', 'together', 'openai-compatible',
    ]);
  });

  it('is empty when hosted AI is switched off', () => {
    const settings = { ...settingsWith({ gemini: 'k' }), enabled: false };
    expect(buildProviderChain(settings)).toHaveLength(0);
  });

  it('moves to the next platform when the first is out of quota, and names who answered', async () => {
    const chain = buildProviderChain(settingsWith({ gemini: 'g', cerebras: 'c' }));
    const { impl, calls } = fetchByHost({ googleapis: quota, cerebras: () => ok('from cerebras') });
    const provider = new FailoverProvider(chain, { fetchImpl: impl, maxRetries: 0, sleep: async () => undefined });

    const response = await provider.complete(request);
    expect(response.text).toBe('from cerebras');
    expect(response.provider).toBe('cerebras');
    expect(response.providerLabel).toBe('Cerebras');
    expect(calls).toEqual(['generativelanguage.googleapis.com', 'api.cerebras.ai']);
  });

  it('does not retry a platform that just ran out of quota', async () => {
    const chain = buildProviderChain(settingsWith({ gemini: 'g', cerebras: 'c' }));
    const { impl, calls } = fetchByHost({ googleapis: quota, cerebras: () => ok('ok') });
    const provider = new FailoverProvider(chain, { fetchImpl: impl, maxRetries: 0, sleep: async () => undefined });

    await provider.complete(request);
    calls.length = 0;
    await provider.complete(request);
    expect(calls).toEqual(['api.cerebras.ai']);
  });

  it('throws the last error when every platform fails', async () => {
    const chain = buildProviderChain(settingsWith({ gemini: 'g', cerebras: 'c' }));
    const { impl } = fetchByHost({ googleapis: quota, cerebras: quota });
    const provider = new FailoverProvider(chain, { fetchImpl: impl, maxRetries: 0, sleep: async () => undefined });
    await expect(provider.complete(request)).rejects.toThrow();
  });
});
