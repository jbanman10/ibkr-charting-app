/**
 * drawingClipboard
 *
 * The one-slot clipboard behind Ctrl+C / Ctrl+V on drawings.
 *
 * It holds a whole drawing, geometry included, so pasting reproduces the shape
 * exactly — a channel keeps its slope AND its band width, a rectangle its size,
 * a position its R multiple. Only the drawing's reference point moves (see
 * `translateDrawingTo`); nothing is recomputed from the target chart, which is
 * why a copied channel does not flatten out when pasted somewhere else.
 *
 * Backed by localStorage rather than a plain module variable, for one concrete
 * reason: Ctrl+N opens a second Electron window with its OWN renderer process,
 * and a module variable would be invisible to it. Same origin means same
 * localStorage, so copy in one window and paste in another just works — and it
 * survives a reload for free. The in-memory slot is only the fallback for when
 * storage is unavailable (private mode, quota, blocked site data).
 *
 * Deliberately NOT the system clipboard: reading that needs a permission the
 * browser build would have to prompt for, and it would mean parsing whatever
 * text the user last copied from anywhere else.
 */

import type { Drawing } from './drawings';
import { cloneDrawing } from './drawings';

const STORAGE_KEY = 'ibkr-chart:drawing-clipboard:v1';

/** Every type a drawing can legitimately be — anything else is rejected. */
const TYPES: ReadonlySet<string> = new Set([
  'trendline', 'channel', 'hline', 'rectangle', 'position', 'callout', 'alert',
]);

let slot: Drawing | null = null;

function isDrawing(v: unknown): v is Drawing {
  const d = v as { type?: unknown; id?: unknown };
  return !!d && typeof d === 'object' && typeof d.type === 'string'
    && TYPES.has(d.type) && typeof d.id === 'string';
}

/** Put a copy of this drawing on the clipboard. */
export function copyDrawing(d: Drawing): void {
  // Store a clone, so later edits to the original drawing cannot reach back
  // and change what is waiting to be pasted.
  slot = cloneDrawing(d);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(slot)); } catch { /* quota / blocked */ }
}

/**
 * What would be pasted, or null. Storage is checked FIRST because another
 * window may have copied something more recent than this one's slot.
 */
export function readClipboard(): Drawing | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isDrawing(parsed)) return parsed;
    }
  } catch { /* unavailable or corrupt — fall back to this window's slot */ }
  return slot;
}

export function clearClipboard(): void {
  slot = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
