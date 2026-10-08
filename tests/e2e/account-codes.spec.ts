import { expect, test } from './fixtures';

/**
 * The Account page's payment section, driven in the real extension page. Only the answers of the cloud
 * (account status, prices, checkout) are stubbed; the page, its buttons and its drawing are the real ones.
 */
const STUB = () => {
  const w = window as unknown as { chrome: typeof chrome; __calls: unknown[]; __paid: boolean };
  w.__calls = [];
  w.__paid = false;
  const codes: Record<string, { kind: 'promo' | 'offer'; bps: number; title: string }> = {
    ASHA10: { kind: 'promo', bps: 1000, title: 'Creator code · Asha' },
    DIWALI5: { kind: 'offer', bps: 500, title: 'Diwali sale' },
  };
  const quote = (currency: 'INR' | 'USD', asked: string[]) => {
    const list = currency === 'INR' ? 44900 : 500;
    const applied: Array<{ kind: string; code: string; discount_bps: number; title: string }> = [];
    const rejected: Array<{ code: string; reason: string }> = [];
    for (const code of asked) {
      const known = codes[code];
      if (!known) rejected.push({ code, reason: 'not_found' });
      else if (applied.some((a) => a.kind === known.kind)) rejected.push({ code, reason: 'same_kind' });
      else applied.push({ kind: known.kind, code, discount_bps: known.bps, title: known.title });
    }
    const promo = applied.find((a) => a.kind === 'promo');
    const offer = applied.find((a) => a.kind === 'offer');
    const promoOff = promo ? Math.round((list * promo.discount_bps) / 10000) : 0;
    const offerOff = offer ? Math.round(((list - promoOff) * offer.discount_bps) / 10000) : 0;
    return { order: { currency, listMinor: list, promoOffMinor: promoOff, offerOffMinor: offerOff, finalMinor: list - promoOff - offerOff }, applied, rejected };
  };
  const status = () => ({
    cloudConfigured: true, pendingApplications: 0, priceLabel: '$5 one-time', priceInrLabel: '₹449', shareOffers: false,
    access: { allowed: true, plan: w.__paid ? 'paid' : 'trial', remaining: 2, limit: 3, signedIn: true, email: 'priya@example.com' },
  });
  const real = w.chrome.runtime.sendMessage.bind(w.chrome.runtime);
  (w.chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = (message: { type: string; codes?: string[]; currency?: string }, callback: (r: unknown) => void) => {
    const answer = (value: unknown) => setTimeout(() => callback(value), 10);
    w.__calls.push(message);
    if (message.type === 'fillie:account-status' || message.type === 'fillie:refresh-payment') return answer(status());
    if (message.type === 'fillie:checkout-quote') return answer({ ok: true, quotes: { INR: quote('INR', message.codes ?? []), USD: quote('USD', message.codes ?? []) } });
    if (message.type === 'fillie:checkout') return answer({ ok: true });
    if (message.type === 'fillie:list-offers') return answer({ ok: true, offers: [{ code: 'DIWALI5', title: 'Diwali sale', discount_bps: 500, ends_at: null, left: null }, { code: 'FIRST100', title: 'First 100 users', discount_bps: 1500, ends_at: null, left: 12 }] });
    return real(message, callback);
  };
};

test.describe('Account: creator and offer codes', () => {
  test('shows what each code takes off, prices both payment options, and sends the codes with the payment', async ({ fillie }) => {
    const page = await fillie.context.newPage();
    await page.addInitScript(STUB);
    await page.goto(`chrome-extension://${fillie.extensionId}/pages/app.html#/account`);

    await expect(page.locator('#promo-code')).toBeVisible();
    await expect(page.locator('[data-action="checkout"][data-currency="INR"]')).toContainText('₹449');

    await page.locator('#promo-code').fill('nope1234');
    await page.locator('[data-action="apply-code"]').click();
    await expect(page.locator('.code-note')).toContainText('not valid');

    await page.locator('#promo-code').fill('asha10');
    await page.locator('[data-action="apply-code"]').click();
    const first = page.locator('.code-applied li');
    await expect(first).toHaveCount(1);
    await expect(first).toContainText('ASHA10');
    await expect(first).toContainText('− ₹44.90');
    await expect(first).toContainText('− $0.50');
    await expect(page.locator('.price-sum .total')).toContainText('₹404.10');

    await page.locator('#promo-code').fill('diwali5');
    await page.locator('[data-action="apply-code"]').click();
    await expect(page.locator('.code-applied li')).toHaveCount(2);
    await expect(page.locator('.code-applied li').nth(1)).toContainText('− ₹20.21');
    await expect(page.locator('.price-sum .total')).toContainText('₹383.89');
    await expect(page.locator('.price-sum .total')).toContainText('$4.27');
    await expect(page.locator('[data-action="checkout"][data-currency="INR"]')).toContainText('₹383.89');
    await expect(page.locator('[data-action="checkout"][data-currency="USD"]')).toContainText('$4.27');
    await page.screenshot({ path: '/tmp/claude-501/ext-account-codes.png', fullPage: true });

    await page.locator('[data-action="checkout"][data-currency="INR"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __calls: Array<{ type: string; codes?: string[]; currency?: string }> }).__calls.filter((c) => c.type === 'fillie:checkout').map((c) => ({ ...c, codes: [...(c.codes ?? [])].sort() })))).toEqual([{ type: 'fillie:checkout', currency: 'INR', codes: ['ASHA10', 'DIWALI5'] }]);

    // A removed code stops counting.
    await page.locator('[data-action="remove-code"][data-code="ASHA10"]').click();
    await expect(page.locator('.code-applied li')).toHaveCount(1);
    await expect(page.locator('.price-sum .total')).toContainText('₹426.55');
    await page.close();
  });

  test('Explore offers lists the admin\'s public offers, and Apply puts one on the order', async ({ fillie }) => {
    const page = await fillie.context.newPage();
    await page.addInitScript(STUB);
    await page.goto(`chrome-extension://${fillie.extensionId}/pages/app.html#/account`);
    await expect(page.locator('.code-multi')).toHaveText('(multiple coupons applicable)');
    await page.locator('[data-action="explore-offers"]').click();
    const modal = page.locator('.offers-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.offers-note')).toContainText("creator's promo code");
    await expect(modal.locator('.offers-list li')).toHaveCount(2);
    await expect(modal.locator('.offers-list li').nth(1)).toContainText('12 left');
    expect(await modal.textContent()).not.toContain('ASHA10'); // creator codes are never listed
    await page.screenshot({ path: '/tmp/claude-501/ext-offers.png' });

    // A click inside the window keeps it open; the backdrop closes it.
    await modal.locator('h2').click();
    await expect(modal).toBeVisible();
    await page.locator('.offers-back').click({ position: { x: 5, y: 5 } });
    await expect(modal).toHaveCount(0);

    await page.locator('[data-action="explore-offers"]').click();
    await page.locator('[data-action="use-offer"][data-code="DIWALI5"]').click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.code-applied li')).toContainText('DIWALI5');
    await expect(page.locator('.price-sum .total')).toContainText('₹426.55'); // 5% off ₹449
    // Open again: the applied one shows as applied.
    await page.locator('[data-action="explore-offers"]').click();
    await expect(page.locator('.offer-applied')).toHaveCount(1);
    await page.close();
  });

  test('celebrates with a quiet confetti burst when the payment arrives, once', async ({ fillie }) => {
    const page = await fillie.context.newPage();
    await page.addInitScript(STUB);
    await page.goto(`chrome-extension://${fillie.extensionId}/pages/app.html#/account`);
    await expect(page.locator('[data-action="checkout"]').first()).toBeVisible();
    expect(await page.locator('canvas').count()).toBe(0);

    // The customer pays in the other tab and comes back.
    await page.evaluate(() => { (window as unknown as { __paid: boolean }).__paid = true; window.dispatchEvent(new Event('focus')); });
    await expect(page.locator('.hero-card')).toContainText('Fillie is yours');
    await expect(page.locator('body > canvas')).toHaveCount(1);
    await expect(page.locator('body > canvas')).toHaveCount(0, { timeout: 8_000 }); // it cleans up after itself
    await expect(page.locator('#promo-code')).toHaveCount(0);

    // Coming back again does not celebrate again.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(600);
    expect(await page.locator('body > canvas').count()).toBe(0);
    await page.close();
  });
});
