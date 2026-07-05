/**
 * DrawingSettings
 *
 * Floating settings card for a drawing, opened by double-clicking it on the
 * chart. Edits color, line width, line style (solid/dashed), and extend-right,
 * adapting the controls to the drawing type. All changes apply live via the
 * per-symbol drawing store.
 */

import { RECT_PALETTE } from '../../lib/chartTheme';
import type { Drawing } from '../../lib/drawings';
import styles from './DrawingSettings.module.css';

interface Props {
  drawing: Drawing;
  onChange: (patch: Partial<Drawing>) => void;
  onDelete: () => void;
  onClose: () => void;
}

const TITLES: Record<Drawing['type'], string> = {
  trendline: 'Trend Line',
  hline: 'Horizontal Line',
  rectangle: 'Rectangle',
};

const WIDTHS = [1, 2, 3, 4];

function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export default function DrawingSettings({ drawing, onChange, onDelete, onClose }: Props) {
  const color = drawing.type === 'rectangle' ? drawing.borderColor : drawing.color;
  const width = drawing.type === 'rectangle' ? (drawing.borderWidth ?? 1) : drawing.width;
  const dashed = drawing.type === 'rectangle' ? false : !!drawing.dashed;

  const setColor = (hex: string) => {
    if (drawing.type === 'rectangle') {
      onChange({ borderColor: hex, fillColor: hexToRgba(hex, 0.15) } as Partial<Drawing>);
    } else {
      onChange({ color: hex } as Partial<Drawing>);
    }
  };

  const setWidth = (w: number) => {
    if (drawing.type === 'rectangle') onChange({ borderWidth: w } as Partial<Drawing>);
    else onChange({ width: w } as Partial<Drawing>);
  };

  return (
    <div
      className={styles.root}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className={styles.header}>
        <span className={styles.title}>{TITLES[drawing.type]}</span>
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
              onClick={() => setColor(c.border)}
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
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
        </div>
      </div>

      {/* Line width */}
      <div className={styles.row}>
        <span className={styles.label}>{drawing.type === 'rectangle' ? 'Border' : 'Width'}</span>
        <div className={styles.btnGroup}>
          {WIDTHS.map((w) => (
            <button
              key={w}
              className={`${styles.opt} ${width === w ? styles.optActive : ''}`}
              onClick={() => setWidth(w)}
              title={`${w}px`}
            >
              <span className={styles.widthPreview} style={{ height: w }} />
            </button>
          ))}
        </div>
      </div>

      {/* Line style (lines only) */}
      {drawing.type !== 'rectangle' && (
        <div className={styles.row}>
          <span className={styles.label}>Style</span>
          <div className={styles.btnGroup}>
            <button
              className={`${styles.opt} ${!dashed ? styles.optActive : ''}`}
              onClick={() => onChange({ dashed: false } as Partial<Drawing>)}
            >
              Solid
            </button>
            <button
              className={`${styles.opt} ${dashed ? styles.optActive : ''}`}
              onClick={() => onChange({ dashed: true } as Partial<Drawing>)}
            >
              Dashed
            </button>
          </div>
        </div>
      )}

      {/* Extend right (trendline + rectangle) */}
      {drawing.type !== 'hline' && (
        <div className={styles.row}>
          <span className={styles.label}>Extend</span>
          <div className={styles.btnGroup}>
            <button
              className={`${styles.opt} ${(drawing as { extendRight?: boolean }).extendRight ? styles.optActive : ''}`}
              onClick={() => onChange({ extendRight: !(drawing as { extendRight?: boolean }).extendRight } as Partial<Drawing>)}
              title="Project the drawing to the right chart edge"
            >
              Right →
            </button>
          </div>
        </div>
      )}

      <div className={styles.footer}>
        <button className={styles.deleteBtn} onClick={onDelete}>Delete drawing</button>
      </div>
    </div>
  );
}
