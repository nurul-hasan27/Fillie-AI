/**
 * Cloud settings. The anon key is public by design (Supabase protects data with
 * row-level security), so it is safe to ship in the extension. The Stripe secret
 * and the service-role key must NEVER appear here; they live only in Supabase
 * function secrets.
 */
export const CLOUD = {
  supabaseUrl: 'https://erhrkrcbcugckaczavsm.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyaHJrcmNiY3VnY2thY3phdnNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyMzM1OTcsImV4cCI6MjEwNjgwOTU5N30.uvq5Zpa9NnM6KJWxPx012fjIpG42crXW_tHKDKUfXP4',
  /** Free form-fillings per calendar week before sign-in + payment is required. */
  freeFillsPerWeek: 3,
  priceLabel: '$5 one-time',
  /** Shown on the Razorpay (UPI / cards / netbanking) button. Match RAZORPAY_AMOUNT_MINOR on the server. */
  razorpayLabel: '₹449',
  /** How many applications are fetched per page in the Database view. */
  pageSize: 100,
};

/** False while the placeholders above are untouched (local development). */
export function isCloudConfigured(config = CLOUD): boolean {
  return !config.supabaseUrl.includes('YOUR-PROJECT') && !config.anonKey.startsWith('YOUR-');
}
