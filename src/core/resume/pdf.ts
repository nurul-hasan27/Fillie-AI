/**
 * Minimal, dependency-free PDF text extraction.
 *
 * Fillie ships no PDF library: this reads the content streams, inflates them with
 * the platform's DecompressionStream and pulls text out of the text operators.
 * It handles the text layout produced by common resume generators (LaTeX,
 * Word, Google Docs exports). Encrypted or image-only PDFs return no text and
 * the UI falls back to manual entry.
 */

interface PdfStream {
  data: Uint8Array;
  dict: string;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

async function inflate(bytes: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<Uint8Array | null> {
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!Ctor) return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new Ctor(format));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

/**
 * Locates every `stream` and the dictionary that belongs to it.
 *
 * A PDF dictionary can contain nested dictionaries (`/Resources << /Font … >>`),
 * so the dictionary is found by walking backwards from `stream` and tracking
 * `<<` / `>>` depth rather than by a flat non-greedy match — the latter pairs
 * a stream with the wrong dictionary whenever nesting is present.
 */
function findStreams(bytes: Uint8Array): PdfStream[] {
  const text = latin1(bytes);
  const streams: PdfStream[] = [];
  const streamPattern = /\bstream\r?\n/g;
  let match: RegExpExecArray | null;

  while ((match = streamPattern.exec(text))) {
    const dataStart = match.index + match[0].length;

    // A stream's dictionary always belongs to the object that starts after the
    // previous `endobj`, which is a far more reliable anchor than trying to
    // match `<<` backwards through nested dictionaries.
    const objectStart = text.lastIndexOf('obj', dataStart);
    if (objectStart === -1) continue;

    const endIndex = text.indexOf('endstream', dataStart);
    if (endIndex === -1) continue;
    let end = endIndex;
    if (text[end - 1] === '\n') end -= 1;
    if (text[end - 1] === '\r') end -= 1;

    streams.push({
      data: bytes.subarray(dataStart, Math.max(dataStart, end)),
      dict: text.slice(objectStart, dataStart),
    });
    streamPattern.lastIndex = endIndex;
  }
  return streams;
}

/** Content streams carry text operators; images and fonts do not. */
function isContentStream(dict: string): boolean {
  return !/\/(?:Image|DCTDecode|JPXDecode|CCITTFaxDecode)\b/.test(dict);
}

function decodePdfString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '\\') {
      const next = raw[i + 1];
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      if (next === '(' || next === ')' || next === '\\') {
        out += next;
        i += 1;
      } else if (next in escapes) {
        out += escapes[next];
        i += 1;
      } else if (/[0-7]/.test(next)) {
        const octal = /^[0-7]{1,3}/.exec(raw.slice(i + 1))?.[0] ?? '';
        out += String.fromCharCode(parseInt(octal, 8));
        i += octal.length;
      } else {
        out += next;
        i += 1;
      }
    } else {
      out += char;
    }
  }
  return out;
}

function decodeHexString(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    // Most PDFs use a single byte per glyph here.
    out += String.fromCharCode(code);
  }
  return out;
}

function extractTextFromContent(content: string): string {
  const blocks: string[] = [];
  const blockPattern = /BT([\s\S]*?)ET/g;
  let block: RegExpExecArray | null;

  while ((block = blockPattern.exec(content))) {
    const body = block[1];
    const pieces: string[] = [];
    let lastIndex = 0;
    // String tokens inside text objects.
    const tokenPattern = /\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]+>|\bTJ\b|\bTj\b|\bT\*|\bTd\b|\bTD\b|\bTf\b|\bET\b/g;
    let token: RegExpExecArray | null;
    let pendingBreak = false;

    while ((token = tokenPattern.exec(body))) {
      const value = token[0];
      if (value.startsWith('(')) {
        if (pendingBreak) pieces.push('\n');
        pieces.push(decodePdfString(value.slice(1, -1)));
        pendingBreak = false;
      } else if (value.startsWith('<')) {
        if (pendingBreak) pieces.push('\n');
        pieces.push(decodeHexString(value.slice(1, -1)));
        pendingBreak = false;
      } else if (value === 'T*' || value === 'Td' || value === 'TD') {
        pendingBreak = true;
      } else if (value === 'Tf') {
        pendingBreak = true;
      }
      lastIndex = token.index + value.length;
    }
    void lastIndex;
    // Do NOT split camelCase: a resume is full of product and language names
    // (TypeScript, PostgreSQL, GraphQL) that must survive intact.
    const text = pieces.join('').replace(/[ \t]{2,}/g, ' ').trim();
    if (text) blocks.push(text);
  }

  return blocks.join('\n');
}

export async function extractPdfText(data: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(data);

  // Encrypted files are skipped outright: their bytes are scrambled, so
  // decoding them yields noise that the field extractor would then "find"
  // confident-looking values in.
  if (/\/Encrypt\b/.test(latin1(bytes))) return '';

  const streams = findStreams(bytes);
  const chunks: string[] = [];

  for (const stream of streams) {
    if (!isContentStream(stream.dict)) continue;
    let payload: Uint8Array | null = null;
    if (/\/FlateDecode/.test(stream.dict)) {
      payload = await inflate(stream.data, 'deflate');
      if (!payload) payload = await inflate(stream.data, 'deflate-raw');
    } else if (!/\/Filter/.test(stream.dict)) {
      payload = stream.data;
    }
    if (!payload) continue;
    const content = latin1(payload);
    if (!/(BT|Tj|TJ)/.test(content)) continue;
    const text = extractTextFromContent(content);
    if (text.trim().length > 20) chunks.push(text);
  }

  const joined = chunks.join('\n');
  return joined.replace(/\n{3,}/g, '\n\n').trim();
}

export function looksLikePdf(name: string): boolean {
  return /\.pdf$/i.test(name);
}