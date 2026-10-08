/**
 * Interview reminders: a notification the day before an interview and another an hour before.
 * The decision (who is due, what to say) is plain functions so it can be tested; the worker
 * only supplies the clock, the saved interviews and the notification call.
 */

export const REMINDERS_KEY = 'fillie:reminders';
export const REMINDERS_SENT_KEY = 'fillie:reminders-sent';
export const REMINDER_ALARM = 'fillie:reminders';
export const NOTIFICATION_PREFIX = 'fillie-interview:';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface UpcomingInterview {
  id: string;
  company: string;
  role: string;
  resumeName?: string;
  /** Local date-time as typed, for example 2026-10-12T16:30. */
  interviewAt: string;
}

export type ReminderKind = 'day' | 'hour';

export interface Reminder {
  key: string;
  kind: ReminderKind;
  interview: UpcomingInterview;
  whenMs: number;
}

/** Reminder keys already sent, with the interview time they belong to (so old ones can be forgotten). */
export type SentMap = Record<string, number>;

/** Which reminders are due right now and have not been sent yet. */
export function dueReminders(upcoming: UpcomingInterview[], now: number, sent: SentMap): Reminder[] {
  const due: Reminder[] = [];
  for (const interview of upcoming) {
    const whenMs = new Date(interview.interviewAt).getTime();
    if (!Number.isFinite(whenMs)) continue;
    const diff = whenMs - now;
    // An interview that began up to 10 minutes ago still gets its "starting now" reminder.
    const kind: ReminderKind | null = diff >= -10 * MINUTE && diff <= HOUR ? 'hour' : diff > HOUR && diff <= 24 * HOUR ? 'day' : null;
    if (!kind) continue;
    const key = `${interview.id}|${interview.interviewAt}|${kind}`;
    if (key in sent) continue;
    due.push({ key, kind, interview, whenMs });
  }
  return due;
}

export function reminderText(reminder: Reminder, now: number): { title: string; message: string } {
  const { interview, whenMs } = reminder;
  const at = new Date(whenMs);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const role = interview.role || (interview.resumeName ? `(${interview.resumeName})` : '');
  const minutes = Math.round((whenMs - now) / MINUTE);
  const title =
    reminder.kind === 'hour'
      ? minutes <= 1
        ? `Interview starting now · ${interview.company}`
        : `Interview in ${minutes} minutes · ${interview.company}`
      : `Interview ${at.getDate() === new Date(now).getDate() ? 'today' : 'tomorrow'} at ${time} · ${interview.company}`;
  return { title, message: [role, reminder.kind === 'hour' ? time : at.toLocaleDateString(undefined, { weekday: 'long' })].filter(Boolean).join(' · ') || 'Good luck!' };
}

export interface ReminderDeps {
  enabled(): Promise<boolean>;
  upcoming(): Promise<UpcomingInterview[]>;
  readSent(): Promise<SentMap>;
  writeSent(sent: SentMap): Promise<void>;
  notify(id: string, title: string, message: string): void;
  now?: () => number;
}

/** One pass: send what is due, remember it, forget what is long past. Returns how many were sent. */
export async function checkReminders(deps: ReminderDeps): Promise<number> {
  if (!(await deps.enabled())) return 0;
  const now = (deps.now ?? Date.now)();
  const sent = await deps.readSent();
  const due = dueReminders(await deps.upcoming(), now, sent);
  for (const reminder of due) {
    const { title, message } = reminderText(reminder, now);
    deps.notify(`${NOTIFICATION_PREFIX}${reminder.interview.id}`, title, message);
    sent[reminder.key] = reminder.whenMs;
  }
  const kept: SentMap = {};
  for (const [key, whenMs] of Object.entries(sent)) if (whenMs > now - 2 * 24 * HOUR) kept[key] = whenMs;
  if (due.length || Object.keys(kept).length !== Object.keys(sent).length) await deps.writeSent(kept);
  return due.length;
}
