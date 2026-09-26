/** IANA time zone validation (architecture §8.1). Uses the runtime's ICU data. */
const SUPPORTED = new Set<string>([...Intl.supportedValuesOf('timeZone'), 'UTC']);

export function isValidTimeZone(tz: string): boolean {
  if (SUPPORTED.has(tz)) return true;
  // Fixed offsets ("+02:00") are not IANA zones and would break DST handling.
  if (tz.length === 0 || /^[+-]/.test(tz)) return false;
  // Aliases (e.g. "Etc/UTC", "Asia/Calcutta") are accepted by Intl even if not listed.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "HH:MM" or "HH:MM:SS" 24-hour wall-clock. */
export const PUBLISH_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
