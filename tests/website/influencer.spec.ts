import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { FakeSupabase, SITE } from './fake-supabase';

/**
 * The whole programme in a browser: a creator joins, a customer pays with their code and an offer, the creator
 * withdraws, and the admin approves and pays. The website talks to a real Postgres (running the real migrations)
 * and the real checkout/payment code; only Razorpay and Supabase Auth are faked.
 */
test.describe.configure({ mode: 'serial' });

let fake: FakeSupabase;
let context: BrowserContext;
const shots = process.env.SHOTS ? '/tmp/claude-501/site' : '';

async function open(_unused: unknown, path: string, as?: string): Promise<Page> {
  const page = await context.newPage();
  if (as) await fake.signIn(page, as);
  await page.goto(`${SITE}${path}`);
  return page;
}
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}-${name}.png`, fullPage: true }); };

test.beforeAll(async ({ browser }) => {
  fake = await FakeSupabase.create();
  await fake.addUser('mdnurulhasan1111@gmail.com', 'Admin', true);
  await fake.addUser('asha@example.com', 'Asha Verma');
  await fake.addUser('priya@example.com', 'Priya Nair');
  await fake.addUser('rahul@example.com', 'Rahul Shah');
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await fake.install(context);
});
test.afterAll(async () => { await context.close(); });

let ashaCode = '';

test('a visitor to /influencer is offered every way to sign in', async ({ browser }) => {
  const page = await open(browser, '/influencer');
  await expect(page.getByRole('heading', { name: /Share Fillie/ })).toBeVisible();
  for (const name of ['Google', 'GitHub', 'Apple']) await expect(page.getByRole('button', { name: new RegExp(`Continue with ${name}`) })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await shot(page, 'influencer-gate');
});

test('joining: the form checks everything, then gives the creator a promo code', async ({ browser }) => {
  const page = await open(browser, '/influencer', 'asha@example.com');
  await expect(page.getByRole('heading', { name: 'Join the creator programme' })).toBeVisible();
  await expect(page.getByLabel('Email', { exact: false }).first()).toHaveValue('asha@example.com');

  await page.getByRole('button', { name: /Join and get my promo code/ }).click();
  await expect(page.getByRole('alert')).toContainText('mobile number');

  await page.getByRole('textbox', { name: /^Full name/ }).fill('');
  await page.getByLabel('Mobile number').fill('+91 98765 43210');
  await page.getByRole('button', { name: /Join and get my promo code/ }).click();
  await expect(page.getByRole('alert')).toContainText('full name');
  await page.getByRole('textbox', { name: /^Full name/ }).fill('Asha Verma');
  await page.getByLabel('Display / creator name').fill('Asha Codes');
  await page.getByLabel('Date of birth').fill('2015-01-01');
  await page.getByRole('button', { name: /Join and get my promo code/ }).click();
  await expect(page.getByRole('alert')).toContainText('at least 18');
  await page.getByLabel('Date of birth').fill('1998-04-02');
  await page.getByLabel('City').fill('Pune');
  await page.getByLabel('State').fill('Maharashtra');
  await page.getByLabel('Instagram username').fill('@ashacodes');
  await page.getByLabel('Instagram link').fill('instagram.com/ashacodes');
  await page.getByLabel('Primary platform').selectOption('Instagram');
  await page.getByRole('button', { name: /Join and get my promo code/ }).click();
  await expect(page.getByRole('alert')).toContainText('must start with https://');
  await page.getByLabel('Instagram link').fill('https://instagram.com/ashacodes');
  await page.getByLabel('Total followers').fill('52000');
  await page.getByRole('button', { name: /Join and get my promo code/ }).click();
  await expect(page.getByRole('alert')).toContainText('content category');
  await page.locator('.f-checks[role=radiogroup]').getByText('Tech').click();
  await page.getByLabel('Audience location').fill('India');
  await page.getByLabel('Approximate audience size').selectOption('10k-50k');
  await page.getByLabel('Short description about your content').fill('Coding tutorials for students.');
  await page.getByRole('button', { name: /Join and get my promo code/ }).click();
  await expect(page.getByRole('alert')).toContainText('where you will promote');
  await page.locator('.f-checks[role=group]').getByText('Instagram').click();
  await page.locator('.f-checks[role=group]').getByText('YouTube').click();
  await page.getByLabel('Preferred promo code').fill('asha10');
  await page.getByRole('button', { name: /Join and get my promo code/ }).click();
  await expect(page.getByRole('alert')).toContainText('four agreements');

  await expect(page.getByText('You must add your bank details and PAN before your first withdrawal.')).toBeVisible();
  await shot(page, 'influencer-onboarding');
  for (const box of await page.locator('.f-agree input[type=checkbox]').all()) await box.check();
  await page.getByRole('button', { name: /Join and get my promo code/ }).click();

  await expect(page.getByRole('dialog', { name: /You're in/ })).toBeVisible();
  await expect(page.locator('.welcome-code code').first()).toHaveText('ASHA10');
  ashaCode = 'ASHA10';
  await shot(page, 'influencer-welcome');
  await page.getByRole('button', { name: 'Go to my dashboard' }).click();
  await expect(page.getByText('Available to withdraw')).toBeVisible();
  await expect(page.getByText('Add your bank details and PAN in')).toBeVisible();
  await page.close();
});

test('a customer arriving from the creator\'s link gets the code applied, adds an offer, and pays less', async ({ browser }) => {
  // Admin makes an offer first.
  await fake.sql(`select public.checkout_resolve('X', null)`); // warm up
  const adminPage = await open(browser, '/admin', 'mdnurulhasan1111@gmail.com');
  await adminPage.getByRole('tab', { name: 'Offers' }).click();
  await adminPage.getByRole('button', { name: '+ Create offer' }).click();
  await adminPage.getByLabel('Offer code').fill('diwali5');
  await adminPage.getByLabel('Name (for you)').fill('Diwali sale');
  await adminPage.getByLabel('Discount (%)').fill('5');
  await expect(adminPage.getByText('Example: ₹449 → ₹427')).toBeVisible();
  await adminPage.getByRole('button', { name: 'Create offer', exact: true }).click();
  await expect(adminPage.getByRole('cell', { name: /DIWALI5/ })).toBeVisible();
  await expect(adminPage.getByText('Live', { exact: true })).toBeVisible();
  await shot(adminPage, 'admin-offers');
  await adminPage.close();

  const page = await open(browser, `/?code=${ashaCode}`, 'priya@example.com');
  await expect(page.getByRole('button', { name: 'Pay ₹449 or $5' })).toBeVisible();
  await page.getByRole('button', { name: 'Pay ₹449 or $5' }).click();
  const modal = page.getByRole('dialog');
  // The code from the link is already applied.
  await expect(modal.locator('.code-applied li')).toContainText('ASHA10');
  await expect(modal.getByRole('button', { name: /Pay .*₹404/ })).toBeVisible(); // 449 - 10% = 404.1
  await expect(modal.getByRole('button', { name: /Pay .*\$4\.50/ })).toBeVisible();
  await shot(page, 'checkout-promo');

  // A wrong code is explained; the offer stacks on top of the promo.
  await modal.getByPlaceholder('Enter code').fill('NOPE1234');
  await modal.getByRole('button', { name: 'Apply' }).click();
  await expect(modal.locator('.code-note')).toContainText('not valid');
  await modal.getByPlaceholder('Enter code').fill('diwali5');
  await modal.getByRole('button', { name: 'Apply' }).click();
  await expect(modal.locator('.code-applied li')).toHaveCount(2);
  await expect(modal.getByRole('button', { name: /Pay .*₹383\.89/ })).toBeVisible(); // 404.10 - 5% = 383.89
  await shot(page, 'checkout-both');

  await modal.getByRole('button', { name: /Pay .*₹383\.89/ }).click();
  // A quiet confetti burst marks the confirmed payment.
  await page.waitForSelector('body > canvas', { timeout: 30_000 });
  await expect(page.getByText('Payment received', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/unlimited access/i).first()).toBeVisible({ timeout: 30_000 });

  const [pay] = await fake.sql<{ amount_minor: number; list_amount_minor: number; promo_discount_minor: number; offer_discount_minor: number; status: string }>(`select amount_minor, list_amount_minor, promo_discount_minor, offer_discount_minor, status from public.payments`);
  expect(pay).toMatchObject({ amount_minor: 38389, list_amount_minor: 44900, promo_discount_minor: 4490, offer_discount_minor: 2021, status: 'paid' });
  const [commission] = await fake.sql<{ commission_minor: number; status: string; order_amount_minor: number }>(`select commission_minor, status, order_amount_minor from public.commissions`);
  expect(commission).toMatchObject({ order_amount_minor: 38389, commission_minor: 3838, status: 'pending' }); // 10% of what Priya actually paid
  await page.close();
});

test('the creator\'s own code is refused at checkout (self-referral)', async ({ browser }) => {
  const page = await open(browser, `/?code=${ashaCode}`, 'asha@example.com');
  await page.getByRole('button', { name: 'Pay ₹449 or $5' }).click();
  await expect(page.getByRole('dialog').locator('.code-note')).toContainText('cannot use your own code');
  await expect(page.getByRole('dialog').locator('.code-applied li')).toHaveCount(0);
  await page.close();
});

test('Explore offers shows the admin\'s public offers (never creator codes) and Apply puts one on the order', async ({ browser }) => {
  await fake.sql(`insert into public.discount_offers (code, title, discount_bps, listed) values ('SECRET15', 'Secret', 1500, false)`);
  const page = await open(browser, '/', 'rahul@example.com');
  await page.getByRole('button', { name: 'Pay ₹449 or $5' }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByText('(multiple coupons applicable)')).toBeVisible();
  await modal.getByRole('button', { name: 'Explore offers' }).click();
  await expect(modal.locator('.offers-note')).toContainText("creator's promo code");
  const rows = modal.locator('.offers-list li');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Diwali sale');
  await expect(rows.first()).toContainText('DIWALI5');
  await expect(modal).not.toContainText('ASHA10');
  await expect(modal).not.toContainText('SECRET15');
  await shot(page, 'checkout-offers');
  await rows.first().getByRole('button', { name: 'Apply' }).click();
  await expect(modal.locator('.code-applied li')).toContainText('DIWALI5');
  await expect(modal.getByRole('button', { name: /Pay .*₹426\.55/ })).toBeVisible();
  await page.close();
});

test('the creator\'s dashboard shows the order, privately, with the money still pending', async ({ browser }) => {
  const page = await open(browser, '/influencer', 'asha@example.com');
  await expect(page.getByText('Available to withdraw')).toBeVisible();
  await expect(page.locator('.kpi', { hasText: 'Pending' }).locator('strong')).toHaveText('₹38.38');
  await expect(page.locator('.kpi', { hasText: 'Orders' }).locator('strong').first()).toHaveText('1');
  const row = page.locator('table.adm-table tbody tr').first();
  await expect(row).toContainText('ORD-');
  await expect(row).toContainText('₹383.89');
  await expect(row).toContainText('pending');
  expect(await page.locator('body').innerText()).not.toMatch(/priya|rahul|@example\.com.*priya/i);
  await shot(page, 'influencer-dashboard');

  await page.getByRole('tab', { name: 'Promo codes' }).click();
  await expect(page.locator('.code-card').first()).toContainText('ASHA10');
  await page.getByPlaceholder('e.g. ASHAYT').fill('ashayt');
  await page.getByRole('button', { name: 'Create code' }).click();
  await expect(page.locator('.code-card')).toHaveCount(2);
  await page.getByPlaceholder('e.g. ASHAYT').fill('ASHA10');
  await page.getByRole('button', { name: 'Create code' }).click();
  await expect(page.getByRole('alert')).toContainText('already taken');
  await shot(page, 'influencer-codes');
  await page.close();
});

test('the admin lowers the minimum withdrawal in the programme settings', async ({ browser }) => {
  const page = await open(browser, '/admin', 'mdnurulhasan1111@gmail.com');
  await page.getByRole('tab', { name: 'Influencers' }).click();
  await page.getByRole('tab', { name: 'Programme settings' }).click();
  await page.getByLabel('Minimum withdrawal (₹)').fill('10');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  const [row] = await fake.sql<{ value: { INR: number } }>(`select value from public.platform_settings where key = 'min_withdrawal_minor'`);
  expect(row!.value.INR).toBe(1000);
  await shot(page, 'admin-settings');
  await page.close();
});

test('withdrawing: payment details first, then an honest breakdown, then a request', async ({ browser }) => {
  await fake.age(8); // past the 7-day refund window
  const page = await open(browser, '/influencer#earnings', 'asha@example.com');
  await expect(page.locator('.kpi.bal strong')).toHaveText('₹38.38');
  await page.getByRole('button', { name: 'Withdraw' }).click();
  const modal = page.getByRole('dialog', { name: 'Withdraw your earnings' });
  await expect(modal).toContainText('Add your bank account and PAN first');
  await modal.getByRole('button', { name: 'Add payment details' }).click();

  // Settings: the form refuses bad input, then saves a masked copy.
  await expect(page.getByRole('heading', { name: 'Payment details' })).toBeVisible();
  await page.getByLabel('Account holder name').fill('Asha Verma');
  await page.getByRole('textbox', { name: /^Bank account number/ }).fill('123456789012');
  await page.getByLabel('Confirm bank account number').fill('123456789000');
  await page.getByLabel('IFSC code').fill('hdfc0001234');
  await page.getByLabel('PAN number').fill('abcde1234f');
  await page.getByRole('button', { name: 'Save payment details' }).click();
  await expect(page.getByRole('alert').last()).toContainText('do not match');
  await page.getByLabel('Confirm bank account number').fill('123456789012');
  await page.getByLabel('Bank name').fill('HDFC Bank');
  await page.getByRole('button', { name: 'Save payment details' }).click();
  await expect(page.getByText('account ending 9012')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('123456789012');
  await expect(page.locator('body')).not.toContainText('ABCDE1234F');
  await shot(page, 'influencer-settings');

  await page.getByRole('tab', { name: 'Earnings' }).click();
  await page.getByRole('button', { name: 'Withdraw' }).click();
  const quote = page.getByRole('dialog', { name: 'Withdraw your earnings' });
  await expect(quote.locator('.sum-row.total')).toContainText('₹38.38');
  await expect(quote).toContainText('None apply to this withdrawal');
  await expect(quote).toContainText('9012');
  await shot(page, 'influencer-withdraw');
  await quote.getByRole('button', { name: /Request ₹38\.38/ }).click();
  await expect(page.getByText('Withdrawal requested')).toBeVisible();
  const row = page.locator('table.adm-table tbody tr').first();
  await expect(row).toContainText('pending');
  await expect(page.locator('.kpi.bal strong')).toHaveText('₹0');
  await page.close();
});

test('the admin sees the influencer in a box, opens the full profile and history, and reviews the withdrawal', async ({ browser }) => {
  const page = await open(browser, '/admin', 'mdnurulhasan1111@gmail.com');
  await expect(page.getByText('Active influencers').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Influencers' }).click();
  const box = page.locator('.inf-box').first();
  await expect(box).toContainText('Asha Codes');
  await expect(box).toContainText('ASHA10');
  await expect(box).toContainText('ASHAYT');
  await expect(box).toContainText('Pune, Maharashtra');
  await expect(box.locator('.tg')).toHaveText('Active');
  await expect(box.locator('.inf-box-stats')).toContainText('₹383.89'); // revenue: what customers paid
  await expect(box.locator('.inf-box-stats')).toContainText('₹38.38'); // commission
  await shot(page, 'admin-influencers');

  await box.click();
  const profile = page.getByRole('dialog', { name: 'Asha Codes' });
  await expect(profile).toContainText('asha@example.com');
  await expect(profile).toContainText('123456789012'); // admin sees the full account number
  await expect(profile).toContainText('ABCDE1234F');
  await expect(profile.getByRole('cell', { name: 'priya@example.com' })).toBeVisible(); // admin sees the customer
  await expect(profile.locator('.tg', { hasText: 'Unverified' })).toBeVisible();
  await profile.getByRole('button', { name: 'Mark verified' }).click();
  await expect(profile.locator('.tg', { hasText: 'Verified' })).toBeVisible();
  await shot(page, 'admin-influencer-detail');
  await profile.getByRole('button', { name: 'Close' }).click();

  // Withdrawal management.
  await expect(page.getByRole('tab', { name: /Withdrawal management/ })).toContainText('1');
  await page.getByRole('tab', { name: /Withdrawal management/ }).click();
  const list = page.locator('table.adm-table tbody tr');
  await expect(list).toHaveCount(1);
  await expect(list.first()).toContainText('Asha Codes');
  await expect(list.first()).toContainText('₹38.38');
  await expect(list.first()).toContainText('Bank transfer');
  await list.first().getByRole('button', { name: 'Review' }).click();
  const review = page.getByRole('dialog', { name: /Withdrawal #1/ });
  await expect(review).toContainText('Asha Verma');
  await expect(review).toContainText('123456789012');
  await expect(review).toContainText('Related commission transactions');
  await expect(review).toContainText('This is their first withdrawal');
  await shot(page, 'admin-withdrawal');
  await review.getByRole('button', { name: 'Mark as paid' }).waitFor({ state: 'detached' }).catch(() => undefined);
  await review.getByRole('button', { name: 'Approve' }).click();
  await expect(review.locator('.tg', { hasText: 'approved' }).first()).toBeVisible();
  await review.getByRole('button', { name: 'Mark as paid' }).click();
  await expect(review.getByRole('button', { name: /Confirm paid/ })).toBeDisabled(); // needs a UTR
  await review.getByPlaceholder(/UTR/).fill('UTR-5551234');
  await review.getByRole('button', { name: /Confirm paid ₹38\.38/ }).click();
  await expect(review.locator('.tg', { hasText: 'paid' }).first()).toBeVisible();
  await review.getByRole('button', { name: 'Close' }).click();

  // Ledger.
  await page.getByRole('tab', { name: 'Transaction ledger' }).click();
  const ledgerRow = page.locator('table.adm-table tbody tr').first();
  await expect(ledgerRow).toContainText('ASHA10');
  await expect(ledgerRow).toContainText('Asha Codes');
  await expect(ledgerRow).toContainText('₹383.89');
  await expect(ledgerRow).toContainText('₹38.38');
  await expect(ledgerRow).toContainText('approved');
  await shot(page, 'admin-ledger');
  await page.getByRole('tab', { name: 'Suspicious activity' }).click();
  await expect(page.getByText('Nothing suspicious right now')).toBeVisible();
  await page.close();

  const [w] = await fake.sql<{ status: string; payout_reference: string; net_minor: number }>(`select status, payout_reference, net_minor from public.withdrawals`);
  expect(w).toEqual({ status: 'paid', payout_reference: 'UTR-5551234', net_minor: 3838 });
});

test('a creator\'s message reaches the admin inbox', async ({ browser }) => {
  const page = await open(browser, '/influencer#support', 'asha@example.com');
  await page.getByLabel('Subject').fill('When is my payout?');
  await page.getByLabel('Message').fill('I requested a withdrawal yesterday.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Thanks! Your message is with us.')).toBeVisible();
  await page.close();

  const admin = await open(browser, '/admin', 'mdnurulhasan1111@gmail.com');
  await admin.getByRole('tab', { name: 'Influencers' }).click();
  await expect(admin.getByRole('tab', { name: /^Support/ })).toContainText('1');
  await admin.getByRole('tab', { name: /^Support/ }).click();
  await expect(admin.locator('.feed-item')).toContainText('When is my payout?');
  await expect(admin.locator('.feed-item')).toContainText('asha@example.com');
  await admin.getByRole('button', { name: 'Mark resolved' }).click();
  await expect(admin.getByText('Inbox zero')).toBeVisible();
  await admin.close();
});

test('leaving the programme: money must be withdrawn first, and personal data is erased', async ({ browser }) => {
  // Rahul pays with the code too; the commission matures.
  const [promo] = await fake.sql<{ id: string }>(`select id from public.promo_codes where code = 'ASHA10'`);
  const [rahul] = await fake.sql<{ id: string }>(`select id from auth.users where email = 'rahul@example.com'`);
  await fake.sql(`insert into public.payments (user_id, provider, provider_ref, amount_minor, currency, list_amount_minor, promo_code_id, promo_discount_minor) values ($1, 'razorpay', 'plink_RAHUL01', 40410, 'INR', 44900, $2, 4490)`, [rahul!.id, promo!.id]);
  await fake.sql(`select public.finalize_order('plink_RAHUL01')`);
  await fake.age(8);

  const page = await open(browser, '/influencer#settings', 'asha@example.com');
  await page.getByRole('button', { name: 'Delete influencer account' }).click();
  const leave = page.getByRole('dialog', { name: 'Withdraw your money first' });
  await expect(leave).toContainText('₹40.41');
  await shot(page, 'influencer-leave');
  await leave.getByRole('button', { name: 'Withdraw now' }).click();
  const quote = page.getByRole('dialog', { name: 'Withdraw your earnings' });
  await expect(quote.locator('.sum-row.total')).toContainText('₹40.41');
  await quote.getByRole('button', { name: /Request ₹40\.41/ }).click();
  await expect(page.getByText('Withdrawal requested')).toBeVisible();

  // Still being processed: deletion waits.
  await page.getByRole('button', { name: 'Delete influencer account' }).click();
  await expect(page.getByRole('dialog')).toContainText('still being processed');
  await page.getByRole('button', { name: 'OK' }).click();

  // The admin pays it.
  await fake.sql(`update public.withdrawals set status = 'paid', paid_at = now(), payout_reference = 'UTR2' where status = 'pending'`);

  await page.reload();
  await page.getByRole('button', { name: 'Delete influencer account' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete influencer account?' });
  const del = confirm.getByRole('button', { name: 'Delete my account' });
  await expect(del).toBeDisabled();
  await confirm.getByLabel(/Type DELETE/).fill('DELETE');
  await del.click();
  await expect(page.getByRole('heading', { name: 'Join the creator programme' })).toBeVisible();

  const [gone] = await fake.sql<{ status: string; phone: string; email: string; user_id: string | null; dob: string | null }>(`select status, phone, email, user_id, dob from public.influencers`);
  expect(gone).toMatchObject({ status: 'deleted', phone: '', email: '', user_id: null, dob: null });
  expect(await fake.sql(`select 1 from public.influencer_payouts`)).toHaveLength(0);
  expect(await fake.sql(`select 1 from public.promo_codes where active`)).toHaveLength(0);

  // The admin still sees them, marked as deleted, with their history.
  const admin = await open(browser, '/admin', 'mdnurulhasan1111@gmail.com');
  await admin.getByRole('tab', { name: 'Influencers' }).click();
  await expect(admin.locator('.inf-box').first().locator('.tg')).toHaveText('Deleted account');
  await expect(admin.locator('.inf-box').first()).toContainText('Asha Codes');
  await admin.close();
  await page.close();
});

test('the creator and admin pages fit a phone screen', async ({ browser }) => {
  for (const [path, who] of [['/influencer', undefined], ['/influencer', 'priya@example.com'], ['/admin', 'mdnurulhasan1111@gmail.com'], ['/?code=ASHA10', 'rahul@example.com']] as const) {
    const landing = path.startsWith('/?');
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    if (who) await fake.signIn(page, who);
    await page.goto(`${SITE}${path}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(600);
    if (path === '/admin') { await page.getByRole('tab', { name: 'Influencers' }).click(); await page.waitForTimeout(500); }
    // The landing page has its own, older layout; for it only the payment window is checked.
    if (landing) await page.getByRole('button', { name: /Pay ₹449/ }).click();
    const overflow = landing ? await page.evaluate(() => { const m = document.querySelector('.modal.pay')!; return m.scrollWidth - m.clientWidth; }) : await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} as ${who ?? 'visitor'} scrolls sideways`).toBeLessThanOrEqual(1);
    await shot(page, `mobile-${path.replace(/\W/g, '') || 'home'}-${who ? 'in' : 'out'}`);
    await page.close();
  }
  void browser;
});
