/**
 * IndicatorSettings
 *
 * Floating settings card for a moving-average line, opened by double-clicking
 * it on the chart — same pattern (and styles) as DrawingSettings. Edits color
 * and line width; changes apply live via the panel's indicator config.
 */

import type { IndicatorConfig } from '@ibkr-chart/types';
import { RECT_PALETTE } from '../../lib/chartTheme';
import styles from './DrawingSettings.module.css';

interface Props {
  indicator: IndicatorConfig;
  onChange: (patch: Partial<IndicatorConfig>) => void;
  onRemove: () => void;
  onClose: () => void;
}

const WIDTHS = [1, 2, 3, 4];

export default function IndicatorSettings({ indicator, onChange, onRemove, onClose }: Props) {
  const width = indicator.lineWidth ?? 1;

  return (
    <div
      className={styles.root}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className={styles.header}>
        <span className={styles.title}>{indicator.type} {indicator.period}</span>
        <button className={styles.closeBtn} onClick={onClose} title="Close (Esc)">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* Color */}
      <div className={styles.row}>
        <span className={styles.label}>Color</span>
        <div className={styles.swatches}>
          {RECT_PALETTE.map((c) => (
            <button
              key={c.name}
              className={`${styles.swatch} ${indicator.color === c.border ? styles.swatchActive : ''}`}
              style={{ background: c.border }}
              onClick={() => onChange({ color: c.border })}
              title={c.name}
            />
          ))}
          <label className={styles.customSwatch} title="Custom color">
            <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(indicator.color) ? indicator.color : '#2962ff'}
              onChange={(e) => onChange({ color: e.target.value })}
            />
          </label>
        </div>
      </div>

      {/* Line width */}
      <div className={styles.row}>
        <span className={styles.label}>Width</span>
        <div className={styles.btnGroup}>
          {WIDTHS.map((w) => (
            <button
              key={w}
              className={`${styles.opt} ${width === w ? styles.optActive : ''}`}
              onClick={() => onChange({ lineWidth: w })}
              title={`${w}px`}
            >
              <span className={styles.widthPreview} style={{ height: w }} />
            </button>
          ))}
        </div>
      </div>

      <div className={styles.footer}>
        <button className={styles.deleteBtn} onClick={onRemove}>Remove indicator</button>
      </div>
    </div>
  );
}
