import type { DeviceSignals } from './types';

/**
 * Device signals for the free-trial counter. Two hashes are sent:
 *  - `hw` uses only machine-level traits, so Chrome, Brave and Edge on the same
 *    computer produce the same value;
 *  - `br` adds browser-level traits.
 * No raw values leave the device, only SHA-256 hashes, and they are used for
 * nothing but counting free fillings. Disclose this in the privacy policy.
 *
 * This deters casual resets; it cannot stop a determined person, and two
 * identical machines may share a `hw` value (they would simply be asked to sign
 * in sooner).
 */

export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  // Content scripts on plain http:// pages have no crypto.subtle, so a pure
  // implementation keeps the trial counter working there too.
  if (!globalThis.crypto?.subtle) return sha256Fallback(bytes);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Plain SHA-256 (FIPS 180-4). */
export function sha256Fallback(bytes: Uint8Array): string {
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map((n) => n.toString(16).padStart(8, '0')).join('');
}

function gpuRenderer(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  } catch {
    return '';
  }
}

function canvasTrait(): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 30;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('Fillie·fp 1.0', 2, 2);
    return canvas.toDataURL().slice(-64);
  } catch {
    return '';
  }
}

export interface RawTraits {
  hardware: string[];
  browser: string[];
}

export function collectTraits(): RawTraits {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const screenInfo = typeof screen !== 'undefined' ? screen : undefined;
  return {
    hardware: [
      String(nav.hardwareConcurrency ?? ''),
      String(nav.deviceMemory ?? ''),
      screenInfo ? `${Math.max(screenInfo.width, screenInfo.height)}x${Math.min(screenInfo.width, screenInfo.height)}x${screenInfo.colorDepth}` : '',
      typeof devicePixelRatio === 'number' ? String(devicePixelRatio) : '',
      Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
      gpuRenderer(),
    ],
    browser: [navigator.userAgent, (navigator.languages ?? []).join(','), canvasTrait(), String(navigator.maxTouchPoints ?? 0)],
  };
}

/** The two hashes; the extension's background worker adds the install id. */
export async function computeHashes(): Promise<Pick<DeviceSignals, 'hw' | 'br'>> {
  const traits = collectTraits();
  const hw = await sha256(`fillie-hw|${traits.hardware.join('|')}`);
  const br = await sha256(`fillie-br|${hw}|${traits.browser.join('|')}`);
  return { hw, br };
}
