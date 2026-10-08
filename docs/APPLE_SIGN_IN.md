# Sign in with Apple: automatic client-secret renewal

Supabase's Apple provider needs a **client secret** that is not a fixed password: it is a token signed with your Apple private key, and Apple only allows it to live **6 months**. When it expires, "Continue with Apple" stops working until someone makes a new one. Fillie renews it automatically.

## How it works

```
GitHub Actions (every Monday)  ->  Edge Function rotate-apple-secret  ->  Supabase Auth settings
   .github/workflows/rotate-apple-secret.yml     signs a new token with       (external_apple_secret)
   sends only a shared token                      your .p8 key, only when
                                                  < 45 days are left
```

* The **Apple private key never leaves Supabase**. It lives in Edge Function secrets; GitHub only holds a random token that lets it *ask* for a renewal.
* A new token is valid for **180 days** and is created when fewer than **45 days** remain, so a run that fails still leaves about six weekly retries before expiry. Runs in between do nothing.
* The expiry is remembered in `platform_settings` (key `apple_client_secret`, created by migration `0005_influencers.sql`). If that table is missing the renewal still works; you just get a warning and it renews on every run.
* If Apple or Supabase rejects a renewal, the workflow run **fails and GitHub emails you**. Nothing else changes.

## One-time setup

You need your Apple values from developer.apple.com (the ones already entered in Supabase's Apple provider form):

| Secret (Supabase Edge Function) | Where to find it |
| --- | --- |
| `APPLE_TEAM_ID` | Membership details, 10 characters |
| `APPLE_KEY_ID` | Certificates, Identifiers & Profiles → Keys → your "Sign in with Apple" key, 10 characters |
| `APPLE_SERVICES_ID` | Identifiers → Services IDs, for example `com.yourname.fillie.web` (the *Client ID* in Supabase) |
| `APPLE_PRIVATE_KEY` | The full contents of the downloaded `AuthKey_XXXXXXXXXX.p8` file, including the BEGIN/END lines |
| `SUPABASE_MANAGEMENT_TOKEN` | supabase.com → Account → Access Tokens → Generate new token (`sbp_…`). It can change your projects' settings, so keep it only here. Supabase does not allow secret names starting with `SUPABASE_`; if `secrets set` refuses this name, use `MANAGEMENT_ACCESS_TOKEN` and set the same name in `supabase/functions/rotate-apple-secret/index.ts`. |
| `APPLE_ROTATION_TOKEN` | Any long random string, at least 24 characters (`openssl rand -hex 32`). The same value goes into GitHub. |
| `APPLE_ROTATE_BEFORE_DAYS` | Optional, default `45` |

1. Set the secrets and deploy (the function must accept calls without a Supabase login, and checks `APPLE_ROTATION_TOKEN` itself):
   ```bash
   supabase secrets set APPLE_TEAM_ID=... APPLE_KEY_ID=... APPLE_SERVICES_ID=... \
     APPLE_ROTATION_TOKEN=$(openssl rand -hex 32) SUPABASE_MANAGEMENT_TOKEN=sbp_...
   supabase secrets set APPLE_PRIVATE_KEY="$(cat AuthKey_XXXXXXXXXX.p8)"
   supabase functions deploy rotate-apple-secret --no-verify-jwt
   ```
2. In GitHub → repository → Settings → Secrets and variables → Actions, add `SUPABASE_URL` (already there for the keep-alive job) and `APPLE_ROTATION_TOKEN` (the value you set above; read it back with `supabase secrets list` is not possible, so keep a copy).
3. Check it without changing anything:
   ```bash
   curl -sS -X POST "$SUPABASE_URL/functions/v1/rotate-apple-secret" \
     -H "Authorization: Bearer $APPLE_ROTATION_TOKEN" -H "Content-Type: application/json" -d '{"dryRun": true}'
   ```
   It answers `{"ok":true,"rotated":false,"reason":"dry_run_due",…}` on the first run.
4. Run it once for real: GitHub → Actions → **rotate-apple-secret** → Run workflow (tick *force* if you want to renew even though the current secret is fine). Then try "Continue with Apple" on the site.

After that nothing needs doing. The Apple *key* itself does not expire (but if you revoke it in the Apple console, update `APPLE_PRIVATE_KEY` and `APPLE_KEY_ID`, deploy, and force a run).

## Safety notes

* The function answers only to a request carrying `APPLE_ROTATION_TOKEN` (constant-time check), and never returns or logs the key, the management token or the generated secret.
* It sends exactly one field to Supabase (`external_apple_secret`), so no other auth setting can be changed by it.
* Rotating the token does not sign anybody out: it only affects the next Apple sign-in.

## Tests

`npx vitest run tests/unit/apple-secret.test.ts` checks the token against Apple's rules (ES256, claims, 180 days), verifies its signature with the matching public key, and covers when a renewal is due, a refused update, a bad key, missing settings and that nothing secret is returned. The Edge Function wrapper (`index.ts`) and the real Apple and Supabase calls are not exercised by tests; use the dry run and a forced run above to check them in your project.
