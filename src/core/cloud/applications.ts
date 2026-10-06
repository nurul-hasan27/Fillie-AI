import type { Storage } from '../storage';
import { normalizeText, stableHash } from '../text';
import { CloudClient } from './client';
import { CLOUD } from './config';
import type { Application, ApplicationStatus } from './types';
import { APPLICATION_STATUSES } from './types';

const LOCAL_KEY = 'fillie:applications';

/** Rows saved while signed out or offline, waiting to be uploaded. */
export interface LocalApplications {
  rows: Application[];
}

interface Row {
  id: string;
  company: string;
  role: string;
  status: ApplicationStatus;
  interview_at: string | null;
  offer_lpa: number | null;
  applied_at: string;
  notes: string[];
  rating: number | null;
  rating_source: 'ai' | 'user' | null;
  url: string;
  host: string;
  resume_name: string;
  offered_ctc: string;
  updated_at: number;
}

export interface ApplicationQuery {
  offset?: number;
  limit?: number;
  search?: string;
  status?: ApplicationStatus | 'all';
}

/** What the popup shows at a glance: how many forms, where they stand, and the next interviews. */
export interface TrackerSummary {
  total: number;
  counts: Record<ApplicationStatus, number>;
  /** Scheduled interviews that have not happened yet, soonest first. */
  upcoming: Array<{ id: string; company: string; role: string; resumeName: string; interviewAt: string }>;
  /** True when these numbers come only from this device. */
  localOnly: boolean;
}

export interface ApplicationPage {
  rows: Application[];
  hasMore: boolean;
  /** True when these rows come only from this device (not signed in / offline). */
  localOnly: boolean;
}

/** Same company + role is one application, however many times the form is opened. */
export function applicationKey(company: string, role: string, resumeName = ''): string {
  // With no role to tell postings apart, the resume used stands in for it.
  const what = normalizeText(role) || (resumeName ? `(${normalizeText(resumeName)})` : '');
  return `${normalizeText(company).toLowerCase()}|${what.toLowerCase()}`;
}

export function newApplication(input: Partial<Application> & { company: string; role: string }): Application {
  const now = Date.now();
  return {
    id: input.id ?? `app-${stableHash(applicationKey(input.company, input.role, input.resumeName) + now).toString(36)}-${now.toString(36)}`,
    company: input.company.trim().slice(0, 120),
    role: input.role.trim().slice(0, 160),
    status: input.status ?? 'applied',
    interviewAt: input.interviewAt ?? null,
    offerLpa: input.offerLpa ?? null,
    appliedAt: input.appliedAt ?? new Date(now).toISOString().slice(0, 10),
    notes: (input.notes ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 8),
    rating: clampRating(input.rating),
    ratingSource: input.rating ? (input.ratingSource ?? 'user') : null,
    url: input.url ?? '',
    host: input.host ?? '',
    resumeName: (input.resumeName ?? '').trim().slice(0, 80),
    offeredCtc: (input.offeredCtc ?? '').trim().slice(0, 80),
    updatedAt: now,
  };
}

export function clampRating(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : null;
}

/** Keeps what the form allows for each status, so stale data never lingers. */
export function normalizeApplication(app: Application): Application {
  return {
    ...app,
    status: APPLICATION_STATUSES.includes(app.status) ? app.status : 'applied',
    interviewAt: app.status === 'interview' ? app.interviewAt : null,
    offerLpa: app.status === 'offer' && app.offerLpa !== null && Number.isFinite(Number(app.offerLpa)) ? Number(app.offerLpa) : null,
    rating: clampRating(app.rating),
    ratingSource: clampRating(app.rating) ? app.ratingSource : null,
    notes: app.notes.map((n) => n.trim()).filter(Boolean).slice(0, 8),
    offeredCtc: (app.offeredCtc ?? '').trim().slice(0, 80),
    updatedAt: Date.now(),
  };
}

const toRow = (app: Application, userId: string): Row & { user_id: string } => ({
  user_id: userId,
  id: app.id,
  company: app.company,
  role: app.role,
  status: app.status,
  interview_at: app.interviewAt,
  offer_lpa: app.offerLpa,
  applied_at: app.appliedAt,
  notes: app.notes,
  rating: app.rating,
  rating_source: app.ratingSource,
  url: app.url,
  host: app.host,
  resume_name: app.resumeName,
  offered_ctc: app.offeredCtc,
  updated_at: app.updatedAt,
});

const fromRow = (row: Row): Application => ({
  id: row.id,
  company: row.company,
  role: row.role,
  status: row.status,
  interviewAt: row.interview_at,
  offerLpa: row.offer_lpa === null ? null : Number(row.offer_lpa),
  appliedAt: row.applied_at,
  notes: row.notes ?? [],
  rating: row.rating,
  ratingSource: row.rating_source,
  url: row.url ?? '',
  host: row.host ?? '',
  resumeName: row.resume_name ?? '',
  offeredCtc: row.offered_ctc ?? '',
  updatedAt: Number(row.updated_at),
});

/**
 * Applications live in the cloud database and are fetched a page at a time (100
 * rows) only when the Database view is opened. When the user is signed out or
 * offline, rows are kept on this device and uploaded the next time they can be.
 */
export class ApplicationStore {
  constructor(
    private readonly storage: Pick<Storage, 'read' | 'put'>,
    private readonly client: CloudClient,
  ) {}

  private async readLocal(): Promise<Application[]> {
    return (await this.storage.read<LocalApplications>(LOCAL_KEY))?.rows ?? [];
  }

  private async writeLocal(rows: Application[]): Promise<void> {
    await this.storage.put(LOCAL_KEY, { rows } satisfies LocalApplications);
  }

  async pendingCount(): Promise<number> {
    return (await this.readLocal()).length;
  }

  /** Creates the application unless the same company + role is already tracked. */
  async track(
    draft: Partial<Application> & { company: string; role: string },
    /** Only called for a new application (it may be slow, e.g. an AI call). May refine the company and role. */
    enrich?: () => Promise<Partial<Application>>,
  ): Promise<{ app: Application; created: boolean }> {
    // The same page, or the same company and role, is the same application however often it is filled.
    const known = (await this.findByUrl(draft.url)) ?? (await this.findByKey(applicationKey(draft.company, draft.role, draft.resumeName)));
    if (known) return { app: known, created: false };

    const merged = { ...draft, ...(enrich ? await enrich() : {}) } as Partial<Application> & { company: string; role: string };
    // Reading the whole form may have named the company or role differently; check again before adding a copy.
    const sameAsMerged = applicationKey(merged.company, merged.role, merged.resumeName);
    if (sameAsMerged !== applicationKey(draft.company, draft.role, draft.resumeName)) {
      const again = await this.findByKey(sameAsMerged);
      if (again) return { app: again, created: false };
    }
    const app = newApplication(merged);
    await this.save(app);
    return { app, created: true };
  }

  private async findByUrl(url: string | undefined): Promise<Application | undefined> {
    if (!url) return undefined;
    const local = (await this.readLocal()).find((row) => sameUrl(row.url, url));
    if (local) return local;
    if (!(await this.client.getSession())) return undefined;
    try {
      const rows = await this.client.json<Row[]>(`/rest/v1/applications?select=*&url=eq.${encodeURIComponent(url)}&limit=1`);
      return rows[0] ? fromRow(rows[0]) : undefined;
    } catch {
      return undefined;
    }
  }

  private async findByKey(key: string): Promise<Application | undefined> {
    const local = (await this.readLocal()).find((row) => applicationKey(row.company, row.role, row.resumeName) === key);
    if (local) return local;
    const session = await this.client.getSession();
    if (!session) return undefined;
    try {
      const [company, what] = key.split('|');
      const byResume = what.startsWith('(') && what.endsWith(')');
      const second = byResume
        ? `role=eq.&resume_name=ilike.${encodeURIComponent(escapeLike(what.slice(1, -1)))}`
        : `role=ilike.${encodeURIComponent(escapeLike(what))}`;
      const rows = await this.client.json<Row[]>(
        `/rest/v1/applications?select=*&company=ilike.${encodeURIComponent(escapeLike(company))}&${second}&limit=1`,
      );
      return rows[0] ? fromRow(rows[0]) : undefined;
    } catch {
      return undefined;
    }
  }

  async save(input: Application): Promise<Application> {
    const app = normalizeApplication(input);
    const session = await this.client.getSession();
    if (session) {
      try {
        await this.client.json(
          '/rest/v1/applications?on_conflict=id',
          { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(toRow(app, session.user.id)) },
        );
        await this.removeLocal(app.id);
        return app;
      } catch {
        /* fall through to the local queue */
      }
    }
    const local = (await this.readLocal()).filter((row) => row.id !== app.id);
    await this.writeLocal([app, ...local]);
    return app;
  }

  private async removeLocal(id: string): Promise<void> {
    const local = await this.readLocal();
    if (local.some((row) => row.id === id)) await this.writeLocal(local.filter((row) => row.id !== id));
  }

  async remove(id: string): Promise<void> {
    await this.removeLocal(id);
    if (!(await this.client.getSession())) return;
    await this.client.json(`/rest/v1/applications?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
  }

  /** Uploads rows waiting on this device. Safe to call any time. */
  async flush(): Promise<number> {
    const session = await this.client.getSession();
    const pending = await this.readLocal();
    if (!session || !pending.length) return 0;
    try {
      await this.client.json('/rest/v1/applications?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(pending.map((app) => toRow(app, session.user.id))),
      });
      await this.writeLocal([]);
      return pending.length;
    } catch {
      return 0;
    }
  }

  /**
   * Counts and the upcoming interviews, from the cloud when signed in (plus anything still
   * waiting on this device), otherwise from this device.
   */
  async summary(now = Date.now()): Promise<TrackerSummary> {
    const byId = new Map<string, Pick<Application, 'id' | 'company' | 'role' | 'resumeName' | 'status' | 'interviewAt'>>();
    let localOnly = true;
    if (await this.client.getSession()) {
      try {
        const rows = await this.client.json<Row[]>(
          '/rest/v1/applications?select=id,company,role,resume_name,status,interview_at&order=applied_at.desc&limit=2000',
          {},
          { timeoutMs: 6000 },
        );
        for (const row of rows) byId.set(row.id, { id: row.id, company: row.company, role: row.role, resumeName: row.resume_name ?? '', status: row.status, interviewAt: row.interview_at });
        localOnly = false;
      } catch {
        /* offline: fall back to this device */
      }
    }
    for (const row of await this.readLocal()) byId.set(row.id, row);

    const counts: Record<ApplicationStatus, number> = { applied: 0, interview: 0, offer: 0, rejected: 0 };
    const upcoming: TrackerSummary['upcoming'] = [];
    for (const row of byId.values()) {
      if (row.status in counts) counts[row.status] += 1;
      if (row.status !== 'interview' || !row.interviewAt) continue;
      const when = new Date(row.interviewAt).getTime();
      // A short grace period, so an interview that has just started still shows.
      if (Number.isFinite(when) && when >= now - 30 * 60 * 1000) {
        upcoming.push({ id: row.id, company: row.company, role: row.role, resumeName: row.resumeName, interviewAt: row.interviewAt });
      }
    }
    upcoming.sort((a, b) => new Date(a.interviewAt).getTime() - new Date(b.interviewAt).getTime());
    return { total: byId.size, counts, upcoming: upcoming.slice(0, 30), localOnly };
  }

  async list(query: ApplicationQuery = {}): Promise<ApplicationPage> {
    const limit = query.limit ?? CLOUD.pageSize;
    const offset = query.offset ?? 0;
    const session = await this.client.getSession();

    if (session) {
      try {
        await this.flush();
        const filters: string[] = [];
        if (query.status && query.status !== 'all') filters.push(`status=eq.${query.status}`);
        const search = query.search?.trim();
        if (search) {
          const term = encodeURIComponent(`*${escapeLike(search)}*`);
          filters.push(`or=(company.ilike.${term},role.ilike.${term})`);
        }
        // One extra row tells us whether another page exists without a count query.
        const path = `/rest/v1/applications?select=*&order=applied_at.desc,id.desc&limit=${limit + 1}&offset=${offset}${filters.length ? `&${filters.join('&')}` : ''}`;
        const rows = await this.client.json<Row[]>(path);
        return { rows: rows.slice(0, limit).map(fromRow), hasMore: rows.length > limit, localOnly: false };
      } catch {
        /* offline: show what this device has */
      }
    }

    const needle = query.search?.trim().toLowerCase();
    const all = (await this.readLocal())
      .filter((row) => !query.status || query.status === 'all' || row.status === query.status)
      .filter((row) => !needle || `${row.company} ${row.role}`.toLowerCase().includes(needle))
      .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt) || b.updatedAt - a.updatedAt);
    return { rows: all.slice(offset, offset + limit), hasMore: all.length > offset + limit, localOnly: true };
  }
}

/** Same page, ignoring the #fragment and tracking parameters. */
export function sameUrl(a: string, b: string): boolean {
  const norm = (value: string) => {
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key);
      url.hash = '';
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`.toLowerCase();
    } catch {
      return value;
    }
  };
  return Boolean(a) && Boolean(b) && norm(a) === norm(b);
}

/** Escapes characters that are wildcards in a PostgREST `ilike` pattern. */
function escapeLike(value: string): string {
  return value.replace(/[%_*(),]/g, ' ').trim();
}
