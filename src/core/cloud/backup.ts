import type { Storage } from '../storage';
import { normalizeProfile } from '../profile';
import type { AISettings, LearnedAnswer, ResumesState, UserProfile } from '../types';
import { CloudClient } from './client';

export const BACKUP_VERSION = 1;
/** Stay well under the database row/request limits. */
const MAX_BACKUP_CHARS = 1_500_000;

export interface Backup {
  version: number;
  profile: UserProfile;
  memory: LearnedAnswer[];
  resumes: ResumesState;
  /** Everything except API keys, which never leave this device. */
  settings: Omit<AISettings, 'config'> & { config: Omit<AISettings['config'], 'apiKey' | 'apiKeys'> };
  savedAt: number;
}

export function hasProfileData(profile: UserProfile): boolean {
  return Boolean(profile.personal.fullName.trim() || profile.personal.email.trim());
}

/** Builds the payload to upload. API keys and attached file contents are left out. */
export async function buildBackup(storage: Storage): Promise<Backup> {
  const [profile, memory, resumes, settings] = await Promise.all([
    storage.getProfile(),
    storage.getMemory(),
    storage.getResumes(),
    storage.getSettings(),
  ]);
  const { apiKey: _apiKey, apiKeys: _apiKeys, ...config } = settings.config;
  return {
    version: BACKUP_VERSION,
    profile: { ...profile, documents: (profile.documents ?? []).map(({ dataUrl: _dataUrl, ...doc }) => doc) as UserProfile['documents'] },
    memory,
    resumes,
    settings: { ...settings, config },
    savedAt: Date.now(),
  };
}

export class BackupService {
  constructor(
    private readonly storage: Storage,
    private readonly client: CloudClient,
  ) {}

  async upload(): Promise<{ ok: boolean; reason?: string }> {
    const session = await this.client.getSession();
    if (!session) return { ok: false, reason: 'Not signed in.' };
    const backup = await buildBackup(this.storage);
    // Never overwrite a good backup with an empty device.
    if (!hasProfileData(backup.profile) && !backup.memory.length && !backup.resumes.resumes.length) {
      return { ok: false, reason: 'Nothing to back up yet.' };
    }
    const body = JSON.stringify({ user_id: session.user.id, data: backup, updated_at: new Date().toISOString() });
    if (body.length > MAX_BACKUP_CHARS) return { ok: false, reason: 'Your data is too large to back up.' };
    try {
      await this.client.json('/rest/v1/backups?on_conflict=user_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'Backup failed.' };
    }
  }

  async fetch(): Promise<Backup | null> {
    const rows = await this.client.json<Array<{ data: Backup }>>('/rest/v1/backups?select=data&limit=1');
    return rows[0]?.data ?? null;
  }

  /** Writes a backup onto this device, keeping this device's own API keys. */
  async apply(backup: Backup): Promise<void> {
    await this.storage.saveProfile(normalizeProfile(backup.profile));
    await this.storage.saveMemory(backup.memory ?? []);
    await this.storage.saveResumes(backup.resumes ?? { resumes: [], defaultId: '' });
    const current = await this.storage.getSettings();
    await this.storage.saveSettings({
      ...current,
      ...backup.settings,
      config: { ...current.config, ...backup.settings.config, apiKey: current.config.apiKey, apiKeys: current.config.apiKeys },
    });
  }

  /**
   * Restores when this device has no profile yet, e.g. after the browser's
   * extension data was cleared. Returns true when something was restored.
   */
  async restoreIfEmpty(): Promise<boolean> {
    if (hasProfileData(await this.storage.getProfile())) return false;
    if (!(await this.client.getSession())) return false;
    try {
      const backup = await this.fetch();
      if (!backup || !hasProfileData(backup.profile)) return false;
      await this.apply(backup);
      return true;
    } catch {
      return false;
    }
  }
}
