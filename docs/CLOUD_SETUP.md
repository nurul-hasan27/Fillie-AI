# Cloud setup (all free tiers)

Fillie's accounts, application database, backup, free-trial counter, payments and admin dashboard run on **Supabase** (free plan), with **Stripe** (cards, $5) and **Razorpay** (UPI, cards, netbanking, INR) for the one-time payment. Neither charges a monthly fee, only a small fee per payment. No other server is needed.

| Piece | Where it lives |
| --- | --- |
| Sign-in (email, Google, GitHub, Apple) | Supabase Auth |
| Applications, backups, licences | Supabase Postgres, protected by row-level security |
| Free-trial counter (3 per week, per device) | Supabase Edge Function `trial` |
| One-time payment | `create-checkout` starts Stripe or Razorpay checkout; `stripe-webhook` / `razorpay-webhook` unlock the user and record the payment |
| Admin dashboard | SQL functions in `0002_*.sql`, readable only by your verified Google account (see the website repo's `/admin`) |

## 1. Supabase project

1. Create a project at supabase.com (free plan).
2. **SQL editor**: run `supabase/migrations/0001_init.sql`, then `0002_payments_feedback_admin.sql`, then `0003_table_grants.sql` (without it the API roles have no table privileges and every request fails with `42501 permission denied`).
3. **Authentication → Providers**: enable Email, Google, GitHub and (optionally) Apple.
   - Google/GitHub: create an OAuth app in each console and paste the client id and secret.
   - Apple: needs your Apple Developer account (Services ID, key and team ID, entered in Supabase's Apple provider form).
4. **Authentication → URL configuration → Redirect URLs**: add `chrome-extension://<EXTENSION_ID>/pages/auth-callback.html`. Your extension ID is shown on `chrome://extensions` (it is fixed once the extension is published; for local testing, use the ID of your unpacked copy).
5. Copy the **Project URL** and **anon public key** into `src/core/cloud/config.ts`. The anon key is public by design; never put the `service_role` key in the extension.

## 2. Edge Functions

Install the Supabase CLI, then from the repo root:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase secrets set TRIAL_SALT=$(openssl rand -hex 16)
supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set RAZORPAY_KEY_ID=rzp_live_... RAZORPAY_KEY_SECRET=... RAZORPAY_WEBHOOK_SECRET=... RAZORPAY_AMOUNT_MINOR=44900
supabase secrets set SUCCESS_URL=https://your-site.com/thanks CANCEL_URL=https://your-site.com
supabase functions deploy trial
supabase functions deploy create-checkout
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy razorpay-webhook --no-verify-jwt
```

## 3. Stripe

1. Create a Stripe account (no monthly fee).
2. **Developers → Webhooks → Add endpoint**: `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`, event `checkout.session.completed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Test with Stripe's test keys and card `4242 4242 4242 4242` first, then switch to live keys.

## 3b. Razorpay

1. Create a Razorpay account and finish KYC (needed for live payments).
2. **Settings → API Keys**: generate a key; put the id and secret in the secrets above.
3. **Settings → Webhooks → Add**: URL `https://<project-ref>.supabase.co/functions/v1/razorpay-webhook`, a secret you choose (= `RAZORPAY_WEBHOOK_SECRET`), event **payment_link.paid**.
4. Make `RAZORPAY_AMOUNT_MINOR` (paise) match `razorpayLabel` in `src/core/cloud/config.ts` (44900 paise = ₹449).

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

## Troubleshooting payments

Both payment functions log one JSON line per problem (Supabase Dashboard → Edge Functions → the function → Logs). No keys or card data are ever logged.

| Symptom | Log line | Usual cause |
| --- | --- | --- |
| The Razorpay button shows an error such as "Razorpay: Authentication failed" | `checkout_failed` (provider razorpay) | Wrong `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`, test key with live mode (or the reverse), or the account's KYC is not finished. The extension shows Razorpay's own message. |
| "Razorpay is not set up" | `checkout_failed ... secret missing` | `RAZORPAY_KEY_ID` or `RAZORPAY_KEY_SECRET` secret missing. |
| Payment succeeds but Fillie stays locked | `razorpay_webhook_rejected` | `RAZORPAY_WEBHOOK_SECRET` is not exactly the secret typed in Razorpay → Settings → Webhooks. |
| Payment succeeds, no log line at all | (none) | The webhook is not saved in Razorpay, points at the wrong URL (`…/functions/v1/razorpay-webhook`), or is switched off. |
| `razorpay_webhook_received` with another type | `type: payment.captured`, etc. | Tick **payment_link.paid** in the webhook's events. |
| `payment_record_failed` | `step`, `code` | A database privilege or user problem; run `0003_table_grants.sql`. |

After paying, open the Account page and press **I have paid** (or just come back to the tab; it re-checks automatically).
