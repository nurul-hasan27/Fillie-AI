# Influencer programme and offers

Creators join at **/influencer**, get a promo code, and earn commission on every payment made with it. You run everything from **/admin** (tabs **Influencers** and **Offers**).

## How the money works

| Step | What happens |
| --- | --- |
| Customer pays | A creator code gives the customer **10% off** the list price (₹449 → ₹404.10). An **offer code** (made by you) can be added on top: it takes its percentage off the price *after* the creator discount. Both together are allowed; the price never goes below ₹1 / $1. |
| Commission | The creator earns **10% of what the customer actually paid**. It is written to the ledger as **pending**. |
| Refund window | After **7 days** it becomes **approved** automatically and can be withdrawn. If you refund the customer first, reverse the ledger line (see below). |
| Withdrawal | The creator withdraws their whole available balance (minimum ₹500 / $10). They see the exact amount that reaches their bank *before* confirming. |
| Payout | You review the request in **Influencers → Withdrawal management**: **Approve**, send the money from your bank app, then **Mark as paid** with the transfer reference (UTR). Or **Reject** with a reason, and the money returns to the creator's balance. |

Offers have a **Show in "Explore offers"** switch: on, customers can browse and apply them from the payment window and the extension; off, the code only works when typed in. Creator codes are never listed.

Customers can enter codes in two places: the payment window on the website, and **Account** in the extension. Both show every applied code with how much it takes off (in ₹ and $), the price before and after, and the amount to pay, all worked out by the server. A confetti burst plays when a payment is confirmed.

Everything above is a setting, not code: **Influencers → Programme settings** (discount %, commission %, refund window, minimum withdrawal, TDS, transfer fee, codes per creator).

### What is deducted at payout

* **TDS (income tax at source)**: 2% of the creator's commission once their payouts in the Indian financial year (1 April to 31 March) pass ₹20,000, with a catch-up on the amount before the limit; 20% if no valid PAN. These are the defaults in the settings. **Please confirm the current section 194H rate and limit with your accountant** and change them if needed. Deducted tax is yours to deposit and report (Form 26Q) and gives the creator a credit in Form 26AS.
* **Transfer fee**: ₹0 by default. If you pay out through a service that charges per transfer, enter it in the settings and it is shown to the creator as a line before they confirm.
* **Razorpay's fee on the customer's payment (about 2% + GST)** is **not** deducted from the creator. Commission is 10% of what the customer paid, and the gateway fee comes out of your share.

## Ledger and disputes

Every commission is one line: *Order ID → Promo code → Influencer → Order amount → Commission → Status → Date* (**Influencers → Transaction ledger**), with the customer's email visible to you only.

| Status | Meaning |
| --- | --- |
| Pending | Inside the refund window. |
| Approved | Withdrawable (or already in a withdrawal). |
| Cancelled | Not eligible (fraud, self-referral). Self-referrals are cancelled automatically. |
| Reversed | The customer was refunded. If the commission was already paid out, it is subtracted from the creator's next withdrawal. |

Actions: **Cancel**, **Reverse**, **Approve now**, **Reinstate**. Refunds are made in Razorpay as before; then reverse the matching ledger line here (the system does not hear about refunds from Razorpay).

**Suspicious activity** flags self-referrals, one customer using several creator codes, many cancellations, refunds after commission, bursts of orders in one hour, and brand-new accounts buying with the same code. They are signals to look at, not automatic punishments.

## Privacy

Creators never see customer names, emails or full order ids, only a short order number, the amount and the date. Bank details are readable only by the creator (masked) and by you. Profile photos are public images; bank proofs are in a private bucket and opened through short-lived links.

## Leaving

A creator can delete their influencer account in Settings. If they have money available they get a pop-up to withdraw it first; money still inside the refund window is forfeited only after an explicit confirmation. Their promo codes stop working, personal and bank details are erased, and their name, codes and ledger stay in your admin as **Deleted account**.

## Setting it up

1. Run `supabase/migrations/0005_influencers.sql`, `0006_influencer_api.sql`, `0007_influencer_admin.sql` and `0008_public_offers.sql` (the last one adds the "Explore offers" list) in the Supabase SQL editor (or `supabase db push`). They only add things.
2. Deploy the changed functions **before** the website, because the checkout page now asks the function to price codes:
   ```bash
   supabase functions deploy create-checkout
   supabase functions deploy razorpay-webhook --no-verify-jwt
   supabase functions deploy confirm-payment
   ```
3. Deploy the website. Creators use `https://<your-site>/influencer`; share links look like `https://<your-site>/?code=ASHA10`.
4. In **Authentication → URL configuration** add `https://<your-site>/influencer` to the redirect URLs, so Google, GitHub and Apple sign-in can return to it.

## Testing

* `npx vitest run tests/unit/influencer-db.test.ts` runs the real migrations in an in-memory Postgres and checks codes, discounts, commissions, tax, withdrawals, deletion, fraud flags and permissions.
* `npm run test:website` opens the real website (the sibling `../fillie-website` folder) in a browser against that same database: a creator joins, a customer pays with a code and an offer, the creator withdraws, you approve and pay, the creator leaves. Razorpay and Supabase Auth are the only faked parts.

## Not included

* **Email notifications.** Support messages from creators arrive in **Influencers → Support** instead of your inbox. Sending email needs a provider (Resend, SES) that is not set up.
* **Automatic payouts.** You send each payout yourself and mark it paid.
* **Automatic refund detection** from Razorpay (reverse the ledger line by hand).
