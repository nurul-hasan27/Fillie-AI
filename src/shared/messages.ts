import type { AccessState, Application, ApplicationStatus, OAuthProvider } from '../core/cloud/types';
import type {
  AIProviderId,
  AIProviderConfig,
  AISettings,
  AnswerValue,
  ApplicationContext,
  DetectedField,
  FieldPlan,
  KnowledgeRef,
  LearnedAnswer,
  ResumesState,
  SessionStats,
  UserProfile,
} from '../core/types';

/**
 * Message contract between the content script, popup, extension pages and the
 * service worker. The API key only ever exists inside the service worker.
 */

export interface PlanRequest {
  fields: DetectedField[];
  context: ApplicationContext;
  /** Resume chosen for this application; 'none' sends the profile only. */
  resumeId?: string;
  userFacts?: Array<{ id: string; key: string; value: string }>;
}

/** Which platform and model produced a response, for the "answered by" chip. */
export interface ServedBy {
  provider: AIProviderId;
  label: string;
  model: string;
  cached?: boolean;
}

export interface ResumeSuggestion {
  options: Array<{ id: string; name: string; preview: string; score: number }>;
  suggestedId: string;
}

export interface PlanResponse {
  servedBy?: ServedBy[];
  /** Platforms that were skipped (quota, bad key) before one answered. */
  switchedFrom?: string[];
  ok: boolean;
  plans?: FieldPlan[];
  stats?: SessionStats;
  aiCalls?: number;
  memoryHits?: number;
  problems?: string[];
  profileCompleteness?: number;
  aiEnabled?: boolean;
  error?: string;
}

export interface GenerateRequest {
  resumeId?: string;
  question: string;
  hint?: string;
  contextText?: string;
  field?: DetectedField;
  /** What the user supplied, plus the knowledge they explicitly chose. */
  notes: Array<{ label: string; answer: string; refId?: string }>;
  /** Knowledge items offered as choices, so refs can be resolved by id. */
  choices?: Array<{ value: string; refId?: string }>;
  context: ApplicationContext;
}

export interface GenerateResponse {
  servedBy?: ServedBy[];
  ok: boolean;
  answer?: string;
  confidence?: number;
  sources?: KnowledgeRef[];
  generic?: boolean;
  notes?: string[];
  usedAI?: boolean;
  problems?: string[];
  error?: string;
}

export interface RememberRequest {
  question: string;
  answer: string;
  intent?: string;
  sources?: KnowledgeRef[];
  context: ApplicationContext;
  generic?: boolean;
  facts?: Array<{ id: string; key: string; value: string }>;
  factMemory?: boolean;
}

/** Final field values captured when the user submits the page's form. */
export interface RememberBatchRequest {
  entries: Array<{ question: string; answer: string }>;
  context: ApplicationContext;
}

export interface DeviceHashes {
  hw: string;
  br: string;
}

export interface AccountStatus {
  cloudConfigured: boolean;
  access: AccessState;
  /** Applications saved on this device, waiting to upload. */
  pendingApplications: number;
  priceLabel: string;
  lastBackupAt?: number;
}

export interface ApplicationsRequest {
  offset?: number;
  search?: string;
  status?: ApplicationStatus | 'all';
}

export interface StatusResponse {
  access?: AccessState;
  hasProfile: boolean;
  profileCompleteness: number;
  aiConfigured: boolean;
  aiEnabled: boolean;
  provider: string;
  model: string;
  memoryCount: number;
  lastSession?: {
    url: string;
    host: string;
    at: number;
    stats: SessionStats;
  };
  debug: boolean;
  /** Lifetime usage counters, for the Advanced screen. */
  stats: {
    sessions: number;
    fieldsFilled: number;
    aiCalls: number;
    cacheHits: number;
  };
}

export interface FieldReport {
  id: string;
  answer: AnswerValue | null;
  source?: FieldPlan['source'];
  context?: ApplicationContext;
}

export type BackgroundMessage =
  | { type: 'fillie:get-status' }
  | { type: 'fillie:plan'; payload: PlanRequest }
  | { type: 'fillie:generate'; payload: GenerateRequest }
  | { type: 'fillie:remember'; payload: RememberRequest }
  | { type: 'fillie:get-profile' }
  | { type: 'fillie:save-profile'; profile: UserProfile }
  | { type: 'fillie:get-settings' }
  | { type: 'fillie:save-settings'; settings: AISettings }
  | { type: 'fillie:test-connection'; config?: AIProviderConfig }
  | { type: 'fillie:get-resumes' }
  | { type: 'fillie:save-resumes'; state: ResumesState }
  | { type: 'fillie:suggest-resume'; context: ApplicationContext }
  | { type: 'fillie:remember-batch'; payload: RememberBatchRequest }
  | { type: 'fillie:account-status'; device: DeviceHashes }
  | { type: 'fillie:begin-run'; url: string; device: DeviceHashes }
  | { type: 'fillie:sign-in'; mode: 'signin' | 'signup'; email: string; password: string }
  | { type: 'fillie:sign-in-oauth'; provider: OAuthProvider }
  | { type: 'fillie:sign-out' }
  | { type: 'fillie:checkout' }
  | { type: 'fillie:open-account' }
  | { type: 'fillie:refresh-payment'; device: DeviceHashes }
  | { type: 'fillie:backup-now' }
  | { type: 'fillie:restore-now' }
  | { type: 'fillie:apps-list'; query: ApplicationsRequest }
  | { type: 'fillie:apps-save'; app: Application }
  | { type: 'fillie:apps-delete'; id: string }
  | { type: 'fillie:apps-track'; context: ApplicationContext }
  | { type: 'fillie:get-memory' }
  | { type: 'fillie:save-memory'; memory: LearnedAnswer[] }
  | { type: 'fillie:report-session'; url: string; stats: SessionStats; aiCalls?: number }
  | { type: 'fillie:clear-cache' }
  | { type: 'fillie:explain'; payload: { fields: DetectedField[]; context: ApplicationContext } };

export type ContentMessage =
  | { type: 'fillie:run' }
  | { type: 'fillie:toggle' }
  | { type: 'fillie:ping' }
  | { type: 'fillie:highlight'; fieldId: string; state: 'filled' | 'attention' | 'error' };

export interface ContentPingResponse {
  ok: boolean;
  version: string;
  url: string;
}

export function sendMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const chromeApi = (globalThis as { chrome?: typeof chrome }).chrome;
    if (!chromeApi?.runtime?.sendMessage) {
      reject(new Error('Extension messaging is unavailable in this context.'));
      return;
    }
    chromeApi.runtime.sendMessage(message, (response) => {
      const lastError = chromeApi.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message ?? 'Message failed.'));
        return;
      }
      resolve(response as T);
    });
  });
}