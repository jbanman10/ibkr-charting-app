/**
 * executionStore
 *
 * Account fills (from IBKR via the backend) keyed by UNDERLYING symbol, so an
 * option fill draws on the underlying's chart. Hydrates once from
 * GET /api/executions; live additions arrive over the WS 'executions' message.
 * The backend's executions.json file is the source of truth — no localStorage.
 */

import type { TradeExecution } from '@ibkr-chart/types';

type Listener = (symbol: string) => void;

const bySymbol = new Map<string, TradeExecution[]>();
const seen = new Set<string>(); // execIds
const listeners = new Set<Listener>();

let hydrateStarted = false;

function hydrate(): void {
  if (hydrateStarted) return;
  hydrateStarted = true;
  void (async () => {
    try {
      const res = await fetch('/api/executions');
      if (!res.ok) return;
      const body = (await res.json()) as { executions?: TradeExecution[] };
      addExecutions(body.executions ?? []);
    } catch { /* backend not up yet — WS broadcasts still feed us */ }
  })();
}

export function getExecutions(symbol: string): TradeExecution[] {
  hydrate();
  return bySymbol.get(symbol) ?? [];
}

export function addExecutions(execs: TradeExecution[]): void {
  const touched = new Set<string>();
  for (const e of execs) {
    if (!e?.execId || seen.has(e.execId)) continue;
    seen.add(e.execId);
    const arr = bySymbol.get(e.symbol) ?? [];
    arr.push(e);
    arr.sort((a, b) => a.time - b.time);
    bySymbol.set(e.symbol, arr);
    touched.add(e.symbol);
  }
  for (const sym of touched) {
    for (const l of listeners) l(sym);
  }
}

export function subscribeExecutions(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
