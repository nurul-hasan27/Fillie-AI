import type { BrowserContext, Page, Route } from '@playwright/test';
import type { PGlite } from '@electric-sql/pglite';
import { parseCodes, pickPrice, priceOrder } from '../../supabase/functions/_shared/pricing';
import { recordPayment, type AdminClient } from '../../supabase/functions/_shared/payments';
import { toPaidLink } from '../../supabase/functions/_shared/razorpay-api';
import { makeDb } from '../helpers/pg-backend';

export const SUPABASE_URL = 'https://erhrkrcbcugckaczavsm.supabase.co';
export const SITE = 'http://127.0.0.1:5199';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const fakeJwt = (sub: string, email: string) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, email, role: 'authenticated', exp: 4_102_444_800 })}.sig`;

interface Link { user: string; notes: Record<string, string>; amount: number; currency: string; recorded: boolean }

/**
 * Plays the part of Supabase for the website in a real browser: the website's own requests are answered from an
 * in-memory Postgres that has the real migrations applied, and the checkout and payment functions run the real
 * shared pricing and payment-recording code. Only Razorpay and Supabase Auth are faked.
 */
export class FakeSupabase {
  db!: PGlite;
  users = new Map<string, { id: string; email: string; name?: string }>();
  links = new Map<string, Link>();
  private chain: Promise<unknown> = Promise.resolve();
  private linkCount = 0;
  requests: string[] = [];

  static async create(): Promise<FakeSupabase> {
    const fake = new FakeSupabase();
    fake.db = await makeDb();
    return fake;
  }

  /** Runs database work one request at a time, because the stand-in Postgres has one session. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async addUser(email: string, name?: string, admin = false): Promise<string> {
    const id = (await this.db.query<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [email])).rows[0]!.id;
    this.users.set(email, { id, email, name });
    if (admin) await this.db.query(`insert into auth.identities (user_id, provider, identity_data) values ($1, 'google', $2)`, [id, JSON.stringify({ email, email_verified: true })]);
    return id;
  }

  /** Makes every pending commission old enough to count as past the refund window. */
  age(days: number): Promise<unknown> {
    return this.serial(() => this.db.query(`update public.commissions set created_at = created_at - make_interval(days => $1)`, [days]));
  }

  sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return this.serial(async () => (await this.db.query<T>(text, params)).rows);
  }

  /** Signs a user in to a page (before it loads) the way supabase-js stores a session. */
  async signIn(page: Page, email: string): Promise<void> {
    const user = this.users.get(email);
    if (!user) throw new Error(`unknown user ${email}`);
    const session = {
      access_token: fakeJwt(user.id, email), token_type: 'bearer', expires_in: 3600, expires_at: 4_102_444_800, refresh_token: 'refresh',
      user: { id: user.id, email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: user.name ? { full_name: user.name } : {}, created_at: new Date().toISOString() },
    };
    await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), ['sb-erhrkrcbcugckaczavsm-auth-token', JSON.stringify(session)]);
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route(`${SUPABASE_URL}/**`, (route) => void this.handle(route));
  }

  private uidFrom(route: Route): { id: string; email: string } | null {
    const token = (route.request().headers()['authorization'] ?? '').replace(/^Bearer\s+/i, '');
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
      return payload.sub ? { id: payload.sub, email: payload.email } : null;
    } catch {
      return null;
    }
  }

  private reply(route: Route, body: unknown, status = 200) {
    return route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: body === undefined ? '' : JSON.stringify(body) });
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    this.requests.push(`${request.method()} ${url.pathname}`);
    if (request.method() === 'OPTIONS') return void route.fulfill({ status: 204, headers: CORS });
    const who = this.uidFrom(route);

    try {
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const fn = url.pathname.split('/').pop()!;
        const args = (request.postDataJSON() ?? {}) as Record<string, unknown>;
        return void this.reply(route, await this.rpc(who?.id ?? null, fn, args));
      }
      if (url.pathname === '/rest/v1/entitlements') {
        const uid = (url.searchParams.get('user_id') ?? '').replace('eq.', '');
        const rows = await this.sql<{ paid: boolean }>(`select paid from public.entitlements where user_id = $1`, [uid || null]);
        return void this.reply(route, rows);
      }
      if (url.pathname === '/functions/v1/create-checkout') return void this.reply(route, ...(await this.createCheckout(who, request.postDataJSON() ?? {})));
      if (url.pathname === '/functions/v1/confirm-payment') return void this.reply(route, { confirmed: await this.confirm(who?.id ?? null) });
      if (url.pathname === '/auth/v1/user') return void this.reply(route, who ? { id: who.id, email: who.email } : { error: 'no' }, who ? 200 : 401);
      if (url.pathname.startsWith('/auth/v1/logout')) return void route.fulfill({ status: 204, headers: CORS });
      if (url.pathname.startsWith('/storage/v1/object/list/')) return void this.reply(route, []);
      if (url.pathname.startsWith('/storage/v1/object/')) return void this.reply(route, { Key: url.pathname, Id: 'x' });
      return void this.reply(route, { message: `unmocked ${request.method()} ${url.pathname}` }, 404);
    } catch (error) {
      const err = error as { message?: string; code?: string };
      return void this.reply(route, { message: err.message ?? 'error', code: err.code ?? 'P0001', details: null, hint: null }, err.code === '42501' ? 403 : 400);
    }
  }

  private rpc(uid: string | null, fn: string, args: Record<string, unknown>): Promise<unknown> {
    return this.serial(async () => {
      await this.db.query(`select set_config('request.uid', $1, false)`, [uid ?? '']);
      const names = Object.keys(args);
      const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
      const params = names.map((n) => { const v = args[n]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v; });
      return (await this.db.query<{ r: unknown }>(sql, params)).rows[0]?.r ?? null;
    });
  }

  /** The same steps as the create-checkout Edge Function, with Razorpay replaced by an instantly paid fake link. */
  private async createCheckout(who: { id: string; email: string } | null, body: { currency?: string; codes?: unknown; quote?: boolean }): Promise<[unknown, number]> {
    if (!who) return [{ error: 'Sign in first.' }, 401];
    const price = pickPrice(body.currency, () => undefined);
    const applied: Array<{ kind: 'promo' | 'offer'; id: string; code: string; discount_bps: number; title: string }> = [];
    const rejected: Array<{ code: string; reason: string }> = [];
    for (const code of parseCodes(body.codes)) {
      const result = (await this.sql<{ r: any }>(`select public.checkout_resolve($1, $2) as r`, [code, who.id]))[0]!.r;
      if (result.error) rejected.push({ code, reason: result.error });
      else if (applied.some((a) => a.kind === result.kind)) rejected.push({ code, reason: 'same_kind' });
      else applied.push(result);
    }
    const promo = applied.find((a) => a.kind === 'promo');
    const offer = applied.find((a) => a.kind === 'offer');
    const order = priceOrder(price, promo?.discount_bps ?? 0, offer?.discount_bps ?? 0);
    if (body.quote) return [{ order, applied: applied.map(({ kind, code, discount_bps, title }) => ({ kind, code, discount_bps, title })), rejected }, 200];
    const refused = rejected.filter((r) => r.reason !== 'same_kind');
    if (refused.length) return [{ error: 'A code you entered can no longer be used. Remove it and try again.', rejected: refused }, 409];
    const id = `plink_T${String(++this.linkCount).padStart(7, '0')}`;
    this.links.set(id, {
      user: who.id, amount: order.finalMinor, currency: order.currency, recorded: false,
      notes: { user_id: who.id, ...(promo ? { promo_id: promo.id } : {}), ...(offer ? { offer_id: offer.id } : {}), list_minor: String(order.listMinor), promo_off: String(order.promoOffMinor), offer_off: String(order.offerOffMinor) },
    });
    return [{ url: `${SITE}/?payment=success` }, 200];
  }

  /** Razorpay's webhook / "I have paid" path: every fake link counts as paid, and is recorded once by the real code. */
  async confirm(uid: string | null): Promise<number> {
    let confirmed = 0;
    for (const [id, link] of this.links) {
      if (link.recorded || (uid && link.user !== uid)) continue;
      const paid = toPaidLink({ id, status: 'paid', amount: link.amount, amount_paid: link.amount, currency: link.currency, notes: link.notes });
      if (!paid) continue;
      const result = await recordPayment(this.adminClient(), { provider: 'razorpay', ...paid });
      if (result.ok) { link.recorded = true; confirmed += 1; }
    }
    return confirmed;
  }

  /** The database client the payment recorder expects, answered by the in-memory Postgres. */
  private adminClient(): AdminClient {
    const fake = this;
    return {
      async rpc(fn, args) {
        try {
          const rows = await fake.sql<{ r: unknown }>(`select public.${fn}(p_ref => $1) as r`, [args?.p_ref]);
          return { data: rows[0]?.r ?? null, error: null };
        } catch (e) { return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } }; }
      },
      from(table) {
        return {
          async upsert(row, options) {
            const keys = Object.keys(row);
            const conflict = options?.onConflict ?? (table === 'entitlements' ? 'user_id' : undefined);
            const action = options?.ignoreDuplicates ? 'do nothing' : `do update set ${keys.filter((k) => k !== conflict).map((k) => `${k} = excluded.${k}`).join(', ')}`;
            try {
              await fake.sql(`insert into public.${table} (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})${conflict ? ` on conflict (${conflict}) ${action}` : ''}`, keys.map((k) => row[k]));
              return { error: null };
            } catch (e) { return { error: { message: (e as Error).message, code: (e as { code?: string }).code } }; }
          },
          select() {
            return { eq: (column, value) => ({ async maybeSingle() { const rows = await fake.sql(`select * from public.${table} where ${column} = $1 limit 1`, [value]); return { data: (rows[0] as Record<string, unknown>) ?? null, error: null }; } }) };
          },
        };
      },
    };
  }
}
