/** Start of the current calendar week (Monday, UTC) as YYYY-MM-DD. */
export function weekStart(now = Date.now()): string {
  const date = new Date(now);
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}
