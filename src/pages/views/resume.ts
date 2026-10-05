import type { ResumesState } from '../../core/types';
import { escapeHtml, html, type TemplateResult } from '../../ui/dom';
import { sectionIntro } from '../controls';
import { resumeArt } from '../../ui/art';

/**
 * Resume tab. Each resume has a tag the user chooses ("Frontend", "Data
 * science", …). Before Fillie answers a form it asks which one to use and
 * highlights the best match for the posting.
 */

export function resumeView(resumes: ResumesState, activeId: string): TemplateResult {
  const active = resumes.resumes.find((r) => r.id === activeId) ?? resumes.resumes[0];

  const tabs = html`
    <div class="resume-tabs" role="tablist" aria-label="Your resumes">
      ${resumes.resumes.map(
        (r) => html`
          <button
            class="resume-tab"
            type="button"
            role="tab"
            data-action="select-resume"
            data-id="${escapeHtml(r.id)}"
            aria-selected="${r.id === active?.id ? 'true' : 'false'}"
          >
            <span class="resume-tab-name" data-resume-tab-name="${escapeHtml(r.id)}">${escapeHtml(r.name || 'Untitled')}</span>
            ${r.id === resumes.defaultId ? html`<span class="resume-tab-default" title="Default resume">Default</span>` : ''}
          </button>
        `,
      )}
      <button class="resume-tab resume-tab-new" type="button" data-action="new-resume">
        <span data-icon="plus" data-size="13"></span> New resume
      </button>
    </div>
  `;

  if (!active) {
    return html`
      ${sectionIntro('Role-based resumes', 'Keep one resume per kind of role. Fillie asks which to use before it answers a form.')}
      <div class="resume-empty">
        ${resumeArt}
        <h3>Add your first resume</h3>
        <p>Paste it as plain text or upload a PDF, DOCX or TXT. Give it a tag such as “Frontend” so it is easy to pick later.</p>
        <div class="row-wrap">
          <button class="ff-btn ff-btn-primary" type="button" data-action="new-resume">
            <span data-icon="plus" data-size="14"></span> Paste a resume
          </button>
          <label class="ff-btn ff-btn-secondary">
            <span data-icon="upload" data-size="14"></span> Upload a file
            <input id="resume-upload" type="file" accept=".txt,.pdf,.docx,text/plain" hidden />
          </label>
        </div>
      </div>
    `;
  }

  return html`
    ${sectionIntro(
      'Role-based resumes',
      'One resume per kind of role. Before answering a form, Fillie asks which to use and highlights the best match for the job description.',
    )}
    ${tabs}
    <div class="resume-editor">
      <div class="resume-toolbar">
        <div class="ff-field resume-name-field">
          <label class="ff-field-label" for="resume-name">Tag</label>
          <input class="ff-input" id="resume-name" value="${escapeHtml(active.name)}" maxlength="40" placeholder="e.g. Frontend, Data science" />
        </div>
        <div class="resume-actions">
          <label class="ff-btn ff-btn-secondary ff-btn-sm">
            <span data-icon="upload" data-size="13"></span> Replace from file
            <input id="resume-upload" type="file" accept=".txt,.pdf,.docx,text/plain" hidden />
          </label>
          <button class="ff-btn ff-btn-ghost ff-btn-sm" type="button" data-action="default-resume" data-id="${escapeHtml(active.id)}" ${active.id === resumes.defaultId ? 'disabled' : ''}>
            Make default
          </button>
          <button class="ff-btn ff-btn-ghost ff-btn-sm" type="button" data-action="delete-resume" data-id="${escapeHtml(active.id)}">
            <span data-icon="trash" data-size="13"></span> Delete
          </button>
        </div>
      </div>
      <textarea
        class="ff-textarea resume-textarea"
        id="resume-text"
        spellcheck="false"
        placeholder="Paste this resume as plain text…"
        aria-label="Resume text"
      >${escapeHtml(active.text)}</textarea>
      <div class="ff-row-between">
        <span class="ff-meta" id="resume-count">${active.text.length.toLocaleString()} characters</span>
        <span class="ff-meta">Saved automatically · stays in this browser</span>
      </div>
    </div>
  `;
}
