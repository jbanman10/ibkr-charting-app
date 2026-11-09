/**
 * drawingDefaultsStore
 *
 * Per-tool default styling for new drawings: set a channel's fill to None,
 * hit "Save as default", and every channel you draw from then on starts
 * unfilled until you change it back.
 *
 * Only STYLE is remembered, never geometry or content — a default that carried
 * a price, a time or a text body would paste the old drawing on top of the new
 * one. `STYLE_KEYS` is the whitelist that decides this, and it is applied in
 * BOTH directions: on save (so nothing else can be captured) and on load (so a
 * stale or hand-edited file can't inject fields we no longer honour).
 *
 * The position tool has no colours of its own — its zones are fixed green/red —
 * so what it saves instead is the reward:risk multiple, which is the one thing
 * about it a trader sets the same way every time. Price alerts have nothing but
 * a price, so they have no defaults and no button.
 *
 * Persistence mirrors `chartSettingsStore`: localStorage as the warm cache plus
 * a durable JSON file behind `/api/store/drawingDefaults`, so the choices
 * survive app updates, cache clears and reinstalls.
 */

import type { Drawing } from './drawings';

const STORAGE_KEY = 'ibkr-chart:drawing-defaults:v1';
const SAVE_DEBOUNCE_MS = 400;

/** Drawing types that have something worth defaulting. */
export type DefaultableType = 'trendline' | 'channel' | 'hline' | 'rectangle' | 'callout' | 'position';

/**
 * The fields each type may carry as a default.
 *
 * `extended` is deliberately absent: no UI can turn it on, so persisting it
 * would be dead config. `position` holds a derived `rr` rather than real fields
 * — see `styleOf`.
 */
const STYLE_KEYS: Record<DefaultableType, readonly string[]> = {
  trendline: ['color', 'width', 'dashed', 'extendRight'],
  channel:   ['color', 'width', 'dashed', 'fillColor', 'extendRight'],
  hline:     ['color', 'width', 'dashed'],
  rectangle: ['borderColor', 'fillColor', 'borderWidth', 'extendRight'],
  callout:   ['color', 'fillColor', 'width'],
  position:  ['rr'],
};

/** Reward:risk a fresh position opens at when nothing has been saved. */
export const DEFAULT_POSITION_RR = 2;

export type DrawingDefaults = Partial<Record<DefaultableType, Record<string, unknown>>>;

type Listener = (defaults: DrawingDefaults) => void;

let current: DrawingDefaults = {};
let loaded = false;
const listeners = new Set<Listener>();

export function canHaveDefaults(type: Drawing['type']): type is DefaultableType {
  return type in STYLE_KEYS;
}

/**
 * The saveable style of a drawing — exactly the whitelisted fields it actually
 * carries. Returns null when there is nothing to save.
 */
export function styleOf(d: Drawing): Record<string, unknown> | null {
  if (!canHaveDefaults(d.type)) return null;

  if (d.type === 'position') {
    // Positions have no styling; the setting worth keeping is the R multiple.
    const risk = Math.abs(d.entry - d.stop);
    if (!(risk > 1e-9)) return null;
    return { rr: Math.abs(d.target - d.entry) / risk };
  }

  const src = d as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of STYLE_KEYS[d.type]) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return Object.keys(out).length ? out : null;
}

/** Drop anything not on the whitelist, so disk contents can't widen the shape. */
function sanitize(raw: unknown): DrawingDefaults {
  if (!raw || typeof raw !== 'object') return {};
  const out: DrawingDefaults = {};
  for (const [type, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(type in STYLE_KEYS)) continue;
    if (!value || typeof value !== 'object') continue;
    const keys = STYLE_KEYS[type as DefaultableType];
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keys.includes(k)) clean[k] = v;
    }
    if (Object.keys(clean).length) out[type as DefaultableType] = clean;
  }
  return out;
}

/** Load from localStorage, then reconcile with the durable file. */
export function initDrawingDefaults(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) current = sanitize(JSON.parse(raw));
  } catch { /* corrupt — start with none */ }

  // The file is authoritative across reinstalls; adopt it if it differs.
  void (async () => {
    try {
      const res = await fetch('/api/store/drawingDefaults');
      if (!res.ok) return;
      const disk = sanitize(await res.json());
      if (JSON.stringify(disk) !== JSON.stringify(current)) {
        current = disk;
        for (const l of listeners) l(current);
      }
    } catch { /* backend not up — localStorage still applied */ }
  })();
}

export function getDrawingDefaults(): DrawingDefaults {
  return current;
}

export function hasDefaultFor(type: Drawing['type']): boolean {
  return canHaveDefaults(type) && current[type] !== undefined;
}

/** Remember this drawing's style as the starting point for new ones. */
export function saveDefaultFrom(d: Drawing): boolean {
  const style = styleOf(d);
  if (!style || !canHaveDefaults(d.type)) return false;
  current = { ...current, [d.type]: style };
  persist();
  for (const l of listeners) l(current);
  return true;
}

/** Forget the saved default for a type; new drawings fall back to the built-ins. */
export function clearDefaultFor(type: Drawing['type']): void {
  if (!canHaveDefaults(type) || current[type] === undefined) return;
  const next = { ...current };
  delete next[type];
  current = next;
  persist();
  for (const l of listeners) l(current);
}

/**
 * Overlay the saved default on a freshly built drawing.
 *
 * `extendRight` is OR-ed rather than overwritten: dragging a shape out to the
 * right edge is a per-drawing gesture that has to keep working even when the
 * saved default has extend switched off.
 */
export function withDefaults<T extends Drawing>(d: T): T {
  // Positions take their default through DEFAULT_POSITION_RR at the point the
  // prices are computed; `rr` is not a field, so it must not be spread on.
  if (d.type === 'position' || !canHaveDefaults(d.type)) return d;
  const saved = current[d.type];
  if (!saved) return d;
  const out = { ...d, ...saved } as T & { extendRight?: boolean };
  if ((d as { extendRight?: boolean }).extendRight) out.extendRight = true;
  return out as T;
}

/** Saved reward:risk for new positions. */
export function defaultPositionRR(): number {
  const rr = current.position?.rr;
  return typeof rr === 'number' && Number.isFinite(rr) && rr > 0 ? rr : DEFAULT_POSITION_RR;
}

export function subscribeDrawingDefaults(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* quota */ }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void fetch('/api/store/drawingDefaults', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(current),
    }).catch(() => { /* transient — next change retries */ });
  }, SAVE_DEBOUNCE_MS);
}
