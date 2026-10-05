/**
 * Fillie — shared domain types.
 *
 * These types form the contract between the content scanner, the reasoning
 * engine, the AI provider layer, storage and the UI. Nothing in here is
 * UI-specific so the engine stays testable in isolation.
 */

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'date'
  | 'number'
  | 'email'
  | 'tel'
  | 'url'
  | 'custom'
  | 'unknown';

export type FieldSource = 'native' | 'google-forms' | 'custom';

/** A single answerable control discovered on a page. */
export interface DetectedField {
  /** Stable identifier for this field within a page session. */
  id: string;
  kind: FieldKind;
  /** Best available human label / question text. */
  label: string;
  /** Supporting text: placeholder, aria help, hint, unit suffix. */
  hint?: string;
  /** Section heading / surrounding context. */
  context?: string;
  /** Options for select, radio group and checkbox group controls. */
  options?: string[];
  /** Index of this field inside its option group (radio/checkbox). */
  optionIndex?: number;
  required: boolean;
  disabled: boolean;
  visible: boolean;
  /** How the control was discovered — lets us apply site specific handling. */
  source: FieldSource;
  /** Coarse numeric hints used for formatting (e.g. expected digits). */
  maxLength?: number;
  inputMode?: string;
  /** True when this control cannot be filled safely (file inputs, etc.). */
  manualOnly?: boolean;
  /**
   * True for passwords, one-time codes and payment fields. The scanner detects
   * these from the control type as well as the label, so a field whose label
   * happens to be innocuous is still refused.
   */
  sensitive?: boolean;
  /** True when the control looks like a "I agree to terms" style ack. */
  acknowledgement?: boolean;
  /** Short stable fingerprint of the question text, used for memory lookups. */
  fingerprint: string;
}

/** A page-level description of a form, produced by the scanner. */
export interface ScanResult {
  url: string;
  title: string;
  fields: DetectedField[];
  /** Text extracted from the page that may describe the application. */
  pageText: string;
  formCount: number;
  scannedAt: number;
}

export interface ApplicationContext {
  url: string;
  host: string;
  pageTitle: string;
  company?: string;
  role?: string;
  location?: string;
  department?: string;
  /** Extracted job description text (trimmed + summarised when long). */
  jobDescription?: string;
  formTitle?: string;
  detectedAt: number;
}

export type ProfileSection =
  | 'personal'
  | 'education'
  | 'skills'
  | 'experience'
  | 'projects'
  | 'achievements'
  | 'links'
  | 'documents'
  | 'preferences';

export type AnswerSource =
  | 'profile'
  | 'memory'
  | 'generated'
  | 'user'
  | 'deterministic'
  | 'manual';

export type FieldPlanStatus =
  | 'ready'
  | 'needs-attention'
  | 'review'
  | 'skipped'
  | 'manual';

export type AnswerValue = string | string[] | boolean | null | Record<string, unknown>;

export interface KnowledgeRef {
  /** Dotted path into the knowledge bundle, e.g. "profile.personal.email". */
  id: string;
  /** Short human label, e.g. "Email". */
  label: string;
  kind: 'profile' | 'experience' | 'project' | 'achievement' | 'education' | 'skills' | 'preference' | 'memory' | 'document';
  /** Where in the user's profile the value came from. */
  path?: string;
}

export interface InterviewOption {
  label: string;
  value: string;
  /** Optional knowledge reference backing this option. */
  ref?: KnowledgeRef;
}

export interface InterviewQuestion {
  id: string;
  label: string;
  help?: string;
  type: 'choice' | 'text' | 'longtext' | 'number';
  options?: InterviewOption[];
  placeholder?: string;
  required: boolean;
}

export interface InterviewSpec {
  /** Short explanation of what is missing. */
  reason: string;
  questions: InterviewQuestion[];
}

export interface FieldPlan {
  field: DetectedField;
  status: FieldPlanStatus;
  source?: AnswerSource;
  answer?: AnswerValue;
  /** 0..1 — combined score from retrieval, AI, lexical evidence and grounding. */
  confidence: number;
  /** Short, user-facing explanation of the answer or why it is unresolved. */
  reason?: string;
  sources: KnowledgeRef[];
  interview?: InterviewSpec;
  /** Set when the engine could not produce something safe to write. */
  blockedReason?: string;
  /** Filled/verified results are written back here by the content runtime. */
  fillResult?: FillVerification;
}

export interface FillVerification {
  filled: boolean;
  verified: boolean;
  error?: string;
  method?: string;
}

export interface SessionStats {
  total: number;
  filledFromProfile: number;
  filledFromMemory: number;
  generated: number;
  fromUser: number;
  needsAttention: number;
  skipped: number;
  manual: number;
  verified: number;
}

export interface FormSession {
  id: string;
  url: string;
  startedAt: number;
  updatedAt: number;
  context: ApplicationContext;
  plans: FieldPlan[];
  stats: SessionStats;
  aiCalls: number;
  memoryHits: number;
  status: 'scanning' | 'analysing' | 'reviewing' | 'ready' | 'failed';
}

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

export interface PersonalProfile {
  fullName: string;
  firstName?: string;
  lastName?: string;
  email: string;
  phone: string;
  phoneCountryCode?: string;
  phoneNumber?: string;
  phoneExtension?: string;
  location: string;
  address: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  dateOfBirth: string;
  nationality: string;
  gender?: string;
  languages: string[];
}

export interface EducationSchoolItem {
  id: string;
  level: string;
  schoolName: string;
  board?: string;
  stream?: string;
  year?: string;
  percentage?: string;
}

export interface EducationProfile {
  university: string;
  college?: string;
  degree: string;
  branch?: string;
  specialization?: string;
  graduationYear?: string;
  currentSemester?: string;
  cgpa?: string;
  percentage?: string;
  schoolName?: string;
  board?: string;
  twelfthSchool?: string;
  twelfthBoard?: string;
  twelfthStream?: string;
  twelfthYear?: string;
  twelfthPercentage?: string;
  tenthSchool?: string;
  tenthBoard?: string;
  tenthYear?: string;
  tenthPercentage?: string;
  schools?: EducationSchoolItem[];
  coursework: string[];
}

export interface ExperienceItem {
  id: string;
  type: 'internship' | 'job' | 'volunteer' | 'other';
  organisation: string;
  role: string;
  location?: string;
  startDate: string;
  endDate: string;
  responsibilities: string[];
  achievements: string[];
}

export interface ProjectItem {
  id: string;
  name: string;
  description: string;
  problem?: string;
  solution?: string;
  technologies: string[];
  contribution?: string;
  challenges?: string;
  results?: string;
  metrics?: string;
  github?: string;
  demo?: string;
  teamSize?: string;
  leadership?: string;
}

export interface AchievementItem {
  id: string;
  type: 'hackathon' | 'award' | 'certification' | 'competition' | 'ranking' | 'publication';
  title: string;
  organisation?: string;
  date?: string;
  detail?: string;
  credentialId?: string;
  url?: string;
}

export interface SkillsProfile {
  programmingLanguages: string[];
  frameworks: string[];
  databases: string[];
  cloud: string[];
  tools: string[];
  technologies: string[];
  softSkills: string[];
}

export interface LinksProfile {
  linkedin: string;
  github: string;
  portfolio: string;
  website?: string;
  other: string[];
}

export interface PreferencesProfile {
  willingToRelocate: string;
  preferredLocations: string[];
  workMode: string;
  availability: string;
  noticePeriod: string;
  salaryExpectation: string;
  currency?: string;
  notes?: string;
}

export interface DocumentItem {
  id: string;
  name: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  keywords: string[];
  category?: 'resume' | 'cover-letter' | 'transcript' | 'certificate' | 'id' | 'other';
  dataUrl?: string;
  textContent?: string;
  isDefault?: boolean;
  updatedAt: number;
}

export interface UserProfile {
  personal: PersonalProfile;
  education: EducationProfile;
  skills: SkillsProfile;
  experience: ExperienceItem[];
  projects: ProjectItem[];
  achievements: AchievementItem[];
  links: LinksProfile;
  documents?: DocumentItem[];
  preferences: PreferencesProfile;
  updatedAt: number;
  version: number;
}

/**
 * Recursively optional. Resume extraction genuinely produces partial sections
 * (`{ personal: { email } }`), and typing that as `Partial<UserProfile>` would
 * force every caller to restate a full section it does not have.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** A named plain-text resume, e.g. "Frontend" or "Data science". */
export interface ResumeVariant {
  id: string;
  /** The tag the user gave it; also used to match it against a job description. */
  name: string;
  text: string;
  updatedAt: number;
}

export interface ResumesState {
  resumes: ResumeVariant[];
  /** Used when the user is not asked, or skips the picker. */
  defaultId: string;
}

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

export interface LearnedAnswer {
  id: string;
  /** The original question text as seen on a form. */
  question: string;
  /** Normalised semantic intent produced by the engine / AI. */
  intent: string;
  answer: string;
  /** Knowledge references the answer was built from. */
  sources: KnowledgeRef[];
  /** Extra facts the user supplied during the interview. */
  userFacts: UserProvidedFact[];
  context: {
    company?: string;
    role?: string;
    host?: string;
    /** True when the answer is generic enough to reuse anywhere. */
    isGeneric: boolean;
  };
  createdAt: number;
  updatedAt: number;
  useCount: number;
  /** Embedding-free semantic fingerprint of the question + intent. */
  signature: string;
}

export interface UserProvidedFact {
  id: string;
  key: string;
  value: string;
}

/* ------------------------------------------------------------------ */
/* AI layer                                                            */
/* ------------------------------------------------------------------ */

export type AIProviderId =
  | 'groq'
  | 'gemini'
  | 'openrouter'
  | 'together'
  | 'cerebras'
  | 'openai-compatible'
  | 'offline';

export interface AIProviderConfig {
  provider: AIProviderId;
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Optional JSON mode toggle for providers that support it. */
  jsonMode: boolean;
  /** Remembered API keys per provider, so switching providers retains individual keys. */
  apiKeys?: Partial<Record<AIProviderId, string>>;
}

export interface AISettings {
  enabled: boolean;
  config: AIProviderConfig;
  /** How many questions are sent per request. */
  batchSize: number;
  /** Max retries with exponential backoff on 429/5xx/timeouts. */
  maxRetries: number;
  /** Minimum confidence before an AI answer is filled automatically. */
  autoFillThreshold: number;
  /** Confidence at or above which a field is marked "review". */
  reviewThreshold: number;
  /** Surfaces per-field reasoning on the Advanced screen. */
  debug: boolean;
  /**
   * Providers in the order Fillie tries them. A provider with no key is
   * skipped; when one runs out of quota Fillie moves to the next.
   */
  providerOrder: AIProviderId[];
  /** Model chosen for each provider (defaults come from the preset). */
  providerModels: Partial<Record<AIProviderId, string>>;
  /** Endpoint per provider; only the custom provider needs one. */
  providerBaseUrls: Partial<Record<AIProviderId, string>>;
}

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIRequest {
  messages: AIChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
  /** Idempotency key used for response caching. */
  cacheKey?: string;
}

export interface AIResponse {
  /** Short name of the platform that answered, e.g. "Gemini". */
  providerLabel?: string;
  text: string;
  model: string;
  provider: AIProviderId;
  cached: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AIProvider {
  readonly id: AIProviderId;
  readonly label: string;
  /** True when the provider needs an API key before it can be used. */
  readonly requiresKey: boolean;
  complete(request: AIRequest): Promise<AIResponse>;
  /** Optional health probe used by the settings screen. */
  testConnection?(): Promise<{ ok: boolean; message: string; model?: string }>;
}

export class AIError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'auth'
      | 'rate-limit'
      | 'timeout'
      | 'network'
      | 'bad-response'
      | 'not-configured'
      | 'aborted'
      | 'server',
    readonly retryable = false,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AIError';
  }
}

/* ------------------------------------------------------------------ */
/* Knowledge bundle passed to the AI                                   */
/* ------------------------------------------------------------------ */

export interface KnowledgeItem {
  id: string;
  kind: KnowledgeRef['kind'];
  label: string;
  value: string;
  /** Extra detail for generative answers. */
  detail?: string;
  /** Tags used for retrieval scoring. */
  tags: string[];
  docRef?: {
    id: string;
    name: string;
    fileName: string;
    fileType: string;
    dataUrl?: string;
    isDefault?: boolean;
  };
}

export interface KnowledgeBundle {
  items: KnowledgeItem[];
  /** Facts the user entered during this session's interview. */
  userFacts: UserProvidedFact[];
  /**
   * Plain-text resume the user pasted in the Resume tab. Kept off `items` so
   * retrieval and the offline resolver never copy a whole resume into a field;
   * it feeds the AI prompt and the grounding check only.
   */
  resumeText?: string;
}