import { celebrate } from './confetti';
import styles from './tour.css';

/**
 * The guided tour: a spotlight on the part of the screen being explained and a friendly floating card with
 * a big picture, a few words and one button. The same engine runs the welcome tour (many steps, dims the
 * page) and the small one-step tips (no dimming, a corner card).
 */

export interface TourStep {
  id: string;
  title: string;
  text: string;
  /** SVG markup of the big picture. */
  art?: string;
  /** A beating heart instead of a picture. */
  demo?: 'heart';
  /** Keys to show as key caps, for example ['Alt', 'Shift', 'F']. */
  keys?: string[];
  /** CSS selector of the part of the page to point at. Without it the card sits in the middle. */
  target?: string;
  /** Page to open first (a hash such as "#/database"). */
  route?: string;
  /** Label of the main button; "Next" by default and "Done" on the last step. */
  button?: string;
}

export interface TourOptions {
  steps: TourStep[];
  /** A quiet one-step tip: nothing is dimmed and the page stays usable. */
  tip?: boolean;
  onRoute?(route: string): void | Promise<void>;
  onEnd(reason: 'done' | 'skip'): void;
  /** Confetti when the last step is finished. */
  celebrate?: boolean;
}

export interface TourHandle {
  stop(): void;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const GAP = 16;
const MARGIN = 12;

/** Where the card goes: beside the highlighted part when there is room, else below or above it, else in the middle. */
export function placeCard(target: Box | null, card: { width: number; height: number }, viewport: { width: number; height: number }, tip = false): { left: number; top: number } {
  const clamp = (value: number, size: number, max: number) => Math.max(MARGIN, Math.min(value, max - size - MARGIN));
  if (!target) {
    return tip
      ? { left: viewport.width - card.width - 20, top: viewport.height - card.height - 20 }
      : { left: (viewport.width - card.width) / 2, top: Math.max(MARGIN, (viewport.height - card.height) / 2) };
  }
  const centerY = target.top + target.height / 2 - card.height / 2;
  const centerX = target.left + target.width / 2 - card.width / 2;
  if (target.left + target.width + GAP + card.width + MARGIN <= viewport.width) return { left: target.left + target.width + GAP, top: clamp(centerY, card.height, viewport.height) };
  if (target.top + target.height + GAP + card.height + MARGIN <= viewport.height) return { left: clamp(centerX, card.width, viewport.width), top: target.top + target.height + GAP };
  if (target.top - GAP - card.height >= MARGIN) return { left: clamp(centerX, card.width, viewport.width), top: target.top - GAP - card.height };
  if (target.left - GAP - card.width >= MARGIN) return { left: target.left - GAP - card.width, top: clamp(centerY, card.height, viewport.height) };
  return { left: (viewport.width - card.width) / 2, top: Math.max(MARGIN, (viewport.height - card.height) / 2) };
}

const HEART_DEMO = '<span class="ft-heart" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 13.6C3.2 10.2 2 7.3 3.4 5.3a2.9 2.9 0 0 1 4.6-.2 2.9 2.9 0 0 1 4.6.2c1.4 2-.2 4.9-4.6 8.3Z" stroke="#f64932" stroke-width="1.2" stroke-linejoin="round"/></svg></span>';

function injectStyles(): void {
  if (document.getElementById('fillie-tour-style')) return;
  const style = document.createElement('style');
  style.id = 'fillie-tour-style';
  style.textContent = styles;
  document.head.append(style);
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function startTour(options: TourOptions): TourHandle {
  injectStyles();
  const { steps, tip = false } = options;
  let index = 0;
  let ended = false;

  const root = el('div', 'ft-root');
  root.dataset.tip = String(tip);
  root.dataset.modal = String(!tip);
  const dim = el('div', 'ft-dim');
  const spot = el('div', 'ft-spot');
  spot.style.opacity = '0';
  const card = el('section', 'ft-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');
  card.setAttribute('aria-label', 'Fillie tour');
  root.append(dim, spot, card);
  document.body.append(root);
  requestAnimationFrame(() => (root.dataset.ready = 'true'));

  const finish = (reason: 'done' | 'skip') => {
    if (ended) return;
    ended = true;
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('keydown', onKey, true);
    root.remove();
    if (reason === 'done' && options.celebrate) void celebrate();
    options.onEnd(reason);
  };

  const targetBox = (step: TourStep): Box | null => {
    if (!step.target) return null;
    const node = document.querySelector<HTMLElement>(step.target);
    if (!node || !node.offsetParent) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { left: rect.left - 6, top: rect.top - 4, width: rect.width + 12, height: rect.height + 8 };
  };

  function reposition(): void {
    if (ended) return;
    const step = steps[index]!;
    const box = targetBox(step);
    root.dataset.target = String(Boolean(box));
    if (box) {
      Object.assign(spot.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, opacity: '1' });
    } else {
      spot.style.opacity = '0';
    }
    const size = { width: card.offsetWidth || 328, height: card.offsetHeight || 260 };
    const pos = placeCard(box, size, { width: window.innerWidth, height: window.innerHeight }, tip);
    card.style.left = `${Math.round(pos.left)}px`;
    card.style.top = `${Math.round(pos.top)}px`;
  }

  async function show(next: number, direction: 1 | -1 = 1): Promise<void> {
    index = Math.max(0, Math.min(next, steps.length - 1));
    const step = steps[index]!;
    if (step.route && options.onRoute) {
      await options.onRoute(step.route);
      // Give the page a moment to draw the new section before pointing at it.
      await new Promise((resolve) => setTimeout(resolve, 160));
    }
    if (ended) return;
    if (step.target) document.querySelector<HTMLElement>(step.target)?.scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior });

    card.replaceChildren();
    const art = el('div', step.demo ? 'ft-demo' : 'ft-art');
    art.dataset.key = step.id;
    art.innerHTML = step.demo === 'heart' ? HEART_DEMO : (step.art ?? '');
    card.append(art, el('h2', 'ft-title', step.title), el('p', 'ft-text', step.text));
    if (step.keys?.length) {
      const keys = el('div', 'ft-keys');
      for (const key of step.keys) keys.append(el('kbd', undefined, key));
      card.append(keys);
    }
    const foot = el('div', 'ft-foot');
    const dots = el('div', 'ft-dots');
    dots.setAttribute('aria-label', `Step ${index + 1} of ${steps.length}`);
    steps.forEach((_, i) => {
      const dot = el('i');
      dot.dataset.on = String(i === index);
      dot.dataset.done = String(i < index);
      dots.append(dot);
    });
    const actions = el('div', 'ft-actions');
    if (index > 0 && !tip) {
      const back = el('button', 'ft-btn ft-ghost', 'Back');
      back.type = 'button';
      back.addEventListener('click', () => void show(index - 1, -1));
      actions.append(back);
    }
    const last = index === steps.length - 1;
    const primary = el('button', 'ft-btn ft-primary', step.button ?? (last ? (tip ? 'Got it' : 'Done') : 'Next'));
    primary.type = 'button';
    primary.addEventListener('click', () => (last ? finish('done') : void show(index + 1)));
    actions.append(primary);
    foot.append(dots, actions);
    card.append(foot);
    if (!tip || steps.length > 1) {
      const skip = el('button', 'ft-skip', last ? 'Close' : 'Skip tour');
      skip.type = 'button';
      skip.addEventListener('click', () => finish(last ? 'done' : 'skip'));
      card.append(skip);
    }
    // The card pops in again for each step.
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';
    reposition();
    primary.focus({ preventScroll: true });
    void direction;
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      finish('skip');
    } else if (event.key === 'ArrowRight' && !tip) {
      event.preventDefault();
      if (index < steps.length - 1) void show(index + 1);
    } else if (event.key === 'ArrowLeft' && !tip) {
      event.preventDefault();
      if (index > 0) void show(index - 1, -1);
    }
  }

  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('keydown', onKey, true);
  void show(0);
  return { stop: () => finish('skip') };
}
