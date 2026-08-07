/**
 * Chart markers for a journal trade.
 *
 * Kept out of ChartPanel so the mapping from a matched trade's legs to
 * lightweight-charts markers is a pure function of (trade, loaded bars) — the
 * part worth reasoning about on its own, and the only part that can silently
 * put an arrow on the wrong candle.
 *
 * Markers only render on times that exist in the series, so every leg is
 * snapped to the nearest loaded bar at or before the fill (the same rule the
 * ambient execution arrows use).
 */

import type { SeriesMarker, Time } from 'lightweight-charts';
import type { Bar, MatchedTrade, TradeLeg } from '@ibkr-chart/types';
import { unixToDayString } from './drawings';

const ENTRY_COLOR = '#2962ff';
const EXIT_COLOR = '#ff9800';

/** Nearest bar time at or before `t`, or null when `t` predates the history. */
export function snapToBarTime(bars: Bar[], t: number): number | null {
  if (!bars.length || t < Number(bars[0].time)) return null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const bt = Number(bars[i].time);
    if (bt <= t) return bt;
  }
  return null;
}

export function buildJournalMarkers(
  trade: MatchedTrade,
  bars: Bar[],
  forming: Bar | null,
  daily: boolean
): SeriesMarker<Time>[] {
  const markers: SeriesMarker<Time>[] = [];
  // A long is entered by buying and exited by selling; a short is the reverse.
  const longSide = trade.direction === 'long';

  const push = (legs: TradeLeg[], kind: 'Entry' | 'Exit', isBuySide: boolean) => {
    legs.forEach((l, i) => {
      let barTime = snapToBarTime(bars, l.time);
      if (barTime == null) return;
      // A fill inside the still-forming candle belongs on that candle.
      if (forming && l.time >= Number(forming.time)) barTime = Number(forming.time);
      const label = legs.length > 1 ? `${kind} ${i + 1}/${legs.length}` : kind;
      markers.push({
        time: (daily ? unixToDayString(barTime) : barTime) as Time,
        position: isBuySide ? 'belowBar' : 'aboveBar',
        shape: isBuySide ? 'arrowUp' : 'arrowDown',
        color: kind === 'Entry' ? ENTRY_COLOR : EXIT_COLOR,
        text: `${label} ${l.quantity}@${l.price.toFixed(2)}`,
        size: 2,
      });
    });
  };

  push(trade.entryLegs, 'Entry', longSide);
  push(trade.exitLegs, 'Exit', !longSide);
  return markers;
}
