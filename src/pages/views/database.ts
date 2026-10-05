import type { Application, ApplicationStatus } from '../../core/cloud/types';
import { APPLICATION_STATUSES } from '../../core/cloud/types';
import { escapeHtml, html, type TemplateResult } from '../../ui/dom';
import { banner, sectionIntro } from '../controls';

/**
 * Database view: every application the user has sent. Rows load 100 at a time.
 * Tags are colour-coded so status and notes can be read at a glance.
 */

export const STATUS_LABEL: Record<ApplicationStatus, string> = {
  applied: 'Applied',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
};

/** Pastel tones cycled over note tags so a row is easy to scan. */
const NOTE_TONES = ['sky', 'marigold', 'coral', 'green', 'sand'];

export interface DatabaseState {
  rows: Application[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  localOnly: boolean;
  signedIn: boolean;
  search: string;
  status: ApplicationStatus | 'all';
  error?: string;
}

export function formatDate(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatInterview(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function stars(app: Application): TemplateResult {
  const label = app.rating ? `Rated ${app.rating} out of 5${app.ratingSource === 'ai' ? ' (suggested by AI, tap to change)' : ''}` : 'Not rated, tap a star';
  return html`
    <span class="stars" role="group" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
      ${[1, 2, 3, 4, 5].map(
        (n) => html`<button class="star" type="button" data-action="rate-app" data-id="${escapeHtml(app.id)}" data-value="${n}" data-on="${String((app.rating ?? 0) >= n)}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`,
      )}
      ${app.ratingSource === 'ai' && app.rating ? html`<span class="ai-badge" title="Suggested by AI. Change it if you disagree.">AI</span>` : ''}
    </span>
  `;
}

function statusDetail(app: Application): TemplateResult | string {
  if (app.status === 'interview' && app.interviewAt) {
    return html`<span class="tag tag-marigold-line" title="Interview">🗓 ${escapeHtml(formatInterview(app.interviewAt))}</span>`;
  }
  if (app.status === 'offer' && app.offerLpa !== null) {
    return html`<span class="tag tag-green-line" title="Offered package">${escapeHtml(String(app.offerLpa))} LPA</span>`;
  }
  return '';
}

function row(app: Application): TemplateResult {
  return html`
    <article class="app-row" data-app-id="${escapeHtml(app.id)}" data-status="${app.status}">
      <div class="app-main">
        <h3>${escapeHtml(app.company)}</h3>
        <p>${escapeHtml(app.role)}</p>
      </div>
      <div class="app-status">
        <button class="tag tag-${app.status}" type="button" data-action="edit-app" data-id="${escapeHtml(app.id)}" title="Change status">${STATUS_LABEL[app.status]}</button>
        ${statusDetail(app)}
      </div>
      <div class="app-meta">
        <span class="ff-meta">Applied ${escapeHtml(formatDate(app.appliedAt))}</span>
        ${stars(app)}
      </div>
      <div class="app-notes">
        ${app.notes.map((note, i) => html`<span class="tag tag-note tag-${NOTE_TONES[i % NOTE_TONES.length]}">${escapeHtml(note)}</span>`)}
      </div>
      <div class="app-actions">
        ${app.url ? html`<a class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" href="${escapeHtml(app.url)}" target="_blank" rel="noreferrer" aria-label="Open the posting"><span data-icon="external" data-size="14"></span></a>` : ''}
        <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" type="button" data-action="edit-app" data-id="${escapeHtml(app.id)}" aria-label="Edit"><span data-icon="pencil" data-size="14"></span></button>
        <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" type="button" data-action="delete-app" data-id="${escapeHtml(app.id)}" aria-label="Delete"><span data-icon="trash" data-size="14"></span></button>
      </div>
    </article>
  `;
}

export function databaseView(state: DatabaseState): TemplateResult {
  const chips: Array<ApplicationStatus | 'all'> = ['all', ...APPLICATION_STATUSES];
  return html`
    ${sectionIntro('Your applications', 'Everything you have applied to, in one place. Update the status as things move.')}
    ${state.localOnly && state.loaded
      ? banner({
          tone: 'info',
          title: state.signedIn ? 'Showing what is saved on this device' : 'Saved on this device only',
          body: state.signedIn
            ? 'Fillie could not reach the cloud. Your rows will upload when it can.'
            : 'Sign in from the Account page to keep these safe in the cloud and see them anywhere.',
        })
      : ''}
    ${state.error ? banner({ tone: 'danger', title: 'Could not load', body: state.error }) : ''}
    <div class="db-toolbar">
      <div class="status-chips" role="group" aria-label="Filter by status">
        ${chips.map(
          (chip) => html`<button class="tag tag-${chip}${state.status === chip ? ' is-on' : ''}" type="button" data-action="filter-status" data-status="${chip}">${chip === 'all' ? 'All' : STATUS_LABEL[chip]}</button>`,
        )}
      </div>
      <div class="db-actions">
        <input class="ff-input" id="db-search" type="search" placeholder="Search company or role…" value="${escapeHtml(state.search)}" aria-label="Search applications" />
        <button class="ff-btn ff-btn-primary" type="button" data-action="add-app"><span data-icon="plus" data-size="14"></span> Add</button>
      </div>
    </div>

    ${!state.loaded
      ? html`<div class="db-empty"><span class="ff-spinner"></span><p>Loading…</p></div>`
      : state.rows.length === 0
        ? html`
            <div class="db-empty">
              <div class="db-empty-art" aria-hidden="true">📋</div>
              <h3>${state.search || state.status !== 'all' ? 'No matches' : 'No applications yet'}</h3>
              <p>${state.search || state.status !== 'all' ? 'Try another search or filter.' : 'Fill a form with Fillie and it shows up here automatically, or add one yourself.'}</p>
            </div>
          `
        : html`
            <section class="app-list" aria-label="Applications">${state.rows.map(row)}</section>
            <div class="db-foot">
              <span class="ff-meta">${state.rows.length} shown</span>
              ${state.hasMore
                ? html`<button class="ff-btn ff-btn-secondary" id="db-more" type="button" data-action="load-more" ${state.loading ? 'disabled' : ''}>${state.loading ? 'Loading…' : 'Load more'}</button>`
                : html`<span class="ff-meta">That is everything</span>`}
            </div>
          `}
  `;
}

/** Add / edit form, shown in a dialog. */
export function applicationEditor(app: Application, isNew: boolean): TemplateResult {
  return html`
    <div class="modal-backdrop" data-action="close-editor">
      <form class="modal" id="app-form" role="dialog" aria-modal="true" aria-labelledby="app-form-title" data-id="${escapeHtml(app.id)}" data-new="${String(isNew)}">
        <h2 id="app-form-title">${isNew ? 'Add application' : 'Edit application'}</h2>
        <div class="grid-2">
          <div class="ff-field"><label class="ff-field-label" for="af-company">Company</label>
            <input class="ff-input" id="af-company" name="company" value="${escapeHtml(app.company)}" required /></div>
          <div class="ff-field"><label class="ff-field-label" for="af-role">Role</label>
            <input class="ff-input" id="af-role" name="role" value="${escapeHtml(app.role)}" required /></div>
        </div>

        <div class="ff-field">
          <span class="ff-field-label">Status</span>
          <div class="status-chips" role="radiogroup" aria-label="Status">
            ${APPLICATION_STATUSES.map(
              (s) => html`<label class="tag tag-${s}${app.status === s ? ' is-on' : ''}"><input type="radio" name="status" value="${s}" ${app.status === s ? 'checked' : ''} hidden />${STATUS_LABEL[s]}</label>`,
            )}
          </div>
        </div>

        <div class="grid-2">
          <div class="ff-field" data-only="interview"><label class="ff-field-label" for="af-interview">Interview date &amp; time</label>
            <input class="ff-input" id="af-interview" name="interviewAt" type="datetime-local" value="${escapeHtml(app.interviewAt ?? '')}" /></div>
          <div class="ff-field" data-only="offer"><label class="ff-field-label" for="af-offer">Package (LPA)</label>
            <input class="ff-input" id="af-offer" name="offerLpa" type="number" min="0" step="0.1" value="${app.offerLpa ?? ''}" placeholder="e.g. 12" /></div>
          <div class="ff-field"><label class="ff-field-label" for="af-applied">Applied on</label>
            <input class="ff-input" id="af-applied" name="appliedAt" type="date" value="${escapeHtml(app.appliedAt)}" /></div>
          <div class="ff-field"><span class="ff-field-label">Your rating</span>
            <div class="rating-edit" role="radiogroup" aria-label="Rating">
              ${[1, 2, 3, 4, 5].map(
                (n) => html`<label class="star" data-on="${String((app.rating ?? 0) >= n)}"><input type="radio" name="rating" value="${n}" ${app.rating === n ? 'checked' : ''} hidden />★</label>`,
              )}
              <button class="ff-btn ff-btn-ghost ff-btn-sm" type="button" data-action="clear-rating">Clear</button>
            </div>
            ${app.ratingSource === 'ai' && app.rating ? html`<span class="ff-hint">Suggested by AI. It is your call.</span>` : ''}
          </div>
        </div>

        <div class="ff-field"><label class="ff-field-label" for="af-notes">Notes (one per line)</label>
          <textarea class="ff-textarea" id="af-notes" name="notes" rows="4" placeholder="2 year bond&#10;Good mentors">${escapeHtml(app.notes.join('\n'))}</textarea></div>

        <div class="row-wrap" style="justify-content:flex-end">
          <button class="ff-btn ff-btn-ghost" type="button" data-action="close-editor">Cancel</button>
          <button class="ff-btn ff-btn-primary" type="submit">Save</button>
        </div>
      </form>
    </div>
  `;
}
