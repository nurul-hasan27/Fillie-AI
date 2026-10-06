export interface CloudUser {
  id: string;
  email: string;
  provider?: string;
}

export interface CloudSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  user: CloudUser;
}

export type OAuthProvider = 'google' | 'github' | 'apple';

export type ApplicationStatus = 'applied' | 'interview' | 'offer' | 'rejected';

export const APPLICATION_STATUSES: ApplicationStatus[] = ['applied', 'interview', 'offer', 'rejected'];

export interface Application {
  id: string;
  company: string;
  role: string;
  status: ApplicationStatus;
  /** ISO date-time of the scheduled interview, when status is "interview". */
  interviewAt: string | null;
  /** Offered package in lakhs per annum, when status is "offer". */
  offerLpa: number | null;
  /** ISO date (YYYY-MM-DD). */
  appliedAt: string;
  /** Short bullet points, e.g. "2 year bond". */
  notes: string[];
  /** 1-5, or null when unknown. The user always has the last word. */
  rating: number | null;
  ratingSource: 'ai' | 'user' | null;
  url: string;
  host: string;
  /** Name of the resume used to fill the form; shown when the role could not be read. */
  resumeName: string;
  updatedAt: number;
}

export interface AccessState {
  allowed: boolean;
  plan: 'paid' | 'trial';
  /** Free fills left this week (trial only). */
  remaining: number;
  limit: number;
  signedIn: boolean;
  email?: string;
  /** Why access was refused, or a note such as "offline". */
  reason?: string;
}

export interface DeviceSignals {
  /** Random id created at install time. */
  install: string;
  /** Hash of hardware-level traits; the same across browsers on one machine. */
  hw: string;
  /** Hash of browser-level traits. */
  br: string;
}
