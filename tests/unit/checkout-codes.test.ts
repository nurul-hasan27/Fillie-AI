import { describe, expect, it } from 'vitest';
import { accountView, type AccountState } from '../../src/pages/views/account';
import { toNode } from '../../src/ui/dom';
import { formatMoney, percentLabel, readQuote, rejectionNote, type QuoteSet } from '../../src/core/cloud/money';
import { createPieces, stepPiece, CONFETTI_COLORS, celebrate } from '../../src/ui/confetti';
import type { AccountStatus } from '../../src/shared/messages';

const order = (currency: 'INR' | 'USD', list: number, promoOff: number, offerOff: number) => ({ currency, listMinor: list, promoOffMinor: promoOff, offerOffMinor: offerOff, finalMinor: list - promoOff - offerOff });
const quotes: QuoteSet = {
  INR: { order: order('INR', 44900, 4490, 2021), applied: [{ kind: 'promo', code: 'ASHA10', discount_bps: 1000, title: 'Creator code · Asha' }, { kind: 'offer', code: 'DIWALI5', discount_bps: 500, title: 'Diwali sale' }], rejected: [] },
  USD: { order: order('USD', 500, 50, 23), applied: [{ kind: 'promo', code: 'ASHA10', discount_bps: 1000, title: 'Creator code · Asha' }, { kind: 'offer', code: 'DIWALI5', discount_bps: 500, title: 'Diwali sale' }], rejected: [] },
};
const status = (plan: 'trial' | 'paid' = 'trial'): AccountStatus => ({
  cloudConfigured: true, pendingApplications: 0, priceLabel: '$5 one-time', priceInrLabel: '₹449', shareOffers: false,
  access: { allowed: true, plan, remaining: 2, limit: 3, signedIn: true, email: 'priya@example.com' },
});
const state = (over: Partial<AccountState> = {}): AccountState => ({ status: status(), mode: 'signin', busy: '', feedbackRating: 0, codes: [], quotes: null, codeBusy: false, codeNote: '', codesSupported: true, ...over });
const render = (s: AccountState) => toNode(accountView(s));

describe('money', () => {
  it('shows whole amounts without decimals and others with two', () => {
    expect(formatMoney(44900, 'INR')).toBe('₹449');
    expect(formatMoney(38389, 'INR')).toBe('₹383.89');
    expect(formatMoney(450, 'USD')).toBe('$4.50');
    expect(formatMoney(500, 'USD')).toBe('$5');
    expect(percentLabel(1250)).toBe('12.5%');
  });

  it('reads a price answer, and treats anything else (an old checkout function) as no answer', () => {
    expect(readQuote(quotes.INR)).toMatchObject({ order: { finalMinor: 38389 } });
    expect(readQuote({ url: 'https://rzp.io/x' })).toBeNull();
    expect(readQuote(null)).toBeNull();
    expect(readQuote({ order: { finalMinor: 'x' }, applied: [] })).toBeNull();
  });

  it('explains a refused code, and ignores the harmless same-kind replacement', () => {
    expect(rejectionNote({ ...quotes.INR, rejected: [{ code: 'NOPE1234', reason: 'not_found' }] })).toBe('NOPE1234: That code is not valid.');
    expect(rejectionNote({ ...quotes.INR, rejected: [{ code: 'ASHA10', reason: 'own_code' }] })).toContain('own code');
    expect(rejectionNote({ ...quotes.INR, rejected: [{ code: 'OLD12345', reason: 'same_kind' }] })).toBe('');
  });
});

describe('Account page payment section', () => {
  it('offers a code box and the plain prices when no code is applied', () => {
    const page = render(state());
    expect(page.querySelector('#promo-code')).toBeTruthy();
    expect(page.querySelector('.code-applied li')).toBeNull();
    expect(page.querySelector('.price-sum')).toBeNull();
    const pay = page.querySelectorAll('[data-action="checkout"]');
    expect(pay[0]!.textContent).toContain('₹449');
    expect(pay[1]!.textContent).toContain('$5');
  });

  it('shows how much each code takes off, in rupees and dollars, and what the buyer pays', () => {
    const page = render(state({ codes: ['ASHA10', 'DIWALI5'], quotes }));
    const rows = [...page.querySelectorAll('.code-applied li')].map((li) => li.textContent!.replace(/\s+/g, ' '));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('ASHA10');
    expect(rows[0]).toContain('Creator code');
    expect(rows[0]).toContain('10% off');
    expect(rows[0]).toContain('− ₹44.90');
    expect(rows[0]).toContain('− $0.50');
    expect(rows[1]).toContain('DIWALI5');
    expect(rows[1]).toContain('5% extra off');
    expect(rows[1]).toContain('− ₹20.21');
    expect(rows[1]).toContain('− $0.23');
    const sum = page.querySelector('.price-sum')!.textContent!.replace(/\s+/g, ' ');
    expect(sum).toContain('Price₹449 $5');
    expect(sum).toContain('You pay₹383.89 $4.27');
    const pay = page.querySelectorAll('[data-action="checkout"]');
    expect(pay[0]!.textContent).toContain('₹449');
    expect(pay[0]!.querySelector('s')).toBeTruthy(); // the old price is struck out
    expect(pay[0]!.textContent).toContain('₹383.89');
    expect(pay[1]!.textContent).toContain('$4.27');
    expect(page.querySelectorAll('[data-action="remove-code"]')).toHaveLength(2);
  });

  it('shows a message for a code that did not work, and hides the box when the server cannot price codes', () => {
    expect(render(state({ codeNote: 'NOPE1234: That code is not valid.' })).querySelector('.code-note')?.textContent).toContain('not valid');
    expect(render(state({ codesSupported: false })).querySelector('#promo-code')).toBeNull();
  });

  it('shows no code box to people who are not signed in or who have already paid', () => {
    expect(render(state({ status: { ...status(), access: { ...status().access, signedIn: false } } })).querySelector('#promo-code')).toBeNull();
    expect(render(state({ status: status('paid') })).querySelector('#promo-code')).toBeNull();
  });
});

describe('confetti', () => {
  const seeded = () => { let n = 7; return () => ((n = (n * 16807) % 2147483647) / 2147483647); };

  it('starts a fixed number of pieces in the product colours, aimed up and inwards from both sides', () => {
    const pieces = createPieces(1200, 800, 80, seeded());
    expect(pieces).toHaveLength(80);
    for (const p of pieces) expect(CONFETTI_COLORS).toContain(p.color);
    const left = pieces.filter((p) => p.x < 600);
    const right = pieces.filter((p) => p.x > 600);
    expect(left.length).toBe(40);
    expect(right.length).toBe(40);
    expect(left.every((p) => p.vx > 0 && p.vy < 0)).toBe(true);
    expect(right.every((p) => p.vx < 0 && p.vy < 0)).toBe(true);
  });

  it('rises, then falls under gravity, and waits out its delay first', () => {
    const [p] = createPieces(1000, 800, 1, seeded());
    p!.delay = 0.1;
    const y0 = p!.y;
    stepPiece(p!, 0.05);
    expect(p!.y).toBe(y0); // still waiting
    stepPiece(p!, 0.05);
    stepPiece(p!, 0.05);
    expect(p!.y).toBeLessThan(y0); // moving up
    for (let i = 0; i < 80; i += 1) stepPiece(p!, 0.02);
    expect(p!.vy).toBeGreaterThan(0); // gravity has won
  });

  it('draws nothing for people who ask for reduced motion', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null })) as typeof window.matchMedia;
    await celebrate();
    expect(document.querySelector('canvas')).toBeNull();
    window.matchMedia = original;
  });
});
