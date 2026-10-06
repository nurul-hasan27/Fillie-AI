import type { AccountStatus, StatusResponse } from '../shared/messages';
import { computeHashes } from '../core/cloud/fingerprint';
import { sendMessage, type ContentPingResponse } from '../shared/messages';
import { escapeHtml, html, preferredTheme, setTheme, type TemplateResult } from '../ui/dom';
import { icon } from '../ui/icons';
import { VERSION } from '../shared/version';
import type { TrackerSummary } from '../core/cloud/applications';
import { PROVIDER_PRESETS } from '../core/ai/presets';

/**
 * Popup = quick status + one primary action. Anything that needs room (profile,
 * settings, memory) lives in the Fillie tab.
 */

const app = document.getElementById('app')!;

interface TabInfo {
  id?: number;
  url?: string;
  active?: boolean;
}

function render(state: {
  status?: StatusResponse;
  pageOk: boolean;
  tab?: TabInfo;
  busy?: boolean;
  message?: string;
  summary?: TrackerSummary;
}): TemplateResult {
  const status = state.status;
  const provider = PROVIDER_PRESETS.find((preset) => preset.id === (status?.provider ?? 'groq'));

  const access = status?.access;
  const email = access?.signedIn ? access.email ?? '' : '';
  const account = access
    ? email
      ? html`
          <button class="pop-user" data-action="open-account" type="button" title="${escapeHtml(email)}">
            <span class="pop-avatar" aria-hidden="true">${escapeHtml(email.charAt(0).toUpperCase())}</span>
            <span class="pop-user-text">
              <strong>${escapeHtml(email)}</strong>
              <span>${access.plan === 'paid' ? 'Unlocked' : `${access.remaining} free left this week`}</span>
            </span>
          </button>
        `
      : html`<button class="pop-signin" data-action="open-account" type="button">Sign in</button>`
    : '';

  const header = html`
    <header class="pop-head rise" style="--i:0">
      <div class="pop-brand">
        <span class="pop-mark" aria-hidden="true"></span>
        <strong class="pop-name">Fillie</strong>
      </div>
      ${account}
      <button class="ff-btn ff-btn-ghost ff-btn-icon ff-btn-sm" data-action="open-app" type="button" aria-label="Open Fillie" title="Open Fillie">
        <span data-icon="external"></span>
      </button>
    </header>
  `;

  if (state.busy) {
    return html`
      ${header}
      <div class="pop-body">
        <div class="pop-scanning">
          <div class="pop-orb" data-icon="sparkle"></div>
          <p class="ff-heading">Working on this page…</p>
          <p class="ff-meta">${escapeHtml(state.message ?? 'Scanning the form.')}</p>
          <div class="ff-progress"><span class="ff-progress-bar ff-progress-bar--indeterminate"></span></div>
        </div>
      </div>
    `;
  }

  if (!status) {
    return html`
      ${header}
      <div class="pop-body">
        <div class="ff-empty">
          <div class="ff-empty-art" data-icon="info"></div>
          <p class="ff-body ff-secondary">Fillie could not read its storage. Try reloading the extension.</p>
        </div>
      </div>
    `;
  }

  if (!status.hasProfile) {
    return html`
      ${header}
      <div class="pop-body">
        <div class="pop-hero">
          <div class="pop-orb" data-icon="sparkles"></div>
          <h1 class="ff-display">Tell Fillie about you once</h1>
          <p class="ff-body ff-secondary">
            Add your education, experience, projects and preferences. Fillie then answers most application
            questions on its own.
          </p>
        </div>
        <button class="ff-btn ff-btn-primary ff-btn-lg ff-btn-block" data-action="open-profile" type="button">
          Set up my profile
        </button>
        ${!status.aiConfigured
          ? html`<p class="ff-hint pop-note">
              ${icon('sparkle', { size: 13 })}
              Without an AI key Fillie still fills from your profile. Add one in Settings for generated answers.
            </p>`
          : ''}
      </div>
    `;
  }

  const pageName = pageTitle(state.tab?.url);
  const summary = state.summary;
  const counts = summary?.counts ?? { applied: 0, interview: 0, offer: 0, rejected: 0 };
  const pipeline: Array<[keyof typeof counts, string]> = [
    ['applied', 'Applied'],
    ['interview', 'Interview'],
    ['offer', 'Offer'],
    ['rejected', 'Rejected'],
  ];
  const aiLine = status.aiConfigured ? `Ready · ${escapeHtml(provider?.label ?? 'AI')}` : 'Profile only (no AI key)';

  return html`
    ${header}
    <div class="pop-body">
      <section class="pop-summary rise" style="--i:1" aria-label="Your applications">
        <div class="pop-hero-top">
          <div class="pop-total">
            ${summary
              ? html`<b data-count="${summary.total}">${summary.total}</b>`
              : html`<b class="skeleton" aria-hidden="true">00</b>`}
            <span>${summary?.total === 1 ? 'form filled' : 'forms filled'}</span>
          </div>
          <button class="pop-viewall" data-action="open-database" type="button">
            View all <span data-icon="arrow-right" data-size="14"></span>
          </button>
        </div>
        <div class="pop-pipeline" role="list">
          ${pipeline.map(
            ([key, label], index) => html`
              <button class="pop-chip pop-chip-${key}" style="--j:${index}" data-action="open-database" type="button" role="listitem">
                <b>${summary ? counts[key] : '–'}</b><span>${label}</span>
              </button>
            `,
          )}
        </div>
        ${summary?.localOnly && summary.total > 0
          ? html`<p class="pop-local">Saved on this device. <button class="pop-link" data-action="open-account" type="button">Sign in to back up</button></p>`
          : ''}
      </section>

      <section class="pop-upcoming rise" style="--i:2" aria-label="Upcoming interviews">
        <div class="pop-section-head">
          <h2>Upcoming interviews</h2>
          ${summary && summary.upcoming.length ? html`<span class="pop-count">${summary.upcoming.length}</span>` : ''}
        </div>
        ${!summary
          ? html`<div class="pop-skel-list"><i class="skeleton"></i><i class="skeleton"></i></div>`
          : summary.upcoming.length === 0
            ? html`<p class="pop-empty">No interviews scheduled. When you set one in the Database, it shows up here.</p>`
            : html`<ol class="pop-interviews">${summary.upcoming.map((item, index) => interviewRow(item, index))}</ol>`}
      </section>

      <button class="pop-cta rise" style="--i:3" data-action="run" type="button" ${state.pageOk ? '' : 'disabled'}>
        <span class="pop-cta-icon" data-icon="sparkle"></span>
        <span class="pop-cta-body">
          <strong>${state.pageOk ? 'Fill this page' : 'No form on this page'}</strong>
          <span class="ff-meta">${state.pageOk ? escapeHtml(pageName) : 'Open a form, then come back'}</span>
        </span>
        <span class="pop-cta-go" data-icon="arrow-right"></span>
      </button>

      <footer class="pop-foot rise" style="--i:4">
        <span class="pop-dot" data-ok="${status.aiConfigured}"></span>
        <span>${aiLine}</span>
        <span class="pop-sep">·</span>
        <span class="pop-keys" title="Run Fillie on the current page">⌥⇧F</span>
        <button class="pop-link" data-action="open-settings" type="button" aria-label="Settings"><span data-icon="sliders" data-size="12"></span></button>
      </footer>
    </div>
  `;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Today", "Tomorrow" or "in 3 days" for a scheduled time. */
export function whenLabel(when: Date, now = new Date()): string {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(when) - startOfDay(now)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `in ${days} days`;
}

function interviewRow(item: TrackerSummary['upcoming'][number], index: number): TemplateResult {
  const when = new Date(item.interviewAt);
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const weekday = when.toLocaleDateString(undefined, { weekday: 'short' });
  const label = whenLabel(when);
  return html`
    <li class="pop-interview" style="--k:${index}" data-soon="${label === 'Today' || label === 'Tomorrow'}">
      <time class="pop-date" datetime="${escapeHtml(item.interviewAt)}">
        <span>${MONTHS[when.getMonth()]}</span><b>${when.getDate()}</b>
      </time>
      <div class="pop-interview-main">
        <strong>${escapeHtml(item.company)}</strong>
        <span>${item.role ? escapeHtml(item.role) : item.resumeName ? html`<em>(${escapeHtml(item.resumeName)})</em>` : 'Role not found'}</span>
      </div>
      <div class="pop-interview-when">
        <span class="pop-when">${label}</span>
        <span>${weekday} · ${time}</span>
      </div>
    </li>
  `;
}

function pageTitle(url?: string): string {
  if (!url) return 'This page';
  try {
    const parsed = new URL(url);
    if (/^(chrome|edge|about|chrome-extension):/.test(parsed.protocol)) return 'This browser page';
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return 'This page';
  }
}

function hydrate(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((node) => {
    const name = node.dataset.icon as Parameters<typeof icon>[0];
    node.replaceChildren(icon(name, { size: Number(node.dataset.size ?? 15) }));
  });
}

function paint(next: Parameters<typeof render>[0]): void {
  // The layout animates in once, while loading. When the numbers arrive only they animate.
  app.dataset.phase = next.summary ? 'ready' : 'loading';
  const result = render(next);
  app.innerHTML = result.__html;
  hydrate(app);
  countUp();
}

/** The big number counts up from zero (skipped when the user prefers reduced motion). */
function countUp(): void {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  app.querySelectorAll<HTMLElement>('[data-count]').forEach((node) => {
    const target = Number(node.dataset.count);
    if (reduced || !Number.isFinite(target) || target < 1) return;
    const start = performance.now();
    const duration = 750;
    node.textContent = '0';
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t); // ease-out expo
      node.textContent = String(Math.round(target * eased));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Frames can be paused while the popup is hidden; the final number must still be right.
    setTimeout(() => {
      node.textContent = String(target);
    }, duration + 80);
  });
}

async function loadStatus(): Promise<StatusResponse> {
  const status = await sendMessage<StatusResponse>({ type: 'fillie:get-status' });
  try {
    const account = await sendMessage<AccountStatus>({ type: 'fillie:account-status', device: await computeHashes() });
    if (account.cloudConfigured) status.access = account.access;
  } catch {
    /* the plan chip is optional */
  }
  return status;
}

async function activeTab(): Promise<TabInfo | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Asks the active tab's content script whether it is there. The message has to
 * go to the tab, not to the service worker — only the content script answers it.
 */
async function isFormPage(tab: TabInfo | undefined): Promise<boolean> {
  const url = tab?.url;
  if (tab?.id === undefined || !url || !/^https?:/.test(url)) return false;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'fillie:ping' });
    return Boolean((response as ContentPingResponse | undefined)?.ok);
  } catch {
    return false;
  }
}

async function runOnPage(tabId: number): Promise<void> {
  paint({ status: await loadStatus(), pageOk: true, tab: await activeTab(), busy: true, message: 'Scanning the page…' });
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'fillie:run' });
    window.close();
  } catch {
    paint({
      status: await loadStatus(),
      pageOk: false,
      tab: await activeTab(),
      message: 'Could not reach the page.',
    });
  }
}

async function openApp(path = ''): Promise<void> {
  const url = chrome.runtime.getURL(`pages/app.html${path}`);
  await chrome.tabs.create({ url });
  window.close();
}

async function init(): Promise<void> {
  setTheme(preferredTheme());
  const [status, tab] = await Promise.all([loadStatus(), activeTab()]);
  const pageOk = await isFormPage(tab);
  // Show the popup straight away, with placeholders where the numbers will be...
  paint({ status, pageOk, tab });
  // ...then fill them in.
  try {
    const summary = await sendMessage<TrackerSummary>({ type: 'fillie:apps-summary' });
    paint({ status, pageOk, tab, summary });
  } catch {
    paint({ status, pageOk, tab, summary: { total: 0, counts: { applied: 0, interview: 0, offer: 0, rejected: 0 }, upcoming: [], localOnly: true } });
  }
}

app.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'open-app') return void openApp();
  if (action === 'open-profile') return void openApp('#/profile/personal');
  if (action === 'open-memory') return void openApp('#/memory');
  if (action === 'open-database') return void openApp('#/database');
  if (action === 'open-account') return void openApp('#/account');
  if (action === 'open-settings') return void openApp('#/settings/ai');
  if (action === 'run') {
    const tab = await activeTab();
    if (tab?.id !== undefined) return void runOnPage(tab.id);
  }
});

void init();

export { VERSION, paint };