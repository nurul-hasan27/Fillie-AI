import type { FieldPlan, InterviewQuestion, InterviewSpec, KnowledgeRef, SessionStats } from '../core/types';
import { icon, type IconName } from '../ui/icons';
import { truncate } from '../core/text';
import { savedAnswerId } from '../core/cloud/saved-answers';
import styles from './overlay.css';

/**
 * The in-page Fillie assistant. Everything lives inside a shadow root so the
 * host page can neither style nor break the panel.
 */

export interface ResumeChoice {
  id: string;
  name: string;
  preview: string;
  suggested: boolean;
}

export type OverlayView =
  | { kind: 'paywall'; message: string; price: string }
  | { kind: 'choose-resume'; options: ResumeChoice[] }
  | { kind: 'scanning'; message: string; completed: number; total: number; indeterminate: boolean }
  | { kind: 'tasks'; plans: FieldPlan[]; stats: SessionStats; company?: string; role?: string }
  | { kind: 'resolve'; plan: FieldPlan; draft: DraftState }
  | { kind: 'edit'; plan: FieldPlan }
  | { kind: 'review'; plans: FieldPlan[]; stats: SessionStats }
  | { kind: 'success'; plans: FieldPlan[]; stats: SessionStats }
  /** `tone` defaults to danger. A page with no form is informational, not a failure. */
  | { kind: 'error'; message: string; detail?: string; tone?: 'danger' | 'neutral' }
  | { kind: 'idle' };

export type OverlayFilter = 'all' | 'answered' | 'doubtful' | 'needs-attention' | 'unanswered';

export interface DraftState {
  /** Current draft text (editable). */
  text: string;
  /** True while the AI is writing. */
  generating: boolean;
  /** Sources shown under the draft. */
  sources: KnowledgeRef[];
  /** Notes/caveats from the engine. */
  notes: string[];
  generic: boolean;
  usedAI: boolean;
  /** Short "Gemini · model" for the platform that wrote the draft. */
  aiSource?: string;
}

export interface OverlayCallbacks {
  onStart(): void;
  onFillNow(): void;
  onOpenQuestion(plan: FieldPlan): void;
  onBackFromResolve(): void;
  onGenerate(plan: FieldPlan, answers: Record<string, string>): void;
  onAccept(plan: FieldPlan, text: string, generic: boolean, remember: boolean): void;
  onSkip(plan: FieldPlan): void;
  onRegenerate(plan: FieldPlan): void;
  onFocusField(fieldId: string): void;
  onOpenSettings(): void;
  onDismiss(): void;
  onMinimise(): void;
  onOpenEdit?(plan: FieldPlan): void;
  onEdit?(plan: FieldPlan, newValue: string, saveToFillie: boolean): void;
  /** Saves every final field value on the page to Fillie's memory. */
  onSaveAnswers?(): void;
  /** Resume picked for this application; 'none' means profile only. */
  onPickResume?(id: string): void;
  /** Opens the account page to sign in and unlock. */
  onUpgrade?(): void;
  /** The user hearted (or un-hearted) an answer to keep it with the application for the interview. */
  onToggleSaved?(plan: FieldPlan, saved: boolean): void;
  /** Whether this answer may be kept: false for passwords, files and other private fields. */
  canSave?(plan: FieldPlan): boolean;
  /** The first-time heart tip was dismissed or used. */
  onHeartHintSeen?(): void;
}

const HIGHLIGHT_CSS = `
.fillie-highlight {
  outline: 2px solid #0075de !important;
  outline-offset: 1px !important;
  border-radius: 6px;
  animation: fillie-fade-outline 2.6s var(--ff-ease, ease) forwards;
}
.fillie-highlight--attention { outline-color: #d99413 !important; }
.fillie-highlight--error { outline-color: #cf4436 !important; }
@keyframes fillie-fade-outline {
  0%, 70% { outline-color: inherit; }
  100% { outline-color: transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .fillie-highlight { animation: none; }
}
`;

export function injectHighlightStyles(doc: Document = document): void {
  if (doc.getElementById('fillie-highlight-style')) return;
  const style = doc.createElement('style');
  style.id = 'fillie-highlight-style';
  style.textContent = HIGHLIGHT_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export class FillieOverlay {
  private host: HTMLDivElement | null = null;
  private root: HTMLDivElement | null = null;
  private collapsed = false;
  private renderQueued = false;
  private pendingView: OverlayView | null = null;
  private lastView: OverlayView | null = null;
  private activeFilter: OverlayFilter = 'all';
  /** Which platform and model produced this session's answers, e.g. "Gemini · gemini-3.5-flash-lite". */
  private aiSource = '';
  /** e.g. "2 free fillings left this week". */
  private planNote = '';
  /** True when no AI platform is set up, so the panel offers the free setup. */
  private aiMissing = false;
  /** Ids of the questions already hearted on this application. */
  private savedIds = new Set<string>();
  private heartHint = false;

  setAiMissing(missing: boolean): void {
    this.aiMissing = missing;
  }

  setPlanNote(text: string): void {
    this.planNote = text;
  }

  setAiSource(label: string): void {
    this.aiSource = label;
  }

  constructor(private readonly callbacks: OverlayCallbacks) {}

  get isOpen(): boolean {
    return this.host !== null;
  }

  getFilter(): OverlayFilter {
    return this.activeFilter;
  }

  setFilter(filter: OverlayFilter): void {
    this.activeFilter = filter;
    this.reRenderCurrentView();
  }

  /** Which answers are already kept (from an earlier visit to this page). */
  setSavedIds(ids: Iterable<string>): void {
    this.savedIds = new Set(ids);
    this.reRenderCurrentView();
  }

  /** Shows the one-time tip that explains the heart. */
  setHeartHint(show: boolean): void {
    if (this.heartHint === show) return;
    this.heartHint = show;
    this.reRenderCurrentView();
  }

  private reRenderCurrentView(): void {
    if (this.lastView) {
      this.render(this.lastView);
    }
  }

  mount(): void {
    if (this.host) return;
    const host = document.createElement('div');
    host.setAttribute('data-fillie', 'ui');
    host.setAttribute('data-fillie-panel', 'true');
    host.setAttribute('data-theme', 'light');
    host.style.cssText = [
      'all: initial',
      'position: fixed !important',
      'bottom: 20px !important',
      'right: 20px !important',
      'inset: auto 20px 20px auto !important',
      'z-index: 2147483600 !important',
      'display: block !important',
      'margin: 0 !important',
      'padding: 0 !important',
      'border: none !important',
      'background: transparent !important',
      'width: auto !important',
      'height: auto !important',
      'box-shadow: none !important',
      'pointer-events: auto !important',
    ].join('; ');

    try {
      chrome.storage?.local?.get?.(['fillie:theme'], (res) => {
        if (chrome.runtime?.lastError) return;
        if (res?.['fillie:theme'] === 'dark') {
          host.setAttribute('data-theme', 'dark');
        } else {
          host.setAttribute('data-theme', 'light');
        }
      });
    } catch {
      // In test or restricted environments
    }

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styles;
    shadow.appendChild(style);
    const root = document.createElement('div');
    root.className = 'panel';
    shadow.appendChild(root);
    document.documentElement.appendChild(host);
    this.host = host;
    this.root = root;
    injectHighlightStyles();
  }

  unmount(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.root?.setAttribute('data-collapsed', String(collapsed));
    if (this.lastView) {
      this.render(this.lastView);
    }
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  /**
   * Coalesces rapid state updates into one paint, but always paints the most
   * recent view — an earlier queued view must never win over a newer one.
   */
  render(view: OverlayView): void {
    if (!this.root) return;
    this.lastView = view;
    this.pendingView = view;
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (!this.root || !this.pendingView) return;
      const view = this.pendingView;
      this.pendingView = null;
      const scrollTop = this.root.querySelector('.body')?.scrollTop ?? 0;
      this.root.replaceChildren(this.renderView(view));
      if (!this.collapsed && view.kind !== 'resolve' && view.kind !== 'edit') {
        const body = this.root.querySelector('.body');
        if (body && scrollTop) body.scrollTop = scrollTop;
      }
    });
  }

  private renderView(view: OverlayView): DocumentFragment {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(this.renderHeader(view));

    if (this.collapsed) {
      this.root?.setAttribute('data-collapsed', 'true');
      return fragment;
    }
    this.root?.setAttribute('data-collapsed', 'false');

    const body = el('div', { class: 'body' });
    switch (view.kind) {
      case 'paywall':
        body.appendChild(this.renderPaywall(view));
        break;
      case 'choose-resume':
        body.appendChild(this.renderChooseResume(view));
        break;
      case 'scanning':
        body.appendChild(this.renderScanning(view));
        break;
      case 'tasks':
        body.append(...this.renderTasks(view));
        break;
      case 'resolve':
        body.appendChild(this.renderResolve(view));
        break;
      case 'edit':
        body.appendChild(this.renderEdit(view));
        break;
      case 'review':
        body.appendChild(this.renderReview(view));
        break;
      case 'success':
        body.appendChild(this.renderSuccess(view));
        break;
      case 'error':
        body.appendChild(this.renderError(view));
        break;
      case 'idle':
        body.appendChild(this.renderScanning({ kind: 'scanning', message: 'Ready', completed: 0, total: 0, indeterminate: true }));
        break;
    }

    fragment.appendChild(body);
    const foot = this.renderFooter(view);
    if (foot) fragment.appendChild(foot);
    return fragment;
  }

  private renderHeader(view: OverlayView): HTMLElement {
    const head = el('div', { class: 'head' });
    const brand = el('div', { class: 'brand' });
    const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    mark.setAttribute('viewBox', '0 0 32 32');
    mark.setAttribute('width', '22');
    mark.setAttribute('height', '22');
    mark.innerHTML =
      '<rect x="6" y="3.5" width="15" height="21" rx="4.4" fill="currentColor" opacity=".14"/><rect x="6" y="3.5" width="15" height="21" rx="4.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10.5 11h6M10.5 15.5h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" opacity=".5"/><path d="M22 14.6l1.06 2.64 2.64 1.06-2.64 1.06-1.06 2.64-1.06-2.64L18.5 18.3l2.64-1.06L22 14.6Z" fill="currentColor"/>';
    brand.appendChild(mark);
    brand.appendChild(text('span', {}, 'Fillie'));
    head.appendChild(brand);

    if (this.collapsed) {
      head.style.cursor = 'pointer';
      head.title = 'Click to maximize Fillie';
      head.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        this.setCollapsed(false);
        this.callbacks.onMinimise();
      });
    }

    const status = el('div', { class: 'head-meta' });
    if (view.kind === 'scanning') {
      status.appendChild(el('span', { class: 'ff-spinner', style: 'width:12px;height:12px' }));
    } else if (this.collapsed && 'plans' in view && Array.isArray(view.plans)) {
      const ready = view.plans.filter((p) => p.status === 'ready').length;
      if (ready > 0) {
        status.appendChild(text('span', { class: 'count-pill', style: 'margin-right:4px' }, `${ready} ready`));
      }
    }

    if (this.collapsed) {
      status.appendChild(
        iconButton('plus', 'Maximize Fillie', () => {
          this.setCollapsed(false);
          this.callbacks.onMinimise();
        }),
      );
    } else {
      status.appendChild(
        iconButton('minus', 'Minimize Fillie', () => {
          this.setCollapsed(true);
          this.callbacks.onMinimise();
        }),
      );
    }
    status.appendChild(iconButton('close', 'Close Fillie', () => this.callbacks.onDismiss()));
    head.appendChild(status);
    return head;
  }

  private renderPaywall(view: Extract<OverlayView, { kind: 'paywall' }>): HTMLElement {
    const wrap = el('div', { class: 'paywall' });
    const badge = el('div', { class: 'paywall-badge' });
    badge.appendChild(icon('lock', { size: 22 }));
    wrap.appendChild(badge);
    wrap.appendChild(text('h3', { class: 'choose-title' }, 'Your free fillings are used up'));
    wrap.appendChild(text('p', { class: 'choose-sub' }, view.message));
    const list = el('ul', { class: 'paywall-list' });
    for (const line of ['Unlimited form filling, forever', 'Application tracker and cloud backup', 'One payment. No subscription.']) {
      list.appendChild(text('li', {}, line));
    }
    wrap.appendChild(list);
    return wrap;
  }

  private renderChooseResume(view: Extract<OverlayView, { kind: 'choose-resume' }>): HTMLElement {
    const wrap = el('div', { class: 'ff-stack' });
    wrap.appendChild(text('h3', { class: 'choose-title' }, 'Which resume fits this role?'));
    wrap.appendChild(
      text('p', { class: 'choose-sub' }, 'Fillie answers from the one you pick. The best match for this posting is highlighted.'),
    );
    const list = el('ul', { class: 'resume-picks' });
    for (const option of view.options) {
      const item = el('li');
      const button = el('button', {
        class: 'resume-pick',
        type: 'button',
        'data-suggested': String(option.suggested),
        'data-fillie-resume': option.id,
      });
      const top = el('span', { class: 'resume-pick-top' });
      top.appendChild(text('span', { class: 'resume-pick-name' }, option.name));
      if (option.suggested) top.appendChild(text('span', { class: 'pill-suggested' }, 'Best match'));
      button.appendChild(top);
      if (option.preview) button.appendChild(text('span', { class: 'resume-pick-preview' }, option.preview));
      button.addEventListener('click', () => this.callbacks.onPickResume?.(option.id));
      item.appendChild(button);
      list.appendChild(item);
    }
    wrap.appendChild(list);
    return wrap;
  }

  private renderScanning(view: Extract<OverlayView, { kind: 'scanning' }>): HTMLElement {
    const wrap = el('div', { class: 'scan' });
    const orb = el('div', { class: 'scan-orb' });
    orb.appendChild(icon('sparkle', { size: 26, strokeWidth: 1.3 }));
    wrap.appendChild(orb);
    wrap.appendChild(text('div', { class: 'scan-title' }, 'Understanding your application'));
    wrap.appendChild(text('div', { class: 'scan-sub' }, view.message));

    const bar = el('div', { class: 'bar' });
    const fill = el('i');
    if (view.indeterminate || view.total <= 0) {
      fill.setAttribute('data-indeterminate', 'true');
    } else {
      const pct = Math.max(4, Math.round((view.completed / view.total) * 100));
      fill.style.width = `${pct}%`;
    }
    bar.appendChild(fill);
    wrap.appendChild(bar);

    wrap.appendChild(
      text(
        'div',
        { class: 'scan-count' },
        view.total > 0 ? `${Math.min(view.completed, view.total)} of ${view.total} questions` : 'Reading the page…',
      ),
    );
    return wrap;
  }

  private renderTasks(view: Extract<OverlayView, { kind: 'tasks' }>): HTMLElement[] {
    const out: HTMLElement[] = [];
    const { stats, plans } = view;

    out.push(this.renderStats(stats, plans));

    if (this.activeFilter === 'answered') {
      const answered = plans.filter(isPlanAnswered);
      const head = el('div', { class: 'inbox-head' });
      head.appendChild(text('span', { class: 'inbox-title' }, 'Answered questions'));
      head.appendChild(text('span', { class: 'count-pill' }, String(answered.length)));
      out.push(head);

      if (answered.length) {
        const list = el('ul', { class: 'review-list' });
        for (const plan of answered) list.appendChild(this.renderReviewRow(plan));
        out.push(list);
      } else {
        const empty = el('div', { class: 'notice' });
        empty.appendChild(icon('info', { size: 15 }));
        empty.appendChild(text('span', {}, 'No answered questions yet.'));
        out.push(empty);
      }
    } else if (this.activeFilter === 'doubtful') {
      const doubtful = plans.filter(isPlanDoubtful);
      const head = el('div', { class: 'inbox-head' });
      head.appendChild(text('span', { class: 'inbox-title' }, 'Doubtful — please check'));
      head.appendChild(text('span', { class: 'count-pill' }, String(doubtful.length)));
      out.push(head);

      if (doubtful.length) {
        const list = el('ul', { class: 'review-list' });
        for (const plan of doubtful) list.appendChild(this.renderReviewRow(plan));
        out.push(list);
      } else {
        const empty = el('div', { class: 'notice' });
        empty.appendChild(icon('info', { size: 15 }));
        empty.appendChild(text('span', {}, 'Nothing is in doubt.'));
        out.push(empty);
      }
    } else if (this.activeFilter === 'needs-attention') {
      const pending = plans.filter((plan) => plan.status === 'needs-attention');
      const head = el('div', { class: 'inbox-head' });
      head.appendChild(text('span', { class: 'inbox-title' }, 'Needs your attention'));
      head.appendChild(text('span', { class: 'count-pill' }, String(pending.length)));
      out.push(head);

      if (pending.length) {
        const list = el('ul', { class: 'tasks' });
        pending.forEach((plan, index) => list.appendChild(this.renderTask(plan, index)));
        out.push(list);
      } else {
        const empty = el('div', { class: 'notice' });
        empty.appendChild(icon('info', { size: 15 }));
        empty.appendChild(text('span', {}, 'No questions need your attention right now.'));
        out.push(empty);
      }
    } else if (this.activeFilter === 'unanswered') {
      const unanswered = plans.filter(isPlanUnanswered);
      const head = el('div', { class: 'inbox-head' });
      head.appendChild(text('span', { class: 'inbox-title' }, 'Unanswered questions'));
      head.appendChild(text('span', { class: 'count-pill' }, String(unanswered.length)));
      out.push(head);

      if (unanswered.length) {
        const list = el('ul', { class: 'tasks' });
        unanswered.forEach((plan, index) => {
          if (plan.status === 'needs-attention') {
            list.appendChild(this.renderTask(plan, index));
          } else {
            const item = el('li');
            const button = el('button', {
              class: 'task',
              type: 'button',
              'data-fillie-task': plan.field.id,
              'aria-label': `Resolve: ${plan.field.label}`,
            });
            button.appendChild(text('span', { class: 'task-index' }, String(index + 1).padStart(2, '0')));
            const main = el('span', { class: 'task-main' });
            main.appendChild(text('span', { class: 'task-kind' }, kindLabel(plan)));
            main.appendChild(text('span', { class: 'task-q' }, plan.field.label || plan.field.context || 'Question'));
            if (plan.reason) main.appendChild(text('span', { class: 'task-meta' }, truncate(plan.reason, 68)));
            button.appendChild(main);
            const go = el('span', { class: 'task-go' });
            go.appendChild(icon('arrow-right', { size: 15 }));
            button.appendChild(go);
            button.addEventListener('click', () => this.callbacks.onOpenQuestion(plan));
            item.appendChild(button);
            list.appendChild(item);
          }
        });
        out.push(list);
      } else {
        const empty = el('div', { class: 'notice' });
        empty.appendChild(icon('info', { size: 15 }));
        empty.appendChild(text('span', {}, 'All questions have answers!'));
        out.push(empty);
      }
    } else {
      const pending = plans.filter((plan) => plan.status === 'needs-attention');
      const done = plans.filter((plan) => plan.status !== 'needs-attention');

      // The first time, the heart is explained right at the top, where it cannot be missed.
      if (done.length && this.heartHint && this.callbacks.onToggleSaved) out.push(this.renderHeartTip());

      if (pending.length) {
        const head = el('div', { class: 'inbox-head' });
        head.appendChild(text('span', { class: 'inbox-title' }, 'Needs your attention'));
        head.appendChild(text('span', { class: 'count-pill' }, String(pending.length)));
        out.push(head);

        const list = el('ul', { class: 'tasks' });
        pending.forEach((plan, index) => list.appendChild(this.renderTask(plan, index)));
        out.push(list);
      }

      if (done.length) {
        out.push(text('span', { class: 'section-label' }, `Filled automatically · ${done.length}`));
        const list = el('ul', { class: 'review-list' });
        for (const plan of done.slice(0, 40)) list.appendChild(this.renderReviewRow(plan));
        out.push(list);
      }

      if (!plans.length) {
        const empty = el('div', { class: 'notice' });
        empty.appendChild(icon('info', { size: 15 }));
        empty.appendChild(
          text(
            'span',
            {},
            'Fillie could not find any question fields on this page. Open the form fully, then run Fillie again.',
          ),
        );
        out.push(empty);
      }
    }

    if (view.company || view.role) {
      const ctx = el('div', { class: 'manual-note' });
      ctx.appendChild(icon('layers', { size: 13 }));
      ctx.appendChild(text('span', {}, [view.company, view.role].filter(Boolean).join(' · ')));
      out.push(ctx);
    }

    return out;
  }

  private renderStats(stats: SessionStats, plans?: FieldPlan[]): HTMLElement {
    const container = el('div', { class: 'stats-container' });
    const grid = el('div', { class: 'summary' });
    const filled = stats.filledFromProfile + stats.filledFromMemory + stats.generated + stats.fromUser;

    const filledStat = stat(filled, 'Filled', 'success');
    filledStat.setAttribute('role', 'button');
    filledStat.setAttribute('tabindex', '0');
    filledStat.setAttribute('aria-label', 'Show answered questions');
    if (this.activeFilter === 'answered') filledStat.setAttribute('data-active', 'true');
    filledStat.addEventListener('click', () => {
      this.activeFilter = this.activeFilter === 'answered' ? 'all' : 'answered';
      this.reRenderCurrentView();
    });
    grid.appendChild(filledStat);

    const attentionStat = stat(stats.needsAttention, 'Need attention', stats.needsAttention ? 'warning' : 'muted');
    attentionStat.setAttribute('role', 'button');
    attentionStat.setAttribute('tabindex', '0');
    attentionStat.setAttribute('aria-label', 'Show questions needing attention');
    if (this.activeFilter === 'needs-attention') attentionStat.setAttribute('data-active', 'true');
    attentionStat.addEventListener('click', () => {
      this.activeFilter = this.activeFilter === 'needs-attention' ? 'all' : 'needs-attention';
      this.reRenderCurrentView();
    });
    grid.appendChild(attentionStat);

    const totalStat = stat(stats.total, 'Questions', 'muted');
    totalStat.setAttribute('role', 'button');
    totalStat.setAttribute('tabindex', '0');
    totalStat.setAttribute('aria-label', 'Show all questions');
    if (this.activeFilter === 'all') totalStat.setAttribute('data-active', 'true');
    totalStat.addEventListener('click', () => {
      this.activeFilter = 'all';
      this.reRenderCurrentView();
    });
    grid.appendChild(totalStat);

    container.appendChild(grid);

    if (this.planNote) {
      container.appendChild(text('div', { class: 'plan-note' }, this.planNote));
    }

    if (this.aiSource) {
      const source = el('div', { class: 'ai-source', title: 'The platform and model that wrote these answers' });
      source.appendChild(icon('sparkle', { size: 11 }));
      source.appendChild(text('span', {}, this.aiSource));
      container.appendChild(source);
    }

    if (plans && plans.length > 0) {
      container.appendChild(this.renderFilterTabs(plans));
    }

    return container;
  }

  private renderFilterTabs(plans: FieldPlan[]): HTMLElement {
    const tabs = el('div', { class: 'filter-tabs', role: 'tablist' });
    const answeredCount = plans.filter(isPlanAnswered).length;
    const attentionCount = plans.filter(isPlanNeedsAttention).length;
    const unansweredCount = plans.filter(isPlanUnanswered).length;

    const items: Array<{ id: OverlayFilter; label: string; count: number }> = [
      { id: 'all', label: 'All', count: plans.length },
      { id: 'answered', label: 'Answered', count: answeredCount },
      { id: 'doubtful', label: 'Doubtful', count: plans.filter(isPlanDoubtful).length },
      { id: 'needs-attention', label: 'Need attention', count: attentionCount },
      { id: 'unanswered', label: 'Unanswered', count: unansweredCount },
    ];

    for (const item of items) {
      const btn = el('button', {
        class: 'filter-tab-btn',
        type: 'button',
        role: 'tab',
        'data-filter': item.id,
        'data-active': String(this.activeFilter === item.id),
      });
      btn.appendChild(text('span', {}, item.label));
      btn.appendChild(text('span', { class: 'tab-badge' }, String(item.count)));
      btn.addEventListener('click', () => {
        this.activeFilter = item.id;
        this.reRenderCurrentView();
      });
      tabs.appendChild(btn);
    }
    return tabs;
  }

  private renderTask(plan: FieldPlan, index: number): HTMLLIElement {
    const item = el('li');
    const button = el('button', {
      class: 'task',
      type: 'button',
      'data-fillie-task': plan.field.id,
      'aria-label': `Resolve: ${plan.field.label}`,
    });
    button.appendChild(text('span', { class: 'task-index' }, String(index + 1).padStart(2, '0')));
    const main = el('span', { class: 'task-main' });
    main.appendChild(text('span', { class: 'task-kind' }, kindLabel(plan)));
    main.appendChild(text('span', { class: 'task-q' }, plan.field.label || plan.field.context || 'Question'));
    if (plan.reason) main.appendChild(text('span', { class: 'task-meta' }, truncate(plan.reason, 68)));
    button.appendChild(main);
    const go = el('span', { class: 'task-go' });
    go.appendChild(icon('arrow-right', { size: 15 }));
    button.appendChild(go);
    button.addEventListener('click', () => this.callbacks.onOpenQuestion(plan));
    item.appendChild(button);
    return item;
  }

  private renderReviewRow(plan: FieldPlan): HTMLLIElement {
    const item = el('li', { class: 'review-item' });
    const button = el('button', { class: 'review-row', type: 'button' });
    button.appendChild(statusIcon(plan));
    button.appendChild(text('span', { class: 'review-q' }, plan.field.label || 'Question'));
    const value = plan.fillResult?.verified
      ? answerPreview(plan)
      : plan.answer !== undefined && plan.answer !== null && String(plan.answer).trim() !== ''
        ? answerPreview(plan)
        : statusLabel(plan);
    button.appendChild(text('span', { class: 'review-v' }, value));
    button.addEventListener('click', () => this.callbacks.onFocusField(plan.field.id));
    item.appendChild(button);

    const actions = el('div', { class: 'review-actions' });

    const answerStr = planAnswerToCopyText(plan);
    if (answerStr && this.callbacks.onToggleSaved && (this.callbacks.canSave?.(plan) ?? true)) {
      actions.appendChild(this.renderHeart(plan));
    }
    if (answerStr) {
      const copyBtn = el('button', {
        class: 'icon-btn review-copy-btn',
        type: 'button',
        'aria-label': `Copy answer for ${plan.field.label || 'question'}`,
        title: 'Copy answer',
        'data-fillie-copy': plan.field.id,
      });
      copyBtn.appendChild(icon('copy', { size: 13 }));
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyIconToClipboard(copyBtn, answerStr);
      });
      actions.appendChild(copyBtn);
    }

    const editBtn = el('button', {
      class: 'icon-btn review-edit-btn',
      type: 'button',
      'aria-label': `Edit ${plan.field.label || 'answer'}`,
      title: 'Edit answer',
      'data-fillie-edit': plan.field.id,
    });
    editBtn.appendChild(icon('pencil', { size: 13 }));
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onOpenEdit?.(plan);
    });
    actions.appendChild(editBtn);

    item.appendChild(actions);
    return item;
  }

  /**
   * The heart: keeps this exact question and answer with the application, to read again before the
   * interview. A small burst of confetti marks the moment it is saved.
   */
  private renderHeart(plan: FieldPlan): HTMLElement {
    const id = savedAnswerId(plan.field.label || 'Question');
    const wrap = el('span', { class: 'heart-wrap' });
    const button = el('button', {
      class: 'heart-btn',
      type: 'button',
      'data-fillie-heart': plan.field.id,
      'aria-pressed': String(this.savedIds.has(id)),
      'aria-label': `Save the answer to "${plan.field.label || 'this question'}" for your interview`,
      title: 'Save this answer for your interview',
    });
    button.dataset.saved = String(this.savedIds.has(id));
    if (this.heartHint && this.savedIds.size === 0) button.classList.add('heart-nudge');
    button.appendChild(icon('heart', { size: 15, strokeWidth: 1.7 }));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const next = !this.savedIds.has(id);
      if (next) this.savedIds.add(id);
      else this.savedIds.delete(id);
      button.dataset.saved = String(next);
      button.setAttribute('aria-pressed', String(next));
      button.classList.remove('heart-nudge');
      if (next) heartBurst(wrap);
      if (this.heartHint) {
        this.heartHint = false;
        this.root?.querySelector('.heart-tip')?.remove();
        this.callbacks.onHeartHintSeen?.();
      }
      this.callbacks.onToggleSaved?.(plan, next);
    });
    wrap.appendChild(button);
    return wrap;
  }

  /** The one-time card that explains the heart, with a heart that beats. */
  private renderHeartTip(): HTMLElement {
    const tip = el('div', { class: 'heart-tip', role: 'note' });
    const art = el('span', { class: 'heart-tip-art', 'aria-hidden': 'true' });
    art.appendChild(icon('heart', { size: 22, strokeWidth: 1.6 }));
    tip.appendChild(art);
    const copy = el('span', { class: 'heart-tip-copy' });
    copy.appendChild(text('strong', {}, 'Tap the heart to keep an answer'));
    copy.appendChild(text('span', {}, 'Each filled answer below has one. It is saved with this application, to read before your interview.'));
    tip.appendChild(copy);
    const close = el('button', { class: 'heart-tip-close', type: 'button', 'aria-label': 'Got it' }, 'Got it');
    close.addEventListener('click', () => {
      this.heartHint = false;
      tip.remove();
      this.root?.querySelectorAll('.heart-nudge').forEach((node) => node.classList.remove('heart-nudge'));
      this.callbacks.onHeartHintSeen?.();
    });
    tip.appendChild(close);
    return tip;
  }

  private renderResolve(view: Extract<OverlayView, { kind: 'resolve' }>): HTMLElement {
    const { plan, draft } = view;
    const drawer = el('div', { class: 'drawer', 'data-fillie-drawer': plan.field.id });

    const head = el('div', { class: 'drawer-head' });
    const back = el('button', { class: 'drawer-back', type: 'button' });
    back.appendChild(icon('arrow-left', { size: 13 }));
    back.appendChild(text('span', {}, 'All questions'));
    back.addEventListener('click', () => this.callbacks.onBackFromResolve());
    head.appendChild(back);
    head.appendChild(text('span', { class: 'drawer-title' }, 'Answer needed'));
    drawer.appendChild(head);

    const body = el('div', { class: 'drawer-body' });

    const original = el('div', { class: 'original-q' });
    original.appendChild(text('div', { class: 'q' }, `“${plan.field.label || 'Untitled question'}”`));
    const src = [plan.field.context, plan.field.hint].filter(Boolean).join(' · ');
    if (src) original.appendChild(text('div', { class: 'src' }, truncate(src, 90)));
    body.appendChild(original);

    if (plan.reason) {
      const why = el('div', { class: 'notice' });
      why.appendChild(icon('info', { size: 14 }));
      why.appendChild(text('span', {}, plan.reason));
      body.appendChild(why);
    }

    const answers: Record<string, string> = {};
    const spec = plan.interview;

    if (!draft.text) {
      body.appendChild(this.renderInterview(spec, answers, plan));
    } else {
      const draftBox = el('div', { class: 'draft' });
      const draftHeader = el('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;' });
      const label = el('div', { class: 'draft-label' });
      label.appendChild(icon(draft.generating ? 'sparkle' : 'check', { size: 12 }));
      label.appendChild(text('span', {}, draft.generating ? 'Writing your answer' : 'Your answer'));
      draftHeader.appendChild(label);

      if (draft.text) {
        const copyDraftBtn = el('button', {
          class: 'copy-pill-btn',
          type: 'button',
          title: 'Copy answer to clipboard',
          'data-fillie-copy-draft': plan.field.id,
        });
        copyDraftBtn.appendChild(icon('copy', { size: 12 }));
        copyDraftBtn.appendChild(text('span', {}, 'Copy'));
        copyDraftBtn.addEventListener('click', (e) => {
          e.preventDefault();
          copyPillToClipboard(copyDraftBtn, textArea.value || draft.text);
        });
        draftHeader.appendChild(copyDraftBtn);
      }
      draftBox.appendChild(draftHeader);

      const textArea = document.createElement('textarea');
      textArea.value = draft.text;
      textArea.placeholder = 'Draft answer';
      textArea.setAttribute('data-fillie-draft', plan.field.id);
      textArea.style.minHeight = '104px';
      draftBox.appendChild(textArea);

      if (draft.sources.length) {
        const sources = el('div', { class: 'sources' });
        sources.appendChild(text('span', { class: 'k' }, 'Based on'));
        for (const source of draft.sources.slice(0, 4)) {
          sources.appendChild(text('span', { class: 'src-chip' }, source.label));
        }
        draftBox.appendChild(sources);
      }

      if (draft.aiSource) {
        const source = el('div', { class: 'ai-source' });
        source.appendChild(icon('sparkle', { size: 11 }));
        source.appendChild(text('span', {}, draft.aiSource));
        draftBox.appendChild(source);
      }

      for (const note of draft.notes) {
        const caution = el('div', { class: 'notice', 'data-tone': 'warning' });
        caution.appendChild(icon('alert', { size: 13 }));
        caution.appendChild(text('span', {}, note));
        draftBox.appendChild(caution);
      }

      body.appendChild(draftBox);

      // What the user approves is remembered. When the draft names a specific
      // company, reuse is limited to that application, so the checkbox is off by
      // default and the consequence is spelled out.
      const rememberRow = el('label', { class: 'ff-switch draft-remember' });
      const rememberBox = document.createElement('input');
      rememberBox.type = 'checkbox';
      rememberBox.checked = draft.generic;
      rememberBox.setAttribute('data-fillie-remember', plan.field.id);
      rememberRow.appendChild(rememberBox);
      const track = el('span', { class: 'ff-switch-track' });
      track.appendChild(el('span', { class: 'ff-switch-thumb' }));
      rememberRow.appendChild(track);
      rememberRow.appendChild(
        text(
          'span',
          { class: 'ff-body' },
          draft.generic
            ? 'Remember this answer for similar questions'
            : 'Remember for this application only',
        ),
      );
      body.appendChild(rememberRow);

      const choiceGroup = el('div', { class: 'save-choice-group' });
      choiceGroup.appendChild(text('div', { class: 'save-choice-title' }, 'Save answer to Fillie?'));
      choiceGroup.appendChild(
        text(
          'div',
          { class: 'save-choice-desc' },
          draft.generic
            ? 'Store this answer in Fillie memory so future questions can be answered automatically.'
            : 'This answer mentions specific company details; saving will be restricted to this application.',
        ),
      );
      const btnGroup = el('div', { class: 'save-choice-buttons' });
      const yesBtn = el('button', {
        class: `btn-choice ${rememberBox.checked ? 'active' : ''}`,
        type: 'button',
        'data-save-fillie': 'yes',
      });
      yesBtn.appendChild(icon('check', { size: 12 }));
      yesBtn.appendChild(text('span', {}, 'Yes, save to Fillie'));

      const noBtn = el('button', {
        class: `btn-choice ${!rememberBox.checked ? 'active' : ''}`,
        type: 'button',
        'data-save-fillie': 'no',
      });
      noBtn.appendChild(text('span', {}, 'No, this form only'));

      const updateChoiceVisuals = (isYes: boolean) => {
        rememberBox.checked = isYes;
        if (isYes) {
          yesBtn.classList.add('active');
          noBtn.classList.remove('active');
        } else {
          yesBtn.classList.remove('active');
          noBtn.classList.add('active');
        }
      };

      yesBtn.addEventListener('click', (e) => {
        e.preventDefault();
        updateChoiceVisuals(true);
      });
      noBtn.addEventListener('click', (e) => {
        e.preventDefault();
        updateChoiceVisuals(false);
      });
      rememberBox.addEventListener('change', () => {
        updateChoiceVisuals(rememberBox.checked);
      });

      btnGroup.appendChild(yesBtn);
      btnGroup.appendChild(noBtn);
      choiceGroup.appendChild(btnGroup);
      body.appendChild(choiceGroup);

      const row1 = el('div', { class: 'btn-row' });
      const accept = el('button', { class: 'btn btn-primary btn-block', type: 'button' });
      accept.setAttribute('data-fillie-accept', plan.field.id);
      accept.appendChild(icon('check', { size: 14 }));
      accept.appendChild(text('span', {}, 'Use this answer'));
      // `generic` decides how widely the answer may be reused; `remember`
      // decides whether it is stored at all. They are separate decisions.
      accept.addEventListener('click', () =>
        this.callbacks.onAccept(plan, textArea.value, draft.generic, rememberBox.checked),
      );
      row1.appendChild(accept);
      body.appendChild(row1);

      const row2 = el('div', { class: 'btn-row' });
      const regen = el('button', { class: 'btn btn-secondary', type: 'button' });
      regen.appendChild(icon('refresh', { size: 13 }));
      regen.appendChild(text('span', {}, 'Regenerate'));
      regen.addEventListener('click', () => this.callbacks.onRegenerate(plan));
      row2.appendChild(regen);

      const skip = el('button', { class: 'btn btn-ghost', type: 'button' });
      skip.setAttribute('data-fillie-skip', plan.field.id);
      skip.appendChild(text('span', {}, 'Skip'));
      skip.addEventListener('click', () => this.callbacks.onSkip(plan));
      row2.appendChild(skip);
      body.appendChild(row2);
    }

    drawer.appendChild(body);
    return drawer;
  }

  private renderInterview(
    spec: InterviewSpec | undefined,
    answers: Record<string, string>,
    plan: FieldPlan,
  ): HTMLElement {
    const wrap = el('div', { class: 'ff-stack' });
    const questions: InterviewQuestion[] = spec?.questions?.length
      ? spec.questions
      : [
          {
            id: 'direct_answer',
            label: `What should Fillie answer for "${plan.field.label || 'this question'}"?`,
            type: plan.field.kind === 'textarea' ? 'longtext' : 'text',
            placeholder: plan.field.hint || 'Type your answer or key points…',
            help: plan.field.hint || plan.field.context || undefined,
            required: plan.field.required,
            options: plan.field.options?.map((opt) => ({ label: opt, value: opt })),
          },
        ];

    for (const question of questions) {
      const group = el('div', { class: 'qa' });
      const label = text('span', { class: 'qa-label' }, question.label);
      group.appendChild(label);
      if (question.help) group.appendChild(text('span', { class: 'qa-help' }, question.help));

      if (question.type === 'choice' && question.options?.length) {
        const options = el('div', { class: 'opts' });
        // Dedupe defensively: a duplicated choice would silently waste a click.
        const seen = new Set<string>();
        question.options
          .filter((option) => {
            const key = option.label.trim().toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .forEach((option, index) => {
            const button = el('button', {
              class: 'opt',
              type: 'button',
              'data-fillie-option': `${plan.field.id}:${question.id}:${index}`,
            });
            button.appendChild(el('span', { class: 'dot' }));
            button.appendChild(text('span', {}, option.label));
            button.addEventListener('click', () => {
              answers[question.id] = option.value;
              for (const sibling of Array.from(options.children)) {
                sibling.removeAttribute('data-selected');
              }
              button.setAttribute('data-selected', 'true');
              this.enableGenerate();
            });
            options.appendChild(button);
          });
        group.appendChild(options);
      } else {
        const input =
          question.type === 'longtext'
            ? document.createElement('textarea')
            : document.createElement('input');
        if (input instanceof HTMLInputElement) input.type = question.type === 'number' ? 'number' : 'text';
        input.placeholder = question.placeholder ?? (question.type === 'number' ? '0' : 'Type your answer…');
        input.setAttribute('data-fillie-answer', `${plan.field.id}:${question.id}`);
        input.addEventListener('input', () => {
          answers[question.id] = (input as HTMLInputElement | HTMLTextAreaElement).value;
          if ((input as HTMLInputElement | HTMLTextAreaElement).value.trim()) {
            this.enableGenerate();
          }
        });
        group.appendChild(input);
      }
      wrap.appendChild(group);
    }

    const extraGroup = el('div', { class: 'qa' });
    extraGroup.appendChild(text('span', { class: 'qa-label' }, 'Additional notes or context (optional)'));
    const extraArea = document.createElement('textarea');
    extraArea.placeholder = 'Add any specific achievements, details, or preferences for the AI to include…';
    extraArea.style.minHeight = '56px';
    extraArea.setAttribute('data-fillie-extra-notes', plan.field.id);
    extraArea.addEventListener('input', () => {
      answers['__extra_notes__'] = extraArea.value;
      if (extraArea.value.trim()) {
        this.enableGenerate();
      }
    });
    extraGroup.appendChild(extraArea);
    wrap.appendChild(extraGroup);

    const actions = el('div', { class: 'btn-row' });
    const generate = el('button', {
      class: 'btn btn-primary btn-block',
      type: 'button',
      'data-fillie-generate': plan.field.id,
    });
    generate.appendChild(icon('sparkle', { size: 14 }));
    generate.appendChild(text('span', {}, 'Draft an answer'));
    generate.addEventListener('click', () => this.callbacks.onGenerate(plan, { ...answers }));
    generate.disabled = true;
    actions.appendChild(generate);

    const skipBtn = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      'data-fillie-skip-interview': plan.field.id,
      title: "Skip this question and update it yourself on the form",
    });
    skipBtn.appendChild(text('span', {}, "I'll update by myself (Skip)"));
    skipBtn.addEventListener('click', () => this.callbacks.onSkip(plan));
    actions.appendChild(skipBtn);

    wrap.appendChild(actions);

    return wrap;
  }

  private renderEdit(view: Extract<OverlayView, { kind: 'edit' }>): HTMLElement {
    const { plan } = view;
    const drawer = el('div', { class: 'drawer', 'data-fillie-drawer': plan.field.id });

    const head = el('div', { class: 'drawer-head' });
    const back = el('button', { class: 'drawer-back', type: 'button' });
    back.appendChild(icon('arrow-left', { size: 13 }));
    back.appendChild(text('span', {}, 'All questions'));
    back.addEventListener('click', () => this.callbacks.onBackFromResolve());
    head.appendChild(back);
    head.appendChild(text('span', { class: 'drawer-title' }, 'Edit answer'));
    drawer.appendChild(head);

    const body = el('div', { class: 'drawer-body' });

    const original = el('div', { class: 'original-q' });
    original.appendChild(text('div', { class: 'q' }, `“${plan.field.label || 'Untitled question'}”`));
    const src = [plan.field.context, plan.field.hint].filter(Boolean).join(' · ');
    if (src) original.appendChild(text('div', { class: 'src' }, truncate(src, 90)));
    body.appendChild(original);

    const inputGroup = el('div', { class: 'qa' });
    const inputHeader = el('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;' });
    inputHeader.appendChild(text('span', { class: 'qa-label' }, 'Your answer'));

    let getValue = () => '';
    const currentVal = plan.answer !== null && plan.answer !== undefined ? String(plan.answer) : '';

    const copyEditBtn = el('button', {
      class: 'copy-pill-btn',
      type: 'button',
      title: 'Copy answer to clipboard',
      'data-fillie-copy-edit': plan.field.id,
    });
    copyEditBtn.appendChild(icon('copy', { size: 12 }));
    copyEditBtn.appendChild(text('span', {}, 'Copy'));
    copyEditBtn.addEventListener('click', (e) => {
      e.preventDefault();
      copyPillToClipboard(copyEditBtn, getValue());
    });
    inputHeader.appendChild(copyEditBtn);
    inputGroup.appendChild(inputHeader);

    if (plan.field.kind === 'textarea') {
      const textarea = document.createElement('textarea');
      textarea.value = currentVal;
      textarea.placeholder = plan.field.hint || 'Type your answer…';
      textarea.style.minHeight = '110px';
      textarea.setAttribute('data-fillie-edit-input', plan.field.id);
      getValue = () => textarea.value;
      inputGroup.appendChild(textarea);
    } else if (plan.field.options && plan.field.options.length > 0) {
      const select = document.createElement('select');
      select.setAttribute('data-fillie-edit-select', plan.field.id);
      select.style.padding = '8px 10px';
      select.style.borderRadius = '8px';
      select.style.border = '1px solid var(--ff-border)';
      select.style.background = 'var(--ff-surface)';
      select.style.color = 'var(--ff-text)';
      select.style.font = 'inherit';
      select.style.width = '100%';

      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = 'Select an option…';
      select.appendChild(emptyOpt);

      for (const opt of plan.field.options) {
        const optionEl = document.createElement('option');
        optionEl.value = opt;
        optionEl.textContent = opt;
        if (opt === currentVal) {
          optionEl.selected = true;
        }
        select.appendChild(optionEl);
      }
      getValue = () => select.value;
      inputGroup.appendChild(select);
    } else {
      const input = document.createElement('input');
      input.type = plan.field.kind === 'number' ? 'number' : plan.field.kind === 'date' ? 'date' : 'text';
      input.value = currentVal;
      input.placeholder = plan.field.hint || 'Type your answer…';
      input.setAttribute('data-fillie-edit-input', plan.field.id);
      getValue = () => input.value;
      inputGroup.appendChild(input);
    }
    body.appendChild(inputGroup);

    let saveToFillie = true;
    const choiceGroup = el('div', { class: 'save-choice-group' });
    choiceGroup.appendChild(text('div', { class: 'save-choice-title' }, 'Save answer to Fillie?'));
    choiceGroup.appendChild(
      text(
        'div',
        { class: 'save-choice-desc' },
        'Remember this answer for future forms and applications.',
      ),
    );
    const btnGroup = el('div', { class: 'save-choice-buttons' });
    const yesBtn = el('button', {
      class: 'btn-choice active',
      type: 'button',
      'data-save-fillie': 'yes',
    });
    yesBtn.appendChild(icon('check', { size: 12 }));
    yesBtn.appendChild(text('span', {}, 'Yes, save to Fillie'));

    const noBtn = el('button', {
      class: 'btn-choice',
      type: 'button',
      'data-save-fillie': 'no',
    });
    noBtn.appendChild(text('span', {}, 'No, this form only'));

    yesBtn.addEventListener('click', () => {
      saveToFillie = true;
      yesBtn.classList.add('active');
      noBtn.classList.remove('active');
    });
    noBtn.addEventListener('click', () => {
      saveToFillie = false;
      yesBtn.classList.remove('active');
      noBtn.classList.add('active');
    });

    btnGroup.appendChild(yesBtn);
    btnGroup.appendChild(noBtn);
    choiceGroup.appendChild(btnGroup);
    body.appendChild(choiceGroup);

    const actions = el('div', { class: 'btn-row' });
    const saveBtn = el('button', {
      class: 'btn btn-primary btn-block',
      type: 'button',
      'data-fillie-save-edit': plan.field.id,
    });
    saveBtn.appendChild(icon('check', { size: 14 }));
    saveBtn.appendChild(text('span', {}, 'Update & Fill'));
    saveBtn.addEventListener('click', () => {
      const val = getValue();
      this.callbacks.onEdit?.(plan, val, saveToFillie);
    });
    actions.appendChild(saveBtn);
    body.appendChild(actions);

    drawer.appendChild(body);
    return drawer;
  }

  private enableGenerate(): void {
    const button = this.root?.querySelector('[data-fillie-generate]') as HTMLButtonElement | null;
    if (button) button.disabled = false;
  }

  private renderReview(view: Extract<OverlayView, { kind: 'review' }>): HTMLElement {
    const wrap = el('div', { class: 'ff-stack' });
    wrap.appendChild(this.renderStats(view.stats, view.plans));

    let filtered = view.plans;
    if (this.activeFilter === 'answered') {
      filtered = view.plans.filter(isPlanAnswered);
    } else if (this.activeFilter === 'doubtful') {
      filtered = view.plans.filter(isPlanDoubtful);
    } else if (this.activeFilter === 'needs-attention') {
      filtered = view.plans.filter(isPlanNeedsAttention);
    } else if (this.activeFilter === 'unanswered') {
      filtered = view.plans.filter(isPlanUnanswered);
    } else {
      filtered = view.plans.filter((plan) => plan.status !== 'skipped');
    }

    if (this.heartHint && this.callbacks.onToggleSaved && filtered.length) wrap.appendChild(this.renderHeartTip());
    const list = el('ul', { class: 'review-list' });
    for (const plan of filtered) {
      list.appendChild(this.renderReviewRow(plan));
    }
    if (!filtered.length) {
      const empty = el('div', { class: 'notice' });
      empty.appendChild(icon('info', { size: 14 }));
      empty.appendChild(text('span', {}, 'No questions match this filter.'));
      list.appendChild(empty);
    }
    wrap.appendChild(list);
    return wrap;
  }

  private renderSuccess(view: Extract<OverlayView, { kind: 'success' }>): HTMLElement {
    const wrap = el('div', { class: 'ff-stack' });
    const success = el('div', { class: 'success' });
    const check = el('div', { class: 'success-check' });
    check.appendChild(icon('check', { size: 20, strokeWidth: 1.9 }));
    success.appendChild(check);
    success.appendChild(text('h3', {}, 'Application ready'));
    success.appendChild(
      text('p', {}, 'Everything Fillie could handle has been prepared. Review the page before submitting.'),
    );
    wrap.appendChild(success);
    wrap.appendChild(this.renderStats(view.stats, view.plans));

    if (this.activeFilter === 'all') {
      const done = view.plans.filter((plan) => plan.status !== 'skipped' && plan.status !== 'needs-attention');
      if (done.length && this.callbacks.onToggleSaved) {
        if (this.heartHint) wrap.appendChild(this.renderHeartTip());
        wrap.appendChild(text('span', { class: 'section-label' }, `Filled by Fillie · ${done.length}`));
        const list = el('ul', { class: 'review-list' });
        for (const plan of done.slice(0, 40)) list.appendChild(this.renderReviewRow(plan));
        wrap.appendChild(list);
      }
    }

    if (this.activeFilter !== 'all') {
      let filtered = view.plans;
      if (this.activeFilter === 'answered') filtered = view.plans.filter(isPlanAnswered);
      else if (this.activeFilter === 'doubtful') filtered = view.plans.filter(isPlanDoubtful);
      else if (this.activeFilter === 'needs-attention') filtered = view.plans.filter(isPlanNeedsAttention);
      else if (this.activeFilter === 'unanswered') filtered = view.plans.filter(isPlanUnanswered);

      const list = el('ul', { class: 'review-list' });
      for (const plan of filtered) {
        list.appendChild(this.renderReviewRow(plan));
      }
      wrap.appendChild(list);
    }

    return wrap;
  }

  private renderError(view: Extract<OverlayView, { kind: 'error' }>): HTMLElement {
    const wrap = el('div', { class: 'ff-stack' });
    const danger = (view.tone ?? 'danger') === 'danger';
    const notice = el('div', { class: 'notice', 'data-tone': danger ? 'danger' : 'neutral' });
    notice.appendChild(icon(danger ? 'alert' : 'info', { size: 15 }));
    const body = el('div');
    body.appendChild(text('div', {}, view.message));
    if (view.detail) body.appendChild(text('div', { class: 'qa-help', style: 'margin-top:4px' }, view.detail));
    notice.appendChild(body);
    wrap.appendChild(notice);

    const row = el('div', { class: 'btn-row' });
    const retry = el('button', { class: 'btn btn-secondary btn-block', type: 'button' });
    retry.appendChild(icon('refresh', { size: 13 }));
    retry.appendChild(text('span', {}, 'Try again'));
    retry.addEventListener('click', () => this.callbacks.onStart());
    row.appendChild(retry);
    wrap.appendChild(row);
    return wrap;
  }

  /** Friendly nudge to add a free AI key, shown only when none is set up. */
  private appendAiNudge(foot: HTMLElement): void {
    if (!this.aiMissing) return;
    const box = el('div', { class: 'ai-nudge', role: 'note' });
    const head = el('div', { class: 'ai-nudge-head' });
    head.appendChild(icon('sparkle', { size: 13 }));
    head.appendChild(text('strong', {}, 'Answer the rest with free AI'));
    box.appendChild(head);
    box.appendChild(
      text('p', {}, 'Fillie filled what your profile covers. Add a free key (Google Gemini takes about a minute) for the open-ended questions. Nothing extra to pay.'),
    );
    const button = el('button', { class: 'btn btn-secondary btn-block', type: 'button', 'data-fillie-action': 'setup-ai' });
    button.appendChild(text('span', {}, 'Set up AI · it’s free'));
    button.addEventListener('click', () => this.callbacks.onOpenSettings());
    box.appendChild(button);
    foot.appendChild(box);
  }

  /** "Save answers" — teaches Fillie what is on the page right now. */
  private appendSaveAnswers(foot: HTMLElement): void {
    if (!this.callbacks.onSaveAnswers) return;
    const save = el('button', {
      class: 'btn btn-secondary btn-block',
      type: 'button',
      'data-fillie-action': 'save-answers',
    });
    save.appendChild(icon('brain', { size: 14 }));
    save.appendChild(text('span', {}, 'Save answers & track application'));
    save.addEventListener('click', () => {
      this.callbacks.onSaveAnswers?.();
      save.replaceChildren(icon('check', { size: 14 }), text('span', {}, 'Saved'));
    });
    foot.appendChild(save);
  }

  private renderFooter(view: OverlayView): HTMLElement | null {
    const foot = el('div', { class: 'foot' });

    if (view.kind === 'scanning') {
      const cancel = el('button', { class: 'btn btn-ghost btn-block', type: 'button' });
      cancel.appendChild(text('span', {}, 'Cancel'));
      cancel.addEventListener('click', () => this.callbacks.onDismiss());
      foot.appendChild(cancel);
      return foot;
    }

    if (view.kind === 'tasks') {
      const pending = view.plans.filter((plan) => plan.status === 'needs-attention').length;
      const fill = el('button', {
        class: 'btn btn-primary btn-lg btn-block',
        type: 'button',
        'data-fillie-action': 'fill',
      });
      fill.appendChild(icon('sparkle', { size: 15 }));
      fill.appendChild(
        text(
          'span',
          {},
          pending ? `Fill ${view.plans.length - pending} ready ${view.plans.length - pending === 1 ? 'answer' : 'answers'}` : 'Fill this application',
        ),
      );
      fill.addEventListener('click', () => this.callbacks.onFillNow());
      foot.appendChild(fill);

      this.appendSaveAnswers(foot);
      this.appendAiNudge(foot);

      const note = el('div', { class: 'manual-note' });
      note.appendChild(icon('shield', { size: 13 }));
      note.appendChild(text('span', {}, 'Fillie never submits forms — you always do that.'));
      foot.appendChild(note);
      return foot;
    }

    if (view.kind === 'success' || view.kind === 'review') {
      const review = el('button', { class: 'btn btn-secondary btn-block', type: 'button' });
      review.appendChild(icon('eye', { size: 14 }));
      review.appendChild(text('span', {}, 'Show me every field'));
      review.addEventListener('click', () => this.callbacks.onFocusField('__all__'));
      foot.appendChild(review);
      this.appendSaveAnswers(foot);
      this.appendAiNudge(foot);

      const note = el('div', { class: 'manual-note' });
      note.appendChild(icon('shield', { size: 13 }));
      note.appendChild(text('span', {}, 'Check the page, then submit it yourself.'));
      foot.appendChild(note);
      return foot;
    }

    if (view.kind === 'paywall') {
      const unlock = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-fillie-action': 'unlock' });
      unlock.appendChild(text('span', {}, `Sign in & unlock · ${view.price}`));
      unlock.addEventListener('click', () => this.callbacks.onUpgrade?.());
      foot.appendChild(unlock);
      return foot;
    }

    if (view.kind === 'choose-resume') {
      const none = el('button', { class: 'btn btn-ghost btn-block', type: 'button' });
      none.appendChild(text('span', {}, 'Use my profile only'));
      none.addEventListener('click', () => this.callbacks.onPickResume?.('none'));
      foot.appendChild(none);
      return foot;
    }

    if (view.kind === 'resolve') {
      const skip = el('button', { class: 'btn btn-ghost btn-block', type: 'button' });
      skip.appendChild(text('span', {}, 'Skip this question'));
      skip.addEventListener('click', () => this.callbacks.onSkip(view.plan));
      foot.appendChild(skip);
      return foot;
    }

    if (view.kind === 'edit') {
      const cancel = el('button', { class: 'btn btn-ghost btn-block', type: 'button' });
      cancel.appendChild(text('span', {}, 'Cancel edit'));
      cancel.addEventListener('click', () => this.callbacks.onBackFromResolve());
      foot.appendChild(cancel);
      return foot;
    }

    if (view.kind === 'error') {
      const settings = el('button', { class: 'btn btn-ghost btn-block', type: 'button' });
      settings.appendChild(icon('sliders', { size: 13 }));
      settings.appendChild(text('span', {}, 'Open Fillie settings'));
      settings.addEventListener('click', () => this.callbacks.onOpenSettings());
      foot.appendChild(settings);
    }

    return foot.children.length ? foot : null;
  }
}

/* -------------------------------------------------------------- helpers */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (content !== undefined) node.textContent = content;
  return node;
}

export function text(
  tag: string,
  attrs: Record<string, string> = {},
  content?: string,
): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  if (content !== undefined) node.textContent = content;
  return node;
}

function iconButton(name: IconName, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'icon-btn';
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(icon(name, { size: 15 }));
  button.addEventListener('click', onClick);
  return button;
}

function stat(value: number, label: string, tone: 'success' | 'warning' | 'muted'): HTMLElement {
  const node = el('div', { class: 'stat' });
  node.setAttribute('data-tone', tone);
  node.appendChild(el('b', {}, String(value)));
  node.appendChild(el('span', {}, label));
  return node;
}

function kindLabel(plan: FieldPlan): string {
  switch (plan.field.kind) {
    case 'textarea':
      return 'Long answer';
    case 'select':
      return 'Dropdown';
    case 'radio':
      return 'Multiple choice';
    case 'checkbox':
      return 'Checkbox';
    case 'date':
      return 'Date';
    case 'file':
      return 'File upload';
    default:
      return plan.field.required ? 'Required' : 'Short answer';
  }
}

export function statusLabel(plan: FieldPlan): string {
  switch (plan.status) {
    case 'ready':
      return plan.fillResult?.verified ? 'Verified' : 'Filled';
    case 'review':
      return 'Check this';
    case 'needs-attention':
      return 'Needs you';
    case 'skipped':
      return 'Skipped';
    case 'manual':
      return 'You do this';
    default:
      return '';
  }
}

function statusIcon(plan: FieldPlan): HTMLElement {
  const wrap = el('span', { class: 'status' });
  const tone =
    plan.status === 'ready'
      ? 'filled'
      : plan.status === 'review' || plan.status === 'needs-attention'
        ? 'attention'
        : plan.status === 'manual'
          ? 'error'
          : 'muted';
  wrap.setAttribute('data-tone', tone);
  const name: IconName =
    tone === 'filled' ? 'check-circle' : tone === 'attention' ? 'alert' : tone === 'error' ? 'close-circle' : 'minus';
  wrap.appendChild(icon(name, { size: 14 }));
  return wrap;
}

function answerPreview(plan: FieldPlan): string {
  const value = plan.answer;
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Selected' : 'Not selected';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') {
    const doc = value as { name?: string; fileName?: string };
    return doc.name || doc.fileName || 'Attached document';
  }
  return truncate(String(value), 60);
}

/** Filled, but the engine is not sure enough to leave it unchecked. */
export function isPlanDoubtful(plan: FieldPlan): boolean {
  return plan.status === 'review';
}

export function isPlanAnswered(plan: FieldPlan): boolean {
  if (plan.status === 'review') return false;
  if (plan.status === 'ready') return true;
  if (plan.fillResult?.verified) return true;
  if (plan.answer !== null && plan.answer !== undefined && String(plan.answer).trim() !== '') return true;
  return false;
}

export function isPlanNeedsAttention(plan: FieldPlan): boolean {
  return plan.status === 'needs-attention' || plan.status === 'manual';
}

export function isPlanUnanswered(plan: FieldPlan): boolean {
  return !isPlanAnswered(plan) && !isPlanDoubtful(plan);
}

export function planAnswerToCopyText(plan: FieldPlan): string {
  const ans = plan.answer;
  if (ans !== null && ans !== undefined) {
    if (typeof ans === 'string') return ans;
    if (typeof ans === 'number' || typeof ans === 'boolean') return String(ans);
    if (Array.isArray(ans)) return ans.join(', ');
    if (typeof ans === 'object') {
      const doc = ans as { name?: string; fileName?: string; text?: string };
      return doc.text || doc.name || doc.fileName || '';
    }
  }
  return '';
}

export function copyIconToClipboard(button: HTMLElement, textToCopy: string): void {
  if (!textToCopy) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(textToCopy);
    } else {
      const ta = document.createElement('textarea');
      ta.value = textToCopy;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    button.classList.add('copied');
    button.setAttribute('title', 'Copied!');
    button.replaceChildren(icon('check', { size: 13 }));
    setTimeout(() => {
      button.classList.remove('copied');
      button.setAttribute('title', 'Copy answer');
      button.replaceChildren(icon('copy', { size: 13 }));
    }, 1500);
  } catch {
    // Ignore clipboard error
  }
}

export function copyPillToClipboard(button: HTMLElement, textToCopy: string): void {
  if (!textToCopy) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(textToCopy);
    } else {
      const ta = document.createElement('textarea');
      ta.value = textToCopy;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    button.classList.add('copied');
    button.replaceChildren(icon('check', { size: 12 }), text('span', {}, 'Copied!'));
    setTimeout(() => {
      button.classList.remove('copied');
      button.replaceChildren(icon('copy', { size: 12 }), text('span', {}, 'Copy'));
    }, 1500);
  } catch {
    // Ignore clipboard error
  }
}

/**
 * A small, quiet confetti burst around the heart that was just saved: a dozen specks fly out and fade.
 * Skipped for people who prefer reduced motion.
 */
export function heartBurst(anchor: HTMLElement): void {
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (typeof anchor.animate !== 'function') return;
  const colors = ['#f64932', '#ffb110', '#0075de', '#62aef0', '#17795e', '#ff7a66'];
  const count = 12;
  for (let i = 0; i < count; i += 1) {
    const speck = el('span', { class: 'heart-speck', 'aria-hidden': 'true' });
    const angle = (i / count) * Math.PI * 2 + (i % 2 ? 0.2 : -0.2);
    const distance = 20 + (i % 3) * 7;
    speck.style.background = colors[i % colors.length]!;
    if (i % 3 === 0) speck.style.borderRadius = '50%';
    anchor.appendChild(speck);
    const move = speck.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.4)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(angle) * distance}px), calc(-50% + ${Math.sin(angle) * distance - 4}px)) scale(1) rotate(${i * 40}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${Math.cos(angle) * distance * 1.25}px), calc(-50% + ${Math.sin(angle) * distance * 1.25 + 10}px)) scale(0.6) rotate(${i * 70}deg)`, opacity: 0 },
      ],
      { duration: 720, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
    );
    move.onfinish = () => speck.remove();
  }
}
