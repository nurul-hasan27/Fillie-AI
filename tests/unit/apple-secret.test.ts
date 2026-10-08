// @vitest-environment node
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { APPLE_SECRET_LIFETIME_SECONDS, buildAppleClientSecret, needsRotation, pemToDer } from '../../supabase/functions/_shared/apple-secret';
import { rotateAppleSecret, type RotationEnv, type RotationStore } from '../../supabase/functions/_shared/apple-rotation';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const creds = { teamId: 'TEAM123456', keyId: 'KEY1234567', servicesId: 'com.example.fillie.web', privateKey: pem };
const DAY = 86_400;
const NOW = 1_800_000_000;
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString());

describe('Apple client secret', () => {
  it('is an ES256 token with the claims Apple requires', async () => {
    const { token, expiresAt } = await buildAppleClientSecret(creds, NOW);
    const [h, c] = token.split('.');
    expect(decode(h!)).toEqual({ alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
    expect(decode(c!)).toEqual({ iss: 'TEAM123456', iat: NOW, exp: NOW + APPLE_SECRET_LIFETIME_SECONDS, aud: 'https://appleid.apple.com', sub: 'com.example.fillie.web' });
    expect(expiresAt).toBe(NOW + APPLE_SECRET_LIFETIME_SECONDS);
  });

  it('is signed with the private key, so Apple can verify it with the public key', async () => {
    const { token } = await buildAppleClientSecret(creds, NOW);
    const [h, c, sig] = token.split('.');
    const ok = createVerify('SHA256').update(`${h}.${c}`).verify({ key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'));
    expect(ok).toBe(true);
    const tampered = createVerify('SHA256').update(`${h}.${c}x`).verify({ key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'));
    expect(tampered).toBe(false);
  });

  it('never asks for longer than Apple allows (about 6 months)', () => {
    expect(APPLE_SECRET_LIFETIME_SECONDS).toBeLessThanOrEqual(15_777_000);
  });

  it('accepts a key whose line breaks were flattened to \\n by a secret store', async () => {
    const flat = pem.trim().replace(/\n/g, '\\n');
    const { token } = await buildAppleClientSecret({ ...creds, privateKey: flat }, NOW);
    expect(token.split('.')).toHaveLength(3);
    expect(pemToDer(flat)).toEqual(pemToDer(pem));
  });

  it('rejects a malformed key with a clear message and never echoes it', async () => {
    await expect(buildAppleClientSecret({ ...creds, privateKey: 'not a key !!!' }, NOW)).rejects.toThrow('APPLE_PRIVATE_KEY is not a valid .p8 key.');
    await expect(buildAppleClientSecret({ ...creds, privateKey: '' }, NOW)).rejects.toThrow(/valid .p8/);
  });

  it('decides when a secret is due: unknown, or within the renewal window', () => {
    expect(needsRotation(null, NOW)).toBe(true);
    expect(needsRotation(undefined, NOW)).toBe(true);
    expect(needsRotation(NOW + 100 * DAY, NOW)).toBe(false);
    expect(needsRotation(NOW + 45 * DAY, NOW)).toBe(true);
    expect(needsRotation(NOW + 46 * DAY, NOW)).toBe(false);
    expect(needsRotation(NOW + 10 * DAY, NOW, 5)).toBe(false);
    expect(needsRotation(NOW - DAY, NOW)).toBe(true);
  });
});

const env: RotationEnv = { ...creds, managementToken: 'sbp_test_token_value', projectRef: 'erhrkrcbcugckaczavsm' };
const memory = (expiry: number | null = null): RotationStore & { saved: Array<[number, number]> } => {
  const saved: Array<[number, number]> = [];
  return { saved, getExpiry: async () => expiry, setExpiry: async (e, r) => void saved.push([e, r]) };
};
const ok = () => vi.fn(async () => new Response('{}', { status: 200 }));

describe('rotateAppleSecret', () => {
  it('renews when nothing has been set yet, and updates Supabase Auth through the management API', async () => {
    const store = memory(null);
    const fetchMock = ok();
    const result = await rotateAppleSecret(env, store, fetchMock, {}, NOW);
    expect(result).toMatchObject({ ok: true, rotated: true, reason: 'renewed', daysLeft: 180 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/erhrkrcbcugckaczavsm/config/auth');
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sbp_test_token_value');
    const sent = JSON.parse(String(init.body)) as { external_apple_secret: string };
    expect(Object.keys(sent)).toEqual(['external_apple_secret']); // nothing else about the auth config is touched
    expect(decode(sent.external_apple_secret.split('.')[1]!).sub).toBe('com.example.fillie.web');
    expect(store.saved).toEqual([[NOW + APPLE_SECRET_LIFETIME_SECONDS, NOW]]);
  });

  it('does nothing while the current secret has plenty of time left', async () => {
    const store = memory(NOW + 120 * DAY);
    const fetchMock = ok();
    expect(await rotateAppleSecret(env, store, fetchMock, {}, NOW)).toMatchObject({ ok: true, rotated: false, reason: 'still_valid', daysLeft: 120 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.saved).toEqual([]);
  });

  it('renews when the secret is inside the 45-day window, and sooner or later if configured', async () => {
    expect(await rotateAppleSecret(env, memory(NOW + 30 * DAY), ok(), {}, NOW)).toMatchObject({ rotated: true });
    expect(await rotateAppleSecret({ ...env, rotateBeforeDays: 10 }, memory(NOW + 30 * DAY), ok(), {}, NOW)).toMatchObject({ rotated: false });
  });

  it('can be forced, and can be asked what it would do without doing it', async () => {
    const fetchMock = ok();
    expect(await rotateAppleSecret(env, memory(NOW + 150 * DAY), fetchMock, { force: true }, NOW)).toMatchObject({ rotated: true });
    const dry = ok();
    expect(await rotateAppleSecret(env, memory(NOW + 10 * DAY), dry, { dryRun: true }, NOW)).toMatchObject({ rotated: false, reason: 'dry_run_due' });
    expect(await rotateAppleSecret(env, memory(NOW + 150 * DAY), dry, { dryRun: true }, NOW)).toMatchObject({ reason: 'dry_run_not_due' });
    expect(dry).not.toHaveBeenCalled();
  });

  it('does not remember a rotation that Supabase refused, so the next run tries again', async () => {
    const store = memory(null);
    const result = await rotateAppleSecret(env, store, vi.fn(async () => new Response('{"message":"Unauthorized"}', { status: 401 })), {}, NOW);
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(result)).not.toContain('sbp_test_token_value');
    expect(store.saved).toEqual([]);
  });

  it('names every missing setting, and never a value', async () => {
    const fetchMock = ok();
    const result = await rotateAppleSecret({ teamId: 'T' }, memory(), fetchMock, {}, NOW);
    expect(result).toMatchObject({ ok: false, status: 500, missing: ['APPLE_KEY_ID', 'APPLE_SERVICES_ID', 'APPLE_PRIVATE_KEY', 'SUPABASE_MANAGEMENT_TOKEN', 'SUPABASE_PROJECT_REF'] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a project reference that could change the request address', async () => {
    const fetchMock = ok();
    expect(await rotateAppleSecret({ ...env, projectRef: '../evil' }, memory(), fetchMock, {}, NOW)).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a bad private key without calling Supabase or leaking the key', async () => {
    const fetchMock = ok();
    const result = await rotateAppleSecret({ ...env, privateKey: 'garbage' }, memory(), fetchMock, {}, NOW);
    expect(result).toMatchObject({ ok: false, status: 500, error: 'APPLE_PRIVATE_KEY is not a valid .p8 key.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still reports success, with a warning, when only remembering the expiry fails', async () => {
    const store: RotationStore = { getExpiry: async () => null, setExpiry: async () => { throw new Error('relation "platform_settings" does not exist'); } };
    const result = await rotateAppleSecret(env, store, ok(), {}, NOW);
    expect(result).toMatchObject({ ok: true, rotated: true, warning: expect.stringContaining('platform_settings') });
  });

  it('never returns the secret it created', async () => {
    const result = await rotateAppleSecret(env, memory(), ok(), {}, NOW);
    expect(JSON.stringify(result)).not.toMatch(/eyJ|BEGIN PRIVATE/);
  });
});
