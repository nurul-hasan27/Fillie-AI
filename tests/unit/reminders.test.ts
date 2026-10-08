// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { checkReminders, dueReminders, reminderText, type ReminderDeps, type SentMap, type UpcomingInterview } from '../../src/background/reminders';

const MIN = 60_000;
const at = (offsetMinutes: number, now: number) => {
  const d = new Date(now + offsetMinutes * MIN);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const NOW = new Date(2026, 9, 10, 9, 0, 0).getTime();
const interview = (id: string, offsetMinutes: number): UpcomingInterview => ({ id, company: `Co ${id}`, role: 'Engineer', interviewAt: at(offsetMinutes, NOW) });

describe('which reminders are due', () => {
  it('sends a day reminder inside the last 24 hours and an hour reminder inside the last hour', () => {
    const due = dueReminders([interview('far', 3 * 24 * 60), interview('day', 20 * 60), interview('hour', 45), interview('now', -5), interview('over', -30)], NOW, {});
    expect(due.map((d) => `${d.interview.id}:${d.kind}`)).toEqual(['day:day', 'hour:hour', 'now:hour']);
  });

  it('never sends the same reminder twice, but still sends the later hour reminder after a day reminder', () => {
    const upcoming = [interview('a', 20 * 60)];
    const first = dueReminders(upcoming, NOW, {});
    expect(first).toHaveLength(1);
    const sent: SentMap = { [first[0]!.key]: first[0]!.whenMs };
    expect(dueReminders(upcoming, NOW, sent)).toEqual([]);
    expect(dueReminders(upcoming, NOW + 19 * 60 * MIN + 30 * MIN, sent).map((d) => d.kind)).toEqual(['hour']);
  });

  it('ignores an unreadable date', () => {
    expect(dueReminders([{ id: 'x', company: 'X', role: '', interviewAt: 'soon' }], NOW, {})).toEqual([]);
  });

  it('words the notification for tomorrow, in an hour and starting now', () => {
    const [tomorrow] = dueReminders([{ ...interview('t', 20 * 60), role: '', resumeName: 'Frontend' }], NOW, {});
    expect(reminderText(tomorrow!, NOW).title).toMatch(/^Interview tomorrow at .* · Co t$/);
    expect(reminderText(tomorrow!, NOW).message).toContain('(Frontend)');
    const [soon] = dueReminders([interview('s', 45)], NOW, {});
    expect(reminderText(soon!, NOW)).toMatchObject({ title: 'Interview in 45 minutes · Co s' });
    const [started] = dueReminders([interview('n', -5)], NOW, {});
    expect(reminderText(started!, NOW).title).toBe('Interview starting now · Co n');
  });
});

function deps(over: { upcoming?: UpcomingInterview[]; sent?: SentMap; on?: boolean } = {}) {
  let sent: SentMap = over.sent ?? {};
  const notify = vi.fn();
  const writes: SentMap[] = [];
  const d: ReminderDeps = {
    enabled: async () => over.on ?? true,
    upcoming: async () => over.upcoming ?? [],
    readSent: async () => ({ ...sent }),
    writeSent: async (next) => { sent = next; writes.push(next); },
    notify,
    now: () => NOW,
  };
  return { d, notify, writes, get sent() { return sent; } };
}

describe('checkReminders', () => {
  it('notifies once, remembers it, and stays quiet on the next pass', async () => {
    const run = deps({ upcoming: [interview('a', 45), interview('b', 20 * 60)] });
    expect(await checkReminders(run.d)).toBe(2);
    expect(run.notify).toHaveBeenCalledTimes(2);
    expect(run.notify.mock.calls[0]![0]).toBe('fillie-interview:a');
    expect(await checkReminders(run.d)).toBe(0);
    expect(run.notify).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the reminders are switched off', async () => {
    const run = deps({ upcoming: [interview('a', 45)], on: false });
    expect(await checkReminders(run.d)).toBe(0);
    expect(run.notify).not.toHaveBeenCalled();
    expect(run.writes).toEqual([]);
  });

  it('forgets reminders for interviews that are long past', async () => {
    const run = deps({ sent: { 'old|x|hour': NOW - 5 * 24 * 60 * MIN, 'new|y|day': NOW + 60 * MIN } });
    await checkReminders(run.d);
    expect(Object.keys(run.sent)).toEqual(['new|y|day']);
  });
});
