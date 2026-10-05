# Cloud setup (all free tiers)

Fillie's accounts, application database, backup, free-trial counter and one-time payment run on **Supabase** (free plan) and **Stripe** (no monthly fee, a small fee per payment). No other server is needed.

| Piece | Where it lives |
| --- | --- |
| Sign-in (email, Google, GitHub, Apple) | Supabase Auth |
| Applications, backups, licences | Supabase Postgres, protected by row-level security |
| Free-trial counter (3 per week, per device) | Supabase Edge Function `trial` |
| $5 payment | Stripe Checkout via Edge Functions `create-checkout` and `stripe-webhook` |

## 1. Supabase project

1. Create a project at supabase.com (free plan).
2. **SQL editor**: paste and run `supabase/migrations/0001_init.sql`.
3. **Authentication → Providers**: enable Email, Google, GitHub and (optionally) Apple.
   - Google/GitHub: create an OAuth app in each console and paste the client id and secret.
   - **Apple needs a paid Apple Developer account ($99/year).** Skip it if you want zero cost; the sign-in button then reports an error, so remove it from `src/pages/views/account.ts`.
4. **Authentication → URL configuration → Redirect URLs**: add `https://<EXTENSION_ID>.chromiumapp.org/`. Your extension ID is shown on `chrome://extensions` (it is fixed once the extension is published; for local testing, use the ID of your unpacked copy).
5. Copy the **Project URL** and **anon public key** into `src/core/cloud/config.ts`. The anon key is public by design; never put the `service_role` key in the extension.

## 2. Edge Functions

Install the Supabase CLI, then from the repo root:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase secrets set TRIAL_SALT=$(openssl rand -hex 16)
supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set SUCCESS_URL=https://your-site.com/thanks CANCEL_URL=https://your-site.com
supabase functions deploy trial
supabase functions deploy create-checkout
supabase functions deploy stripe-webhook --no-verify-jwt
```

## 3. Stripe

1. Create a Stripe account (no monthly fee).
2. **Developers → Webhooks → Add endpoint**: `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`, event `checkout.session.completed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Test with Stripe's test keys and card `4242 4242 4242 4242` first, then switch to live keys.

## 4. Keep the free database awake

Supabase pauses free projects after ~1 week of no activity. The workflow in `.github/workflows/keepalive.yml` pings it twice a week. Add the repository secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY`. (Paused projects keep their data and can be resumed, but users would be locked out until you do.)

## 5. Build for the store

```bash
npm run package      # refuses to build while config.ts still has placeholders
```

Upload `release/fillie-extension.zip` to the Chrome Web Store.

## Things to know

- **Local-first.** Profile, resumes, memory and settings live on the device. When signed in they are also backed up (API keys are never uploaded). If the browser data is cleared, the next form filling restores the backup.
- **Applications** are stored in the cloud and loaded 100 at a time when the Database page is opened. Signed-out rows wait on the device and upload after sign-in.
- **The free-trial limit is a deterrent, not a lock.** The count is kept on the server against a hashed install id, a hashed hardware fingerprint (the same across browsers on one computer) and a hashed IP, so reinstalling, incognito and switching browser do not reset it. A determined person who edits the extension's code can still bypass any check that runs in their own browser; that is true of every browser extension.
- **Privacy policy.** The Chrome Web Store requires a privacy policy that discloses: email (sign-in), the hashed device identifiers above (free-trial counting), and backed-up profile data. Say that API keys never leave the device.
