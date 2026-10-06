import { describe, expect, it } from 'vitest';
import { centreOver, createAuthWindow, type WindowsApi } from '../../src/background/popup-window';

const api = (create: WindowsApi['create'], parent = { left: 100, top: 50, width: 1400, height: 900 }): WindowsApi => ({
  getLastFocused: async () => parent,
  create,
});

describe('sign-in window', () => {
  it('centres over the browser window', () => {
    expect(centreOver({ left: 100, top: 50, width: 1400, height: 900 })).toEqual({ left: 560, top: 140 });
  });

  it('never asks for a position off the top-left of the screen', () => {
    expect(centreOver({ left: -8, top: -8, width: 300, height: 300 })).toEqual({ left: 0, top: 0 });
  });

  it('opens a centred popup when the browser accepts it', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const id = await createAuthWindow(api(async (o) => (seen.push(o), { id: 7 })), 'https://x');
    expect(id).toBe(7);
    expect(seen[0]).toMatchObject({ type: 'popup', width: 480, height: 720, left: 560, top: 140 });
  });

  it('drops the placement, then the size, if the browser refuses them', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const create: WindowsApi['create'] = async (o) => {
      seen.push(o);
      if ('left' in o) throw new Error('Invalid value for bounds. Bounds must be at least 50% within visible screen space.');
      if ('width' in o) throw new Error('bad size');
      return { id: 9 };
    };
    expect(await createAuthWindow(api(create), 'https://x')).toBe(9);
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({ type: 'popup' });
    expect('width' in seen[2]).toBe(false);
  });

  it('reports the browser\'s own message when nothing works', async () => {
    const create: WindowsApi['create'] = async () => {
      throw new Error('windows are disabled');
    };
    await expect(createAuthWindow(api(create), 'https://x')).rejects.toThrow('windows are disabled');
  });
});
