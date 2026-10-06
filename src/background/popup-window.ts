/**
 * Creates the sign-in window. Placing a window precisely is the part most likely
 * to be refused (multi-monitor layouts, maximised or minimised parents, small
 * screens: "Bounds must be at least 50% within visible screen space"), so the
 * placement is attempted first and dropped, step by step, if the browser says no.
 * Signing in matters more than where the window lands.
 */
export interface WindowsApi {
  getLastFocused(): Promise<{ left?: number; top?: number; width?: number; height?: number } | undefined>;
  create(options: Record<string, unknown>): Promise<{ id?: number } | undefined>;
}

export const AUTH_WINDOW = { width: 480, height: 720 };

/** Centres a window of `size` over `parent`, never off the top-left of the screen. */
export function centreOver(
  parent: { left?: number; top?: number; width?: number; height?: number } | undefined,
  size = AUTH_WINDOW,
): { left: number; top: number } {
  const left = (parent?.left ?? 0) + ((parent?.width ?? 1200) - size.width) / 2;
  const top = (parent?.top ?? 0) + ((parent?.height ?? 800) - size.height) / 2;
  return { left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)) };
}

export async function createAuthWindow(api: WindowsApi, url: string): Promise<number> {
  const parent = await api.getLastFocused().catch(() => undefined);
  const attempts: Array<Record<string, unknown>> = [
    { url, type: 'popup', focused: true, ...AUTH_WINDOW, ...centreOver(parent) }, // centred
    { url, type: 'popup', focused: true, ...AUTH_WINDOW }, // sized, placed by the browser
    { url, type: 'popup', focused: true }, // as a last resort, still a separate window
  ];
  let lastError: unknown;
  for (const options of attempts) {
    try {
      const created = await api.create(options);
      if (created?.id !== undefined) return created.id;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('The browser did not open the sign-in window.');
}
