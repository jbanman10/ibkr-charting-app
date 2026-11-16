/**
 * Bar list helpers.
 */

import type { Bar } from '@ibkr-chart/types';

/**
 * Splice a freshly-fetched LIVE-EDGE window over the history already loaded.
 *
 * The periodic re-sync asks for only a couple of sessions (`scope=recent`),
 * because only the right-hand edge can still change — late-reported prints, the
 * extended-hours NBBO clamp, IBKR's penny revisions. Everything to the left is
 * settled, and re-downloading it every few minutes is what made a deep history
 * expensive to KEEP rather than just to load.
 *
 * The cut is strict (`<` the first repaired bar), so the result is ascending
 * with no duplicate times — lightweight-charts rejects anything else outright
 * with "data must be asc ordered by time".
 *
 * Degenerate cases fall back to the repaired window alone, which is exactly the
 * replace-everything behaviour this used to have: nothing older to keep (first
 * sync), or a loaded window no deeper than the repair window.
 */
export function mergeRecentBars(existing: readonly Bar[], recent: readonly Bar[]): Bar[] {
  if (!recent.length) return existing.slice();
  const cutoff = Number(recent[0].time);
  if (!Number.isFinite(cutoff)) return recent.slice();
  const kept = existing.filter((b) => Number(b.time) < cutoff);
  return kept.length ? [...kept, ...recent] : recent.slice();
}
