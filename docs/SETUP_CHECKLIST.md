# Launch checklist (do these in order)

Everything below uses free plans. Payment providers only take a small fee per payment.

## A. Supabase (accounts, database, server functions)
1. Create a project at supabase.com. Note the **Project URL**, **anon public key**, and **project ref**.
2. SQL editor: run `supabase/migrations/0001_init.sql`, then `0002_payments_feedback_admin.sql`, then `0003_table_grants.sql` (required: it gives the server and signed-in users their table privileges).
3. Authentication → **Sign In / Providers**: turn on **Email** (enable "Confirm email"), **Google**, **GitHub** and **Apple**. Each needs a client id/secret from its console (Apple: Services ID + key from your developer account). Add Google first; the admin dashboard needs it.
4. Authentication → **URL Configuration**:
   - Site URL: your Vercel site.
   - Redirect URLs: `https://<your-site>/admin` and `https://<EXTENSION_ID>.chromiumapp.org/`.
5. Install the CLI (`npm i -g supabase`), then `supabase login` and `supabase link --project-ref <ref>`.

## B. Payments
**Stripe**: create an account, copy the secret key. Add a webhook to `https://<ref>.supabase.co/functions/v1/stripe-webhook` for `checkout.session.completed`; copy its signing secret.
**Razorpay**: complete KYC, create API keys (Settings → API Keys). Add a webhook to `https://<ref>.supabase.co/functions/v1/razorpay-webhook` for `payment_link.paid` with a secret you choose.

## C. Deploy the server functions
```bash
supabase secrets set TRIAL_SALT=$(openssl rand -hex 16)
supabase secrets set SUCCESS_URL=https://<your-site>/ CANCEL_URL=https://<your-site>/
supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set RAZORPAY_KEY_ID=rzp_live_... RAZORPAY_KEY_SECRET=... RAZORPAY_WEBHOOK_SECRET=... RAZORPAY_AMOUNT_MINOR=42000
supabase functions deploy trial
supabase functions deploy create-checkout
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy razorpay-webhook --no-verify-jwt
```
Test with Stripe test keys and card `4242 4242 4242 4242` and Razorpay test mode first, then switch to live keys.

## D. Extension
1. Put the Project URL and anon key in `src/core/cloud/config.ts`. Check `razorpayLabel` matches `RAZORPAY_AMOUNT_MINOR`.
2. `npm run package` (it refuses while placeholders remain). This creates `release/fillie-extension.zip`.
3. Chrome Web Store developer dashboard (one-time $5 fee): upload the zip, add screenshots, a **privacy policy URL**, and the data-use disclosures (email, hashed device id for the free-trial count, backed-up profile data; API keys stay on the device). Submit for review.
4. When approved, copy the extension ID and (a) add `https://<EXTENSION_ID>.chromiumapp.org/` to the Supabase redirect URLs, (b) paste the store URL into the website config.

## E. Website (fillie-website repo)
1. Edit `src/config.ts`: `storeUrl`, `SUPABASE.url`, `SUPABASE.anonKey`. Keep `ADMIN_EMAIL`.
2. Push to GitHub, import into Vercel, deploy.
3. Open `https://<your-site>/admin`, sign in with Google as the admin address. If it says "not authorised", check step A3 (Google provider) and that the address in `0002_*.sql` (`is_admin`) matches yours.

## F. Keep it running
1. GitHub repo secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY` so `.github/workflows/keepalive.yml` keeps the free project awake.
2. Write the privacy policy page and link it in the store listing and the website footer.
3. Decide the repository license now that the product is paid (the repo is still MIT).
