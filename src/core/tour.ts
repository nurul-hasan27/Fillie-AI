/**
 * Which parts of the guided tour a person has already seen. Kept in the extension's local storage so the
 * welcome tour, the section tips, the popup tip and the first-heart tip each show once.
 */
export const TOUR_KEY = 'fillie:tour';

export interface TourState {
  /** The welcome tour was finished or skipped. */
  welcome: boolean;
  /** Tips already shown, by name (for example "database", "heart"). */
  seen: Record<string, true>;
  /** Lets automated tests see the tour; normal browsers always can. */
  force?: boolean;
}

export const EMPTY_TOUR: TourState = { welcome: false, seen: {} };

interface Area {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const area = (): Area | undefined => (globalThis as { chrome?: { storage?: { local?: Area } } }).chrome?.storage?.local;

export function cleanTour(value: unknown): TourState {
  const raw = (value ?? {}) as Partial<TourState>;
  const seen: Record<string, true> = {};
  for (const [key, flag] of Object.entries(raw.seen ?? {})) if (flag === true && /^[a-z0-9-]{1,40}$/.test(key)) seen[key] = true;
  return { welcome: raw.welcome === true, seen, ...(raw.force === true ? { force: true } : {}) };
}

export async function readTour(storage: Area | undefined = area()): Promise<TourState> {
  try {
    return cleanTour((await storage?.get(TOUR_KEY))?.[TOUR_KEY]);
  } catch {
    return { ...EMPTY_TOUR, seen: {} };
  }
}

async function update(change: (state: TourState) => TourState, storage: Area | undefined = area()): Promise<TourState> {
  const next = change(await readTour(storage));
  try {
    await storage?.set({ [TOUR_KEY]: next });
  } catch {
    /* the tour is a nicety; never fail because of it */
  }
  return next;
}

export const markSeen = (key: string, storage?: Area) => update((s) => ({ ...s, seen: { ...s.seen, [key]: true } }), storage);
export const markWelcomeDone = (storage?: Area) => update((s) => ({ ...s, welcome: true }), storage);
/** "Take the tour again": forget everything that was shown. */
export const resetTour = (storage?: Area) => update((s) => ({ welcome: false, seen: {}, ...(s.force ? { force: true } : {}) }), storage);

/** Browsers driven by automation (tests) skip the tour unless it was asked for, so it never gets in their way. */
export function tourAllowed(state: TourState, automated = typeof navigator !== 'undefined' && navigator.webdriver === true): boolean {
  return !automated || state.force === true;
}

export const shouldShow = (state: TourState, key: string, automated?: boolean): boolean => tourAllowed(state, automated) && !state.seen[key];

/** Marks several tips as seen with one write (after the welcome tour covered them). */
export const markManySeen = (keys: string[], storage?: Area) =>
  update((s) => ({ ...s, seen: { ...s.seen, ...Object.fromEntries(keys.map((key) => [key, true as const])) } }), storage);
