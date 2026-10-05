import { describe, expect, it } from 'vitest';
import { Storage } from '../../src/core/storage';
import { CloudClient, SESSION_KEY, type FetchFn } from '../../src/core/cloud/client';
import { AccessService } from '../../src/core/cloud/access';
import { ApplicationStore, applicationKey, normalizeApplication, newApplication } from '../../src/core/cloud/applications';
import { BackupService, buildBackup } from '../../src/core/cloud/backup';
import { weekStart } from '../../src/core/cloud/week';
import { extractNotes, parseIntel, suggestIntel } from '../../src/core/engine/intel';
import type { CloudSession, DeviceSignals } from '../../src/core/cloud/types';

const config = { supabaseUrl: 'https://p.supabase.co', anonKey: 'anon', freeFillsPerWeek: 3, priceLabel: '$5', pageSize: 100 };
const device: DeviceSignals = { install: 'i1', hw: 'h1', br: 'b1' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

/** A tiny in-memory stand-in for the parts of Supabase Fillie talks to. */
function fakeCloud(options: { paid?: boolean; trialDown?: boolean } = {}) {
  const apps = new Map<string, Record<string, unknown>>();
  let backup: unknown = null;
  let used = 0;
  const calls: string[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith('/token')) return json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: 'me@x.com' } });
    if (url.pathname === '/functions/v1/trial') {
      if (options.trialDown) return json({}, 500);
      const body = JSON.parse(String(init.body));
      let allowed = used < 3;
      if (body.action === 'consume' && allowed) used += 1;
      return json({ allowed, remaining: 3 - used, limit: 3 });
    }
    if (url.pathname === '/rest/v1/entitlements') return json(options.paid ? [{ paid: true }] : []);
    if (url.pathname === '/rest/v1/backups') {
      if (method === 'POST') {
        backup = JSON.parse(String(init.body)).data;
        return new Response(null, { status: 201 });
      }
      return json(backup ? [{ data: backup }] : []);
    }
    if (url.pathname === '/rest/v1/applications') {
      if (method === 'POST') {
        const body = JSON.parse(String(init.body));
        for (const row of Array.isArray(body) ? body : [body]) apps.set(row.id, row);
        return new Response(null, { status: 201 });
      }
      if (method === 'DELETE') {
        apps.delete(String(url.searchParams.get('id')).replace('eq.', ''));
        return new Response(null, { status: 204 });
      }
      const rows = [...apps.values()].sort((a, b) => String(b.applied_at).localeCompare(String(a.applied_at)));
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return json(rows.slice(offset, offset + limit));
    }
    return json({}, 404);
  };
  return { fetchImpl: fetchImpl as unknown as FetchFn, apps, calls, get backup() { return backup; } };
}

async function signedIn(storage: Storage) {
  const session: CloudSession = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, user: { id: 'u1', email: 'me@x.com' } };
  await storage.put(SESSION_KEY, session);
}

describe('weekStart', () => {
  it('is the Monday of that week (UTC)', () => {
    expect(weekStart(Date.UTC(2026, 9, 7))).toBe('2026-10-05'); // Wednesday
    expect(weekStart(Date.UTC(2026, 9, 5))).toBe('2026-10-05'); // Monday
    expect(weekStart(Date.UTC(2026, 9, 11, 23))).toBe('2026-10-05'); // Sunday
  });
});

describe('sign-in', () => {
  it('stores the session and can sign out', async () => {
    const storage = new Storage();
    const cloud = fakeCloud();
    const client = new CloudClient(storage, { config, fetchImpl: cloud.fetchImpl });
    const session = await client.signInWithPassword('me@x.com', 'pw');
    expect(session.user.email).toBe('me@x.com');
    expect((await client.getSession())?.accessToken).toBe('a');
    await client.signOut();
    expect(await client.getSession()).toBeNull();
  });

  it('reads tokens from an OAuth redirect', async () => {
    const storage = new Storage();
    const cloud = fakeCloud();
    const fetchImpl = (async (url: string, init?: RequestInit) =>
      url.endsWith('/auth/v1/user') ? json({ id: 'u9', email: 'g@x.com' }) : cloud.fetchImpl(url, init)) as never;
    const client = new CloudClient(storage, { config, fetchImpl });
    const session = await client.completeOAuth('https://abc.chromiumapp.org/#access_token=t&refresh_token=r&expires_in=3600', 'google');
    expect(session.user).toMatchObject({ id: 'u9', provider: 'google' });
    await expect(client.completeOAuth('https://abc.chromiumapp.org/#error_description=denied', 'google')).rejects.toThrow('denied');
  });
});

describe('access: 3 free fillings a week, then pay', () => {
  it('lets a paid user through without touching the trial counter', async () => {
    const storage = new Storage();
    await signedIn(storage);
    const cloud = fakeCloud({ paid: true });
    const access = new AccessService(storage, new CloudClient(storage, { config, fetchImpl: cloud.fetchImpl }), { config });
    const state = await access.begin(device, 'https://a.com/apply');
    expect(state).toMatchObject({ allowed: true, plan: 'paid' });
    expect(cloud.calls.some((c) => c.includes('/functions/v1/trial'))).toBe(false);
  });

  it('counts three fillings then refuses the fourth', async () => {
    const storage = new Storage();
    const cloud = fakeCloud();
    const access = new AccessService(storage, new CloudClient(storage, { config, fetchImpl: cloud.fetchImpl }), { config });
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await access.begin(device, `https://a.com/${i}`));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[2].remaining).toBe(0);
    expect(results[3].reason).toMatch(/free fillings/);
  });

  it('does not charge twice for re-running the same page', async () => {
    const storage = new Storage();
    const cloud = fakeCloud();
    const access = new AccessService(storage, new CloudClient(storage, { config, fetchImpl: cloud.fetchImpl }), { config });
    await access.begin(device, 'https://a.com/apply');
    const again = await access.begin(device, 'https://a.com/apply');
    expect(again.allowed).toBe(true);
    expect(again.remaining).toBe(2);
  });

  it('falls back to a local counter when the server is unreachable', async () => {
    const storage = new Storage();
    const cloud = fakeCloud({ trialDown: true });
    const access = new AccessService(storage, new CloudClient(storage, { config, fetchImpl: cloud.fetchImpl }), { config });
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push((await access.begin(device, `https://a.com/${i}`)).allowed);
    expect(results).toEqual([true, true, true, false]);
  });

  it('is unlimited in an unconfigured development build', async () => {
    const storage = new Storage();
    const dev = { ...config, supabaseUrl: 'https://YOUR-PROJECT.supabase.co' };
    const access = new AccessService(storage, new CloudClient(storage, { config: dev }), { config: dev });
    expect((await access.begin(device, 'x')).allowed).toBe(true);
  });
});

describe('application tracker', () => {
  it('keeps one row per company + role', async () => {
    const storage = new Storage();
    const store = new ApplicationStore(storage, new CloudClient(storage, { config, fetchImpl: fakeCloud().fetchImpl }));
    const first = await store.track({ company: 'Acme', role: 'Frontend Dev' });
    const second = await store.track({ company: ' acme ', role: 'frontend dev' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect((await store.list()).rows).toHaveLength(1);
  });

  it('queues locally when signed out and uploads after sign-in', async () => {
    const storage = new Storage();
    const cloud = fakeCloud();
    const client = new CloudClient(storage, { config, fetchImpl: cloud.fetchImpl });
    const store = new ApplicationStore(storage, client);
    await store.track({ company: 'Acme', role: 'Dev' });
    expect(cloud.apps.size).toBe(0);
    expect((await store.list()).localOnly).toBe(true);

    await signedIn(storage);
    const page = await store.list();
    expect(cloud.apps.size).toBe(1);
    expect(page.localOnly).toBe(false);
    expect(await store.pendingCount()).toBe(0);
  });

  it('loads 100 rows at a time', async () => {
    const storage = new Storage();
    await signedIn(storage);
    const cloud = fakeCloud();
    const store = new ApplicationStore(storage, new CloudClient(storage, { config, fetchImpl: cloud.fetchImpl }));
    for (let i = 0; i < 130; i += 1) {
      await store.save(newApplication({ company: `Co ${i}`, role: 'Dev', appliedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` }));
    }
    const first = await store.list();
    expect(first.rows).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    const second = await store.list({ offset: 100 });
    expect(second.rows).toHaveLength(30);
    expect(second.hasMore).toBe(false);
  });

  it('only keeps interview date and package for the matching status', () => {
    const base = newApplication({ company: 'A', role: 'B', interviewAt: '2026-10-10T10:00', offerLpa: 12 });
    expect(normalizeApplication({ ...base, status: 'applied' })).toMatchObject({ interviewAt: null, offerLpa: null });
    expect(normalizeApplication({ ...base, status: 'interview' }).interviewAt).toBe('2026-10-10T10:00');
    expect(normalizeApplication({ ...base, status: 'offer' }).offerLpa).toBe(12);
  });

  it('treats an unknown rating as null and remembers who set it', () => {
    expect(newApplication({ company: 'A', role: 'B' }).rating).toBeNull();
    expect(newApplication({ company: 'A', role: 'B', rating: 9 }).rating).toBeNull();
    expect(newApplication({ company: 'A', role: 'B', rating: 4, ratingSource: 'ai' })).toMatchObject({ rating: 4, ratingSource: 'ai' });
    expect(applicationKey(' Acme ', 'Dev')).toBe('acme|dev');
  });
});

describe('backup and restore', () => {
  it('never includes API keys', async () => {
    const storage = new Storage();
    await storage.saveSettings({ ...(await storage.getSettings()), config: { ...(await storage.getSettings()).config, apiKeys: { gemini: 'SECRET' } } });
    const backup = await buildBackup(storage);
    expect(JSON.stringify(backup)).not.toContain('SECRET');
  });

  it('restores an emptied device but never overwrites an existing profile', async () => {
    const source = new Storage();
    await signedIn(source);
    const cloud = fakeCloud();
    const profile = await source.getProfile();
    profile.personal.fullName = 'Ada Lovelace';
    await source.saveProfile(profile);
    await source.saveResumes({ resumes: [{ id: 'a', name: 'Main', text: 'hello', updatedAt: 1 }], defaultId: 'a' });
    expect((await new BackupService(source, new CloudClient(source, { config, fetchImpl: cloud.fetchImpl })).upload()).ok).toBe(true);

    const fresh = new Storage();
    await signedIn(fresh);
    const service = new BackupService(fresh, new CloudClient(fresh, { config, fetchImpl: cloud.fetchImpl }));
    expect(await service.restoreIfEmpty()).toBe(true);
    expect((await fresh.getProfile()).personal.fullName).toBe('Ada Lovelace');
    expect((await fresh.getResumes()).resumes[0].text).toBe('hello');
    expect(await service.restoreIfEmpty()).toBe(false);
  });

  it('does not back up an empty device', async () => {
    const storage = new Storage();
    await signedIn(storage);
    const result = await new BackupService(storage, new CloudClient(storage, { config, fetchImpl: fakeCloud().fetchImpl })).upload();
    expect(result.ok).toBe(false);
  });
});

describe('company notes', () => {
  it('pulls facts the posting states', () => {
    const notes = extractNotes('This role has a 2 year service bond. Hybrid work. 3 month probation. Stipend of ₹25,000/month.');
    expect(notes).toEqual(expect.arrayContaining(['2 year bond', 'Hybrid work', '3 month probation']));
    expect(notes.some((n) => n.startsWith('Pay:'))).toBe(true);
  });

  it('parses the model reply defensively', () => {
    expect(parseIntel('noise {"notes":["Great mentors"],"rating":4} trailing')).toEqual({ notes: ['Great mentors'], rating: 4 });
    expect(parseIntel('{"notes":[],"rating":9}').rating).toBeNull();
    expect(parseIntel('not json')).toEqual({ notes: [], rating: null });
  });

  it('leaves the rating empty when no AI is available', async () => {
    const intel = await suggestIntel({ url: 'u', host: 'h', pageTitle: 't', company: 'Acme', jobDescription: '2 year bond', detectedAt: 0 });
    expect(intel).toEqual({ notes: ['2 year bond'], rating: null });
  });

  it('adds AI notes and a rating when a model answers', async () => {
    const intel = await suggestIntel(
      { url: 'u', host: 'h', pageTitle: 't', company: 'Acme', detectedAt: 0 },
      async () => ({ text: '{"notes":["Good learning"],"rating":4}', model: 'm', provider: 'gemini', cached: false }),
    );
    expect(intel).toEqual({ notes: ['Good learning'], rating: 4 });
  });
});

describe('device fingerprint hashing', () => {
  it('the http:// fallback matches the platform SHA-256', async () => {
    const { sha256Fallback, sha256 } = await import('../../src/core/cloud/fingerprint');
    for (const text of ['', 'abc', 'Fillie·fp 1.0', 'x'.repeat(200)]) {
      expect(sha256Fallback(new TextEncoder().encode(text))).toBe(await sha256(text));
    }
  });
});
