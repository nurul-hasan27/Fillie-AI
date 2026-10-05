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
  updated_at: number;
}

export interface ApplicationQuery {
  offset?: number;
  limit?: number;
  search?: string;
  status?: ApplicationStatus | 'all';
}

export interface ApplicationPage {
  rows: Application[];
  hasMore: boolean;
  /** True when these rows come only from this device (not signed in / offline). */
  localOnly: boolean;
}

/** Same company + role is one application, however many times the form is opened. */
export function applicationKey(company: string, role: string): string {
  return `${normalizeText(company).toLowerCase()}|${normalizeText(role).toLowerCase()}`;
}

export function newApplication(input: Partial<Application> & { company: string; role: string }): Application {
  const now = Date.now();
  return {
    id: input.id ?? `app-${stableHash(applicationKey(input.company, input.role) + now).toString(36)}-${now.toString(36)}`,
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
    /** Only called for a new application (it may be slow, e.g. an AI call). */
    enrich?: () => Promise<Partial<Application>>,
  ): Promise<{ app: Application; created: boolean }> {
    const key = applicationKey(draft.company, draft.role);
    const existing = await this.findByKey(key);
    if (existing) return { app: existing, created: false };
    const app = newApplication({ ...draft, ...(enrich ? await enrich() : {}) });
    await this.save(app);
    return { app, created: true };
  }

  private async findByKey(key: string): Promise<Application | undefined> {
    const local = (await this.readLocal()).find((row) => applicationKey(row.company, row.role) === key);
    if (local) return local;
    const session = await this.client.getSession();
    if (!session) return undefined;
    try {
      const [company, role] = key.split('|');
      const rows = await this.client.json<Row[]>(
        `/rest/v1/applications?select=*&company=ilike.${encodeURIComponent(escapeLike(company))}&role=ilike.${encodeURIComponent(escapeLike(role))}&limit=1`,
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

/** Escapes characters that are wildcards in a PostgREST `ilike` pattern. */
function escapeLike(value: string): string {
  return value.replace(/[%_*(),]/g, ' ').trim();
}
