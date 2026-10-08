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

function ctcTag(app: Application): TemplateResult | string {
  return app.offeredCtc
    ? html`<span class="tag tag-green-line tag-ctc" title="Pay stated in the posting">💰 ${escapeHtml(app.offeredCtc)}</span>`
    : '';
}

const HEART = html`<svg class="prep-heart" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 13.6C3.2 10.2 2 7.3 3.4 5.3a2.9 2.9 0 0 1 4.6-.2 2.9 2.9 0 0 1 4.6.2c1.4 2-.2 4.9-4.6 8.3Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

/** The highlighted button on each application: opens the questions and answers the user kept for the interview. */
function prepButton(app: Application): TemplateResult {
  const count = app.savedAnswers?.length ?? 0;
  return html`<button class="prep-btn" type="button" data-action="open-prep" data-id="${escapeHtml(app.id)}" data-count="${count}" title="Questions and answers you saved from this form">${HEART}<span>Interview prep</span><b>${count}</b></button>`;
}

function row(app: Application): TemplateResult {
  return html`
    <article class="app-row" data-app-id="${escapeHtml(app.id)}" data-status="${app.status}">
      <div class="app-main">
        <h3>${escapeHtml(app.company)}</h3>
        ${app.role
          ? html`<p>${escapeHtml(app.role)}</p>`
          : app.resumeName
            ? html`<p class="app-resume" title="The role could not be read, so this shows the resume used"><em>(${escapeHtml(app.resumeName)})</em></p>`
            : html`<p class="ff-meta">Role not found</p>`}
      </div>
      <div class="app-status">
        <button class="tag tag-${app.status}" type="button" data-action="edit-app" data-id="${escapeHtml(app.id)}" title="Change status">${STATUS_LABEL[app.status]}</button>
        ${statusDetail(app)}
        ${ctcTag(app)}
      </div>
      <div class="app-meta">
        <span class="ff-meta">Applied ${escapeHtml(formatDate(app.appliedAt))}</span>
        ${stars(app)}
      </div>
      <div class="app-notes">
        ${prepButton(app)}
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
            <input class="ff-input" id="af-role" name="role" value="${escapeHtml(app.role)}" placeholder="${escapeHtml(app.resumeName ? `(${app.resumeName})` : '')}" /></div>
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
          <div class="ff-field"><label class="ff-field-label" for="af-ctc">Offered CTC</label>
            <input class="ff-input" id="af-ctc" name="offeredCtc" value="${escapeHtml(app.offeredCtc)}" maxlength="80" placeholder="e.g. 8-12 LPA (left empty if the posting does not say)" /></div>
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

/**
 * "Interview prep": the questions the user hearted while filling this form. Each one opens to show the answer
 * exactly as it was on the form, ready to read before the interview.
 */
export function prepModal(app: Application, openId: string | null): TemplateResult {
  const answers = app.savedAnswers ?? [];
  return html`
    <div class="modal-backdrop" data-action="close-prep">
      <section class="modal prep-modal" role="dialog" aria-modal="true" aria-labelledby="prep-title">
        <button class="prep-close" type="button" data-action="close-prep" aria-label="Close">×</button>
        <header class="prep-head">
          <span class="prep-art" aria-hidden="true">${HEART}</span>
          <div>
            <h2 id="prep-title">Interview prep</h2>
            <p class="ff-meta">${escapeHtml(app.company)}${app.role ? ` · ${escapeHtml(app.role)}` : ''}</p>
          </div>
        </header>
        ${answers.length === 0
          ? html`<div class="prep-empty">
              <span class="prep-beat" aria-hidden="true">${HEART}</span>
              <h3>Nothing saved yet</h3>
              <p>While Fillie fills a form, tap the heart next to an answer to keep it here. Read it again before the interview.</p>
            </div>`
          : html`
              <p class="prep-lead">${answers.length} saved ${answers.length === 1 ? 'answer' : 'answers'}. Tap a question to read it.</p>
              <ol class="prep-list">
                ${answers.map((item, index) => {
                  const open = item.id === openId;
                  return html`
                    <li class="prep-item" data-open="${String(open)}">
                      <button class="prep-q" type="button" data-action="toggle-prep" data-qid="${escapeHtml(item.id)}" aria-expanded="${String(open)}">
                        <span class="prep-n">${index + 1}</span>
                        <span class="prep-qt">${escapeHtml(item.question)}</span>
                        <span class="prep-chevron" aria-hidden="true"></span>
                      </button>
                      <div class="prep-a-wrap"><div class="prep-a-inner">
                        <p class="prep-a">${escapeHtml(item.answer)}</p>
                        <div class="prep-a-actions">
                          <button class="ff-btn ff-btn-secondary ff-btn-sm" type="button" data-action="copy-prep" data-qid="${escapeHtml(item.id)}">Copy answer</button>
                          <button class="ff-btn ff-btn-ghost ff-btn-sm" type="button" data-action="remove-prep" data-qid="${escapeHtml(item.id)}">Remove</button>
                        </div>
                      </div></div>
                    </li>`;
                })}
              </ol>`}
      </section>
    </div>
  `;
}
