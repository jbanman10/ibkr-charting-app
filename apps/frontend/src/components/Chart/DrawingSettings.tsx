/**
 * DrawingSettings
 *
 * Floating settings card for a drawing, opened by double-clicking it on the
 * chart. Edits color, line width, line style (solid/dashed), and extend-right,
 * adapting the controls to the drawing type. All changes apply live via the
 * per-symbol drawing store.
 */

import { useEffect, useState } from 'react';
import { RECT_PALETTE } from '../../lib/chartTheme';
import type { Drawing } from '../../lib/drawings';
import {
  canHaveDefaults,
  clearDefaultFor,
  hasDefaultFor,
  saveDefaultFrom,
  styleOf,
} from '../../lib/drawingDefaultsStore';
import styles from './DrawingSettings.module.css';

interface Props {
  drawing: Drawing;
  onChange: (patch: Partial<Drawing>) => void;
  onDelete: () => void;
  onClose: () => void;
}

const TITLES: Record<Drawing['type'], string> = {
  trendline: 'Trend Line',
  channel: 'Parallel Channel',
  hline: 'Horizontal Line',
  rectangle: 'Rectangle',
  position: 'Position',
  alert: 'Price Alert',
  callout: 'Text Bubble',
};

const WIDTHS = [1, 2, 3, 4];

/**
 * "Save as default" — remember this drawing's styling for new ones of its type.
 *
 * Talks to the defaults store directly rather than through props: it is a
 * self-contained preference with no bearing on the drawing being edited, and
 * threading four more callbacks through ChartPanel would buy nothing. Price
 * alerts carry nothing but a price, so they get no row at all.
 */
function DefaultsRow({ drawing }: { drawing: Drawing }) {
  const [saved, setSaved] = useState(() => hasDefaultFor(drawing.type));
  const [justSaved, setJustSaved] = useState(false);

  // Re-read when the card is pointed at a different drawing.
  useEffect(() => { setSaved(hasDefaultFor(drawing.type)); setJustSaved(false); }, [drawing.id, drawing.type]);

  // Confirmation is a transient label, not a toast — the button is right there.
  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 1600);
    return () => clearTimeout(t);
  }, [justSaved]);

  if (!canHaveDefaults(drawing.type) || !styleOf(drawing)) return null;

  const isPosition = drawing.type === 'position';
  return (
    <div className={styles.row}>
      <span className={styles.label}>Default</span>
      <div className={styles.btnGroup}>
        <button
          className={`${styles.opt} ${justSaved ? styles.optActive : ''}`}
          onClick={() => { if (saveDefaultFrom(drawing)) { setSaved(true); setJustSaved(true); } }}
          title={isPosition
            ? 'New positions open at this reward:risk'
            : 'New drawings of this type start with these settings'}
        >
          {justSaved ? 'Saved ✓' : 'Save'}
        </button>
        <button
          className={styles.opt}
          disabled={!saved}
          onClick={() => { clearDefaultFor(drawing.type); setSaved(false); setJustSaved(false); }}
          title={saved ? 'Go back to the built-in starting settings' : 'No saved default'}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export default function DrawingSettings({ drawing, onChange, onDelete, onClose }: Props) {
  // Price alert: level + armed/triggered state. Editing the price re-arms it.
  if (drawing.type === 'alert') {
    const armed = !drawing.triggeredAt;
    return (
      <div
        className={styles.root}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span className={styles.title}>{TITLES.alert} {armed ? '(Armed)' : '(Triggered ✓)'}</span>
          <button className={styles.closeBtn} onClick={onClose} title="Close (Esc)">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Price</span>
          <input
            className={styles.numInput}
            type="number"
            step="0.01"
            value={drawing.price}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) onChange({ price: v, triggeredAt: null } as Partial<Drawing>);
            }}
          />
        </div>
        {!armed && (
          <div className={styles.row}>
            <span className={styles.label}>Status</span>
            <div className={styles.btnGroup}>
              <button className={styles.opt} onClick={() => onChange({ triggeredAt: null } as Partial<Drawing>)}>
                Re-arm
              </button>
            </div>
          </div>
        )}
        <div className={styles.footer}>
          <button className={styles.deleteBtn} onClick={onDelete}>Delete alert</button>
        </div>
      </div>
    );
  }

  // Text bubble: the text itself is the point, so it leads and takes focus.
  if (drawing.type === 'callout') {
    return (
      <div
        className={styles.root}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span className={styles.title}>{TITLES.callout}</span>
          <button className={styles.closeBtn} onClick={onClose} title="Close (Esc)">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Text</span>
          <textarea
            className={styles.textArea}
            value={drawing.text}
            placeholder="Type here…"
            rows={3}
            maxLength={240}
            spellCheck={false}
            // Autofocus: the bubble is created empty and this card opens with it,
            // so the caret should already be waiting in the box.
            autoFocus
            onChange={(e) => onChange({ text: e.target.value } as Partial<Drawing>)}
          />
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Color</span>
          <div className={styles.swatches}>
            {RECT_PALETTE.map((c) => (
              <button
                key={c.name}
                className={`${styles.swatch} ${drawing.color === c.border ? styles.swatchActive : ''}`}
                style={{ background: c.border }}
                onClick={() => onChange({ color: c.border } as Partial<Drawing>)}
                title={c.name}
              />
            ))}
            <label className={styles.customSwatch} title="Custom color">
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(drawing.color) ? drawing.color : '#3d7eff'}
                onChange={(e) => onChange({ color: e.target.value } as Partial<Drawing>)}
              />
            </label>
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Fill</span>
          <div className={styles.btnGroup}>
            <button
              className={`${styles.opt} ${drawing.fillColor.startsWith('rgba(19,23,34') ? styles.optActive : ''}`}
              onClick={() => onChange({ fillColor: 'rgba(19,23,34,0.92)' } as Partial<Drawing>)}
              title="Dark background"
            >
              Dark
            </button>
            <button
              className={`${styles.opt} ${drawing.fillColor === hexToRgba(drawing.color, 0.18) ? styles.optActive : ''}`}
              onClick={() => onChange({ fillColor: hexToRgba(drawing.color, 0.18) } as Partial<Drawing>)}
              title="Tinted with the bubble colour"
            >
              Tint
            </button>
            <button
              className={`${styles.opt} ${drawing.fillColor === 'transparent' ? styles.optActive : ''}`}
              onClick={() => onChange({ fillColor: 'transparent' } as Partial<Drawing>)}
              title="No background"
            >
              None
            </button>
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Border</span>
          <div className={styles.btnGroup}>
            {WIDTHS.map((w) => (
              <button
                key={w}
                className={`${styles.opt} ${(drawing.width ?? 1) === w ? styles.optActive : ''}`}
                onClick={() => onChange({ width: w } as Partial<Drawing>)}
                title={`${w}px`}
              >
                <span className={styles.widthPreview} style={{ height: w }} />
              </button>
            ))}
          </div>
        </div>

        <DefaultsRow drawing={drawing} />

        <div className={styles.footer}>
          <button className={styles.deleteBtn} onClick={onDelete}>Delete drawing</button>
        </div>
      </div>
    );
  }

  // Position tool: fixed colors (green/red zones), numeric price fields instead.
  if (drawing.type === 'position') {
    const risk = Math.abs(drawing.entry - drawing.stop);
    const reward = Math.abs(drawing.target - drawing.entry);
    const rr = risk > 1e-9 ? reward / risk : 0;
    const numRow = (label: string, key: 'entry' | 'stop' | 'target') => (
      <div className={styles.row}>
        <span className={styles.label}>{label}</span>
        <input
          className={styles.numInput}
          type="number"
          step="0.01"
          value={drawing[key]}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) onChange({ [key]: v } as Partial<Drawing>);
          }}
        />
      </div>
    );
    return (
      <div
        className={styles.root}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span className={styles.title}>
            {TITLES.position} {drawing.target >= drawing.entry ? '(Long)' : '(Short)'}
          </span>
          <button className={styles.closeBtn} onClick={onClose} title="Close (Esc)">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        {numRow('Entry', 'entry')}
        {numRow('Target', 'target')}
        {numRow('Stop', 'stop')}
        <div className={styles.row}>
          <span className={styles.label}>R : R</span>
          <span className={styles.rrValue}>{rr.toFixed(2)}</span>
        </div>
        <DefaultsRow drawing={drawing} />
        <div className={styles.footer}>
          <button className={styles.deleteBtn} onClick={onDelete}>Delete drawing</button>
        </div>
      </div>
    );
  }

  const color = drawing.type === 'rectangle' ? drawing.borderColor : drawing.color;
  const width = drawing.type === 'rectangle' ? (drawing.borderWidth ?? 1) : drawing.width;
  const dashed = drawing.type === 'rectangle' ? false : !!drawing.dashed;

  const setColor = (hex: string) => {
    if (drawing.type === 'rectangle') {
      onChange({ borderColor: hex, fillColor: hexToRgba(hex, 0.15) } as Partial<Drawing>);
    } else if (drawing.type === 'channel') {
      // Recolour the band with the edges, unless the fill was turned off —
      // a channel whose tint keeps the old colour looks like a bug.
      const keepUnfilled = !drawing.fillColor || drawing.fillColor === 'transparent';
      onChange({
        color: hex,
        ...(keepUnfilled ? {} : { fillColor: hexToRgba(hex, 0.10) }),
      } as Partial<Drawing>);
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

      {/* Label — free text drawn on the chart at the drawing's right edge */}
      <div className={styles.row}>
        <span className={styles.label}>Label</span>
        <input
          className={styles.textInput}
          type="text"
          value={(drawing as { label?: string }).label ?? ''}
          placeholder="none"
          maxLength={40}
          spellCheck={false}
          onChange={(e) => onChange({ label: e.target.value } as Partial<Drawing>)}
        />
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

      {/* Channel band fill */}
      {drawing.type === 'channel' && (
        <div className={styles.row}>
          <span className={styles.label}>Fill</span>
          <div className={styles.btnGroup}>
            <button
              className={`${styles.opt} ${drawing.fillColor && drawing.fillColor !== 'transparent' ? styles.optActive : ''}`}
              onClick={() => onChange({ fillColor: hexToRgba(drawing.color, 0.10) } as Partial<Drawing>)}
              title="Tint the band between the edges"
            >
              Tint
            </button>
            <button
              className={`${styles.opt} ${!drawing.fillColor || drawing.fillColor === 'transparent' ? styles.optActive : ''}`}
              onClick={() => onChange({ fillColor: 'transparent' } as Partial<Drawing>)}
              title="Draw the two edges only"
            >
              None
            </button>
          </div>
        </div>
      )}

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

      <DefaultsRow drawing={drawing} />

      <div className={styles.footer}>
        <button className={styles.deleteBtn} onClick={onDelete}>Delete drawing</button>
      </div>
    </div>
  );
}
