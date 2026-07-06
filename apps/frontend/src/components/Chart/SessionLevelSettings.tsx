/**
 * SessionLevelSettings
 *
 * Floating settings card for a session level line (PDH/PDL/PMH/PML/ORH/ORL),
 * opened by double-clicking it on the chart — same pattern (and styles) as
 * DrawingSettings/IndicatorSettings. Edits color, width, and solid/dashed;
 * "Hide" turns off the level's overlay group in this panel.
 */

import { RECT_PALETTE } from '../../lib/chartTheme';
import type { SessionLevelStyle } from '../../lib/layout';
import styles from './DrawingSettings.module.css';

interface Props {
  levelKey: string;
  title: string;
  /** Resolved current style (theme defaults already applied). */
  color: string;
  lineWidth: number;
  dashed: boolean;
  onChange: (patch: SessionLevelStyle) => void;
  onHide: () => void;
  onClose: () => void;
}

const WIDTHS = [1, 2, 3, 4];

export default function SessionLevelSettings({
  levelKey, title, color, lineWidth, dashed, onChange, onHide, onClose,
}: Props) {
  return (
    <div
      className={styles.root}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className={styles.header}>
        <span className={styles.title}>{title} ({levelKey})</span>
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
              className={`${styles.swatch} ${color === c.border ? styles.swatchActive : ''}`}
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
              value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#2962ff'}
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
              className={`${styles.opt} ${lineWidth === w ? styles.optActive : ''}`}
              onClick={() => onChange({ lineWidth: w })}
              title={`${w}px`}
            >
              <span className={styles.widthPreview} style={{ height: w }} />
            </button>
          ))}
        </div>
      </div>

      {/* Line style */}
      <div className={styles.row}>
        <span className={styles.label}>Style</span>
        <div className={styles.btnGroup}>
          <button
            className={`${styles.opt} ${!dashed ? styles.optActive : ''}`}
            onClick={() => onChange({ dashed: false })}
          >
            Solid
          </button>
          <button
            className={`${styles.opt} ${dashed ? styles.optActive : ''}`}
            onClick={() => onChange({ dashed: true })}
          >
            Dashed
          </button>
        </div>
      </div>

      <div className={styles.footer}>
        <button className={styles.deleteBtn} onClick={onHide}>Hide level</button>
      </div>
    </div>
  );
}
