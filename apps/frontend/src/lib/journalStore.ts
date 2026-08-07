/**
 * journalStore
 *
 * The one trade currently being reviewed on a chart. Clicking a trade in the
 * P&L calendar's day drill-down parks it here; ChartPanel picks it up and draws
 * its entry/exit legs alongside the ordinary fill arrows, reusing the same
 * lightweight-charts marker path.
 *
 * Module-level and listener-based, mirroring executionStore — the calendar
 * unmounts when it closes, so the selection can't live in its state.
 */

import type { MatchedTrade } from '@ibkr-chart/types';

type Listener = () => void;

let active: MatchedTrade | null = null;
const listeners = new Set<Listener>();

export function getActiveTrade(): MatchedTrade | null {
  return active;
}

export function setActiveTrade(trade: MatchedTrade | null): void {
  if (active?.id === trade?.id) return;
  active = trade;
  for (const l of listeners) l();
}

export function subscribeJournal(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ─── ET session helpers ───────────────────────────────────────────────────────

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/** ET calendar day ("YYYY-MM-DD") for a unix-seconds time (default: now). */
export function etDay(unixSec?: number): string {
  return ET_DATE.format(unixSec != null ? new Date(unixSec * 1000) : new Date());
}

/** Seconds to add to a UTC instant to read it as ET wall clock. */
function etOffset(unixSec: number): number {
  const o: Record<string, number> = {};
  for (const p of ET_PARTS.formatToParts(new Date(unixSec * 1000))) {
    if (p.type !== 'literal') o[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second) / 1000;
  return unixSec - asUtc;
}

/**
 * Unix seconds at a given ET wall-clock time on an ET calendar date.
 * Used to ask IBKR for the window ending at a past session's close.
 */
export function etTimeOnDate(dateKey: string, hour: number, minute = 0): number {
  const naive = Date.parse(`${dateKey}T00:00:00Z`) / 1000 + hour * 3600 + minute * 60;
  let guess = naive + etOffset(naive);
  guess = naive + etOffset(guess);
  return guess;
}

/**
 * The instant to request history up to for a trade's session: 20:00 ET, the end
 * of post-market, so the whole session (including extended hours) sits inside
 * the returned window.
 */
export function sessionEndFor(dateKey: string): number {
  return etTimeOnDate(dateKey, 20, 0);
}
