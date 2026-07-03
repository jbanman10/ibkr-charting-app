import React from 'react';
import type { IndicatorConfig } from '@ibkr-chart/types';
import { indicatorColors, SESSION_COLORS } from '../../lib/chartTheme';
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
  { key: 'prevDayHL',    label: 'Prev day H/L',       color: SESSION_COLORS.prevDay },
  { key: 'premarketHL',  label: 'Pre-market H/L',     color: SESSION_COLORS.premarket },
  { key: 'shading',      label: 'Session shading',    color: SESSION_COLORS.premarket },
];

const PRESETS: Array<{ type: 'SMA' | 'EMA'; period: number }> = [
  { type: 'SMA', period: 20 },
  { type: 'SMA', period: 50 },
  { type: 'SMA', period: 200 },
  { type: 'EMA', period: 20 },
  { type: 'EMA', period: 50 },
];

export default function IndicatorPanel({ indicators, onChange, sessionOverlays, onSessionOverlaysChange }: Props) {
  const toggle = (type: 'SMA' | 'EMA', period: number) => {
    const key = `${type}-${period}`;
    const existing = indicators.find((i) => `${i.type}-${i.period}` === key);

    if (existing) {
      // Toggle visibility
      onChange(
        indicators.map((i) =>
          `${i.type}-${i.period}` === key ? { ...i, visible: !i.visible } : i
        )
      );
    } else {
      // Add new
      onChange([
        ...indicators,
        {
          type,
          period,
          color: indicatorColors[key] ?? '#8a95a8',
          visible: true,
        },
      ]);
    }
  };

  const remove = (type: 'SMA' | 'EMA', period: number) => {
    onChange(indicators.filter((i) => !(i.type === type && i.period === period)));
  };

  return (
    <div className={styles.panel}>
      <div className={styles.title}>Indicators</div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>Moving averages</div>
        {PRESETS.map(({ type, period }) => {
          const key = `${type}-${period}`;
          const active = indicators.find((i) => `${i.type}-${i.period}` === key);
          const isOn = active?.visible ?? false;
          const color = indicatorColors[key] ?? '#8a95a8';
          return (
            <button
              key={key}
              className={`${styles.presetBtn} ${isOn ? styles.active : ''}`}
              style={{ '--ind-color': color } as React.CSSProperties}
              onClick={() => toggle(type, period)}
            >
              <span className={styles.dot} />
              <span className={styles.label}>{type} {period}</span>
              {isOn && (
                <span
                  className={styles.removeBtn}
                  role="button"
                  onClick={(e) => { e.stopPropagation(); remove(type, period); }}
                  title="Remove"
                >
                  ×
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>Session levels</div>
        {SESSION_TOGGLES.map(({ key, label, color }) => {
          const isOn = sessionOverlays[key];
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
