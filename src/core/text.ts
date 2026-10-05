/**
 * Lightweight text utilities shared by the scanner, retrieval, memory and the
 * prompt builders. Deliberately dependency-free and deterministic so it can be
 * unit tested without a browser.
 */

const STOPWORDS = new Set([
  'a','about','above','after','again','all','also','am','an','and','any','are','as','at','be','because','been','before',
  'being','below','between','both','but','by','can','could','did','do','does','doing','down','during','each','few','for',
  'from','further','had','has','have','having','he','her','here','hers','him','his','how','i','if','in','into','is','it',
  'its','just','me','more','most','my','no','nor','not','now','of','off','on','once','only','or','other','our','out',
  'over','own','please','same','she','should','so','some','such','than','that','the','their','them','then','there','these',
  'they','this','those','through','to','too','under','until','up','very','was','we','were','what','when','where','which',
  'while','who','whom','why','will','with','would','you','your',
]);

export const STOP_WORDS = STOPWORDS;

export function normalizeText(input: string): string {
  return input
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeKey(input: string): string {
  return normalizeText(input).toLowerCase();
}

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeForMatch(input: string): string {
  return normalizeText(input)
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(input: string): string[] {
  const normalized = normalizeForMatch(input);
  if (!normalized) return [];
  return normalized
    .split(/[\s\-_/,.]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

export function bigrams(input: string): string[] {
  const tokens = tokenize(input);
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

export function charNgrams(input: string, n = 3): string[] {
  const clean = normalizeForMatch(input).replace(/\s+/g, ' ');
  const out: string[] = [];
  if (clean.length < n) {
    if (clean) out.push(clean);
    return out;
  }
  for (let i = 0; i <= clean.length - n; i += 1) out.push(clean.slice(i, i + n));
  return out;
}

/** Jaccard similarity of token sets. */
export function jaccard(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Dice similarity over character trigrams — robust to paraphrase. */
export function trigramSimilarity(a: string, b: string): number {
  const gramsA = charNgrams(a, 3);
  const gramsB = charNgrams(b, 3);
  if (gramsA.length === 0 || gramsB.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const gram of gramsA) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let shared = 0;
  for (const gram of gramsB) {
    const c = counts.get(gram);
    if (c && c > 0) {
      shared += 1;
      counts.set(gram, c - 1);
    }
  }
  return (2 * shared) / (gramsA.length + gramsB.length);
}

/** Cosine-ish similarity over IDF weighted tokens. */
export function weightedTokenSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (!tokensA.length || !tokensB.length) return 0;
  const docFreq = new Map<string, number>();
  for (const t of tokensA) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  for (const t of tokensB) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);

  const idf = (token: string) => 1 + Math.log(1 + (2 / (docFreq.get(token) ?? 1)));
  const vecA = new Map<string, number>();
  for (const t of tokensA) vecA.set(t, (vecA.get(t) ?? 0) + idf(t));
  const vecB = new Map<string, number>();
  for (const t of tokensB) vecB.set(t, (vecB.get(t) ?? 0) + idf(t));

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [, v] of vecA) normA += v * v;
  for (const [, v] of vecB) normB += v * v;
  for (const [t, v] of vecA) {
    const other = vecB.get(t);
    if (other) dot += v * other;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Blended semantic-ish similarity used for memory matching. No embeddings are
 * used — this is a deterministic lexical-semantic approximation which keeps
 * the extension tiny and fully offline-capable for matching.
 */
export function semanticSimilarity(a: string, b: string): number {
  const tokenScore = weightedTokenSimilarity(a, b);
  const gramScore = trigramSimilarity(a, b);
  const jacScore = jaccard(a, b);
  const conceptScore = conceptSimilarity(a, b);
  return clamp01(tokenScore * 0.4 + gramScore * 0.26 + jacScore * 0.14 + conceptScore * 0.2);
}

/**
 * Concept expansion for paraphrased questions. Not embeddings — a small,
 * hand-curated map from surface words to the concepts they signal, so "led a
 * team" and "showed leadership" are recognised as the same intent.
 */
const CONCEPTS: Array<{ concept: string; patterns: RegExp }> = [
  { concept: 'leadership', patterns: /\b(lead|led|leading|leadership|head|headed|manage|managed|managing|supervise|directed|mentor|mentored|owned)\b/i },
  { concept: 'team', patterns: /\b(team|teams|group|crew|colleague|collaborat\w*|cross[- ]?functional)\b/i },
  { concept: 'story', patterns: /\b(describe|tell us|give (an )?example|walk (me )?through|elaborate|explain|share)\b/i },
  { concept: 'project', patterns: /\b(project|projects|build|built|develop\w*|ship\w*|implement\w*|product|app|application|system)\b/i },
  { concept: 'challenge', patterns: /\b(challenge|challenging|difficult|hard|struggl\w*|tough|complex|problem|issue|setback)\b/i },
  { concept: 'achievement', patterns: /\b(achiev\w*|accomplish\w*|award\w*|won|winner|proud|impact|result\w*|success\w*)\b/i },
  { concept: 'failure', patterns: /\b(fail\w*|mistake|regret|lesson|went wrong|shortcoming)\b/i },
  { concept: 'motivation', patterns: /\b(why (do you|are you|you)|motivat\w*|interested in|draw (me )?to|appeal\w*)\b/i },
  { concept: 'salary', patterns: /\b(salary|ctc|compensation|pay|package|stipend|expectation\w*|rate)\b/i },
  { concept: 'relocation', patterns: /\b(relocat\w*|willing to (move|relocate)|mobility|open to moving)\b/i },
  { concept: 'availability', patterns: /\b(availab\w*|start date|joining|when (can|could)|notice period|immediately|ready to (start|join))\b/i },
  { concept: 'strength', patterns: /\b(strength|best at|good at|excel\w*|specialis\w*|specializ\w*|proud of)\b/i },
  { concept: 'communication', patterns: /\b(communicat\w*|present\w*|explain\w*|writ\w*|listen\w*|clarity)\b/i },
  { concept: 'conflict', patterns: /\b(conflict|disagree\w*|feedback|difficult (person|colleague)|pushback|resist\w*)\b/i },
  { concept: 'learning', patterns: /\b(learn\w*|curious|improve\w*|new tech|keep up|study|training)\b/i },
  { concept: 'culture', patterns: /\b(culture|values|mission|diversity|inclusion|belong\w*|teamwork)\b/i },
  { concept: 'future', patterns: /\b(five years|5 years|future|career plan|next role|growth|where do you see)\b/i },
  { concept: 'skills', patterns: /\b(skills?|proficien\w*|competen\w*|comfortable|hands[- ]?on|stack|technolog\w*|familiar with|experience with|languages?)\b/i },
  { concept: 'experience', patterns: /\b(experience|experienced|intern|internship|employment|work history|professional|worked|previous role|past role|most recent|current role)\b/i },
  { concept: 'employer', patterns: /\b(company|companies|organisation|organization|employer|firm|where did you work|who did you work)\b/i },
  { concept: 'role', patterns: /\b(role|title|designation|position|job|what did you do|responsib)\b/i },
  { concept: 'education', patterns: /\b(education|educated|degree|university|college|school|stud\w*|graduat\w*|qualification)\b/i },
  { concept: 'contact', patterns: /\b(contact|reach|call|phone|email|address|where are you based|relocat\w*)\b/i },
];

/** Concepts present in a piece of text. */
export function conceptsOf(text: string): Set<string> {
  const found = new Set<string>();
  for (const { concept, patterns } of CONCEPTS) {
    if (patterns.test(text)) found.add(concept);
  }
  return found;
}

/**
 * Concept similarity — robust to wording differences.
 *
 * Uses the Dice coefficient plus an inclusion bonus, so a short question
 * ("led a team") can still match a longer stored one ("describe a project where
 * you showed leadership") without an unrelated question scoring highly.
 */
export function conceptSimilarity(a: string, b: string): number {
  const conceptsA = conceptsOf(a);
  const conceptsB = conceptsOf(b);
  if (!conceptsA.size || !conceptsB.size) return 0;
  let shared = 0;
  for (const concept of conceptsA) if (conceptsB.has(concept)) shared += 1;
  if (!shared) return 0;
  const dice = (2 * shared) / (conceptsA.size + conceptsB.size);
  const coverage = shared / Math.min(conceptsA.size, conceptsB.size);
  // Rarer shared concepts (leadership, conflict) mean more than common ones.
  const rarity = conceptsA.size > 2 && conceptsB.size > 2 ? 1 : 1.05;
  return Math.min(1, (dice * 0.55 + coverage * 0.45) * rarity);
}

/**
 * Deterministic fingerprint of a question, used as the memory key. Stable for
 * paraphrases, order-insensitive enough to survive minor reordering.
 */
export function questionSignature(question: string, intent?: string): string {
  const tokens = [...new Set(tokenize(`${question} ${intent ?? ''}`))].sort();
  return tokens.join('-');
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** Levenshtein distance with early exit for long strings. */
export function editDistance(a: string, b: string, max = 64): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Common abbreviations that appear in profile values but rarely verbatim in a
 * form's option list. Keeps "UK" matching "United Kingdom" without letting the
 * engine guess at anything semantic.
 */
const ABBREVIATIONS: Record<string, string[]> = {
  uk: ['united kingdom', 'great britain', 'britain', 'england'],
  us: ['united states', 'united states of america', 'usa', 'america'],
  uae: ['united arab emirates'],
  netherlands: ['holland', 'the netherlands'],
  india: ['in', 'bharat'],
  germany: ['de', 'deutschland'],
  canada: ['ca'],
  australia: ['au'],
  ireland: ['ie', 'republic of ireland', 'eire'],
};

function expandAbbreviations(value: string): string[] {
  const out = [value];
  const expansions = ABBREVIATIONS[value];
  if (expansions) out.push(...expansions);
  return out;
}

/** Normalised similarity of two short strings (option labels, choices). */
export function optionSimilarity(a: string, b: string): number {
  const normA = normalizeForMatch(a);
  const normB = normalizeForMatch(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  const candidatesA = expandAbbreviations(normA);
  const candidatesB = expandAbbreviations(normB);
  let best = 0;

  for (const left of candidatesA) {
    for (const right of candidatesB) {
      best = Math.max(best, rawOptionSimilarity(left, right));
    }
  }
  return best;
}

function rawOptionSimilarity(normA: string, normB: string): number {
  if (normA === normB) return 1;
  if (normA.includes(normB) || normB.includes(normA)) {
    const shorter = Math.min(normA.length, normB.length);
    const longer = Math.max(normA.length, normB.length);
    return 0.9 + 0.1 * (shorter / longer) - 0.05;
  }
  const dist = editDistance(normA, normB, 12);
  if (dist > 12) return 0;
  return clamp01(1 - dist / Math.max(normA.length, normB.length));
}

/** Best matching option for a value. Returns null when nothing is close enough. */
export function matchOption(
  value: string,
  options: readonly string[],
  threshold = 0.62,
): { option: string; score: number } | null {
  let best: { option: string; score: number } | null = null;
  for (const option of options) {
    const score = optionSimilarity(value, option);
    if (!best || score > best.score) best = { option, score };
  }
  if (!best || best.score < threshold) return null;
  return best;
}

export function titleCase(input: string): string {
  return normalizeText(input).replace(/\b([a-z])(\w*)/g, (_, a: string, b: string) => a.toUpperCase() + b);
}

export function sentenceCase(input: string): string {
  const text = normalizeText(input);
  if (!text) return '';
  return text[0].toUpperCase() + text.slice(1);
}

export function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

/** Strips characters that would break a single-line form control. */
export function toSingleLine(input: string): string {
  return normalizeText(input).replace(/\s*\n+\s*/g, ' ');
}

/** Collapses long text for prompts / char limits. */
export function truncate(input: string, max: number): string {
  const text = normalizeText(input);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const key = keyFn(item);
    (out[key] ||= []).push(item);
  }
  return out;
}

export function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) {
    const m = Math.round(diff / minute);
    return `${m} ${pluralize('minute', m)} ago`;
  }
  if (diff < day) {
    const h = Math.round(diff / hour);
    return `${h} ${pluralize('hour', h)} ago`;
  }
  if (diff < 30 * day) {
    const d = Math.round(diff / day);
    return `${d} ${pluralize('day', d)} ago`;
  }
  return new Date(timestamp).toLocaleDateString();
}

/** Deterministic colour-ish hash, used for stable avatars / chips. */
export function stableHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}