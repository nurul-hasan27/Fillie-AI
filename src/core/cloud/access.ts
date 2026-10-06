import type { Storage } from '../storage';
import { CloudClient, CloudError } from './client';
import { CLOUD, isCloudConfigured } from './config';
import type { AccessState, DeviceSignals } from './types';
import { weekStart } from './week';

const CACHE_KEY = 'fillie:entitlement';
const LOCAL_TRIAL_KEY = 'fillie:trial-local';
const RECENT_KEY = 'fillie:recent-runs';

/** A paid licence keeps working offline for this long after the last check. */
const PAID_OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
/** Re-running Fillie on the same page inside this window is one filling, not two. */
const SAME_PAGE_WINDOW_MS = 30 * 60 * 1000;

interface EntitlementCache {
  userId: string;
  paid: boolean;
  checkedAt: number;
}

interface TrialReply {
  allowed: boolean;
  remaining: number;
  limit: number;
}

/**
 * Decides whether Fillie may run: a paid licence, or one of the free weekly
 * fillings. The weekly count is kept on the server against the device's
 * fingerprint, so reinstalling, going incognito or switching browser does not
 * reset it. If the server cannot be reached, a local counter takes over so the
 * extension never locks up for a connectivity problem.
 */
export class AccessService {
  constructor(
    private readonly storage: Pick<Storage, 'read' | 'put' | 'drop'>,
    private readonly client: CloudClient,
    private readonly options: { now?: () => number; config?: typeof CLOUD } = {},
  ) {}

  private get now() {
    return this.options.now ?? Date.now;
  }
  private get config() {
    return this.options.config ?? CLOUD;
  }

  /** Read-only snapshot for the popup and account page. */
  async status(device: DeviceSignals): Promise<AccessState> {
    const limit = this.config.freeFillsPerWeek;
    if (!isCloudConfigured(this.config)) {
      return { allowed: true, plan: 'paid', remaining: limit, limit, signedIn: false, reason: 'Cloud is not configured (development build).' };
    }
    const session = await this.client.getSession();
    const base = { limit, signedIn: Boolean(session), email: session?.user.email };
    if (session && (await this.isPaid(session.user.id))) {
      return { ...base, allowed: true, plan: 'paid', remaining: limit };
    }
    const trial = await this.trial('check', device);
    return { ...base, allowed: trial.allowed, plan: 'trial', remaining: trial.remaining };
  }

  /** Called when the user starts filling a form. Consumes a free filling when unpaid. */
  async begin(device: DeviceSignals, pageUrl: string): Promise<AccessState> {
    const limit = this.config.freeFillsPerWeek;
    if (!isCloudConfigured(this.config)) {
      return { allowed: true, plan: 'paid', remaining: limit, limit, signedIn: false };
    }
    const session = await this.client.getSession();
    const base = { limit, signedIn: Boolean(session), email: session?.user.email };
    if (session && (await this.isPaid(session.user.id))) {
      return { ...base, allowed: true, plan: 'paid', remaining: limit };
    }

    const recent = (await this.storage.read<Record<string, number>>(RECENT_KEY)) ?? {};
    const last = recent[pageUrl];
    if (last && this.now() - last < SAME_PAGE_WINDOW_MS) {
      const trial = await this.trial('check', device);
      return { ...base, allowed: true, plan: 'trial', remaining: trial.remaining };
    }

    const trial = await this.trial('consume', device);
    if (trial.allowed) {
      const fresh = Object.fromEntries(Object.entries(recent).filter(([, at]) => this.now() - at < SAME_PAGE_WINDOW_MS));
      fresh[pageUrl] = this.now();
      await this.storage.put(RECENT_KEY, fresh);
    }
    return {
      ...base,
      allowed: trial.allowed,
      plan: 'trial',
      remaining: trial.remaining,
      reason: trial.allowed ? undefined : `You have used your ${limit} free fillings this week.`,
    };
  }

  /** True when the signed-in user has paid. Falls back to the last known answer offline. */
  async isPaid(userId: string, options: { force?: boolean } = {}): Promise<boolean> {
    const cached = await this.storage.read<EntitlementCache>(CACHE_KEY);
    // "Paid" can be trusted for a while; "not paid" only briefly, so a user who has just
    // paid is not stuck on the paywall until a cache expires.
    const ttl = cached?.paid ? 10 * 60 * 1000 : 20 * 1000;
    const fresh = cached && cached.userId === userId && this.now() - cached.checkedAt < ttl;
    if (fresh && !options.force) return cached.paid;
    try {
      const rows = await this.client.json<Array<{ paid: boolean }>>(
        `/rest/v1/entitlements?select=paid&user_id=eq.${encodeURIComponent(userId)}`,
      );
      const paid = Boolean(rows[0]?.paid);
      await this.storage.put(CACHE_KEY, { userId, paid, checkedAt: this.now() } satisfies EntitlementCache);
      return paid;
    } catch (error) {
      if (error instanceof CloudError && error.status === 0) throw error;
      // Offline or server trouble: trust a recent "paid" so a paying user is never locked out.
      return Boolean(cached?.userId === userId && cached.paid && this.now() - cached.checkedAt < PAID_OFFLINE_GRACE_MS);
    }
  }

  private async trial(action: 'check' | 'consume', device: DeviceSignals): Promise<TrialReply> {
    const limit = this.config.freeFillsPerWeek;
    try {
      const reply = await this.client.json<TrialReply>(
        '/functions/v1/trial',
        { method: 'POST', body: JSON.stringify({ action, ...device }) },
        { anonymous: true, timeoutMs: 4000 },
      );
      return reply;
    } catch {
      return this.localTrial(action, limit);
    }
  }

  private async localTrial(action: 'check' | 'consume', limit: number): Promise<TrialReply> {
    const week = weekStart(this.now());
    const stored = await this.storage.read<{ week: string; count: number }>(LOCAL_TRIAL_KEY);
    const count = stored?.week === week ? stored.count : 0;
    if (action === 'check') return { allowed: count < limit, remaining: Math.max(0, limit - count), limit };
    if (count >= limit) return { allowed: false, remaining: 0, limit };
    await this.storage.put(LOCAL_TRIAL_KEY, { week, count: count + 1 });
    return { allowed: true, remaining: limit - count - 1, limit };
  }
}
