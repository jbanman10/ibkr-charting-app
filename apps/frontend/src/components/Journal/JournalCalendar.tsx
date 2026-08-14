/**
 * JournalCalendar — the same month grid as the P&L calendar, but for the
 * written journal: each day holds one screenshot of the charts and one note.
 *
 * A day cell shows what it has (📷 / ✎). Clicking opens the day below the grid
 * with the capture full-width and a note box that saves as you type (debounced).
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { captureChartGrid, saveCapture } from '../../lib/chartCapture';
import styles from './JournalCalendar.module.css';

interface Props {
  onClose: () => void;
}

interface JournalDay {
  date: string;
  hasNote: boolean;
  hasImage: boolean;
  capturedAt: number | null;
  excerpt: string;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const dateKey = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const NOTE_SAVE_MS = 700;

export default function JournalCalendar({ onClose }: Props) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [days, setDays] = useState<JournalDay[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [dayMeta, setDayMeta] = useState<{ hasImage: boolean; capturedAt: number | null }>({ hasImage: false, capturedAt: null });
  const [imgKey, setImgKey] = useState(0); // cache-buster after a re-capture
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/journal/summary');
      if (!res.ok) return;
      const body = (await res.json()) as { days: JournalDay[] };
      setDays(body.days ?? []);
    } catch { setError('Backend unreachable'); }
  }, []);

  useEffect(() => { void loadSummary(); }, [loadSummary]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Load a day when it's opened.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/journal/day/${selected}`);
        if (!res.ok || cancelled) return;
        const body = await res.json() as { note: string; hasImage: boolean; capturedAt: number | null };
        if (cancelled) return;
        setNote(body.note ?? '');
        setDayMeta({ hasImage: body.hasImage, capturedAt: body.capturedAt });
      } catch { /* leave the previous state */ }
    })();
    return () => { cancelled = true; };
  }, [selected]);

  // Notes save themselves — a journal you have to remember to save is one you
  // lose entries from.
  const onNoteChange = useCallback((value: string) => {
    setNote(value);
    if (!selected) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void (async () => {
        try {
          await fetch(`/api/journal/day/${selected}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ note: value }),
          });
          setStatus('Saved');
          setTimeout(() => setStatus(null), 1200);
          void loadSummary();
        } catch { setError('Could not save the note'); }
      })();
    }, NOTE_SAVE_MS);
  }, [selected, loadSummary]);

  // Flush a pending note edit when the window closes, so nothing is lost
  // mid-debounce. This MUST NOT depend on `note`/`selected`: with those in the
  // deps its cleanup runs on every keystroke, cancelling the debounced save and
  // firing one with the previous value — i.e. every edit gets dropped. Latest
  // values come from refs instead, and the effect runs once.
  const noteRef = useRef(note);
  const selectedRef = useRef(selected);
  useEffect(() => { noteRef.current = note; }, [note]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  useEffect(() => () => {
    if (!saveTimer.current || !selectedRef.current) return;
    clearTimeout(saveTimer.current);
    void fetch(`/api/journal/day/${selectedRef.current}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: noteRef.current }),
      keepalive: true, // survives the unmount/navigation
    });
  }, []);

  const recapture = useCallback(async () => {
    if (!selected) return;
    setError(null);
    // The modal covers the charts, so it must come down before the grab.
    onClose();
    await new Promise((r) => setTimeout(r, 260));
    try {
      const shot = captureChartGrid();
      if (!shot) { setError('No charts to capture'); return; }
      await saveCapture(selected, shot.dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Capture failed');
    }
  }, [selected, onClose]);

  const removeCapture = useCallback(async () => {
    if (!selected) return;
    await fetch(`/api/journal/day/${selected}/image`, { method: 'DELETE' });
    setDayMeta({ hasImage: false, capturedAt: null });
    void loadSummary();
  }, [selected, loadSummary]);

  const byDate = useMemo(() => {
    const m = new Map<string, JournalDay>();
    for (const d of days) m.set(d.date, d);
    return m;
  }, [days]);

  const weeks = useMemo(() => {
    const first = new Date(year, month, 1);
    const inMonth = new Date(year, month + 1, 0).getDate();
    const cells: Array<{ day: number | null; key: string | null }> = [];
    for (let i = 0; i < first.getDay(); i++) cells.push({ day: null, key: null });
    for (let d = 1; d <= inMonth; d++) cells.push({ day: d, key: dateKey(year, month, d) });
    while (cells.length % 7 !== 0) cells.push({ day: null, key: null });
    const rows: (typeof cells)[] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
  }, [year, month]);

  const shiftMonth = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    setSelected(null);
  };

  const monthCount = days.filter((d) => d.date.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`)).length;
  const prettyDate = selected
    ? new Date(`${selected}T12:00:00Z`).toLocaleDateString('en-US', {
        timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      })
    : '';

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.window} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.nav}>
            <button className={styles.navBtn} onClick={() => shiftMonth(-1)} title="Previous month">‹</button>
            <span className={styles.monthLabel}>{MONTHS[month]} {year}</span>
            <button className={styles.navBtn} onClick={() => shiftMonth(1)} title="Next month">›</button>
            <button
              className={styles.todayBtn}
              onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth()); }}
            >
              Today
            </button>
          </div>
          <div className={styles.headerRight}>
            <span className={styles.count}>{monthCount} {monthCount === 1 ? 'entry' : 'entries'}</span>
            <button className={styles.iconBtn} onClick={onClose} title="Close (Esc)">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        {error && <div className={styles.errorBar}>⚠ {error}</div>}

        <div className={styles.grid}>
          {DOW.map((d) => <div key={d} className={styles.dowCell}>{d}</div>)}
          {weeks.map((row, ri) => (
            <div key={ri} className={styles.weekRow}>
              {row.map((c, ci) => {
                if (c.day == null) return <div key={ci} className={styles.emptyCell} />;
                const entry = byDate.get(c.key!);
                const isToday = c.key === dateKey(now.getFullYear(), now.getMonth(), now.getDate());
                const has = !!entry;
                return (
                  <div
                    key={ci}
                    className={`${styles.cell} ${has ? styles.cellHas : ''} ${isToday ? styles.today : ''} ${
                      selected === c.key ? styles.cellSelected : ''
                    }`}
                    onClick={() => setSelected((cur) => (cur === c.key ? null : c.key))}
                    title={entry?.excerpt || (has ? 'Journal entry' : 'No entry — click to add one')}
                  >
                    <span className={styles.dayNum}>{c.day}</span>
                    {has && (
                      <span className={styles.badges}>
                        {entry!.hasImage && <span className={styles.badge} title="Has a chart capture">📷</span>}
                        {entry!.hasNote && <span className={styles.badge} title="Has notes">✎</span>}
                      </span>
                    )}
                    {entry?.excerpt && <span className={styles.excerpt}>{entry.excerpt}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {selected && (
          <div className={styles.day}>
            <div className={styles.dayHeader}>
              <span className={styles.dayTitle}>{prettyDate}</span>
              {dayMeta.capturedAt && (
                <span className={styles.dayMeta}>
                  captured {new Date(dayMeta.capturedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
              <div className={styles.daySpacer} />
              {status && <span className={styles.saved}>{status}</span>}
              <button className={styles.smallBtn} onClick={recapture} title="Close this window and capture the charts as they are now">
                {dayMeta.hasImage ? 'Replace capture' : 'Capture charts'}
              </button>
              {dayMeta.hasImage && (
                <button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={removeCapture}>Remove</button>
              )}
              <button className={styles.iconBtn} onClick={() => setSelected(null)} title="Close day">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {dayMeta.hasImage ? (
              <a
                className={styles.shotLink}
                href={`/api/journal/day/${selected}/image?v=${imgKey}`}
                target="_blank"
                rel="noreferrer"
                title="Open the capture full size"
              >
                <img
                  className={styles.shot}
                  src={`/api/journal/day/${selected}/image?v=${imgKey}`}
                  alt={`Charts on ${selected}`}
                  onError={() => setImgKey((k) => k + 1)}
                />
              </a>
            ) : (
              <div className={styles.noShot}>
                No capture for this day. Use <b>Capture</b> in the toolbar while your charts are up,
                or the button above to grab them now.
              </div>
            )}

            <textarea
              className={styles.note}
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder="How did the day go? What setups worked, what didn't, what to do differently…"
              rows={7}
              spellCheck
            />
          </div>
        )}
      </div>
    </div>
  );
}
