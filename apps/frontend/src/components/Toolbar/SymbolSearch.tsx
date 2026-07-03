import { useState, useRef, useEffect, useCallback } from 'react';
import type { ContractSearchResult, SecType } from '@ibkr-chart/types';
import { useSymbolSearch } from '../../hooks/useSymbolSearch';
import styles from './SymbolSearch.module.css';

interface Props {
  currentSymbol: string | null;
  onSelect: (result: ContractSearchResult) => void;
}

const SEC_TYPE_BADGE: Record<string, string> = {
  STK: 'Stock',
  FUT: 'Future',
  OPT: 'Option',
  CASH: 'Forex',
  IND: 'Index',
};

export default function SymbolSearch({ currentSymbol, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { results, loading } = useSymbolSearch(query);

  const openSearch = useCallback(() => {
    setOpen(true);
    setQuery('');
    setCursor(0);
    setTimeout(() => inputRef.current?.focus(), 10);
  }, []);

  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const handleSelect = useCallback(
    (result: ContractSearchResult) => {
      onSelect(result);
      closeSearch();
    },
    [onSelect, closeSearch]
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === 'Enter' && results[cursor]) {
        handleSelect(results[cursor]);
      } else if (e.key === 'Escape') {
        closeSearch();
      }
    },
    [results, cursor, handleSelect, closeSearch]
  );

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) closeSearch();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, closeSearch]);

  // Global shortcut: / or Cmd+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.key === '/' || (e.metaKey && e.key === 'k')) && !open) {
        e.preventDefault();
        openSearch();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, openSearch]);

  return (
    <div ref={containerRef} className={styles.root}>
      <button className={styles.trigger} onClick={openSearch}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <span className={styles.symbol}>{currentSymbol ?? 'Search symbol…'}</span>
        <kbd className={styles.kbd}>/</kbd>
      </button>

      {open && (
        <div className={`${styles.dropdown} fade-up`}>
          <div className={styles.inputRow}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className={styles.searchIcon}>
              <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              ref={inputRef}
              className={styles.input}
              placeholder="Search symbol, name…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
              onKeyDown={handleKey}
              spellCheck={false}
              autoComplete="off"
            />
            {loading && <div className={styles.spinner} />}
          </div>

          <div className={styles.results}>
            {results.length === 0 && query.length > 0 && !loading && (
              <div className={styles.empty}>No results for "{query}"</div>
            )}
            {results.map((r, i) => (
              <button
                key={`${r.conId}-${r.symbol}`}
                className={`${styles.result} ${i === cursor ? styles.active : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => handleSelect(r)}
              >
                <span className={styles.resultSymbol}>{r.symbol}</span>
                <span className={styles.resultDesc}>{r.description}</span>
                <span className={`${styles.badge} ${styles[`badge_${r.secType}`] ?? ''}`}>
                  {SEC_TYPE_BADGE[r.secType] ?? r.secType}
                </span>
                <span className={styles.resultExchange}>{r.exchange}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
