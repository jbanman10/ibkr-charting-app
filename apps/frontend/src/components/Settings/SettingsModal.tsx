/**
 * SettingsModal — general app settings.
 *
 * Sectioned so more settings can land here later; Appearance is the first.
 *
 * The colour fields are deliberately the same nine that chartthemes.com
 * publishes, in the same order and with the same names, so a theme from that
 * site can be transferred field-by-field — or pasted in one go via "Paste a
 * theme", which reads the nine colours out of whatever you copied.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  PRESETS,
  THEME_FIELDS,
  DEFAULT_ACCENT,
  parseThemeColors,
  parseColor,
  toHex,
  type ChartTheme,
} from '../../lib/theme';
import { getTheme, setTheme } from '../../lib/themeStore';
import {
  getChartSettings,
  setChartSettings,
  type CandleUpdateMode,
} from '../../lib/chartSettingsStore';
import styles from './SettingsModal.module.css';

interface Props {
  onClose: () => void;
}

type Section = 'appearance' | 'charts';

const CANDLE_MODES: Array<{ id: CandleUpdateMode; label: string; blurb: string }> = [
  {
    id: 'exact',
    label: 'Exact — match TWS',
    blurb: 'Candles change only when IBKR sends data. Nothing on screen is ever '
      + 'provisional, so a closed bar never shifts afterwards. IBKR reports a new '
      + '1-minute bar about 6 seconds after the minute turns, so the new candle '
      + 'appears then rather than on the boundary.',
  },
  {
    id: 'smooth',
    label: 'Smooth — sub-second',
    blurb: 'The forming candle is painted from the live tick feed and the next '
      + 'candle opens on the minute. Much more responsive, but everything between '
      + 'the boundary and IBKR’s first report is a placeholder and re-anchors '
      + 'when the official bar arrives.',
  },
];

export default function SettingsModal({ onClose }: Props) {
  const [section, setSection] = useState<Section>('appearance');
  const [theme, setLocal] = useState<ChartTheme>(getTheme);
  const [candleMode, setCandleMode] = useState<CandleUpdateMode>(() => getChartSettings().candleUpdates);
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);

  // Esc closes, matching the other modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Every edit applies immediately — you judge a theme by looking at the chart,
  // not by reading hex codes, so there's no Save button to hide behind.
  const update = useCallback((patch: Partial<ChartTheme>) => {
    const next = { ...theme, ...patch, id: 'custom', name: patch.name ?? 'Custom' };
    setLocal(next);
    setTheme(next);
  }, [theme]);

  const applyPreset = useCallback((p: ChartTheme) => {
    setLocal(p);
    setTheme(p);
  }, []);

  const applyPaste = useCallback(() => {
    const parsed = parseThemeColors(paste);
    if (!parsed) {
      setPasteError('Need nine colours — copy all of a theme’s values from chartthemes.com.');
      return;
    }
    setPasteError(null);
    const next: ChartTheme = { ...theme, ...parsed, id: 'custom', name: 'Custom' };
    setLocal(next);
    setTheme(next);
    setPaste('');
  }, [paste, theme]);

  const setField = (key: keyof ChartTheme, raw: string) => {
    const c = parseColor(raw);
    update({ [key]: c ? toHex(c) : raw } as Partial<ChartTheme>);
  };

  const candleFields = THEME_FIELDS.filter((f) => f.group === 'candle');
  const generalFields = THEME_FIELDS.filter((f) => f.group === 'general');

  const renderField = (key: keyof ChartTheme, label: string) => {
    const value = String(theme[key] ?? '');
    const valid = !!parseColor(value);
    return (
      <div key={key} className={styles.field}>
        <span className={styles.fieldLabel}>{label}</span>
        <div className={styles.fieldInputs}>
          <label className={styles.swatch} style={{ background: valid ? value : 'transparent' }}>
            <input
              type="color"
              value={valid ? toHex(parseColor(value)!) : '#000000'}
              onChange={(e) => setField(key, e.target.value)}
            />
          </label>
          <input
            className={`${styles.hexInput} ${valid ? '' : styles.hexInvalid}`}
            value={value}
            spellCheck={false}
            onChange={(e) => setField(key, e.target.value)}
          />
        </div>
      </div>
    );
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.window} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>Settings</span>
          <button className={styles.iconBtn} onClick={onClose} title="Close (Esc)">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className={styles.body}>
          <nav className={styles.nav}>
            <button
              className={`${styles.navItem} ${section === 'appearance' ? styles.navActive : ''}`}
              onClick={() => setSection('appearance')}
            >
              Appearance
            </button>
            <button
              className={`${styles.navItem} ${section === 'charts' ? styles.navActive : ''}`}
              onClick={() => setSection('charts')}
            >
              Charts
            </button>
          </nav>

          <div className={styles.content}>
            {section === 'appearance' && (
              <>
                <section className={styles.group}>
                  <h4 className={styles.groupTitle}>Presets</h4>
                  <div className={styles.presets}>
                    {PRESETS.map((p) => (
                      <button
                        key={p.id}
                        className={`${styles.preset} ${theme.id === p.id ? styles.presetActive : ''}`}
                        onClick={() => applyPreset(p)}
                        title={p.name}
                      >
                        <span className={styles.presetSwatches}>
                          <i style={{ background: p.background }} />
                          <i style={{ background: p.bullBody }} />
                          <i style={{ background: p.bearBody }} />
                        </span>
                        {p.name}
                      </button>
                    ))}
                  </div>
                </section>

                <section className={styles.group}>
                  <h4 className={styles.groupTitle}>Paste a theme</h4>
                  <p className={styles.hint}>
                    Copy a theme's colours from{' '}
                    <a href="https://chartthemes.com" target="_blank" rel="noreferrer">chartthemes.com</a>
                    {' '}and paste below — the nine values are read in the order that site lists them
                    (bearish body/wick/border, bullish body/wick/border, background, foreground, text).
                  </p>
                  <textarea
                    className={styles.paste}
                    value={paste}
                    onChange={(e) => { setPaste(e.target.value); setPasteError(null); }}
                    placeholder={'#5A5A5A\n#4A4A4A\n#3F3F3F\n#B0B0B0\n#A0A0A0\n#D0D0D0\n#121212\n#E0E0E0\n#E0E0E0'}
                    rows={4}
                    spellCheck={false}
                  />
                  {pasteError && <div className={styles.error}>{pasteError}</div>}
                  <button className={styles.applyBtn} onClick={applyPaste} disabled={!paste.trim()}>
                    Apply pasted theme
                  </button>
                </section>

                <section className={styles.group}>
                  <h4 className={styles.groupTitle}>Candle colors</h4>
                  <div className={styles.fields}>
                    {candleFields.map((f) => renderField(f.key, f.label))}
                  </div>
                </section>

                <section className={styles.group}>
                  <h4 className={styles.groupTitle}>General colors</h4>
                  <div className={styles.fields}>
                    {generalFields.map((f) => renderField(f.key, f.label))}
                    {renderField('accent', 'Accent (buttons)')}
                  </div>
                  <p className={styles.hint}>
                    Panels, borders and secondary text are derived from background and foreground,
                    so the whole app follows — including the toolbar and drawers.
                  </p>
                </section>

                <section className={styles.group}>
                  <button
                    className={styles.resetBtn}
                    onClick={() => applyPreset(PRESETS[0])}
                  >
                    Reset to Mallard Dark
                  </button>
                </section>
              </>
            )}

            {section === 'charts' && (
              <section className={styles.group}>
                <h4 className={styles.groupTitle}>Candle updates</h4>
                <p className={styles.hint}>
                  IBKR's chart feed reports a finished 1-minute bar roughly <b>6 seconds</b> after
                  the minute turns. That delay can't be removed, so the choice is whether to show
                  a placeholder in the meantime.
                </p>
                <div className={styles.modeList}>
                  {CANDLE_MODES.map((m) => (
                    <button
                      key={m.id}
                      className={`${styles.mode} ${candleMode === m.id ? styles.modeActive : ''}`}
                      onClick={() => {
                        setCandleMode(m.id);
                        setChartSettings({ ...getChartSettings(), candleUpdates: m.id });
                      }}
                    >
                      <span className={styles.modeHead}>
                        <span className={styles.modeRadio} aria-hidden />
                        {m.label}
                      </span>
                      <span className={styles.modeBlurb}>{m.blurb}</span>
                    </button>
                  ))}
                </div>
                <p className={styles.hint}>
                  Applies to every chart immediately — no reload needed. Price alerts keep firing
                  off the live tick feed in both modes.
                </p>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export { DEFAULT_ACCENT };
