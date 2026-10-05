import { describe, expect, it } from 'vitest';
import { Storage, STORAGE_KEYS, mergeSettings, DEFAULT_SETTINGS } from '../../src/core/storage';
import { getPreset } from '../../src/core/ai/presets';
import { createLearnedAnswer, updateLearnedAnswer } from '../../src/core/memory';
import { testProfile } from './fixtures';

describe('storage', () => {
  it('round-trips a profile', async () => {
    const storage = new Storage();
    const saved = await storage.saveProfile(testProfile());
    expect(saved.personal.email).toBe('ada@example.com');
    const loaded = await storage.getProfile();
    expect(loaded.personal.fullName).toBe('Ada Lovelace');
    expect(loaded.projects).toHaveLength(1);
  });

  it('normalises anything it is handed', async () => {
    const storage = new Storage();
    await storage.saveProfile({ junk: true } as never);
    const profile = await storage.getProfile();
    expect(profile.personal.fullName).toBe('');
    expect(profile.skills.frameworks).toEqual([]);
  });

  it('stores and reads memory', async () => {
    const storage = new Storage();
    const entry = createLearnedAnswer({
      question: 'Why this role?',
      intent: 'motivation',
      answer: 'Because the team works on distributed systems.',
      sources: [],
      context: { company: 'Northwind', isGeneric: false },
    });
    await storage.saveMemory([entry]);
    const memory = await storage.getMemory();
    expect(memory).toHaveLength(1);
    expect(memory[0].answer).toContain('distributed systems');
  });

  it('merges settings over defaults', async () => {
    const storage = new Storage();
    await storage.saveSettings({
      ...DEFAULT_SETTINGS,
      config: { ...DEFAULT_SETTINGS.config, model: 'custom-model' },
    });
    const settings = await storage.getSettings();
    expect(settings.config.model).toBe('custom-model');
    expect(settings.config.provider).toBe(DEFAULT_SETTINGS.config.provider);
    expect(settings.batchSize).toBe(DEFAULT_SETTINGS.batchSize);
  });

  it('upgrades a stored Gemini model that is closed to new API keys', async () => {
    // Settings live in chrome.storage.local, so a browser that saved the old
    // preset keeps naming the old model after the preset is corrected. Without a
    // migration that user is stuck on a 404 with no way to tell why — changing
    // the provider dropdown would fix it, but nothing says so.
    const storage = new Storage();
    await storage.saveSettings({
      ...DEFAULT_SETTINGS,
      config: {
        ...DEFAULT_SETTINGS.config,
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'existing-key',
      },
    });

    const settings = await storage.getSettings();
    expect(settings.config.model).toBe(getPreset('gemini').defaultModel);
    expect(settings.config.model).not.toMatch(/^gemini-2\./);
    // Only the model moves; the key and endpoint the user configured survive.
    expect(settings.config.apiKey).toBe('existing-key');
    expect(settings.config.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  it('leaves a still-supported model exactly as the user set it', () => {
    const chosen = mergeSettings({
      config: { provider: 'gemini', model: 'gemini-3.8-flash', apiKey: 'k' },
    });
    expect(chosen.config.model).toBe('gemini-3.8-flash');
    expect(chosen.config.apiKey).toBe('k');

    // A non-Gemini provider is untouched by the Gemini migration.
    const groq = mergeSettings({ config: { provider: 'groq', model: 'openai/gpt-oss-120b' } });
    expect(groq.config.model).toBe('openai/gpt-oss-120b');
  });

  it('repairs a model left over from another provider', () => {
    // The reported symptom: a Gemini model sat in the Groq field, so every
    // provider the user tried answered 404 with the same unhelpful message.
    const repaired = mergeSettings({
      config: { provider: 'groq', model: 'gemini-3.5-flash-lite', apiKey: 'k' },
    });
    expect(repaired.config.model).toBe(getPreset('groq').defaultModel);
    // The key the user pasted is preserved — only the model is corrected.
    expect(repaired.config.apiKey).toBe('k');
  });

it('clamps out-of-range settings', () => {
    const merged = mergeSettings({ batchSize: 999, maxRetries: -4, autoFillThreshold: 5, config: { temperature: 0.4 } });
    expect(merged.batchSize).toBe(20);
    expect(merged.maxRetries).toBe(0);
    expect(merged.autoFillThreshold).toBe(1);
    expect(merged.config.temperature).toBe(0.4);
  });

  it('caches answers and prunes old entries', async () => {
    const storage = new Storage();
    await storage.setCacheEntry('k1', 'answer one');
    const cache = await storage.getCache();
    expect(cache.k1.text).toBe('answer one');

    cache.old = { text: 'stale', createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000 };
    await storage.setCacheEntry('k2', 'answer two');
    const refreshed = await storage.getCache();
    expect(refreshed.old).toBeUndefined();
    expect(refreshed.k2.text).toBe('answer two');
  });

  it('exports, imports and clears everything', async () => {
    const storage = new Storage();
    await storage.saveProfile(testProfile());
    await storage.saveMemory([
      createLearnedAnswer({
        question: 'Q',
        intent: 'i',
        answer: 'A',
        sources: [],
        context: { isGeneric: true },
      }),
    ]);

    const dump = await storage.exportAll();
    expect(dump.profile.personal.email).toBe('ada@example.com');
    expect(dump.memory).toHaveLength(1);

    const second = new Storage();
    await second.importAll(dump);
    expect((await second.getProfile()).personal.email).toBe('ada@example.com');
    expect(await second.getMemory()).toHaveLength(1);

    await second.clearAll();
    expect((await second.getProfile()).personal.fullName).toBe('');
    expect(await second.getMemory()).toHaveLength(0);
    expect((await second.getSettings()).config.provider).toBe(DEFAULT_SETTINGS.config.provider);
  });

  it('tracks usage statistics', async () => {
    const storage = new Storage();
    await storage.bumpStats({ sessions: 1, fieldsFilled: 5 });
    await storage.bumpStats({ sessions: 1, aiCalls: 2 });
    const stats = await storage.getStats();
    expect(stats.sessions).toBe(2);
    expect(stats.fieldsFilled).toBe(5);
    expect(stats.aiCalls).toBe(2);
  });

  it('notifies subscribers on write', async () => {
    const storage = new Storage();
    const seen: string[] = [];
    const unsubscribe = storage.subscribe((changes) => seen.push(...Object.keys(changes)));
    await storage.saveProfile(testProfile());
    expect(seen).toContain(STORAGE_KEYS.profile);
    unsubscribe();
  });

  it('ignores malformed imports instead of throwing', async () => {
    const storage = new Storage();
    await storage.importAll({ memory: 'not-an-array' as never });
    expect(await storage.getMemory()).toEqual([]);
  });
});

describe('memory maintenance', () => {
  it('updates an answer and re-signs the question', () => {
    const entry = createLearnedAnswer({
      question: 'What is your CGPA?',
      intent: 'cgpa',
      answer: '8.6',
      sources: [],
      context: { isGeneric: true },
    });
    const [updated] = updateLearnedAnswer([entry], entry.id, { answer: '9.1', question: 'What is your GPA?' });
    expect(updated.answer).toBe('9.1');
    expect(updated.signature).not.toBe(entry.signature);
    expect(updated.updatedAt).toBeGreaterThan(0);
  });
});
describe('shipped defaults', () => {
  it('starts on a provider with a genuinely free tier', () => {
    // Groq shut down every free model it hosted, so a default pointing at Groq
    // would ship the extension aimed at a paid provider.
    expect(DEFAULT_SETTINGS.config.provider).toBe('gemini');
    expect(DEFAULT_SETTINGS.config.model).toBe('gemini-3.5-flash-lite');
  });

  it('ships no model that any provider has shut down', () => {
    for (const retired of [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'qwen/qwen3-32b',
    ]) {
      expect(DEFAULT_SETTINGS.config.model, retired).not.toBe(retired);
    }
  });
});
