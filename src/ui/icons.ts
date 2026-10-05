/**
 * Inline SVG icon set — one consistent stroke weight (1.5), one grid (16px),
 * no emoji, no external icon dependency.
 */

export type IconName =
  | 'sparkle'
  | 'check'
  | 'check-circle'
  | 'alert'
  | 'close'
  | 'close-circle'
  | 'copy'
  | 'pencil'
  | 'refresh'
  | 'arrow-right'
  | 'arrow-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'user'
  | 'briefcase'
  | 'cap'
  | 'folder'
  | 'trophy'
  | 'link'
  | 'sliders'
  | 'brain'
  | 'shield'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'plus'
  | 'minus'
  | 'trash'
  | 'upload'
  | 'download'
  | 'external'
  | 'eye'
  | 'send'
  | 'clock'
  | 'lock'
  | 'info'
  | 'dot'
  | 'menu'
  | 'search'
  | 'sparkles'
  | 'layers';

const PATHS: Record<IconName, string> = {
  sparkle: '<path d="M8 1.5l1.35 3.4a3 3 0 0 0 1.75 1.75L14.5 8l-3.4 1.35a3 3 0 0 0-1.75 1.75L8 14.5 6.65 11.1a3 3 0 0 0-1.75-1.75L1.5 8l3.4-1.35a3 3 0 0 0 1.75-1.75L8 1.5Z"/>',
  sparkles:
    '<path d="M6 1.5l.9 2.3a2 2 0 0 0 1.3 1.3L10.5 6l-2.3.9a2 2 0 0 0-1.3 1.3L6 10.5l-.9-2.3a2 2 0 0 0-1.3-1.3L1.5 6l2.3-.9a2 2 0 0 0 1.3-1.3L6 1.5Z"/><path d="M12 9.5l.5 1.3a1 1 0 0 0 .7.7l1.3.5-1.3.5a1 1 0 0 0-.7.7L12 14.5l-.5-1.3a1 1 0 0 0-.7-.7L9.5 12l1.3-.5a1 1 0 0 0 .7-.7l.5-1.2Z"/>',
  check: '<path d="M3 8.4l3.2 3.2L13 4.8"/>',
  'check-circle': '<circle cx="8" cy="8" r="6.25"/><path d="M5.2 8.2l2 2 3.6-3.9"/>',
  alert: '<path d="M8 2.6L14.2 13.4H1.8L8 2.6Z"/><path d="M8 6.8v3.1"/><circle cx="8" cy="11.6" r=".55" fill="currentColor" stroke="none"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  'close-circle': '<circle cx="8" cy="8" r="6.25"/><path d="M6 6l4 4M10 6l-4 4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h2.5"/>',
  pencil: '<path d="M11.2 2.6l2.2 2.2-7.5 7.5-2.9.7.7-2.9 7.5-7.5Z"/><path d="M9.8 4l2.2 2.2"/>',
  refresh: '<path d="M13.2 7a5.3 5.3 0 1 0 .3 2.6"/><path d="M13.6 3.6V7h-3.3"/>',
  'arrow-right': '<path d="M3 8h10"/><path d="M9.2 4.2L13 8l-3.8 3.8"/>',
  'arrow-left': '<path d="M13 8H3"/><path d="M6.8 4.2L3 8l3.8 3.8"/>',
  'chevron-right': '<path d="M6.5 4l3.6 4-3.6 4"/>',
  'chevron-down': '<path d="M4 6.5l4 3.6 4-3.6"/>',
  user: '<circle cx="8" cy="5.6" r="2.6"/><path d="M3 13.4a5 5 0 0 1 10 0"/>',
  briefcase: '<rect x="2.4" y="5.4" width="11.2" height="7.6" rx="1.6"/><path d="M5.8 5.4V4.2a1.2 1.2 0 0 1 1.2-1.2h2a1.2 1.2 0 0 1 1.2 1.2v1.2"/><path d="M2.4 8.6h11.2"/>',
  cap: '<path d="M8 2.4L14.2 5.6 8 8.8 1.8 5.6 8 2.4Z"/><path d="M4 7.1v3.4c0 1 1.8 2 4 2s4-1 4-2V7.1"/>',
  folder: '<path d="M2.4 4.8c0-.9.7-1.6 1.6-1.6h2.3l1.3 1.6h4.4c.9 0 1.6.7 1.6 1.6v4.8c0 .9-.7 1.6-1.6 1.6H4c-.9 0-1.6-.7-1.6-1.6V4.8Z"/>',
  trophy: '<path d="M5 3h6v3.2a3 3 0 1 1-6 0V3Z"/><path d="M5 4.2H3.2v1a2 2 0 1 0 2 2M11 4.2h1.8v1a2 2 0 1 1-2 2"/><path d="M8 9.2v2.4M6 13.4h4"/>',
  link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.9.3l1.8-1.8a2.6 2.6 0 0 0-3.7-3.7l-1 1"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.9-.3L3.5 8.3a2.6 2.6 0 0 0 3.7 3.7l1-1"/>',
  sliders: '<path d="M2.6 5.2h6.2M11.6 5.2h1.8M2.6 10.8h1.8M7.2 10.8h6.2"/><circle cx="10.2" cy="5.2" r="1.4"/><circle cx="5.8" cy="10.8" r="1.4"/>',
  brain: '<path d="M6.4 3.2a2 2 0 0 0-2 2 1.8 1.8 0 0 0-1 3.2 2 2 0 0 0 1.2 2.6A1.9 1.9 0 0 0 6.6 13v-9.8Z"/><path d="M9.6 3.2a2 2 0 0 1 2 2 1.8 1.8 0 0 1 1 3.2 2 2 0 0 1-1.2 2.6A1.9 1.9 0 0 1 9.4 13V3.2Z"/>',
  shield: '<path d="M8 2.2l4.6 1.7v3.5c0 2.6-1.9 5-4.6 6-2.7-1-4.6-3.4-4.6-6V3.9L8 2.2Z"/><path d="M6 8l1.4 1.5L10.2 6.6"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.6v1.3M8 13.1v1.3M1.6 8h1.3M13.1 8h1.3M3.5 3.5l.9.9M11.6 11.6l.9.9M12.5 3.5l-.9.9M4.4 11.6l-.9.9"/>',
  moon: '<path d="M13 9.6A5.6 5.6 0 0 1 6.4 3 5.8 5.8 0 1 0 13 9.6Z"/>',
  monitor: '<rect x="2.2" y="3.4" width="11.6" height="8" rx="1.4"/><path d="M6 13.6h4"/>',
  plus: '<path d="M8 3.4v9.2M3.4 8h9.2"/>',
  minus: '<path d="M3.4 8h9.2"/>',
  trash: '<path d="M3.4 5.2h9.2M6.4 5.2V3.8c0-.6.4-1 1-1h1.2c.6 0 1 .4 1 1v1.4"/><path d="M4.6 5.2l.5 7.2c0 .6.4 1 1 1h3.8c.6 0 1-.4 1-1l.5-7.2"/>',
  upload: '<path d="M8 10.6V2.8"/><path d="M5 5.6L8 2.6l3 3"/><path d="M2.8 10v2.6c0 .7.5 1.2 1.2 1.2h8c.7 0 1.2-.5 1.2-1.2V10"/>',
  download: '<path d="M8 2.8v7.8"/><path d="M5 7.8l3 3 3-3"/><path d="M2.8 10v2.6c0 .7.5 1.2 1.2 1.2h8c.7 0 1.2-.5 1.2-1.2V10"/>',
  external: '<path d="M9.4 2.6H13.4v4"/><path d="M13.4 2.6L7.6 8.4"/><path d="M12 9.6v3c0 .5-.4.8-.9.8H3.8c-.5 0-.8-.3-.8-.8V5.3c0-.5.3-.9.8-.9h3"/>',
  eye: '<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.8"/>',
  send: '<path d="M14 2.4L7 9.4"/><path d="M14 2.4l-4.4 11.2-2.6-4.2-4.2-2.6L14 2.4Z"/>',
  clock: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.2 1.4"/>',
  lock: '<rect x="3.4" y="7" width="9.2" height="6.2" rx="1.4"/><path d="M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7"/>',
  info: '<circle cx="8" cy="8" r="6.2"/><path d="M8 7.4v3.4"/><circle cx="8" cy="5.2" r=".6" fill="currentColor" stroke="none"/>',
  dot: '<circle cx="8" cy="8" r="2.6"/>',
  menu: '<path d="M2.6 4.6h10.8M2.6 8h10.8M2.6 11.4h10.8"/>',
  search: '<circle cx="7.2" cy="7.2" r="4.4"/><path d="M10.6 10.6l2.6 2.6"/>',
  layers: '<path d="M8 2.4L14.4 5.6 8 8.8 1.6 5.6 8 2.4Z"/><path d="M1.6 9.2L8 12.4l6.4-3.2"/>',
};

export interface IconOptions {
  size?: number;
  className?: string;
  strokeWidth?: number;
  filled?: boolean;
}

export function icon(name: IconName, options: IconOptions = {}): SVGSVGElement {
  const size = options.size ?? 16;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', options.filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(options.strokeWidth ?? 1.5));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (options.className) svg.setAttribute('class', options.className);
  svg.innerHTML = PATHS[name] ?? PATHS.dot;
  return svg;
}

/** Brand mark: a document with a sparkle — readable down to 16px. */
export function brandMark(size = 24, color = 'currentColor'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <rect x="5.5" y="3.5" width="16" height="21" rx="4.2" fill="var(--ff-accent-soft)" stroke="${color}" stroke-width="1.6"/>
    <path d="M10 10.5h7M10 15h7" stroke="${color}" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>
    <path d="M22.4 15.2l1.02 2.56 2.56 1.02-2.56 1.02-1.02 2.56-1.02-2.56-2.56-1.02 2.56-1.02 1.02-2.56Z" fill="var(--ff-accent)" stroke="none"/>
  `;
  return svg;
}