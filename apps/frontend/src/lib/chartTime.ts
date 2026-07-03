/**
 * chartTime — display the time axis in Exchange time (US Eastern).
 *
 * Bars are stored as UTC epoch seconds; lightweight-charts otherwise renders the
 * axis in UTC. These formatters convert to America/New_York so the axis matches
 * both the user's clock and the ET-based session overlays. Display only — the
 * underlying bar times stay UTC.
 */

import type { Time } from 'lightweight-charts';

const TZ = 'America/New_York';

// TickMarkType (lightweight-charts): 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds.

const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtTimeSec = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
const fmtMonth = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short' });
const fmtYear = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric' });
const fmtFull = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Convert a lightweight-charts Time (epoch seconds, or YYYY-MM-DD / BusinessDay) to a JS Date. */
function toDate(time: Time): Date {
  if (typeof time === 'number') return new Date(time * 1000);
  if (typeof time === 'string') return new Date(`${time}T00:00:00Z`);
  // BusinessDay { year, month, day } — treat as UTC midnight
  const bd = time as { year: number; month: number; day: number };
  return new Date(Date.UTC(bd.year, bd.month - 1, bd.day));
}

/** Axis tick labels in ET, varying detail by tick type. */
export function etTickMarkFormatter(time: Time, tickMarkType: number): string {
  const d = toDate(time);
  switch (tickMarkType) {
    case 0: return fmtYear.format(d);   // Year
    case 1: return fmtMonth.format(d);  // Month
    case 2: return fmtDay.format(d);    // DayOfMonth
    case 4: return fmtTimeSec.format(d);// TimeWithSeconds
    default: return fmtTime.format(d);  // Time
  }
}

/** Crosshair tooltip label in ET. */
export function etCrosshairFormatter(time: Time): string {
  return fmtFull.format(toDate(time));
}
