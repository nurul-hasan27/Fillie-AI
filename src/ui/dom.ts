/**
 * Tiny DOM layer: an escaping template tag plus helpers. No framework — the UI
 * is small, and this keeps the extension bundle tiny.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

export type TemplateValue = string | number | boolean | null | undefined | Node | TemplateResult | Array<TemplateValue>;

export interface TemplateResult {
  __html: string;
  nodes: Node[];
}

function render(value: TemplateValue): { html: string; nodes: Node[] } {
  if (value === null || value === undefined || value === false) return { html: '', nodes: [] };
  if (Array.isArray(value)) {
    const nodes: Node[] = [];
    const html = value
      .map((entry) => render(entry as TemplateValue))
      .map((entry) => {
        nodes.push(...entry.nodes);
        return entry.html;
      })
      .join('');
    return { html, nodes };
  }
  if (typeof value === 'number' || typeof value === 'boolean') return { html: String(value), nodes: [] };
  if (typeof value === 'string') return { html: value, nodes: [] };
  if (isTemplateResult(value)) return { html: value.__html, nodes: value.nodes };
  return { html: '', nodes: [value as Node] };
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === 'object' && value !== null && '__html' in (value as Record<string, unknown>);
}

export function html(strings: TemplateStringsArray, ...values: TemplateValue[]): TemplateResult {
  let out = '';
  const nodes: Node[] = [];
  strings.forEach((chunk, index) => {
    out += chunk;
    if (index < values.length) {
      const rendered = render(values[index]);
      out += rendered.html;
      nodes.push(...rendered.nodes);
    }
  });
  return { __html: out, nodes };
}

/** Builds a detached element from a template (used when we need real nodes). */
export function toNode(template: TemplateResult): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = template.__html;
  wrapper.querySelectorAll('script').forEach((script) => script.remove());
  if (wrapper.children.length === 1) return wrapper.firstElementChild as HTMLElement;
  const container = document.createElement('div');
  container.innerHTML = template.__html;
  return container;
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

export function qsa<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** Event delegation — one listener instead of hundreds. */
export function delegate<K extends keyof HTMLElementEventMap>(
  root: HTMLElement,
  selector: string,
  type: K,
  handler: (event: HTMLElementEventMap[K], target: HTMLElement) => void,
): void {
  root.addEventListener(type, (event) => {
    const target = (event.target as HTMLElement | null)?.closest?.(selector) as HTMLElement | null;
    if (target && root.contains(target)) {
      handler(event as HTMLElementEventMap[K], target);
    }
  });
}

export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: T) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function setTheme(theme: 'light' | 'dark' | 'system'): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

export function preferredTheme(): 'light' | 'dark' {
  const query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  return query?.matches ? 'dark' : 'light';
}