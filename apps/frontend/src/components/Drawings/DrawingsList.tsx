/**
 * DrawingsList
 *
 * A right-edge drawer listing every drawing on one symbol, so they can be found
 * and deleted without hunting for them on the chart — the whole point being
 * that a drawing parked months back, or stacked under three others, is
 * effectively unreachable by clicking.
 *
 * Reads the shared per-symbol store directly (not a panel's props) because
 * drawings belong to the SYMBOL, not the panel: the drawer has to be able to
 * show a ticker that isn't currently loaded in any panel. It defaults to the
 * focused panel's symbol and offers every other symbol that has drawings, so an
 * old ticker can be cleaned out without loading it first.
 *
 * Deletes go through the normal store setter, so they land on every panel
 * showing that symbol, persist to disk, and are undoable with Ctrl+Z.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Drawing } from '../../lib/drawings';
import {
  getDrawings,
  getDrawingSymbols,
  setDrawings,
  subscribeDrawings,
} from '../../lib/drawingStore';
import styles from './DrawingsList.module.css';

interface Props {
  /** Symbol on the focused panel — the drawer opens on this one. */
  focusedSymbol?: string;
  onClose: () => void;
}

// ─── Row presentation ────────────────────────────────────────────────────────

const TYPE_LABEL: Record<Drawing['type'], string> = {
  trendline: 'Trend line',
  hline:     'Horizontal',
  rectangle: 'Rectangle',
  position:  'Position',
  callout:   'Text',
  alert:     'Alert',
};

/** The colour to show in the row's swatch — whatever that type actually draws with. */
function swatchColor(d: Drawing): string {
  switch (d.type) {
    case 'trendline': return d.color;
    case 'hline':     return d.color;
    case 'rectangle': return d.borderColor;
    case 'callout':   return d.color;
    case 'position':  return d.target >= d.entry ? '#089981' : '#f23645';
    case 'alert':     return d.triggeredAt ? '#787b86' : '#f59e0b';
  }
}

const px = (n: number) => n.toFixed(2);

/**
 * One line of detail under the type name. Prices are what actually identifies a
 * drawing at a glance — "Rectangle" alone tells you nothing when you have nine.
 */
function describe(d: Drawing): string {
  switch (d.type) {
    case 'trendline': return `${px(d.p1.price)} → ${px(d.p2.price)}`;
    case 'hline':     return px(d.price);
    case 'alert':     return `${px(d.price)}${d.triggeredAt ? ' · triggered' : ' · armed'}`;
    case 'rectangle': {
      const hi = Math.max(d.p1.price, d.p2.price);
      const lo = Math.min(d.p1.price, d.p2.price);
      return `${px(hi)} – ${px(lo)}`;
    }
    case 'position': {
      const long = d.target >= d.entry;
      const risk = Math.abs(d.entry - d.stop);
      const rr = risk > 1e-9 ? Math.abs(d.target - d.entry) / risk : 0;
      return `${long ? 'Long' : 'Short'} ${px(d.entry)} · ${rr.toFixed(1)}R`;
    }
    case 'callout': {
      const text = (d.text ?? '').trim().split('\n')[0];
      return text ? (text.length > 28 ? `${text.slice(0, 28)}…` : text) : '(empty)';
    }
  }
}

/** User label, where the type supports one. */
function labelOf(d: Drawing): string | null {
  if (d.type === 'trendline' || d.type === 'hline' || d.type === 'rectangle') {
    return d.label?.trim() || null;
  }
  return null;
}

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/**
 * Drawing ids are `d_<epoch ms>_<rand>` (newDrawingId), so the creation date
 * comes free. Older ids that predate that format just show nothing.
 */
function createdAt(id: string): string | null {
  const m = /^d_(\d{10,})_/.exec(id);
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms)) return null;
  return DAY.format(new Date(ms));
}

function sortKey(id: string): number {
  const m = /^d_(\d{10,})_/.exec(id);
  return m ? Number(m[1]) : 0;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function DrawingsList({ focusedSymbol, onClose }: Props) {
  const [symbol, setSymbol] = useState(() => focusedSymbol ?? '');
  // Bumped on every store change to re-read; the store is the source of truth.
  const [version, setVersion] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);

  // Follow the focused panel when it changes symbol, unless the user has
  // deliberately switched the drawer to another ticker.
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!pinned && focusedSymbol) setSymbol(focusedSymbol);
  }, [focusedSymbol, pinned]);

  useEffect(() => subscribeDrawings(() => setVersion((v) => v + 1)), []);
  useEffect(() => { setConfirmClear(false); }, [symbol]);

  // Disarm the clear confirmation on its own. Blur alone isn't enough — a click
  // doesn't reliably focus a button on every platform, which would leave the
  // button sitting armed and one stray click from wiping the symbol.
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  const symbols = useMemo(() => {
    const withDrawings = getDrawingSymbols();
    // Always offer the focused symbol, even before anything is drawn on it.
    if (focusedSymbol && !withDrawings.includes(focusedSymbol)) {
      return [focusedSymbol, ...withDrawings];
    }
    return withDrawings;
    // version: a delete can empty a symbol out of the list entirely.
  }, [focusedSymbol, version]);

  const drawings = useMemo(
    () => (symbol ? [...getDrawings(symbol)].sort((a, b) => sortKey(b.id) - sortKey(a.id)) : []),
    [symbol, version]
  );

  const remove = (id: string) => {
    setDrawings(symbol, getDrawings(symbol).filter((d) => d.id !== id));
  };

  const clearAll = () => {
    if (!confirmClear) { setConfirmClear(true); return; }
    setDrawings(symbol, []);
    setConfirmClear(false);
  };

  return (
    <aside className={styles.drawer} onClick={(e) => e.stopPropagation()}>
      <div className={styles.header}>
        <span className={styles.title}>Drawings</span>
        <button className={styles.closeBtn} onClick={onClose} title="Close drawings list">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className={styles.symbolRow}>
        <select
          className={styles.symbolSelect}
          value={symbol}
          onChange={(e) => { setSymbol(e.target.value); setPinned(e.target.value !== focusedSymbol); }}
          aria-label="Symbol"
        >
          {symbols.length === 0 && <option value="">No drawings yet</option>}
          {symbols.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <span className={styles.count}>{drawings.length}</span>
      </div>

      <div className={styles.list}>
        {drawings.length === 0 && (
          <div className={styles.empty}>
            {symbol ? `Nothing drawn on ${symbol} yet.` : 'Draw something to see it listed here.'}
          </div>
        )}

        {drawings.map((d) => {
          const label = labelOf(d);
          const day = createdAt(d.id);
          return (
            <div key={d.id} className={styles.row}>
              <span className={styles.swatch} style={{ background: swatchColor(d) }} aria-hidden />
              <div className={styles.rowMain}>
                <span className={styles.rowTitle}>
                  {label ?? TYPE_LABEL[d.type]}
                  {label && <span className={styles.rowType}> · {TYPE_LABEL[d.type]}</span>}
                </span>
                <span className={styles.rowMeta}>
                  {describe(d)}
                  {day && <span className={styles.rowDate}> · {day}</span>}
                </span>
              </div>
              <button
                className={styles.delBtn}
                onClick={() => remove(d.id)}
                title="Delete this drawing (Ctrl+Z undoes it)"
                aria-label={`Delete ${TYPE_LABEL[d.type]}`}
              >
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 4h9M5.5 4V2.8h3V4M4 4l.6 8h4.8L10 4"
                    stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      {drawings.length > 0 && (
        <div className={styles.footer}>
          <button
            className={`${styles.clearBtn} ${confirmClear ? styles.clearArmed : ''}`}
            onClick={clearAll}
            onBlur={() => setConfirmClear(false)}
          >
            {confirmClear ? `Delete all ${drawings.length}?` : `Clear ${symbol}`}
          </button>
        </div>
      )}
    </aside>
  );
}
