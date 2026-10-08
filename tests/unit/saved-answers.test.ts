import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Storage } from '../../src/core/storage';
import { CloudClient } from '../../src/core/cloud/client';
import { ApplicationStore } from '../../src/core/cloud/applications';
import { MAX_SAVED_ANSWERS, normalizeSavedAnswers, savedAnswerId, withSavedAnswer, withoutSavedAnswer } from '../../src/core/cloud/saved-answers';
import { cleanTour, markManySeen, markSeen, markWelcomeDone, readTour, resetTour, shouldShow, tourAllowed } from '../../src/core/tour';
import { placeCard } from '../../src/ui/tour';
import { FillieOverlay, heartBurst } from '../../src/content/overlay';
import { toNode } from '../../src/ui/dom';
import { databaseView, prepModal } from '../../src/pages/views/database';
import { tipKeyFor, welcomeSteps, SECTION_TIPS } from '../../src/pages/tour-steps';
import type { FieldPlan } from '../../src/core/types';
import type { Application } from '../../src/core/cloud/types';

describe('saved answers', () => {
  it('gives the same question the same id, whatever its case and spacing', () => {
    expect(savedAnswerId('Why do  you want to join us?')).toBe(savedAnswerId(' why do you want to join us? '));
    expect(savedAnswerId('Why us?')).not.toBe(savedAnswerId('Why now?'));
  });

  it('cleans a list: drops blanks and repeats, keeps paragraphs, limits the size', () => {
    const list = normalizeSavedAnswers([
      { question: ' Why us? ', answer: 'Line one\n\n\n\nLine two', savedAt: 5 },
      { question: 'why us?', answer: 'duplicate', savedAt: 6 },
      { question: '', answer: 'no question' },
      { question: 'No answer', answer: '   ' },
      null,
      'junk',
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ question: 'Why us?', answer: 'Line one\n\nLine two', savedAt: 5 });
    expect(normalizeSavedAnswers('nope')).toEqual([]);
    const many = normalizeSavedAnswers(Array.from({ length: 120 }, (_, i) => ({ question: `Q${i}`, answer: 'a', savedAt: i })));
    expect(many).toHaveLength(MAX_SAVED_ANSWERS);
    expect(many.at(-1)!.question).toBe('Q119');
  });

  it('hearting the same question again replaces the answer, and un-hearting removes it', () => {
    let list = withSavedAnswer([], 'Why us?', 'First draft', 1);
    list = withSavedAnswer(list, 'Why us?', 'Better answer', 2);
    expect(list).toEqual([{ id: savedAnswerId('Why us?'), question: 'Why us?', answer: 'Better answer', savedAt: 2 }]);
    expect(withoutSavedAnswer(list, 'why us?')).toEqual([]);
  });
});

describe('saved answers on applications', () => {
  const store = () => {
    const storage = new Storage();
    return new ApplicationStore(storage, new CloudClient(storage, { config: { supabaseUrl: 'https://p.supabase.co', anonKey: 'k', freeFillsPerWeek: 3, priceLabel: '$5', priceInrLabel: '₹449', pageSize: 100 }, fetchImpl: async () => new Response('{}', { status: 401 }) }));
  };

  it('keeps hearted answers with the application and finds them again for the same page', async () => {
    const apps = store();
    const { app } = await apps.track({ company: 'Razorpay', role: 'SDE', url: 'https://jobs.example.com/razorpay/sde' });
    const saved = await apps.setSavedAnswer(app.id, 'Why Razorpay?', 'Because of payments.', true);
    expect(saved?.savedAnswers).toHaveLength(1);
    const again = await apps.savedAnswersFor({ company: 'Razorpay', role: 'SDE', url: 'https://jobs.example.com/razorpay/sde?utm_source=x' });
    expect(again.map((a) => a.question)).toEqual(['Why Razorpay?']);
    await apps.setSavedAnswer(app.id, 'Why Razorpay?', '', false);
    expect(await apps.savedAnswersFor({ company: 'Razorpay', role: 'SDE', url: 'https://jobs.example.com/razorpay/sde' })).toEqual([]);
  });

  it('does nothing for an application that is not there', async () => {
    expect(await store().setSavedAnswer('nope', 'Q', 'A', true)).toBeUndefined();
  });
});

describe('tour memory', () => {
  const memory = () => {
    const data: Record<string, unknown> = {};
    return { get: async (key: string) => ({ [key]: data[key] }), set: async (items: Record<string, unknown>) => void Object.assign(data, items), data };
  };

  it('starts empty and remembers each part once', async () => {
    const area = memory();
    expect(await readTour(area)).toEqual({ welcome: false, seen: {} });
    await markWelcomeDone(area);
    await markSeen('database', area);
    await markManySeen(['ai', 'account'], area);
    expect(await readTour(area)).toEqual({ welcome: true, seen: { database: true, ai: true, account: true } });
    await resetTour(area);
    expect(await readTour(area)).toEqual({ welcome: false, seen: {} });
  });

  it('ignores damaged saved state', () => {
    expect(cleanTour({ welcome: 'yes', seen: { ok: true, 'BAD KEY': true, x: 'no' } })).toEqual({ welcome: false, seen: { ok: true } });
    expect(cleanTour(null)).toEqual({ welcome: false, seen: {} });
  });

  it('stays out of the way of automated browsers unless asked', () => {
    expect(tourAllowed({ welcome: false, seen: {} }, true)).toBe(false);
    expect(tourAllowed({ welcome: false, seen: {}, force: true }, true)).toBe(true);
    expect(tourAllowed({ welcome: false, seen: {} }, false)).toBe(true);
    expect(shouldShow({ welcome: true, seen: { ai: true } }, 'ai', false)).toBe(false);
    expect(shouldShow({ welcome: true, seen: {} }, 'ai', false)).toBe(true);
  });
});

describe('tour layout and content', () => {
  const view = { width: 1280, height: 800 };
  const card = { width: 328, height: 260 };

  it('puts the card beside the highlighted part, below it when there is no room, and in the middle without one', () => {
    expect(placeCard({ left: 10, top: 100, width: 200, height: 30 }, card, view)).toEqual({ left: 226, top: 12 }); // as high as the screen allows
    const low = placeCard({ left: 1000, top: 100, width: 270, height: 30 }, card, view);
    expect(low.top).toBe(146); // below, since the right side is too narrow
    expect(low.left + card.width).toBeLessThanOrEqual(view.width - 12);
    expect(placeCard(null, card, view)).toEqual({ left: 476, top: 270 });
    expect(placeCard(null, card, view, true)).toEqual({ left: 1280 - 328 - 20, top: 800 - 260 - 20 });
  });

  it('keeps the card inside the screen', () => {
    const pos = placeCard({ left: 10, top: 760, width: 200, height: 30 }, card, view);
    expect(pos.top + card.height).toBeLessThanOrEqual(view.height - 12);
  });

  it('walks through every important part in short words, with a picture or a heart on each step', () => {
    const steps = welcomeSteps();
    expect(steps.map((s) => s.id)).toEqual(['hello', 'profile', 'resumes', 'ai', 'fill', 'heart', 'database', 'reminders', 'account', 'done']);
    for (const step of steps) {
      expect(Boolean(step.art) || step.demo === 'heart', step.id).toBe(true);
      expect(step.title.length, step.id).toBeLessThanOrEqual(30);
      expect(step.text.length, step.id).toBeLessThanOrEqual(90);
    }
    expect(steps.find((s) => s.id === 'fill')!.keys).toEqual(['Alt', 'Shift', 'F']);
    expect(steps.find((s) => s.id === 'heart')!.demo).toBe('heart');
  });

  it('has a one-time tip for each section and maps pages to them', () => {
    expect(Object.keys(SECTION_TIPS).sort()).toEqual(['account', 'ai', 'database', 'memory', 'privacy', 'profile', 'resume']);
    expect(tipKeyFor({ kind: 'database' })).toBe('database');
    expect(tipKeyFor({ kind: 'settings', section: 'ai' })).toBe('ai');
    expect(tipKeyFor({ kind: 'settings', section: 'appearance' })).toBeUndefined();
    expect(tipKeyFor({ kind: 'profile', section: 'skills' })).toBe('profile');
  });
});

const app = (over: Partial<Application> = {}): Application => ({
  id: 'a1', company: 'Razorpay', role: 'SDE I', status: 'applied', interviewAt: null, offerLpa: null, appliedAt: '2026-10-01', notes: ['Remote friendly'], rating: null, ratingSource: null,
  url: '', host: '', resumeName: '', offeredCtc: '', updatedAt: 1, savedAnswers: [], ...over,
});

describe('Interview prep on the Database page', () => {
  it('puts a highlighted button with a count on every application', () => {
    const state = { rows: [app(), app({ id: 'a2', company: 'Zoho', savedAnswers: [{ id: 'q1', question: 'Why us?', answer: 'Because', savedAt: 1 }] })], hasMore: false, loading: false, loaded: true, localOnly: false, signedIn: true, search: '', status: 'all' as const };
    const page = toNode(databaseView(state));
    const buttons = [...page.querySelectorAll<HTMLElement>('[data-action="open-prep"]')];
    expect(buttons.map((b) => b.dataset.count)).toEqual(['0', '2'.replace('2', '1')]);
    expect(buttons[1]!.textContent).toContain('Interview prep');
    expect(buttons[1]!.dataset.id).toBe('a2');
    expect(page.querySelectorAll('.tag-note')).toHaveLength(2); // the AI notes are still there next to it
  });

  it('lists the questions, opens one to show its answer, and offers copy and remove', () => {
    const saved = [{ id: 'q1', question: 'Why Razorpay?', answer: 'Payments are fun.\nSecond line.', savedAt: 1 }, { id: 'q2', question: 'Notice period?', answer: '30 days', savedAt: 2 }];
    const closed = toNode(prepModal(app({ savedAnswers: saved }), null));
    expect(closed.querySelectorAll('.prep-item')).toHaveLength(2);
    expect(closed.querySelectorAll('.prep-item[data-open="true"]')).toHaveLength(0);
    expect(closed.querySelector('.prep-lead')!.textContent).toBe('2 saved answers. Tap a question to read it.');
    const open = toNode(prepModal(app({ savedAnswers: saved }), 'q1'));
    const item = open.querySelector('.prep-item[data-open="true"]')!;
    expect(item.querySelector('.prep-qt')!.textContent).toBe('Why Razorpay?');
    expect(item.querySelector('.prep-q')!.getAttribute('aria-expanded')).toBe('true');
    expect(item.querySelector('.prep-a')!.textContent).toBe('Payments are fun.\nSecond line.');
    expect(item.querySelector('[data-action="copy-prep"]')).toBeTruthy();
    expect(item.querySelector('[data-action="remove-prep"]')).toBeTruthy();
  });

  it('explains how to save answers when there are none, and never injects markup from an answer', () => {
    expect(toNode(prepModal(app(), null)).textContent).toContain('tap the heart next to an answer');
    const hostile = toNode(prepModal(app({ savedAnswers: [{ id: 'q', question: '<img src=x onerror=alert(1)>', answer: '<script>alert(1)</script>', savedAt: 1 }] }), 'q'));
    expect(hostile.querySelector('img')).toBeNull();
    expect(hostile.querySelector('script')).toBeNull();
  });
});

describe('the heart on the page', () => {
  const plan = (id: string, label: string, answer: string, over: Partial<FieldPlan> = {}): FieldPlan => ({
    field: { id, label, kind: 'text', required: false } as FieldPlan['field'], status: 'ready', answer, confidence: 1, sources: [], ...over,
  });
  const stats = { total: 2, filled: 2, needsAttention: 0, skipped: 0, doubtful: 0, answered: 2, byKind: {} } as never;
  const shadow = () => document.querySelector<HTMLElement>('[data-fillie="ui"][data-fillie-panel="true"]')!.shadowRoot!;

  let overlay: FillieOverlay;
  const toggles: Array<[string, boolean]> = [];
  let seen = 0;
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    toggles.length = 0;
    seen = 0;
    overlay = new FillieOverlay({
      onStart() {}, onFillNow() {}, onOpenQuestion() {}, onBackFromResolve() {}, onGenerate() {}, onAccept() {}, onSkip() {}, onRegenerate() {}, onFocusField() {}, onOpenSettings() {}, onDismiss() {}, onMinimise() {},
      onToggleSaved: (p, saved) => void toggles.push([p.field.label, saved]),
      canSave: (p) => p.field.label !== 'Password',
      onHeartHintSeen: () => void (seen += 1),
    });
    overlay.mount();
  });
  afterEach(() => overlay.unmount());

  it('shows a heart next to each answer Fillie filled, but not on private fields', async () => {
    overlay.render({ kind: 'review', stats, plans: [plan('f1', 'Why us?', 'Because.'), plan('f2', 'Password', 'secret')] });
    await Promise.resolve();
    const hearts = shadow().querySelectorAll('.heart-btn');
    expect(hearts).toHaveLength(1);
    expect(hearts[0]!.getAttribute('aria-label')).toContain('Why us?');
    expect(hearts[0]!.getAttribute('aria-pressed')).toBe('false');
  });

  it('saves on click with a small burst of confetti, and lets go on a second click', async () => {
    overlay.render({ kind: 'review', stats, plans: [plan('f1', 'Why us?', 'Because.')] });
    await Promise.resolve();
    // The test DOM has no animations; a stand-in lets the burst run so its pieces can be counted.
    (Element.prototype as unknown as { animate: unknown }).animate = () => ({ onfinish: null });
    const heart = shadow().querySelector<HTMLButtonElement>('.heart-btn')!;
    heart.click();
    expect(toggles).toEqual([['Why us?', true]]);
    expect(heart.getAttribute('aria-pressed')).toBe('true');
    expect(heart.dataset.saved).toBe('true');
    expect(shadow().querySelectorAll('.heart-speck').length).toBeGreaterThan(5);
    heart.click();
    expect(toggles.at(-1)).toEqual(['Why us?', false]);
    expect(heart.getAttribute('aria-pressed')).toBe('false');
    delete (Element.prototype as unknown as { animate?: unknown }).animate;
  });

  it('shows hearts that were saved on an earlier visit', async () => {
    overlay.render({ kind: 'review', stats, plans: [plan('f1', 'Why us?', 'Because.')] });
    await Promise.resolve();
    overlay.setSavedIds([savedAnswerId('Why us?')]);
    await Promise.resolve();
    expect(shadow().querySelector('.heart-btn')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('explains the heart the first time, and stops once it has been used', async () => {
    overlay.setHeartHint(true);
    overlay.render({ kind: 'review', stats, plans: [plan('f1', 'Why us?', 'Because.')] });
    await Promise.resolve();
    expect(shadow().querySelector('.heart-tip')!.textContent).toContain('Tap the heart');
    expect(shadow().querySelector('.heart-btn')!.classList.contains('heart-nudge')).toBe(true);
    shadow().querySelector<HTMLButtonElement>('.heart-btn')!.click();
    expect(seen).toBe(1);
    expect(shadow().querySelector('.heart-tip')).toBeNull();
  });

  it('lists the filled answers with hearts on the ready screen too', async () => {
    overlay.render({ kind: 'success', stats, plans: [plan('f1', 'Why us?', 'Because.')] });
    await Promise.resolve();
    expect(shadow().querySelectorAll('.heart-btn')).toHaveLength(1);
  });

  it('makes no confetti for people who prefer reduced motion', () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null })) as typeof window.matchMedia;
    const anchor = document.createElement('span');
    anchor.animate = vi.fn() as never;
    heartBurst(anchor);
    expect(anchor.children).toHaveLength(0);
    window.matchMedia = original;
  });
});
