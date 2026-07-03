import { useState, useEffect, useCallback } from 'react';
import type { Drawing } from '../lib/drawings';
import { getDrawings, setDrawings as writeDrawings, subscribeDrawings } from '../lib/drawingStore';

/**
 * Reads/writes the drawings for a symbol from the shared per-symbol store and
 * stays in sync when any other panel showing the same symbol edits them.
 */
export function useSymbolDrawings(symbol: string): [Drawing[], (drawings: Drawing[]) => void] {
  const [drawings, setLocal] = useState<Drawing[]>(() => getDrawings(symbol));

  // Re-read when the symbol changes or another panel updates this symbol.
  useEffect(() => {
    setLocal(getDrawings(symbol));
    return subscribeDrawings((changed) => {
      if (changed === symbol) setLocal(getDrawings(symbol));
    });
  }, [symbol]);

  const update = useCallback((next: Drawing[]) => {
    writeDrawings(symbol, next); // persists + notifies (this hook included)
  }, [symbol]);

  return [drawings, update];
}
