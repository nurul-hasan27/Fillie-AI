import type { AccountStatus, StatusResponse } from '../shared/messages';
import { computeHashes } from '../core/cloud/fingerprint';
import { sendMessage, type ContentPingResponse } from '../shared/messages';
import { escapeHtml, html, preferredTheme, setTheme, type TemplateResult } from '../ui/dom';
import { icon } from '../ui/icons';
import { resumeArt } from '../ui/art';
import { VERSION } from '../shared/version';
import type { TrackerSummary } from '../core/cloud/applications';
import { PROVIDER_PRESETS } from '../core/ai/presets';
import { markSeen, readTour, shouldShow } from '../core/tour';
import { sized, sparkArt } from '../ui/art';
import { startTour } from '../ui/tour';

/**
 * Popup = quick status + one primary action. Anything that needs room (profile,
 * settings, memory) lives in the Fillie tab.
 */

const app = document.getElementById('app')!;

/** Inline markup that is already safe (our own illustrations), so the template does not escape it. */
const raw = (markup: string): TemplateResult => ({ __html: markup, nodes: [] });

const CROWN = html`<svg class="pop-crown" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3 8l4.6 4.2L12 5l4.4 7.2L21 8l-2 10.5H5L3 8zm2 12h14v1.5H5V20z" /></svg>`;

/**
 * The popup opens with the last numbers it saw, so nothing flashes or counts up, then
 * checks quietly in the background. A cached copy is trusted for a minute unless the
 * background says something changed (an application was saved, AI keys were edited, ...).
 */
const CACHE_KEY = 'fillie:popup-cache';
const DIRTY_KEY = 'fillie:popup-dirty';
const FRESH_MS = 60_000;

interface PopupData {
  status: StatusResponse;
  summary: TrackerSummary;
  at: number;
}

async function readCache(): Promise<{ data?: PopupData; fresh: boolean }> {
  try {
    const stored = await chrome.storage.local.get([CACHE_KEY, DIRTY_KEY]);
    const data = stored[CACHE_KEY] as PopupData | undefined;
    if (!data) return { fresh: false };
    const dirtyAt = Number(stored[DIRTY_KEY] ?? 0);
    return { data, fresh: Date.now() - data.at < FRESH_MS && dirtyAt <= data.at };
  } catch {
    return { fresh: false };
  }
}

async function loadFresh(): Promise<PopupData> {
  const [status, summary] = await Promise.all([
    loadStatus(),
    sendMessage<TrackerSummary>({ type: 'fillie:apps-summary' }).catch(
      () => ({ total: 0, counts: { applied: 0, interview: 0, offer: 0, rejected: 0 }, upcoming: [], localOnly: true }) as TrackerSummary,
    ),
  ]);
  const data = { status, summary, at: Date.now() };
  void chrome.storage.local.set({ [CACHE_KEY]: data }).catch(() => undefined);
  return data;
}

/** What is on screen, so an unchanged refresh repaints nothing. */
let shown = '';

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
          </button>
        `
      : html`<button class="pop-signin" data-action="open-account" type="button">Sign in</button>`
    : '';
  // Premium is a quiet mark; everyone else sees a small way to get it.
  const premium = access
    ? access.plan === 'paid'
      ? html`<span class="pop-premium" title="You have unlimited access">${CROWN}Premium</span>`
      : html`<button class="pop-getpremium" data-action="open-account" type="button">${CROWN}Get premium</button>`
    : '';

  const header = html`
    <header class="pop-head rise" style="--i:0">
      <div class="pop-brand">
        <span class="pop-mark" aria-hidden="true"></span>
        <strong class="pop-name">Fillie</strong>
      </div>
      <div class="pop-head-right">
        ${account}${premium}
        <button class="pop-ext" data-action="open-app" type="button" aria-label="Open Fillie" title="Open Fillie">
          <span data-icon="external" data-size="14"></span>
        </button>
      </div>
    </header>
  `;

  if (state.busy) {
    return html`
      ${header}
      <div class="pop-body">
        <div class="pop-scanning">
          <div class="pop-orb">${raw(sized(sparkArt, 72))}</div>
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
          <div class="pop-orb">${raw(sized(resumeArt, 64))}</div>
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
  const aiLine = `Ready · ${escapeHtml(provider?.label ?? 'AI')}`;

  return html`
    ${header}
    <div class="pop-body">
      <section class="pop-summary rise" style="--i:1" aria-label="Your applications">
        <div class="pop-hero-top">
          <div class="pop-total">
            ${summary
              ? html`<b>${summary.total}</b>`
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
            : html`<ol class="pop-interviews" data-scroll="${String(summary.upcoming.length > 2)}">${summary.upcoming.map((item, index) => interviewRow(item, index))}</ol>`}
      </section>

      <button class="pop-cta rise" style="--i:3" data-action="run" type="button" ${state.pageOk ? '' : 'disabled'}>
        <span class="pop-cta-icon">${raw(sized(sparkArt, 34))}</span>
        <span class="pop-cta-body">
          <strong>${state.pageOk ? 'Fill this page' : 'No form on this page'}</strong>
          <span class="ff-meta">${state.pageOk ? escapeHtml(pageName) : 'Open a form, then come back'}</span>
        </span>
        <span class="pop-cta-go" data-icon="arrow-right"></span>
      </button>

      <footer class="pop-foot rise" style="--i:4">
        ${status.aiConfigured
          ? html`
              <span class="pop-dot" data-ok="true"></span>
              <span>${aiLine}</span>
              <button class="pop-link pop-gear" data-action="open-settings" type="button" aria-label="Settings"><span data-icon="sliders" data-size="12"></span></button>`
          : html`
              <button class="pop-setup-ai" data-action="open-ai-setup" type="button" title="Add a free key from Google Gemini, Cerebras or OpenRouter. It costs nothing extra.">
                <span data-icon="sparkle" data-size="12"></span> Set up AI · it's free
              </button>`}
        <span class="pop-sep">·</span>
        <span class="pop-keys" title="Run Fillie on the current page">⌥⇧F</span>
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

function paint(next: Parameters<typeof render>[0], phase: 'enter' | 'settled' = 'settled'): void {
  // "enter": the popup eases in once. "settled": later updates swap content without any motion.
  app.dataset.phase = phase;
  const result = render(next);
  app.innerHTML = result.__html;
  hydrate(app);
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

/** The theme chosen in Fillie > Appearance, or the system's when it is left on "System". */
async function chosenTheme(): Promise<'light' | 'dark'> {
  try {
    const stored = (await chrome.storage.local.get('fillie:theme'))['fillie:theme'];
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* fall through to the system theme */
  }
  return preferredTheme();
}

/** The first time the popup opens with a profile, point at the one button that matters. */
async function maybeShowPopupTip(): Promise<void> {
  const tour = await readTour();
  if (!shouldShow(tour, 'popup') || !document.querySelector('.pop-cta')) return;
  startTour({
    tip: true,
    steps: [{ id: 'tip-popup', art: sized(sparkArt, 78), title: 'This is the button', text: 'Open a job form, then press it. Or press Alt + Shift + F on the page.', keys: ['Alt', 'Shift', 'F'], target: '.pop-cta', button: 'Got it' }],
    onEnd: () => void markSeen('popup'),
  });
}

async function init(): Promise<void> {
  setTheme(await chosenTheme());
  const [cached, tab] = await Promise.all([readCache(), activeTab()]);
  const pageOk = await isFormPage(tab);

  if (cached.data) {
    // Final numbers, immediately. Nothing counts up and nothing flashes.
    paint({ status: cached.data.status, summary: cached.data.summary, pageOk, tab }, 'enter');
    shown = JSON.stringify([cached.data.status, cached.data.summary]);
    if (cached.fresh) return;
    const fresh = await loadFresh();
    const key = JSON.stringify([fresh.status, fresh.summary]);
    if (key !== shown) {
      shown = key;
      paint({ status: fresh.status, summary: fresh.summary, pageOk, tab }, 'settled');
    }
    return;
  }

  // First ever open: placeholders, then the numbers.
  const status = await loadStatus();
  paint({ status, pageOk, tab }, 'enter');
  const fresh = await loadFresh();
  shown = JSON.stringify([fresh.status, fresh.summary]);
  paint({ status: fresh.status, summary: fresh.summary, pageOk, tab }, 'settled');
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
  if (action === 'open-ai-setup') return void openApp('#/settings/ai');
  if (action === 'run') {
    const tab = await activeTab();
    if (tab?.id !== undefined) return void runOnPage(tab.id);
  }
});

void init().then(() => maybeShowPopupTip()).catch(() => undefined);

export { VERSION, paint };