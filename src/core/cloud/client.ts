import type { Storage } from '../storage';
import { CLOUD } from './config';
import type { CloudSession, CloudUser, OAuthProvider } from './types';

export const SESSION_KEY = 'fillie:session';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

interface AuthResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { id: string; email?: string; app_metadata?: { provider?: string } };
  error_description?: string;
  msg?: string;
  message?: string;
}

/**
 * A small Supabase client written against the REST endpoints so the extension
 * keeps its zero-runtime-dependency rule. It owns the session, refreshes it
 * before it expires, and signs every request.
 */
export class CloudClient {
  constructor(
    private readonly storage: Pick<Storage, 'read' | 'put' | 'drop'>,
    private readonly options: { config?: typeof CLOUD; fetchImpl?: FetchFn; now?: () => number; timeoutMs?: number } = {},
  ) {}

  private get config() {
    return this.options.config ?? CLOUD;
  }
  private get now() {
    return this.options.now ?? Date.now;
  }
  private get fetchFn(): FetchFn {
    return this.options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * Every cloud call has a deadline. Without one, a stalled connection would leave
   * Fillie waiting on "scanning" forever; with one, callers fall back to what is on
   * this device (the local free-fill counter, the cached licence, the local queue).
   */
  private async timed(input: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
    const controller = new AbortController();
    // A call may ask for a shorter deadline than the client's own, never a longer one.
    const limit = Math.min(timeoutMs ?? Infinity, this.options.timeoutMs ?? 8000);
    const timer = setTimeout(() => controller.abort(), limit);
    try {
      return await this.fetchFn(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new CloudError('The server took too long to answer.', 0);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /* -------------------------------- session -------------------------------- */

  async getSession(): Promise<CloudSession | null> {
    const session = await this.storage.read<CloudSession>(SESSION_KEY);
    if (!session?.accessToken) return null;
    if (session.expiresAt - this.now() > 60_000) return session;
    return this.refresh(session);
  }

  private async refresh(session: CloudSession): Promise<CloudSession | null> {
    try {
      const response = await this.auth('/token?grant_type=refresh_token', { refresh_token: session.refreshToken });
      return await this.store(response, session.user.provider);
    } catch (error) {
      // A rejected refresh token means the session is gone; a network error does
      // not, so the stored session is kept for the next try.
      if (error instanceof CloudError && error.status >= 400 && error.status < 500) {
        await this.storage.drop(SESSION_KEY);
      }
      return null;
    }
  }

  private async store(response: AuthResponse, provider?: string): Promise<CloudSession> {
    if (!response.access_token || !response.refresh_token || !response.user) {
      throw new CloudError('The sign-in response was incomplete.');
    }
    const session: CloudSession = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: this.now() + (response.expires_in ?? 3600) * 1000,
      user: toUser(response.user, provider),
    };
    await this.storage.put(SESSION_KEY, session);
    return session;
  }

  /* --------------------------------- auth ---------------------------------- */

  private async auth(path: string, body: unknown): Promise<AuthResponse> {
    const response = await this.timed(`${this.config.supabaseUrl}/auth/v1${path}`, {
      method: 'POST',
      headers: { apikey: this.config.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as AuthResponse;
    if (!response.ok) {
      throw new CloudError(data.error_description ?? data.msg ?? data.message ?? 'Sign-in failed.', response.status);
    }
    return data;
  }

  async signInWithPassword(email: string, password: string): Promise<CloudSession> {
    return this.store(await this.auth('/token?grant_type=password', { email, password }), 'email');
  }

  /** Returns null when the project requires email confirmation first. */
  async signUp(email: string, password: string): Promise<CloudSession | null> {
    const data = await this.auth('/signup', { email, password });
    return data.access_token ? this.store(data, 'email') : null;
  }

  oauthUrl(provider: OAuthProvider, redirectTo: string): string {
    const params = new URLSearchParams({ provider, redirect_to: redirectTo });
    return `${this.config.supabaseUrl}/auth/v1/authorize?${params.toString()}`;
  }

  /** Reads the tokens Supabase puts in the redirect URL's fragment. */
  async completeOAuth(redirectedTo: string, provider: OAuthProvider): Promise<CloudSession> {
    const fragment = new URLSearchParams(new URL(redirectedTo).hash.replace(/^#/, ''));
    const error = fragment.get('error_description');
    if (error) throw new CloudError(error);
    const accessToken = fragment.get('access_token');
    const refreshToken = fragment.get('refresh_token');
    if (!accessToken || !refreshToken) throw new CloudError('Sign-in was cancelled.');

    const response = await this.timed(`${this.config.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: this.config.anonKey, Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new CloudError('Could not confirm the sign-in.', response.status);
    const user = (await response.json()) as AuthResponse['user'];
    return this.store(
      { access_token: accessToken, refresh_token: refreshToken, expires_in: Number(fragment.get('expires_in') ?? 3600), user },
      provider,
    );
  }

  async signOut(): Promise<void> {
    const session = await this.storage.read<CloudSession>(SESSION_KEY);
    await this.storage.drop(SESSION_KEY);
    if (!session) return;
    // Best effort: the local session is already gone.
    await this.timed(`${this.config.supabaseUrl}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: this.config.anonKey, Authorization: `Bearer ${session.accessToken}` },
    }).catch(() => undefined);
  }

  /* ---------------------------- authenticated calls ---------------------------- */

  /** Calls PostgREST (`/rest/v1/...`) or an Edge Function (`/functions/v1/...`). */
  async request(path: string, init: RequestInit = {}, options: { anonymous?: boolean; timeoutMs?: number } = {}): Promise<Response> {
    const session = options.anonymous ? null : await this.getSession();
    if (!options.anonymous && !session) throw new CloudError('You are not signed in.', 401);
    const headers = new Headers(init.headers);
    headers.set('apikey', this.config.anonKey);
    headers.set('Authorization', `Bearer ${session?.accessToken ?? this.config.anonKey}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return this.timed(`${this.config.supabaseUrl}${path}`, { ...init, headers }, options.timeoutMs);
  }

  async json<T>(path: string, init: RequestInit = {}, options: { anonymous?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const response = await this.request(path, init, options);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
      throw new CloudError(body.message ?? body.error ?? `Request failed (${response.status}).`, response.status);
    }
    // Writes use `return=minimal`, which answers 201/204 with an empty body.
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

function toUser(user: NonNullable<AuthResponse['user']>, provider?: string): CloudUser {
  return { id: user.id, email: user.email ?? '', provider: provider ?? user.app_metadata?.provider };
}
