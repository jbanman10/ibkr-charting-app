/**
 * Exchange-time (America/New_York) helpers.
 *
 * Every date bucket in the app — P&L calendar days, trade-journal day keys,
 * RVOL session math — must agree on what "a trading day" is, or a 16:05 fill
 * lands on the wrong side of midnight for anyone not sitting in ET. Bars stay
 * numeric UTC epoch seconds; only the BUCKETING is ET.
 */

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const ET_HM = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** ET calendar day ("YYYY-MM-DD") for a unix-seconds time (default: now). */
export function etDay(unixSec?: number): string {
  return ET_DATE.format(unixSec != null ? new Date(unixSec * 1000) : new Date());
}

/** ET minute-of-day (0–1439). */
export function etMinuteOfDay(unixSec: number): number {
  const [h, m] = ET_HM.format(new Date(unixSec * 1000)).split(':').map(Number);
  return h * 60 + m;
}

/** ET hour-of-day (0–23). */
export function etHour(unixSec: number): number {
  return Math.floor(etMinuteOfDay(unixSec) / 60);
}

/** Day of week for an ET calendar date key, 0 = Sunday. */
export function etDayOfWeek(dateKey: string): number {
  // Parsed as UTC midnight purely to read the weekday off a fixed calendar
  // date — no timezone conversion is wanted here.
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/** Unix seconds at ET midnight starting the given ET calendar date. */
export function etMidnightUnix(dateKey: string): number {
  // Find the UTC instant whose ET date is `dateKey` and ET time is 00:00 by
  // correcting an initial UTC guess with the observed offset (handles DST).
  const guess = Date.parse(`${dateKey}T00:00:00Z`) / 1000;
  const offset = etOffsetSeconds(guess);
  return guess + offset;
}

/** Unix seconds at the END of an ET calendar date (23:59:59 ET). */
export function etEndOfDayUnix(dateKey: string): number {
  return etMidnightUnix(dateKey) + 86_399;
}

/** Seconds to ADD to a UTC instant to express it as ET wall-clock (negative). */
function etOffsetSeconds(unixSec: number): number {
  const parts = parseEtParts(unixSec);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000;
  return unixSec - asUtc;
}

interface EtParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
}

function parseEtParts(unixSec: number): EtParts {
  const out: Record<string, number> = {};
  for (const p of ET_PARTS.formatToParts(new Date(unixSec * 1000))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year, month: out.month, day: out.day,
    // Intl emits hour 24 for midnight under hourCycle h23 in some ICU versions.
    hour: out.hour % 24, minute: out.minute, second: out.second,
  };
}

/**
 * Interpret an exchange-local wall-clock time as a unix instant.
 *
 * IBKR reports execution times in the TWS operator's timezone with no offset in
 * the string. Treating that as the SERVER's local time is only correct while
 * the machine sits in ET, so parse it explicitly against the exchange zone.
 */
export function etWallClockToUnix(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  // One correction pass resolves the offset; a second settles the rare case of
  // a timestamp sitting inside a DST transition hour.
  let guess = naive + etOffsetSeconds(naive);
  guess = naive + etOffsetSeconds(guess);
  return guess;
}
