# Go live: deploying the backend and website, and publishing the extension

Do the parts in this order. Everything in Part 1 only *adds* to your database, so it can be done on the live project without losing data.

## Part 1. Deploy the backend and the website

You need the Supabase CLI logged in (`supabase login`) and linked to the project (`supabase link --project-ref erhrkrcbcugckaczavsm`).

### 1. Apply the database migrations (0005 to 0009)

Run from the `Fillie` folder, one at a time and in this order. Each is one transaction: if it fails, nothing from that file is kept.

```bash
supabase db query --linked -f supabase/migrations/0005_influencers.sql
supabase db query --linked -f supabase/migrations/0006_influencer_api.sql
supabase db query --linked -f supabase/migrations/0007_influencer_admin.sql
supabase db query --linked -f supabase/migrations/0008_public_offers.sql
supabase db query --linked -f supabase/migrations/0009_saved_answers.sql
```

`0009` adds the column that holds hearted answers ("Interview prep"). The extension writes it on every application save, so **apply it before the extension update goes out**, or saving applications fails until it is there.

(Use this instead of `supabase db push`: migrations 0001 to 0004 were applied by hand, so `db push` does not know about them and could try to run them again. You can also paste each file into the Supabase **SQL editor**.)

Check it worked:

```bash
supabase db query --linked "select key from public.platform_settings order by key"
supabase db query --linked "select count(*) from storage.buckets where id in ('influencer-photos','influencer-proofs')"
```

The first lists the programme settings, the second returns `2`.

### 2. Deploy the Edge Functions

`create-checkout` must go out **before** the website, because the payment window now asks it to price codes.

```bash
supabase functions deploy create-checkout
supabase functions deploy confirm-payment
supabase functions deploy razorpay-webhook --no-verify-jwt
```

Optional, for automatic Sign in with Apple renewal: set its secrets and deploy `rotate-apple-secret` as described in `docs/APPLE_SIGN_IN.md`.

### 3. Point the payment return address at the new domain

```bash
supabase secrets set SUCCESS_URL="https://www.fillie.app/?payment=success"
supabase functions deploy create-checkout   # picks up the new value
```

### 4. Website, domain and sign-in addresses

1. Push the website repo (`fillie-website`) to GitHub; Vercel deploys `main` on its own. Push this repo too.
2. **Vercel → Project → Settings → Domains**: add `www.fillie.app` (make it primary) and `fillie.app` (choose *Redirect to www.fillie.app*, permanent 308). Create the DNS records Vercel shows at your registrar and wait for both to turn green.
3. **Supabase → Authentication → URL Configuration**: Site URL `https://www.fillie.app`; Redirect URLs add `https://www.fillie.app/**` and `https://fillie.app/**` (keep the vercel.app one and the `chrome-extension://…/pages/auth-callback.html` one).
4. **Razorpay → Account & Settings**: set the business website to `https://www.fillie.app`.
5. Google, GitHub and Apple sign-in need no change (their callback is Supabase's own address).

### 5. Check it end to end

* `https://www.fillie.app/influencer`: sign in, join, copy the code. `/admin`: Influencers shows the new box; Offers lets you create one.
* Open the payment window on the home page, apply the creator code (a creator cannot use their own, so use a second account) and an offer: the price drops and the buttons show the new amount. You do not have to pay.
* Make one real payment with a test account (₹449 or less with codes), confirm the account unlocks and the commission appears as *Pending* in **Admin → Influencers → Transaction ledger**, then refund it in Razorpay and press **Reverse** on that ledger line.

If something goes wrong: the migrations only add tables, columns and functions, so rolling back means redeploying the previous functions and website. Leave the database alone.

---

## Part 2. Publish the extension on the Chrome Web Store

### Before you start

* A Google account with **2-step verification** on, and the one-time **$5** developer registration at <https://chrome.google.com/webstore/devconsole>.
* The website live at `https://www.fillie.app` with working **/privacy**, **/terms**, **/refund**, **/contact** pages. The store asks for a privacy-policy link, and Razorpay and reviewers check these pages.
* Prepare images:
  * **Screenshots**: at least 1, up to 5, 1280x800 (or 640x400). Show the popup, the on-page panel after Alt+Shift+F, the Database, the Account page.
  * **Small promo tile**: 440x280 (required). A marquee 1400x560 is optional.
  * The 128px icon is already inside the package.

### Build the package

1. Set the version in **both** `src/manifest.json` and `package.json` and `src/shared/version.ts` (they must match; for the first release `1.1.0` is fine, every later upload needs a higher number).
2. Run the checks, then build the zip:
   ```bash
   npm run verify      # builds and runs every test
   npm run package     # writes release/fillie-extension.zip
   ```
   The package script refuses to build if the Supabase keys are still placeholders.

### Create the listing

1. Developer Dashboard → **Add new item** → upload `release/fillie-extension.zip`.
2. **Store listing** tab:
   * **Name**: Fillie. **Summary** (max 132 characters), for example: *AI that fills job applications and forms from your profile, tracks every application and reminds you before interviews.*
   * **Description**: lead with the AI features (answers questions, fills forms, records applications with AI notes and ratings, interview reminders, you always press submit), then pricing (3 free fillings a week, then a one-time payment).
   * **Category**: Productivity. **Language**: English.
   * **Website**: `https://www.fillie.app`. **Support**: your support email or `https://www.fillie.app/contact`.
   * Upload the screenshots and the promo tile.
3. **Privacy** tab:
   * **Single purpose**: *Fill online application forms from the user's saved profile and resume, and keep a record of the applications the user submits.*
   * **Permission justifications** (one short line each):
     * `storage`: keeps the profile, resumes, settings and cached results on the device.
     * `activeTab`: reads and fills the form on the page when the user presses the button or Alt+Shift+F.
     * `identity`: opens the sign-in window for Google, GitHub and Apple login.
     * `alarms`: wakes the extension every 15 minutes to check upcoming interviews.
     * `notifications`: shows the interview reminders.
     * Host permissions (`http://*/*`, `https://*/*`): job forms can be on any website, and Fillie only reads and fills the page the user runs it on.
     * AI provider and `*.supabase.co` hosts: send the user's questions to the AI service they chose, and sync their account and applications.
   * **Remote code**: No (everything is in the package).
   * **Data usage**: tick *Personally identifiable information* (name, email, phone in the profile), *Authentication information* (sign-in), and *Website content* (form questions are read, and sent to the user's own AI provider). Certify that data is not sold, not used for unrelated purposes and not used for creditworthiness. Link your privacy policy.
4. **Distribution** tab: Public (or Unlisted for a soft launch), all regions, free. Payment is taken on your own website through Razorpay, which the store allows; the description should say so.

### Submit

Press **Submit for review**. Because the extension asks for access to all sites, review usually takes several days, sometimes longer. Answer any reviewer email with the justifications above. Choose *publish automatically* after approval, or *defer publishing* if you want to time the launch.

### Right after approval

1. Copy the **extension ID** and the store URL.
2. Website `src/config.ts`: set `SITE.storeUrl` to the store URL (it is still `…/YOUR-EXTENSION-ID`), then push so Vercel deploys.
3. **Supabase → Authentication → URL Configuration → Redirect URLs**: add `chrome-extension://<store extension id>/pages/auth-callback.html`. The store ID differs from the ID of an unpacked copy, so keep both.
4. Install the store version yourself, sign in with each provider (Google, GitHub, Apple, email), and run Fillie on a test form.

### Shipping an update

Raise the version (all three places), `npm run verify && npm run package`, then Developer Dashboard → your item → **Package** → **Upload new package** → submit. Changing permissions (like the new `alarms` and `notifications`) makes Chrome ask existing users to approve the update, so put it in the release notes.
