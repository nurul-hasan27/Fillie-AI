import { afterEach, beforeEach } from 'vitest';

/**
 * happy-dom performs no layout and reports `tabIndex === -1` for every element.
 * Both are patched here so the scanner's visibility and focusability checks can
 * be exercised; elements opt out with `data-hidden="true"`.
 */

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'getClientRects', {
    configurable: true,
    writable: true,
    value: function getClientRects(this: Element) {
      if (this.getAttribute?.('data-hidden') === 'true') return [] as unknown as DOMRectList;
      const rect = {
        x: 0,
        y: 0,
        width: 200,
        height: 32,
        top: 0,
        left: 0,
        right: 200,
        bottom: 32,
        toJSON: () => ({}),
      } as DOMRect;
      return [rect] as unknown as DOMRectList;
    },
  });

  Object.defineProperty(HTMLElement.prototype, 'tabIndex', {
    configurable: true,
    get(this: HTMLElement) {
      const attr = this.getAttribute('tabindex');
      if (attr !== null) return Number(attr);
      return ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName) ? 0 : -1;
    },
  });

  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: () => {},
  });

  if (typeof window !== 'undefined' && !window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
});

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
});