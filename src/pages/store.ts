import type { UserProfile } from '../core/types';
import { createEmptyProfile } from '../core/profile';
import { sendMessage } from '../shared/messages';

/** Single source of truth for the app tab's profile + autosave. */

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface ProfileStore {
  get(): UserProfile;
  set(profile: UserProfile): void;
  subscribe(listener: (profile: UserProfile) => void): () => void;
  save(): Promise<UserProfile>;
  saveState(): SaveState;
}

export function createProfileStore(initial: UserProfile): ProfileStore {
  let current = initial;
  let state: SaveState = 'idle';
  const listeners = new Set<(profile: UserProfile) => void>();
  let pending: Promise<UserProfile> | null = null;

  return {
    get: () => current,
    set(profile) {
      current = profile;
      for (const listener of listeners) listener(current);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    saveState: () => state,
    async save() {
      if (pending) return pending;
      state = 'saving';
      pending = (async () => {
        try {
          const saved = await sendMessage<UserProfile>({ type: 'fillie:save-profile', profile: current });
          current = saved ?? current;
          state = 'saved';
          return current;
        } catch (error) {
          state = 'error';
          throw error;
        } finally {
          pending = null;
        }
      })();
      return pending;
    },
  };
}

export async function loadProfile(): Promise<UserProfile> {
  try {
    const profile = await sendMessage<UserProfile>({ type: 'fillie:get-profile' });
    return profile ?? createEmptyProfile();
  } catch {
    return createEmptyProfile();
  }
}

export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}