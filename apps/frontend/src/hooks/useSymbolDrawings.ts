import { useState, useEffect, useCallback } from 'react';
import type { Drawing } from '../lib/drawings';
import {
  getDrawings,
  setDrawings as writeDrawings,
  subscribeDrawings,
  undoDrawings,
  undoDepth,
} from '../lib/drawingStore';

export interface DrawingUndo {
  undo: () => void;
  canUndo: boolean;
}

/**
 * Reads/writes the drawings for a symbol from the shared per-symbol store and
 * stays in sync when any other panel showing the same symbol edits them.
 *
 * The setter takes the same `undoable` option as the store, so background edits
 * (an alert flipping to triggered) can stay out of the undo history.
 */
export function useSymbolDrawings(
  symbol: string
): [Drawing[], (drawings: Drawing[], opts?: { undoable?: boolean }) => void, DrawingUndo] {
  const [drawings, setLocal] = useState<Drawing[]>(() => getDrawings(symbol));
  const [depth, setDepth] = useState(() => undoDepth(symbol));

  // Re-read when the symbol changes or another panel updates this symbol.
  useEffect(() => {
    setLocal(getDrawings(symbol));
    setDepth(undoDepth(symbol));
    return subscribeDrawings((changed) => {
      if (changed !== symbol) return;
      setLocal(getDrawings(symbol));
      setDepth(undoDepth(symbol));
    });
  }, [symbol]);

  const update = useCallback((next: Drawing[], opts?: { undoable?: boolean }) => {
    writeDrawings(symbol, next, opts); // persists + notifies (this hook included)
  }, [symbol]);

  const undo = useCallback(() => { undoDrawings(symbol); }, [symbol]);

  return [drawings, update, { undo, canUndo: depth > 0 }];
}
