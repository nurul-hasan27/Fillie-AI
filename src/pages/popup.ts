import type { AccountStatus, StatusResponse } from '../shared/messages';
import { computeHashes } from '../core/cloud/fingerprint';
import { sendMessage, type ContentPingResponse } from '../shared/messages';
import { escapeHtml, html, preferredTheme, setTheme, type TemplateResult } from '../ui/dom';
import { icon } from '../ui/icons';
import { VERSION } from '../shared/version';
import { formatRelativeTime } from '../core/text';
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
}): TemplateResult {
  const status = state.status;
  const provider = PROVIDER_PRESETS.find((preset) => preset.id === (status?.provider ?? 'groq'));

  const header = html`
    <header class="pop-head">
      <div class="pop-brand">
        <span class="pop-mark" aria-hidden="true"></span>
        <div class="pop-brand-text">
          <strong>Fillie</strong>
          <span class="ff-meta">Personal form assistant</span>
        </div>
      </div>
      <button class="ff-btn ff-btn-ghost ff-btn-sm" data-action="open-app" type="button">
        Open Fillie
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

  const stats = status.lastSession?.stats;
  const pageName = pageTitle(state.tab?.url);

  return html`
    ${header}
    <div class="pop-body">
      <div class="pop-status">
        <span class="ff-status ${status.aiConfigured ? 'ff-status--filled' : 'ff-status--attention'}">
          <span class="ff-status-dot"></span>
          ${status.aiConfigured ? `Ready · ${escapeHtml(provider?.label ?? 'AI')}` : 'Profile only'}
        </span>
        ${status.access
          ? html`<span class="pop-plan" data-plan="${status.access.plan}">${status.access.plan === 'paid' ? 'Unlocked' : `${status.access.remaining} free left`}</span>`
          : html`<span class="ff-meta">${status.profileCompleteness}% profile</span>`}
      </div>

      <button class="pop-cta" data-action="run" type="button" ${state.pageOk ? '' : 'disabled'}>
        <span class="pop-cta-icon" data-icon="sparkle"></span>
        <span class="pop-cta-body">
          <strong>${state.pageOk ? 'Fill this page' : 'No form here yet'}</strong>
          <span class="ff-meta">${state.pageOk ? escapeHtml(pageName) : 'Open a form, then come back'}</span>
        </span>
        <span class="pop-cta-go" data-icon="arrow-right"></span>
      </button>

      <div style="display:flex; justify-content:center; margin-top:-4px; margin-bottom:var(--ff-space-2);">
        <span class="ff-meta" style="font-size:11px;">Shortcut: <kbd style="background:var(--surface-2); padding:1px 5px; border-radius:4px; border:1px solid var(--border); font-family:inherit;">⌥⇧F</kbd> / <kbd style="background:var(--surface-2); padding:1px 5px; border-radius:4px; border:1px solid var(--border); font-family:inherit;">Alt+Shift+F</kbd></span>
      </div>

      ${
        stats
          ? html`
              <section class="pop-section">
                <div class="ff-row-between">
                  <span class="ff-label">Last run</span>
                  <span class="ff-meta">${escapeHtml(formatRelativeTime(status.lastSession!.at))}</span>
                </div>
                <div class="pop-metrics">
                  <div><b>${stats.total}</b><span>questions</span></div>
                  <div><b>${stats.verified || stats.filledFromProfile + stats.filledFromMemory + stats.generated}</b><span>filled</span></div>
                  <div>
                    <b class="${stats.needsAttention ? 'is-warning' : ''}">${stats.needsAttention}</b>
                    <span>needed you</span>
                  </div>
                </div>
              </section>
            `
          : html`
              <section class="pop-section">
                <span class="ff-label">Quick actions</span>
                <div class="pop-actions">
                  <button class="ff-btn ff-btn-secondary ff-btn-sm" data-action="open-profile" type="button">
                    <span data-icon="user"></span> Profile
                  </button>
                  <button class="ff-btn ff-btn-secondary ff-btn-sm" data-action="open-database" type="button">
                    <span data-icon="layers"></span> Database
                  </button>
                  <button class="ff-btn ff-btn-secondary ff-btn-sm" data-action="open-memory" type="button">
                    <span data-icon="brain"></span> Memory
                    ${status.memoryCount ? html`<span class="ff-chip">${status.memoryCount}</span>` : ''}
                  </button>
                  <button class="ff-btn ff-btn-secondary ff-btn-sm" data-action="open-settings" type="button">
                    <span data-icon="sliders"></span> Settings
                  </button>
                </div>
              </section>
            `
      }

      <p class="pop-foot-note">
        <span data-icon="shield"></span>
        Fillie never submits anything. You always press the final button.
      </p>
    </div>
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

async function init(): Promise<void> {
  setTheme(preferredTheme());
  const [status, tab] = await Promise.all([loadStatus(), activeTab()]);
  const pageOk = await isFormPage(tab);
  paint({ status, pageOk, tab });
}

app.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'open-app') return void openApp();
  if (action === 'open-profile') return void openApp('#/profile/personal');
  if (action === 'open-memory') return void openApp('#/memory');
  if (action === 'open-database') return void openApp('#/database');
  if (action === 'open-settings') return void openApp('#/settings/ai');
  if (action === 'run') {
    const tab = await activeTab();
    if (tab?.id !== undefined) return void runOnPage(tab.id);
  }
});

void init();

export { VERSION, paint };