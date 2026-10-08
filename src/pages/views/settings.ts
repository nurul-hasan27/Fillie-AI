import type { AIProviderId, AISettings } from '../../core/types';
import { escapeHtml, html, type TemplateResult } from '../../ui/dom';
import { PROVIDER_PRESETS, SUGGESTED_MODELS } from '../../core/ai/presets';
import { DEFAULT_SETTINGS } from '../../core/storage';
import { banner, card, sectionIntro } from '../controls';
import { keyArt } from '../../ui/art';

/** Settings views. Every control here maps to a real, working setting. */

export type SettingsSection = 'ai' | 'profile' | 'memory' | 'privacy' | 'appearance' | 'advanced';

export const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string; description: string }> = [
  { id: 'ai', label: 'AI', description: 'Provider, model and generation behaviour.' },
  { id: 'profile', label: 'Profile', description: 'Import, export and reset your data.' },
  { id: 'memory', label: 'Memory', description: 'Learned answers and answer cache.' },
  { id: 'privacy', label: 'Privacy', description: 'What leaves your browser.' },
  { id: 'appearance', label: 'Appearance', description: 'Theme and density.' },
  { id: 'advanced', label: 'Advanced', description: 'Diagnosis and diagnostics.' },
];

export interface ProviderTestState {
  testing?: boolean;
  message?: string;
  ok?: boolean;
}

export function aiView(
  settings: AISettings,
  callsToday: number,
  tests: Record<string, ProviderTestState> = {},
): TemplateResult {
  const config = settings.config;
  const keys = config.apiKeys ?? {};
  const ready = settings.providerOrder.filter((id) => (keys[id] ?? '').trim()).length;

  return html`
    <div class="hero-card" data-tone="sky">
      <div class="hero-copy">
        <h2>AI platforms</h2>
        <p>Add a free key for each platform you like. Fillie tries them top to bottom and moves to the next one when a platform runs out of quota or fails.</p>
        <span class="hero-pill">${ready} of ${settings.providerOrder.length} ready</span>
      </div>
      ${keyArt}
    </div>
    ${ready === 0
      ? banner({
          tone: 'warning',
          title: 'No platform has a key yet',
          body: 'Fillie fills from your profile and learned answers only. Add at least one key below to answer open-ended questions.',
        })
      : ''}
    <section class="ff-card provider-list" aria-label="AI platforms in priority order">
      ${settings.providerOrder.map((id, index) =>
        providerRow(id, index, settings, tests[id] ?? {}),
      )}
    </section>
    <p class="ff-hint">
      The default order puts the strongest free models first (Gemini, Cerebras, OpenRouter), then paid-per-token and
      trial platforms. Use the arrows to rank them your way.
    </p>
    ${card(
      'Connection',
      html`
        <div class="stack-md">
          <label class="ff-switch">
            <input type="checkbox" name="enabled" ${settings.enabled ? 'checked' : ''} data-bind="bool" />
            <span class="ff-switch-track"><span class="ff-switch-thumb"></span></span>
            <span class="ff-body">Use hosted AI for generated answers</span>
          </label>
          <div class="row-wrap">
            <button class="ff-btn ff-btn-ghost ff-btn-sm" data-action="reset-ai" type="button">Reset AI settings</button>
          </div>
        </div>
      `,
    )}
    ${card(
      'Generation',
      html`
        <div class="stack-md">
          <div class="grid-2">
            ${numberField({
              name: 'config.temperature',
              label: 'Temperature',
              value: config.temperature,
              min: 0,
              max: 1,
              step: 0.05,
              hint: 'Lower is more literal. 0.1–0.3 suits forms.',
            })}
            ${numberField({
              name: 'config.maxOutputTokens',
              label: 'Max answer length (tokens)',
              value: config.maxOutputTokens,
              min: 200,
              max: 4000,
              step: 100,
            })}
            ${numberField({
              name: 'config.timeoutMs',
              label: 'Timeout (seconds)',
              // The setting is stored in milliseconds; the user thinks in seconds.
              scale: 1000,
              value: Math.round(config.timeoutMs / 1000),
              min: 5,
              max: 120,
              step: 1,
            })}
            ${numberField({
              name: 'batchSize',
              label: 'Questions per request',
              value: settings.batchSize,
              min: 1,
              max: 20,
              step: 1,
              hint: 'Higher is faster but uses more of your free quota.',
            })}
          </div>
          <label class="ff-switch">
            <input type="checkbox" name="config.jsonMode" ${config.jsonMode ? 'checked' : ''} data-bind="bool" />
            <span class="ff-switch-track"><span class="ff-switch-thumb"></span></span>
            <span class="ff-body">Ask the model for strict JSON</span>
          </label>
        </div>
      `,
    )}
    ${card(
      'Confidence',
      html`
        <div class="stack-md">
          ${sliderField({
            name: 'autoFillThreshold',
            label: 'Fill automatically at or above',
            value: settings.autoFillThreshold,
            hint: 'Answers below this are queued for your review.',
          })}
          ${sliderField({
            name: 'reviewThreshold',
            label: 'Flag for review at or above',
            value: settings.reviewThreshold,
            hint: 'Lower this to be more cautious.',
          })}
          <p class="ff-hint">Confidence blends retrieval score, the model's own estimate and a grounding check against your profile.</p>
        </div>
      `,
    )}
    ${card(
      'Usage',
      html`
        <div class="setting-row">
          <div class="setting-row-main">
            <strong>Requests today</strong>
            <p>Fillie batches questions, caches answers and reuses memory to stay inside free-tier limits.</p>
          </div>
          <div class="setting-row-control">
            <span class="ff-mono">${callsToday}</span>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-row-main">
            <strong>Retries on failure</strong>
            <p>Backoff retries for rate limits and network hiccups. Fillie never switches to a paid provider.</p>
          </div>
          <div class="setting-row-control">
            ${numberField({ name: 'maxRetries', label: 'Retries', value: settings.maxRetries, min: 0, max: 6, step: 1 })}
          </div>
        </div>
      `,
    )}
  `;
}

function providerRow(id: AIProviderId, index: number, settings: AISettings, test: ProviderTestState): TemplateResult {
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === id)!;
  const key = settings.config.apiKeys?.[id] ?? '';
  const model = settings.providerModels[id] ?? preset.defaultModel;
  const baseUrl = settings.providerBaseUrls[id] ?? preset.defaultBaseUrl;
  const models = SUGGESTED_MODELS[id] ?? [];
  const hasKey = Boolean(key.trim());
  const last = index === settings.providerOrder.length - 1;
  const listId = `models-${id}`;

  return html`
    <article class="provider-row" data-provider="${id}" data-ready="${String(hasKey)}">
      <div class="provider-rank">
        <span class="provider-rank-num">${index + 1}</span>
        <div class="provider-rank-btns">
          <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" type="button" data-action="move-provider" data-id="${id}" data-dir="-1" aria-label="Move ${escapeHtml(preset.shortLabel)} up" ${index === 0 ? 'disabled' : ''}>
            <span data-icon="chevron-down" data-size="13" style="transform:rotate(180deg)"></span>
          </button>
          <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" type="button" data-action="move-provider" data-id="${id}" data-dir="1" aria-label="Move ${escapeHtml(preset.shortLabel)} down" ${last ? 'disabled' : ''}>
            <span data-icon="chevron-down" data-size="13"></span>
          </button>
        </div>
      </div>
      <div class="provider-main">
        <div class="provider-head">
          <strong>${escapeHtml(preset.label)}</strong>
          <span class="ff-chip ${hasKey ? 'ff-chip-accent' : ''}">${hasKey ? 'Key added' : 'No key'}</span>
          ${preset.signupUrl ? html`<a class="ff-meta" href="${escapeHtml(preset.signupUrl)}" target="_blank" rel="noreferrer">Get a key</a>` : ''}
        </div>
        <p class="ff-hint">${escapeHtml(preset.freeTierNote)}</p>
        <div class="provider-fields">
          <div class="ff-field">
            <label class="ff-field-label" for="key-${id}">API key</label>
            <input class="ff-input" id="key-${id}" name="key.${id}" type="password" value="${escapeHtml(key)}"
              placeholder="${escapeHtml(preset.keyPlaceholder)}" autocomplete="off" spellcheck="false" data-bind="text" />
          </div>
          <div class="ff-field">
            <label class="ff-field-label" for="model-${id}">Model</label>
            <input class="ff-input" id="model-${id}" name="model.${id}" type="text" value="${escapeHtml(model)}"
              placeholder="${escapeHtml(preset.defaultModel || 'model-id')}" list="${listId}" autocomplete="off" spellcheck="false" data-bind="text" />
            <datalist id="${listId}">${models.map((m) => html`<option value="${escapeHtml(m)}"></option>`)}</datalist>
          </div>
          ${id === 'openai-compatible'
            ? html`
                <div class="ff-field" style="grid-column: 1 / -1">
                  <label class="ff-field-label" for="baseUrl-${id}">API base URL</label>
                  <input class="ff-input" id="baseUrl-${id}" name="baseUrl.${id}" type="text" value="${escapeHtml(baseUrl)}"
                    placeholder="https://…/v1" autocomplete="off" spellcheck="false" data-bind="text" />
                </div>
              `
            : ''}
        </div>
        <div class="row-wrap">
          <button class="ff-btn ff-btn-secondary ff-btn-sm" data-action="test-provider" data-id="${id}" type="button" ${test.testing || !hasKey ? 'disabled' : ''}>
            <span data-icon="${test.testing ? 'refresh' : 'send'}" data-size="13"></span>
            ${test.testing ? 'Testing…' : 'Test'}
          </button>
          ${test.message ? html`<span class="provider-test" data-ok="${String(Boolean(test.ok))}">${escapeHtml(test.message)}</span>` : ''}
        </div>
      </div>
    </article>
  `;
}

function numberField(options: {
  name: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Multiplier applied on commit, for values shown in friendlier units. */
  scale?: number;
  hint?: string;
}): TemplateResult {
  return html`
    <div class="ff-field">
      <label class="ff-field-label" for="fld-${options.name}">${escapeHtml(options.label)}</label>
      <input
        class="ff-input"
        id="fld-${options.name}"
        name="${options.name}"
        type="number"
        value="${options.value}"
        min="${options.min}"
        max="${options.max}"
        step="${options.step}"
        data-bind="number"
        ${options.scale ? `data-scale="${options.scale}"` : ''}
      />
      ${options.hint ? html`<span class="ff-hint">${escapeHtml(options.hint)}</span>` : ''}
    </div>
  `;
}

function sliderField(options: { name: string; label: string; value: number; hint?: string }): TemplateResult {
  return html`
    <div class="ff-field">
      <div class="ff-row-between">
        <label class="ff-field-label" for="fld-${options.name}">${escapeHtml(options.label)}</label>
        <span class="ff-mono" id="out-${options.name}">${options.value.toFixed(2)}</span>
      </div>
      <input
        id="fld-${options.name}"
        name="${options.name}"
        type="range"
        min="0"
        max="1"
        step="0.02"
        value="${options.value}"
        data-bind="range"
        style="accent-color:var(--ff-accent)"
      />
      ${options.hint ? html`<span class="ff-hint">${escapeHtml(options.hint)}</span>` : ''}
    </div>
  `;
}

/* ------------------------------------------------------------------ */

export function profileSettingsView(importBlock: TemplateResult): TemplateResult {
  return html`
    ${sectionIntro('Profile data', 'Import a resume, or move your data between browsers.')}
    ${importBlock}
    ${card(
      'Export & import',
      html`
        <div class="stack-md">
          <p class="ff-body ff-secondary">
            Export writes a JSON file with your profile, learned answers and settings. Import replaces what is currently
            stored — export first if you are unsure.
          </p>
          <div class="row-wrap">
            <button class="ff-btn ff-btn-secondary" data-action="export-data" type="button">
              <span data-icon="download" data-size="14"></span> Export my data
            </button>
            <label class="ff-btn ff-btn-ghost" for="import-data">
              <span data-icon="upload" data-size="14"></span> Import from file
              <input id="import-data" type="file" accept="application/json" hidden data-action="import-data-input" />
            </label>
          </div>
        </div>
      `,
    )}
    ${card(
      'Reset',
      html`
        <div class="setting-row">
          <div class="setting-row-main">
            <strong style="color:var(--ff-danger)">Clear learned answers</strong>
            <p>Deletes every answer Fillie has remembered. Your profile stays untouched.</p>
          </div>
          <div class="setting-row-control" style="display:flex;justify-content:flex-end">
            <button class="ff-btn ff-btn-danger" data-action="clear-memory" type="button">Clear memory</button>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-row-main">
            <strong style="color:var(--ff-danger)">Erase everything</strong>
            <p>Removes your profile, learned answers, cached answers and settings from this browser.</p>
          </div>
          <div class="setting-row-control" style="display:flex;justify-content:flex-end">
            <button class="ff-btn ff-btn-danger" data-action="erase-all" type="button">Erase all Fillie data</button>
          </div>
        </div>
      `,
      undefined,
    )}
  `;
}

/* ------------------------------------------------------------------ */

export function memorySettingsView(count: number, cacheCount: number): TemplateResult {
  return html`
    ${sectionIntro('Memory & cache', 'Fillie remembers approved answers and caches identical requests to protect your free quota.')}
    ${card(
      'Stored answers',
      html`
        <div class="setting-row">
          <div class="setting-row-main">
            <strong>${count} learned ${count === 1 ? 'answer' : 'answers'}</strong>
            <p>Reused automatically for semantically similar questions.</p>
          </div>
          <div class="setting-row-control" style="display:flex;justify-content:flex-end;gap:6px">
            <button class="ff-btn ff-btn-secondary ff-btn-sm" data-action="goto-memory" type="button">Review</button>
            <button class="ff-btn ff-btn-danger ff-btn-sm" data-action="clear-memory" type="button">Clear all</button>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-row-main">
            <strong>${cacheCount} cached responses</strong>
            <p>Answers are cached for 7 days so repeat questions cost nothing.</p>
          </div>
          <div class="setting-row-control" style="display:flex;justify-content:flex-end">
            <button class="ff-btn ff-btn-secondary ff-btn-sm" data-action="clear-cache" type="button">Clear cache</button>
          </div>
        </div>
      `,
    )}
  `;
}

/* ------------------------------------------------------------------ */

export function privacyView(settings: AISettings, reminders = true): TemplateResult {
  const provider = PROVIDER_PRESETS.find((entry) => entry.id === settings.config.provider);
  return html`
    ${sectionIntro('Privacy', 'What Fillie sends, and what it never sends.')}
    ${card(
      'What leaves this browser',
      html`
        <div class="stack-md">
          <ul class="ff-list">
            <li class="ff-list-item">
              <span style="color:var(--ff-text-tertiary)" data-icon="check" data-size="14"></span>
              <span class="ff-body">The text of a question, plus the few profile facts retrieved for that question.</span>
            </li>
            <li class="ff-list-item">
              <span style="color:var(--ff-text-tertiary)" data-icon="check" data-size="14"></span>
              <span class="ff-body">Company, role and a job description excerpt, when the page provides them.</span>
            </li>
            <li class="ff-list-item">
              <span style="color:var(--ff-text-tertiary)" data-icon="check" data-size="14"></span>
              <span class="ff-body">Anything you type during a Fillie interview.</span>
            </li>
          </ul>
          <p class="ff-hint">
            ${settings.enabled && settings.config.provider !== 'offline'
              ? html`These requests go to <strong>${escapeHtml(provider?.label ?? settings.config.provider)}</strong> at <span class="ff-mono">${escapeHtml(settings.config.baseUrl || '—')}</span>.`
              : 'Hosted AI is currently off, so nothing leaves this browser.'}
          </p>
        </div>
      `,
    )}
    ${card(
      'What never leaves',
      html`
        <ul class="ff-list">
          ${[
            'Passwords, one-time codes and payment details — Fillie refuses to touch these fields.',
            'CAPTCHAs and any other anti-bot control.',
            'Your full profile in one blob — only question-relevant facts are sent.',
            'Browsing history unrelated to a form Fillie is working on.',
          ].map(
            (item) => html`
              <li class="ff-list-item">
                <span style="color:var(--ff-text-tertiary)" data-icon="lock" data-size="14"></span>
                <span class="ff-body">${escapeHtml(item)}</span>
              </li>
            `,
          )}
        </ul>
      `,
    )}
    ${card(
      'Interview reminders',
      html`
        <div class="stack-md">
          <label class="ff-switch">
            <input type="checkbox" data-action="toggle-reminders" ${reminders ? 'checked' : ''} />
            <span class="ff-switch-track"><span class="ff-switch-thumb"></span></span>
            <span class="ff-body">Notify me a day before and an hour before each interview in my Database</span>
          </label>
          <p class="ff-hint">Fillie checks your saved interviews every 15 minutes. Nothing is sent anywhere; the notification is made on this device.</p>
        </div>
      `,
    )}
    ${card(
      'API key',
      html`
        <div class="stack-md">
          <p class="ff-body ff-secondary">
            Your key is stored in this browser's extension storage and is used only from the service worker. It is never
            written to logs, never sent to a page, and never included in an export unless you export settings yourself.
          </p>
          <label class="ff-switch">
            <input type="checkbox" name="stripKeyOnExport" data-bind="bool" />
            <span class="ff-switch-track"><span class="ff-switch-thumb"></span></span>
            <span class="ff-body">Remove the API key when I export data</span>
          </label>
        </div>
      `,
    )}
  `;
}

/* ------------------------------------------------------------------ */

export function appearanceView(theme: string): TemplateResult {
  return html`
    ${sectionIntro('Appearance', 'Light, dark or follow your system.')}
    ${card(
      'Theme',
      html`
        <div class="grid-3">
          ${(['light', 'dark', 'system'] as const).map(
            (option) => html`
              <button
                class="ff-card ff-card-hover ff-card-pad"
                data-action="set-theme"
                data-theme="${option}"
                type="button"
                style="text-align:left;cursor:pointer;border-color:${theme === option ? 'var(--ff-accent)' : 'var(--ff-border)'};background:${theme === option ? 'var(--ff-accent-soft)' : 'var(--ff-surface)'}"
              >
                <div class="ff-row" style="gap:8px;margin-bottom:8px">
                  <span style="color:var(--ff-accent)" data-icon="${option === 'light' ? 'sun' : option === 'dark' ? 'moon' : 'monitor'}"></span>
                  <strong class="ff-heading" style="font-size:var(--ff-text-base)">${option[0].toUpperCase()}${option.slice(1)}</strong>
                </div>
                <span class="ff-hint">${option === 'system' ? 'Follows your operating system.' : `Always ${option}.`}</span>
              </button>
            `,
          )}
        </div>
      `,
    )}
  `;
}

/* ------------------------------------------------------------------ */

export function advancedView(diagnostics: {
  version: string;
  aiCalls: number;
  sessions: number;
  fieldsFilled: number;
  cacheHits: number;
  memoryCount: number;
  lastErrors: string[];
}): TemplateResult {
  const rows: Array<[string, string]> = [
    ['Version', diagnostics.version],
    ['Sessions run', String(diagnostics.sessions)],
    ['Fields verified', String(diagnostics.fieldsFilled)],
    ['AI requests', String(diagnostics.aiCalls)],
    ['Cache hits', String(diagnostics.cacheHits)],
    ['Learned answers', String(diagnostics.memoryCount)],
  ];
  return html`
    ${sectionIntro('Advanced', 'Diagnostics for troubleshooting.')}
    ${card(
      'Diagnostics',
      html`
        <div class="stack-md">
          <div class="grid-2">
            ${rows.map(
              ([label, value]) => html`
                <div class="ff-row-between" style="padding:6px 0;border-bottom:1px solid var(--ff-border-subtle)">
                  <span class="ff-body ff-secondary">${escapeHtml(label)}</span>
                  <span class="ff-mono">${escapeHtml(value)}</span>
                </div>
              `,
            )}
          </div>
        </div>
      `,
    )}
    ${card(
      'Recent issues',
      diagnostics.lastErrors.length
        ? html`
            <ul class="ff-list">
              ${diagnostics.lastErrors.map(
                (error) => html`
                  <li class="ff-list-item">
                    <span style="color:var(--ff-warning)" data-icon="alert" data-size="14"></span>
                    <span class="ff-body">${escapeHtml(error)}</span>
                  </li>
                `,
              )}
            </ul>
          `
        : html`<p class="ff-body ff-secondary">No problems recorded. Fillie has run cleanly.</p>`,
    )}
    ${card(
      'Keyboard',
      html`
        <ul class="ff-list">
          <li class="ff-list-item"><span class="ff-mono">Alt + Shift + F</span><span class="ff-body">Run Fillie on the current page</span></li>
          <li class="ff-list-item"><span class="ff-mono">Tab</span><span class="ff-body">Move through the in-page panel</span></li>
          <li class="ff-list-item"><span class="ff-mono">Esc</span><span class="ff-body">Close the in-page panel</span></li>
        </ul>
      `,
    )}
  `;
}

export function defaultSettings(): AISettings {
  return structuredClone(DEFAULT_SETTINGS);
}