/**
 * Small hand-built illustrations in a soft "clay" style: rounded forms, one
 * highlight, no outlines. They are inline SVG so they ship in the bundle with
 * no network, follow the palette tokens and stay crisp at any size.
 */

const defs = (id: string, a: string, b: string) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;

/** A sheet of paper with lines and a marigold tab: the resume. */
export const resumeArt = `
<svg class="art" viewBox="0 0 120 120" width="112" height="112" aria-hidden="true" focusable="false">
  <defs>${defs('ra', '#ffffff', '#ece9e6')}${defs('rb', '#ffc83d', '#ff9f0a')}</defs>
  <ellipse cx="62" cy="108" rx="34" ry="5" fill="rgba(0,0,0,.08)"/>
  <g transform="rotate(-8 60 60)">
    <rect x="26" y="14" width="66" height="86" rx="12" fill="url(#ra)" stroke="rgba(0,0,0,.08)"/>
    <rect x="38" y="30" width="26" height="8" rx="4" fill="#02093a"/>
    <rect x="38" y="46" width="42" height="5" rx="2.5" fill="rgba(0,0,0,.14)"/>
    <rect x="38" y="57" width="36" height="5" rx="2.5" fill="rgba(0,0,0,.14)"/>
    <rect x="38" y="68" width="42" height="5" rx="2.5" fill="rgba(0,0,0,.14)"/>
    <rect x="38" y="79" width="22" height="5" rx="2.5" fill="rgba(0,0,0,.14)"/>
  </g>
  <circle cx="90" cy="30" r="15" fill="url(#rb)"/>
  <path d="M83 30.5l5 5 9-10" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/** A chunky key on a sky disc: the API keys. */
export const keyArt = `
<svg class="art" viewBox="0 0 120 120" width="112" height="112" aria-hidden="true" focusable="false">
  <defs>${defs('ka', '#8cc4f6', '#3d8fe0')}${defs('kb', '#ffc83d', '#ff9f0a')}</defs>
  <ellipse cx="60" cy="108" rx="36" ry="5" fill="rgba(0,0,0,.08)"/>
  <circle cx="46" cy="52" r="32" fill="url(#ka)"/>
  <circle cx="46" cy="52" r="12" fill="#f6f5f4"/>
  <ellipse cx="34" cy="38" rx="9" ry="5" fill="rgba(255,255,255,.35)" transform="rotate(-30 34 38)"/>
  <rect x="66" y="64" width="42" height="14" rx="7" fill="url(#kb)" transform="rotate(32 66 64)"/>
  <rect x="88" y="84" width="9" height="13" rx="4.5" fill="#f64932" transform="rotate(32 88 84)"/>
</svg>`;

/** A coral sparkle cluster: answers being filled. */
export const sparkArt = `
<svg class="art" viewBox="0 0 120 120" width="112" height="112" aria-hidden="true" focusable="false">
  <defs>${defs('sa', '#ff7a66', '#f64932')}${defs('sb', '#ffc83d', '#ff9f0a')}</defs>
  <ellipse cx="60" cy="108" rx="30" ry="5" fill="rgba(0,0,0,.08)"/>
  <path d="M56 16c3 22 12 31 34 34-22 3-31 12-34 34-3-22-12-31-34-34 22-3 31-12 34-34z" fill="url(#sa)"/>
  <path d="M92 70c1.6 11 6 15.4 17 17-11 1.6-15.4 6-17 17-1.6-11-6-15.4-17-17 11-1.6 15.4-6 17-17z" fill="url(#sb)"/>
  <ellipse cx="46" cy="38" rx="8" ry="4" fill="rgba(255,255,255,.4)" transform="rotate(-35 46 38)"/>
</svg>`;

/** Any of the illustrations above at another size (they ship at 112px). */
export const sized = (art: string, size: number): string => art.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
