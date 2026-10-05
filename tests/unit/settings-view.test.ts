import { describe, expect, it } from 'vitest';
import { aiView } from '../../src/pages/views/settings';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/core/storage';
import type { AIProviderId, AISettings } from '../../src/core/types';

/**
 * The AI view is hand-written markup, so its inputs have to satisfy the same
 * contract the app's event delegation relies on: a `data-bind` attribute and a
 * `name` the settings layer recognises. An input missing either still renders
 * and looks correct, but its value is silently discarded.
 *
 * These mirror `isSettingsBinding` and the `data-bind` guard in
 * `src/pages/app.ts`, which is where a mismatch is actually detected.
 */

const TOP_LEVEL_SETTINGS = new Set(['enabled', 'batchSize', 'maxRetries', 'autoFillThreshold', 'reviewThreshold', 'debug']);

function isSettingsBinding(name: string): boolean {
  return (
    name.startsWith('config.') ||
    name.startsWith('key.') ||
    name.startsWith('model.') ||
    name.startsWith('baseUrl.') ||
    TOP_LEVEL_SETTINGS.has(name)
  );
}

function render(settings: AISettings): HTMLInputElement[] {
  const host = document.createElement('div');
  host.innerHTML = aiView(settings, 0, {}).__html;
  document.body.appendChild(host);
  return Array.from(host.querySelectorAll('input, select, textarea'));
}

const KEYED: AIProviderId[] = ['gemini', 'cerebras', 'openrouter', 'groq', 'together', 'openai-compatible'];

describe('AI settings view — one key per platform', () => {
  it.each(KEYED)('renders a bound key field for %s', (id) => {
    const field = render(structuredClone(DEFAULT_SETTINGS)).find((input) => input.name === `key.${id}`);
    expect(field, `${id} should render a key field`).toBeDefined();
    expect(field!.type).toBe('password');
    expect(field!.hasAttribute('data-bind')).toBe(true);
    expect(isSettingsBinding(field!.name)).toBe(true);
  });

  it('shows each stored key back in its own field', () => {
    const settings = mergeSettings({ config: { apiKeys: { gemini: 'g-key', cerebras: 'c-key' } } });
    const fields = render(settings);
    expect(fields.find((f) => f.name === 'key.gemini')!.value).toBe('g-key');
    expect(fields.find((f) => f.name === 'key.cerebras')!.value).toBe('c-key');
    expect(fields.find((f) => f.name === 'key.groq')!.value).toBe('');
  });

  it('lists platforms in the saved order and offers a model per platform', () => {
    const settings = mergeSettings({ providerOrder: ['groq', 'gemini'] });
    const host = document.createElement('div');
    host.innerHTML = aiView(settings, 0, {}).__html;
    const rows = Array.from(host.querySelectorAll<HTMLElement>('.provider-row')).map((row) => row.dataset.provider);
    expect(rows.slice(0, 2)).toEqual(['groq', 'gemini']);
    expect(rows).toHaveLength(6);
    expect(host.querySelectorAll('input[name^="model."]')).toHaveLength(6);
  });

  it('binds every control in the AI view', () => {
    const fields = render(structuredClone(DEFAULT_SETTINGS));
    expect(fields.length).toBeGreaterThan(10);
    for (const field of fields) {
      expect(field.hasAttribute('data-bind'), `${field.name || field.type} is missing data-bind`).toBe(true);
      expect(isSettingsBinding(field.name), `${field.name} is not a recognised settings binding`).toBe(true);
    }
  });
});
