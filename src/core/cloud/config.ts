/**
 * Cloud settings. The anon key is public by design (Supabase protects data with
 * row-level security), so it is safe to ship in the extension. The Stripe secret
 * and the service-role key must NEVER appear here; they live only in Supabase
 * function secrets.
 */
export const CLOUD = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'YOUR-SUPABASE-ANON-KEY',
  /** Free form-fillings per calendar week before sign-in + payment is required. */
  freeFillsPerWeek: 3,
  priceLabel: '$5 one-time',
  /** Shown on the Razorpay (UPI / cards / netbanking) button. Match RAZORPAY_AMOUNT_MINOR on the server. */
  razorpayLabel: '₹420',
  /** How many applications are fetched per page in the Database view. */
  pageSize: 100,
};

/** False while the placeholders above are untouched (local development). */
export function isCloudConfigured(config = CLOUD): boolean {
  return !config.supabaseUrl.includes('YOUR-PROJECT') && !config.anonKey.startsWith('YOUR-');
}
