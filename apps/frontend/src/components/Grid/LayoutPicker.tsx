/**
 * LayoutPicker
 *
 * Dropdown that shows all grid preset options as small SVG previews.
 * Clicking one switches the grid layout immediately.
 */

import { useState, useRef, useEffect } from 'react';
import { GRID_PRESETS, type GridPresetId } from '../../lib/layout';
import styles from './LayoutPicker.module.css';

// SVG preview icons for each layout
const LAYOUT_SVGS: Record<GridPresetId, React.ReactNode> = {
  single: (
    <svg viewBox="0 0 24 24" fill="none" className={styles.previewSvg}>
      <rect x="2" y="2" width="20" height="20" rx="2" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
    </svg>
  ),
  'side-by-side': (
    <svg viewBox="0 0 24 24" fill="none" className={styles.previewSvg}>
      <rect x="2" y="2" width="9" height="20" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="13" y="2" width="9" height="20" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
    </svg>
  ),
  stacked: (
    <svg viewBox="0 0 24 24" fill="none" className={styles.previewSvg}>
      <rect x="2" y="2" width="20" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="2" y="13" width="20" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
    </svg>
  ),
  quad: (
    <svg viewBox="0 0 24 24" fill="none" className={styles.previewSvg}>
      <rect x="2" y="2" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="13" y="2" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="2" y="13" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="13" y="13" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
    </svg>
  ),
  'grid-6': (
    <svg viewBox="0 0 24 24" fill="none" className={styles.previewSvg}>
      <rect x="2" y="2" width="6" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="9" y="2" width="6" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="16" y="2" width="6" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="2" y="13" width="6" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="9" y="13" width="6" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="16" y="13" width="6" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
    </svg>
  ),
  'primary-left': (
    <svg viewBox="0 0 24 24" fill="none" className={styles.previewSvg}>
      <rect x="2" y="2" width="13" height="20" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.15)"/>
      <rect x="17" y="2" width="5" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="17" y="13" width="5" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
    </svg>
  ),
  'primary-right': (
    <svg viewBox="0 0 24 24" fill="none" className={styles.previewSvg}>
      <rect x="2" y="2" width="5" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="2" y="13" width="5" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.08)"/>
      <rect x="9" y="2" width="13" height="20" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="rgba(61,126,255,0.15)"/>
    </svg>
  ),
};

interface Props {
  current: GridPresetId;
  onChange: (id: GridPresetId) => void;
}

export default function LayoutPicker({ current, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const currentPreset = GRID_PRESETS[current];

  return (
    <div ref={ref} className={styles.root}>
      <button
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Change layout"
      >
        <span className={styles.triggerIcon}>{LAYOUT_SVGS[current]}</span>
        <span className={styles.triggerLabel}>{currentPreset.label}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={`${styles.chevron} ${open ? styles.chevronUp : ''}`}>
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownLabel}>Chart Layout</div>
          <div className={styles.grid}>
            {Object.values(GRID_PRESETS).map((preset) => (
              <button
                key={preset.id}
                className={`${styles.option} ${current === preset.id ? styles.optionActive : ''}`}
                onClick={() => { onChange(preset.id); setOpen(false); }}
                title={preset.label}
              >
                {LAYOUT_SVGS[preset.id]}
                <span className={styles.optionLabel}>{preset.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
