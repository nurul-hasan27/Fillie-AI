/**
 * Sign in with Apple does not take a fixed client secret: the "secret" is a short-lived ES256 token
 * that we sign ourselves with the private key (.p8) from the Apple Developer account. Apple allows
 * at most 6 months, which is why it has to be renewed. This file builds that token; it holds no state.
 */

/** Apple rejects a token valid for longer than 15,777,000 seconds (about 6 months). We use 180 days. */
export const APPLE_SECRET_LIFETIME_SECONDS = 180 * 24 * 60 * 60;

export interface AppleCredentials {
  teamId: string;
  keyId: string;
  /** The Services ID (the "client id" you gave Supabase), for example com.example.fillie.web. */
  servicesId: string;
  /** The contents of the AuthKey_XXXX.p8 file. Line breaks may be real or written as \n. */
  privateKey: string;
}

const b64url = (input: ArrayBuffer | Uint8Array | string): string => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Reads the .p8 text, even if a secret store flattened its line breaks into "\n", and returns the DER bytes. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error('APPLE_PRIVATE_KEY is not a valid .p8 key.');
  const binary = atob(body);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Builds and signs the client-secret token. `now` is in seconds since 1970. */
export async function buildAppleClientSecret(credentials: AppleCredentials, now = Math.floor(Date.now() / 1000)): Promise<{ token: string; expiresAt: number }> {
  const key = await crypto.subtle
    .importKey('pkcs8', pemToDer(credentials.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    .catch(() => {
      throw new Error('APPLE_PRIVATE_KEY is not a valid .p8 key.');
    });
  const expiresAt = now + APPLE_SECRET_LIFETIME_SECONDS;
  const header = { alg: 'ES256', kid: credentials.keyId, typ: 'JWT' };
  const claims = { iss: credentials.teamId, iat: now, exp: expiresAt, aud: 'https://appleid.apple.com', sub: credentials.servicesId };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  // WebCrypto returns the signature as r||s, which is exactly the format a JWT wants.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return { token: `${signingInput}.${b64url(signature)}`, expiresAt };
}

/** True when the current token is missing, unknown, or will expire within `beforeDays`. */
export function needsRotation(expiresAt: number | null | undefined, now = Math.floor(Date.now() / 1000), beforeDays = 45): boolean {
  if (!expiresAt || !Number.isFinite(expiresAt)) return true;
  return expiresAt - now <= beforeDays * 24 * 60 * 60;
}
