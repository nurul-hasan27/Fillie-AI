import type { KnowledgeBundle, KnowledgeItem } from './types';
import { clamp01, conceptSimilarity, normalizeForMatch, semanticSimilarity, tokenize } from './text';

/**
 * Retrieval: picks the knowledge items relevant to one question. This keeps
 * prompts small (privacy + rate limits) and improves answer quality because the
 * model sees facts, not a wall of profile text.
 */

export interface RetrievedKnowledge {
  items: KnowledgeItem[];
  /** Aggregate lexical relevance of the selection (0..1). */
  score: number;
  /** The query used for scoring — useful for debugging in the UI. */
  query: string;
}

const EXACT_ALIASES: Array<{ pattern: RegExp; ids: string[]; exclude?: RegExp }> = [
  { pattern: /\b(e-?mail|email address|contact email)\b/i, ids: ['personal.email'] },
  { pattern: /\b(first\s*name|given\s*name|forename|fname)\b/i, ids: ['personal.firstName'] },
  { pattern: /\b(last\s*name|surname|family\s*name|lname)\b/i, ids: ['personal.lastName'] },
  {
    pattern: /\b(phone\s*ext(ension)?|ext(ension)?\.?|telephone\s*ext(ension)?)\b/i,
    exclude: /\b(chrome|browser|file|installed|software|vs\s*code)\s*extension\b/i,
    ids: ['personal.phoneExtension'],
  },
  {
    pattern: /\b(country\s*code|dial(l?ing)?\s*code|phone\s*(code|prefix)|isd(\s*code)?)\b/i,
    ids: ['personal.phoneCountryCode'],
  },
  {
    pattern: /\b(national\s*phone|local\s*phone|subscriber\s*number|phone\s*(number)?\s*\(?(without|no)\s*country\s*code\)?)\b/i,
    ids: ['personal.phoneNumber', 'personal.phone'],
  },
  {
    pattern: /\b(phone|mobile|cell|contact number|whatsapp|telephone)\b/i,
    ids: ['personal.phone', 'personal.phoneNumber'],
  },
  {
    // A bare "name" usually means the applicant's own, but the word appears in a
    // lot of questions that want something else entirely — "Company name",
    // "Project name", "School name". Writing the user's name into one of those
    // is a confident wrong answer, so the owner noun disqualifies it and the
    // question falls through to retrieval instead.
    pattern: /\b(full name|your name|name)\b/i,
    exclude:
      /\b(company|project|business|bank|account|file|folder|user|group|team|product|brand|host|repository|school|college|university|institution|course|module|vendor|supplier|employer|organisation|organization|spouse|father|mother|parent|guardian|pet|reference|referee|first|last|given|family|nickname)\s+name\b/i,
    ids: ['personal.fullName'],
  },
  { pattern: /\b(date of birth|dob|born|birthday|birth date)\b/i, ids: ['personal.dateOfBirth'] },
  { pattern: /\b(nationality|national|citizenship)\b/i, ids: ['personal.nationality'] },
  {
    // "Preferred location" is handled separately below: it asks where the user
    // wants to work, not where they live now.
    pattern: /\b(city|location|based in|where are you located|current location|city of residence)\b/i,
    exclude: /\b(preferred|desired|open to|relocate to|choose|willing to (work|relocate))\b[^.?!]{0,20}\b(location|city|cities|place)\b/i,
    ids: ['personal.location', 'personal.city'],
  },
  { pattern: /\b(country(nationality)?|country of (residence|nationality)|where are you (based|located)|nation)\b/i, ids: ['personal.country', 'personal.nationality'] },
  { pattern: /\b(address|street|postal|pincode|zip)\b/i, ids: ['personal.address', 'personal.postalCode'] },
  { pattern: /\b(linkedin|linked in)\b/i, ids: ['links.linkedin'] },
  { pattern: /\b(github|git hub|code ?repository|repositories)\b/i, ids: ['links.github'] },
  { pattern: /\b(portfolio|personal website|personal site)\b/i, ids: ['links.portfolio', 'links.website'] },
  { pattern: /\b(12th|twelfth|hsc|senior secondary|intermediate|class 12)\b[^.?!]{0,25}\b(school|junior college|college|institution)\b/i, ids: ['education.twelfthSchool', 'education.schoolName'] },
  { pattern: /\b(12th|twelfth|hsc|senior secondary|intermediate|class 12)\b[^.?!]{0,25}\b(board)\b/i, ids: ['education.twelfthBoard', 'education.board'] },
  { pattern: /\b(12th|twelfth|hsc|senior secondary|intermediate|class 12)\b[^.?!]{0,25}\b(stream)\b/i, ids: ['education.twelfthStream'] },
  { pattern: /\b(12th|twelfth|hsc|senior secondary|intermediate|class 12)\b[^.?!]{0,25}\b(year|passing)\b/i, ids: ['education.twelfthYear'] },
  { pattern: /\b(12th|twelfth|hsc|senior secondary|intermediate|class 12)\b[^.?!]{0,25}\b(percentage|percent|marks|cgpa|score|grade)\b/i, ids: ['education.twelfthPercentage', 'education.percentage'] },
  { pattern: /\b(10th|tenth|ssc|secondary|matriculation|class 10)\b[^.?!]{0,25}\b(school|institution)\b/i, ids: ['education.tenthSchool', 'education.schoolName'] },
  { pattern: /\b(10th|tenth|ssc|secondary|matriculation|class 10)\b[^.?!]{0,25}\b(board)\b/i, ids: ['education.tenthBoard', 'education.board'] },
  { pattern: /\b(10th|tenth|ssc|secondary|matriculation|class 10)\b[^.?!]{0,25}\b(year|passing)\b/i, ids: ['education.tenthYear'] },
  { pattern: /\b(10th|tenth|ssc|secondary|matriculation|class 10)\b[^.?!]{0,25}\b(percentage|percent|marks|cgpa|score|grade)\b/i, ids: ['education.tenthPercentage', 'education.percentage'] },
  { pattern: /\b(school name|high school|secondary school)\b/i, ids: ['education.schoolName', 'education.twelfthSchool', 'education.tenthSchool'] },
  { pattern: /\b(university|college|institution|alma mater)\b/i, ids: ['education.university', 'education.college'] },
  { pattern: /\b(degree|bachelor|master|b\.?tech|m\.?tech|b\.?sc|m\.?sc|qualification)\b/i, ids: ['education.degree'] },
  { pattern: /\b(branch|major|discipline|field of study)\b/i, ids: ['education.branch'] },
  { pattern: /\b(cgpa|gpa|grade point)\b/i, ids: ['education.cgpa'] },
  // "board" is its own question (CBSE, IB, A-levels), so it is kept out of the
  // marks alias below — otherwise "School board" answers with the percentage.
  { pattern: /\b(board|examination board|curriculum)\b/i, ids: ['education.board'] },
  { pattern: /\b(percentage|percent|marks|10th|12th|tenth|twelfth|aggregate)\b/i, ids: ['education.percentage', 'education.schoolName'] },
  { pattern: /\b(graduation year|year of graduation|passing year|batch)\b/i, ids: ['education.graduationYear'] },
  { pattern: /\b(semester)\b/i, ids: ['education.semester'] },
  { pattern: /\b(course|subjects|coursework|syllabus)\b/i, ids: ['education.coursework'] },
  { pattern: /\b(salary|ctc|compensation|pay expectation|expected package|stipend)\b/i, ids: ['preferences.salary'] },
  // "Preferred location" asks where the user wants to work, which is a different
  // stored fact from where they live today.
  { pattern: /\b(preferred (location|city|cities|place)|work location|relocate to|open to (working )?in)\b/i, ids: ['preferences.locations', 'personal.location'] },
  { pattern: /\b(relocate|relocation|willing to move|mobility)\b/i, ids: ['preferences.relocate', 'preferences.locations'] },
  { pattern: /\b(remote|hybrid|on-?site|work from home|wfh|work mode|work arrangement|office)\b/i, ids: ['preferences.workMode'] },
  // "Notice period" and "when can you start" are different facts with different
  // values, so they are separate aliases rather than one list: the resolver
  // takes the first id it can resolve, and availability used to win outright.
  { pattern: /\b(notice period|period of notice|serving notice|relieving date)\b/i, ids: ['preferences.noticePeriod'] },
  { pattern: /\b(available|availability|when can you start|joining date|start date)\b/i, ids: ['preferences.availability'] },
  { pattern: /\b(language|languages|fluency|speak)\b/i, ids: ['personal.languages'] },
  { pattern: /\b(gender)\b/i, ids: ['personal.gender'] },
  {
    pattern: /\b(which (company|organisation|organization|employer)|where did you (work|intern)|who did you work|did you intern at|worked at|internship at)\b/i,
    ids: ['experience.organisation'],
  },
  {
    pattern: /\b(what was your role|your (role|title|designation)|current (role|job|title)|most recent (role|job|title)|job title)\b/i,
    ids: ['experience.role'],
  },
  {
    pattern: /\b(what did you (do|build|achieve|work on)|your (achievement|accomplishment)|tell me about your work)\b/i,
    ids: ['experience.achievements', 'experience.summary'],
  },
  {
    pattern: /\b(technolog\w*|toolsknowledge|which (tools|technologies|languages|frameworks)|hands[- ]?on|stack)\b/i,
    ids: ['skills.technologies', 'skills.tools', 'skills.programmingLanguages', 'skills.frameworks', 'skills.databases', 'skills.cloud'],
  },
  {
    pattern: /\b(resume|cv|curriculum vitae)\b/i,
    ids: ['documents.resume', 'documents.cv'],
  },
  {
    pattern: /\b(cover[- ]?letter)\b/i,
    ids: ['documents.coverLetter'],
  },
  {
    pattern: /\b(transcript|mark ?sheet|academic record)\b/i,
    ids: ['documents.transcript'],
  },
  {
    pattern: /\b(certificate|certification)\b/i,
    ids: ['documents.certificate'],
  },
];

/**
 * Alias resolution: deterministic, obviously-safe shortcuts for speed.
 *
 * An alias is treated as a claim that the question and the stored fact mean the
 * same thing, so it is only honoured when the wording genuinely agrees. `exclude`
 * marks the cases where a shared keyword is misleading ("Company name" is not
 * the applicant's name); those questions fall through to scoring-based retrieval,
 * which is free to return nothing.
 */
export function aliasKnowledgeIds(question: string): string[] {
  const hits: string[] = [];
  for (const alias of EXACT_ALIASES) {
    if (alias.exclude?.test(question)) continue;
    if (alias.pattern.test(question)) hits.push(...alias.ids);
  }
  return [...new Set(hits)];
}

const KIND_PRIORITY: Record<KnowledgeItem['kind'], number> = {
  profile: 1,
  preference: 0.98,
  education: 1,
  skills: 1,
  experience: 1,
  project: 0.98,
  achievement: 0.94,
  memory: 1,
  document: 0.95,
};

/**
 * Scores one knowledge item against a question.
 *
 * Concept agreement carries the most weight (so "hands-on experience" finds
 * skills), then literal wording, then how many of the item's own tags the
 * question mentions. Broad tags alone are never enough to win.
 */
export function scoreKnowledgeItem(question: string, item: KnowledgeItem): number {
  const haystack = `${item.label} ${item.value} ${item.detail ?? ''}`;
  const lexical = semanticSimilarity(question, haystack);
  const concepts = conceptSimilarity(question, `${item.label} ${item.tags.join(' ')}`);

  const query = normalizeForMatch(question);
  const tags = item.tags.map((tag) => normalizeForMatch(tag)).filter((tag) => tag.length > 2);
  const hits = tags.filter((tag) => query.includes(tag)).length;
  const tagCoverage = tags.length ? Math.min(1, hits / Math.min(3, tags.length)) : 0;

  const valueOverlap = tokenize(question).some((token) => tokenize(item.value).includes(token)) ? 1 : 0;

  const base = lexical * 0.32 + concepts * 0.42 + tagCoverage * 0.18 + valueOverlap * 0.08;
  return clamp01(base * (KIND_PRIORITY[item.kind] ?? 0.95));
}

export interface RetrieveOptions {
  limit?: number;
  minScore?: number;
  /** Force-include these knowledge ids (alias matches). */
  includeIds?: string[];
  kindFilter?: KnowledgeItem['kind'][];
}

export function retrieveKnowledge(
  bundle: KnowledgeBundle,
  question: string,
  options: RetrieveOptions = {},
): RetrievedKnowledge {
  const limit = options.limit ?? 8;
  const minScore = options.minScore ?? 0.12;
  const includeIds = new Set(options.includeIds ?? []);
  const byId = new Map(bundle.items.map((item) => [item.id, item]));

  /**
   * Aliases are written as stable kinds (`experience.role`) so they do not depend
   * on the user's list ordering. Real ids look like `experience.<id>.role`, so an
   * alias resolves by kind + trailing key.
   */
  const resolveAlias = (id: string): KnowledgeItem[] => {
    const exact = byId.get(id);
    if (exact) return [exact];
    const parts = id.split('.');
    if (parts.length !== 2) return [];
    const [kind, key] = parts;
    return bundle.items.filter((item) => item.kind === kind && item.id.split('.').pop() === key);
  };

  const forced: KnowledgeItem[] = [];
  for (const id of includeIds) {
    for (const item of resolveAlias(id)) {
      if (options.kindFilter && !options.kindFilter.includes(item.kind)) continue;
      if (!forced.some((existing) => existing.id === item.id)) forced.push(item);
    }
  }

  const scored = bundle.items
    .filter((item) => !forced.some((f) => f.id === item.id))
    .filter((item) => !options.kindFilter || options.kindFilter.includes(item.kind))
    .map((item) => ({ item, score: scoreKnowledgeItem(question, item) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score);

  // Open-ended questions ("why do you want to work here?") match nothing by
  // design. Rather than sending the AI nothing, offer the user's substantive
  // material — their projects, roles and achievements — to draw on.
  const entityKinds: KnowledgeItem['kind'][] = ['project', 'experience', 'achievement'];
  const entityFallback = scored.length
    ? []
    : bundle.items
        .filter((item) => entityKinds.includes(item.kind))
        .filter((item) => item.kind === 'achievement' || /\.(details|summary)$/.test(item.id))
        .slice(0, 3);

  const selected = [...scored.map((entry) => entry.item), ...entityFallback];
  const items = [...forced, ...selected].slice(0, limit);
  const rankedScores = scored.slice(0, Math.max(1, items.length - forced.length)).map((entry) => entry.score);
  const score = rankedScores.length ? rankedScores.reduce((acc, value) => acc + value, 0) / rankedScores.length : 0;

  return { items, score, query: question };
}

/** Bundle-scoped helper for memory + user facts. */
export function bundleToPromptText(items: KnowledgeItem[], maxChars = 2400): string {
  const lines = items.map((item) => {
    const detail = item.detail ? ` (${item.detail})` : '';
    return `- [${item.id}] ${item.label}${detail}: ${item.value}`;
  });
  let out = lines.join('\n');
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n- (more profile details omitted)`;
  }
  return out;
}