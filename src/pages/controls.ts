import { escapeHtml, html, type TemplateResult } from '../ui/dom';
import { icon } from '../ui/icons';

/** Reusable form controls used by the profile views. */

export interface FieldOptions {
  name: string;
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  type?: string;
  span?: 1 | 2;
  autocomplete?: string;
  readonly?: boolean;
}

export function textField(options: FieldOptions): TemplateResult {
  return html`
    <div class="ff-field" data-span="${options.span ?? 1}">
      <label class="ff-field-label" for="fld-${options.name}">${escapeHtml(options.label)}</label>
      <input
        class="ff-input"
        id="fld-${options.name}"
        name="${options.name}"
        type="${options.type ?? 'text'}"
        value="${escapeHtml(options.value)}"
        placeholder="${escapeHtml(options.placeholder ?? '')}"
        autocomplete="${options.autocomplete ?? 'off'}"
        data-bind="text"
        ${options.readonly ? 'readonly' : ''}
      />
      ${options.hint ? html`<span class="ff-hint">${escapeHtml(options.hint)}</span>` : ''}
    </div>
  `;
}

export function textAreaField(options: FieldOptions & { rows?: number }): TemplateResult {
  return html`
    <div class="ff-field" data-span="2">
      <label class="ff-field-label" for="fld-${options.name}">${escapeHtml(options.label)}</label>
      <textarea
        class="ff-textarea"
        id="fld-${options.name}"
        name="${options.name}"
        rows="${options.rows ?? 4}"
        placeholder="${escapeHtml(options.placeholder ?? '')}"
        data-bind="text"
      >${escapeHtml(options.value)}</textarea>
      ${options.hint ? html`<span class="ff-hint">${escapeHtml(options.hint)}</span>` : ''}
    </div>
  `;
}

/**
 * Chip-style list editor. Accepts comma/Enter separated values, so it behaves
 * like a plain text field for people who type lists and like chips for those
 * who click.
 */
export function listField(options: {
  name: string;
  label: string;
  values: string[];
  placeholder?: string;
  hint?: string;
}): TemplateResult {
  return html`
    <div class="ff-field" data-span="2">
      <label class="ff-field-label" for="fld-${options.name}">${escapeHtml(options.label)}</label>
      <div class="tag-input" data-list="${options.name}">
        ${options.values.map(
          (value, index) => html`
            <span class="tag">
              ${escapeHtml(value)}
              <button type="button" data-remove-tag="${index}" aria-label="Remove ${escapeHtml(value)}">
                <span data-icon="close" data-size="11"></span>
              </button>
            </span>
          `,
        )}
        <input
          id="fld-${options.name}"
          type="text"
          data-list-input="${options.name}"
          placeholder="${escapeHtml(options.placeholder ?? 'Type and press Enter…')}"
          autocomplete="off"
        />
      </div>
      ${options.hint ? html`<span class="ff-hint">${escapeHtml(options.hint)}</span>` : ''}
    </div>
  `;
}

export function selectField(options: FieldOptions & { options: Array<{ label: string; value: string }> }): TemplateResult {
  return html`
    <div class="ff-field" data-span="${options.span ?? 1}">
      <label class="ff-field-label" for="fld-${options.name}">${escapeHtml(options.label)}</label>
      <select class="ff-select" id="fld-${options.name}" name="${options.name}" data-bind="text">
        ${options.options.map(
          (option) => html`
            <option value="${escapeHtml(option.value)}" ${option.value === options.value ? 'selected' : ''}>
              ${escapeHtml(option.label)}
            </option>
          `,
        )}
      </select>
      ${options.hint ? html`<span class="ff-hint">${escapeHtml(options.hint)}</span>` : ''}
    </div>
  `;
}

export function switchRow(options: {
  label: string;
  description: string;
  name: string;
  checked: boolean;
  danger?: boolean;
}): TemplateResult {
  return html`
    <div class="setting-row">
      <div class="setting-row-main">
        <strong>${escapeHtml(options.label)}</strong>
        <p>${escapeHtml(options.description)}</p>
      </div>
      <div class="setting-row-control" style="display:flex;justify-content:flex-end;padding-top:2px">
        <label class="ff-switch">
          <input type="checkbox" name="${options.name}" ${options.checked ? 'checked' : ''} data-bind="bool" />
          <span class="ff-switch-track"><span class="ff-switch-thumb"></span></span>
          <span class="ff-sr">${escapeHtml(options.label)}</span>
        </label>
      </div>
    </div>
  `;
}

export function card(title: string, body: TemplateResult | TemplateResult[], actions?: TemplateResult): TemplateResult {
  return html`
    <section class="ff-card">
      <div class="ff-row-between" style="padding:var(--ff-space-4) var(--ff-space-5);border-bottom:1px solid var(--ff-border-subtle)">
        <h2 class="ff-title">${escapeHtml(title)}</h2>
        ${actions ?? ''}
      </div>
      <div class="card-pad-lg">${body as never}</div>
    </section>
  `;
}

export function banner(options: {
  tone?: 'info' | 'warning' | 'danger';
  title: string;
  body?: string;
  actions?: TemplateResult;
  iconName?: Parameters<typeof icon>[0];
}): TemplateResult {
  return html`
    <div class="banner" data-tone="${options.tone ?? 'info'}">
      <span data-icon="${options.iconName ?? (options.tone === 'warning' ? 'alert' : options.tone === 'danger' ? 'close-circle' : 'info')}"></span>
      <div class="banner-body">
        <strong>${escapeHtml(options.title)}</strong>
        ${options.body ? html`<span>${escapeHtml(options.body)}</span>` : ''}
      </div>
      ${options.actions ? html`<div class="banner-actions">${options.actions}</div>` : ''}
    </div>
  `;
}

export function emptyState(options: {
  iconName?: Parameters<typeof icon>[0];
  title: string;
  body: string;
  action?: TemplateResult;
}): TemplateResult {
  return html`
    <div class="ff-empty">
      <div class="empty-icon" data-icon="${options.iconName ?? 'sparkles'}"></div>
      <div class="ff-stack-sm" style="align-items:center">
        <p class="ff-heading">${escapeHtml(options.title)}</p>
        <p class="ff-body ff-secondary" style="max-width:44ch">${escapeHtml(options.body)}</p>
      </div>
      ${options.action ?? ''}
    </div>
  `;
}

/** Applies a dotted path value into a profile object (immutably). */
export function setPath<T extends object>(target: T, path: string, value: unknown): T {
  const clone = { ...target } as Record<string, unknown>;
  const parts = path.split('.');
  let cursor = clone;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    cursor[key] = { ...(cursor[key] as Record<string, unknown>) };
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  return clone as T;
}

export function getPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

/** Minimal textarea auto-grow. */
export function autoGrow(element: HTMLElement): void {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

export function sectionIntro(title: string, description: string): TemplateResult {
  return html`
    <div class="section-intro">
      <h2 class="ff-title">${escapeHtml(title)}</h2>
      <p>${escapeHtml(description)}</p>
    </div>
  `;
}

