import React from 'react';
import type { IndicatorConfig } from '@ibkr-chart/types';
import { indicatorColors, SESSION_COLORS } from '../../lib/chartTheme';
import { indicatorKey, BB_DEFAULT_STDDEV, BB_DEFAULT_BASIS_COLOR } from '../../lib/indicators';
import type { SessionOverlays } from '../../lib/layout';
import styles from './IndicatorPanel.module.css';

interface Props {
  indicators: IndicatorConfig[];
  onChange: (updated: IndicatorConfig[]) => void;
  sessionOverlays: SessionOverlays;
  onSessionOverlaysChange: (updated: SessionOverlays) => void;
}

const SESSION_TOGGLES: Array<{ key: keyof SessionOverlays; label: string; color: string }> = [
  { key: 'openingRange', label: 'Opening range (5m)', color: SESSION_COLORS.openingRange },
  { key: 'prevDayHL',    label: 'Prev day H/L',       color: SESSION_COLORS.prevDayHigh },
  { key: 'premarketHL',  label: 'Pre-market H/L',     color: SESSION_COLORS.premarket },
  { key: 'shading',      label: 'Session shading',    color: SESSION_COLORS.premarket },
  { key: 'extendedPrice', label: 'Pre/post price (daily)', color: SESSION_COLORS.preMarketPrice },
];

type Preset = { type: IndicatorConfig['type']; period: number; source?: 'daily'; label?: string };

const PRESETS: Preset[] = [
  { type: 'EMA', period: 9 },
  { type: 'EMA', period: 20 },
  { type: 'EMA', period: 50 },
  { type: 'SMA', period: 20 },
  { type: 'SMA', period: 50 },
  { type: 'SMA', period: 200 },
];

// Daily-source MAs — computed on daily bars, projected onto any timeframe.
const DAILY_PRESETS: Preset[] = [
  { type: 'SMA', period: 5,   source: 'daily' },
  { type: 'SMA', period: 20,  source: 'daily' },
  { type: 'SMA', period: 200, source: 'daily' },
];

// Bollinger Bands — always computed on the panel's own bars, so the values
// follow whatever timeframe the chart is on. 20/2 is TradingView's default.
const BAND_PRESETS: Preset[] = [
  { type: 'BB', period: 20, label: 'Bollinger 20' },
  { type: 'BB', period: 50, label: 'Bollinger 50' },
];

export default function IndicatorPanel({ indicators, onChange, sessionOverlays, onSessionOverlaysChange }: Props) {
  const toggle = (p: Preset) => {
    const key = indicatorKey(p);
    const existing = indicators.find((i) => indicatorKey(i) === key);

    if (existing) {
      onChange(indicators.map((i) => (indicatorKey(i) === key ? { ...i, visible: !i.visible } : i)));
    } else {
      const added: IndicatorConfig = {
        type: p.type, period: p.period, source: p.source,
        color: indicatorColors[key] ?? '#8a95a8', visible: true,
      };
      if (p.type === 'BB') {
        added.stdDev = BB_DEFAULT_STDDEV;
        added.basisColor = BB_DEFAULT_BASIS_COLOR;
      }
      onChange([...indicators, added]);
    }
  };

  const remove = (p: Preset) => {
    const key = indicatorKey(p);
    onChange(indicators.filter((i) => indicatorKey(i) !== key));
  };

  const renderPreset = (p: Preset) => {
    const key = indicatorKey(p);
    const active = indicators.find((i) => indicatorKey(i) === key);
    const isOn = active?.visible ?? false;
    const color = active?.color ?? indicatorColors[key] ?? '#8a95a8';
    return (
      <button
        key={key}
        className={`${styles.presetBtn} ${isOn ? styles.active : ''}`}
        style={{ '--ind-color': color } as React.CSSProperties}
        onClick={() => toggle(p)}
      >
        <span className={styles.dot} />
        <span className={styles.label}>{p.label ?? `${p.type} ${p.period}`}</span>
        {isOn && (
          <span
            className={styles.removeBtn}
            role="button"
            onClick={(e) => { e.stopPropagation(); remove(p); }}
            title="Remove"
          >
            ×
          </span>
        )}
      </button>
    );
  };

  return (
    <div className={styles.panel}>
      <div className={styles.title}>Indicators</div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>Moving averages</div>
        {PRESETS.map(renderPreset)}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>Daily MAs (on any timeframe)</div>
        {DAILY_PRESETS.map(renderPreset)}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>Bands</div>
        {BAND_PRESETS.map(renderPreset)}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>Session levels</div>
        {SESSION_TOGGLES.map(({ key, label, color }) => {
          // Absent means ON: overlays added after a layout was saved must not
          // read as switched off just because the old panel never mentioned them.
          const isOn = sessionOverlays[key] !== false;
          return (
            <button
              key={key}
              className={`${styles.presetBtn} ${isOn ? styles.active : ''}`}
              style={{ '--ind-color': color } as React.CSSProperties}
              onClick={() => onSessionOverlaysChange({ ...sessionOverlays, [key]: !isOn })}
            >
              <span className={styles.dot} />
              <span className={styles.label}>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
