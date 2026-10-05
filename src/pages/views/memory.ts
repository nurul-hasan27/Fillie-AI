import type { LearnedAnswer } from '../../core/types';
import { escapeHtml, html, type TemplateResult } from '../../ui/dom';
import { formatRelativeTime } from '../../core/text';
import { banner, card, emptyState, sectionIntro } from '../controls';

/** Memory view: every answer the user has approved, with edit and delete. */

export function memoryView(entries: LearnedAnswer[], query: string): TemplateResult {
  const filtered = query
    ? entries.filter((entry) =>
        `${entry.question} ${entry.answer} ${entry.context.company ?? ''} ${entry.context.role ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
    : entries;

  const header = html`
    ${sectionIntro(
      'Learned answers',
      'Answers you approved. Fillie reuses them for similar questions and adapts them to the company you are applying to.',
    )}
    ${entries.length === 0
      ? emptyState({
          iconName: 'brain',
          title: 'No saved answers yet',
          body: 'As you approve answers while applying, Fillie will remember them for next time.',
        })
      : html`
          <div class="ff-card" style="padding:var(--ff-space-3) var(--ff-space-4)">
            <div class="ff-row">
              <span class="ff-grow" style="position:relative;display:block">
                <input
                  class="ff-input"
                  type="search"
                  id="memory-search"
                  placeholder="Search saved answers…"
                  value="${escapeHtml(query)}"
                  style="padding-left:30px"
                />
                <span style="position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--ff-text-tertiary);display:grid" data-icon="search" data-size="13"></span>
              </span>
              <button class="ff-btn ff-btn-ghost ff-btn-sm" data-action="clear-memory" type="button" ${entries.length ? '' : 'disabled'}>
                <span data-icon="trash" data-size="13"></span> Clear all
              </button>
            </div>
          </div>
          ${filtered.length === 0
            ? banner({ tone: 'info', title: 'No matches', body: 'Try a different search term.' })
            : html`
                <section class="ff-card">
                  ${filtered.map((entry) => memoryItem(entry))}
                </section>
              `}
        `}
  `;

  return header;
}

function memoryItem(entry: LearnedAnswer): TemplateResult {
  const contextLabel = entry.context.company
    ? `${entry.context.company}${entry.context.role ? ` · ${entry.context.role}` : ''}`
    : (entry.context.host ?? 'General');

  return html`
    <article class="memory-item" data-memory-id="${escapeHtml(entry.id)}">
      <div class="ff-row-between">
        <h3 class="memory-q">${escapeHtml(entry.question || 'Untitled question')}</h3>
        <div class="ff-row" style="gap:2px;flex:none">
          <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" data-action="edit-memory" data-id="${escapeHtml(entry.id)}" type="button" title="Edit">
            <span data-icon="pencil" data-size="13"></span>
          </button>
          <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" data-action="delete-memory" data-id="${escapeHtml(entry.id)}" type="button" title="Delete">
            <span data-icon="trash" data-size="13"></span>
          </button>
        </div>
      </div>
      <p class="memory-a">${escapeHtml(entry.answer)}</p>
      <div class="memory-meta">
        <span class="ff-chip ${entry.context.isGeneric ? 'ff-chip-accent' : ''}">
          ${entry.context.isGeneric ? 'Reusable anywhere' : `Specific to ${escapeHtml(contextLabel)}`}
        </span>
        ${entry.sources.slice(0, 3).map((source) => html`<span class="ff-chip">${escapeHtml(source.label)}</span>`)}
        <span class="ff-meta" style="margin-left:auto">Used ${entry.useCount}× · ${escapeHtml(formatRelativeTime(entry.updatedAt))}</span>
      </div>
    </article>
  `;
}

export function memoryEditor(entry: LearnedAnswer): TemplateResult {
  return html`
    ${sectionIntro('Edit answer', 'Changes take effect the next time Fillie matches a similar question.')}
    ${card(
      'Answer',
      html`
        <div class="stack-md">
          <div class="ff-field">
            <span class="ff-field-label">Original question</span>
            <p class="ff-body ff-secondary">${escapeHtml(entry.question)}</p>
          </div>
          <div class="ff-field">
            <label class="ff-field-label" for="memory-answer">Your answer</label>
            <textarea class="ff-textarea" id="memory-answer" rows="7">${escapeHtml(entry.answer)}</textarea>
          </div>
          <label class="ff-switch">
            <input type="checkbox" id="memory-generic" ${entry.context.isGeneric ? 'checked' : ''} />
            <span class="ff-switch-track"><span class="ff-switch-thumb"></span></span>
            <span class="ff-body">Reusable for any company</span>
          </label>
          <div class="row-wrap">
            <button class="ff-btn ff-btn-primary" data-action="save-memory" data-id="${escapeHtml(entry.id)}" type="button">
              <span data-icon="check" data-size="14"></span> Save answer
            </button>
            <button class="ff-btn ff-btn-ghost" data-action="cancel-memory-edit" type="button">Cancel</button>
          </div>
        </div>
      `,
    )}
  `;
}