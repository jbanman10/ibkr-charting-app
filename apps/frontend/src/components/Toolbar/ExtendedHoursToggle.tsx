/**
 * ExtendedHoursToggle
 *
 * Toggles between Regular Trading Hours (RTH) only and all hours
 * including pre-market and after-hours data.
 *
 * useRTH=0 → all hours (pre + regular + post)
 * useRTH=1 → regular hours only (9:30am–4pm ET for US stocks)
 */

import styles from './ExtendedHoursToggle.module.css';

interface Props {
  useRTH: 0 | 1;
  onChange: (useRTH: 0 | 1) => void;
}

export default function ExtendedHoursToggle({ useRTH, onChange }: Props) {
  const isExtended = useRTH === 0;

  return (
    <button
      className={`${styles.btn} ${isExtended ? styles.active : ''}`}
      onClick={() => onChange(isExtended ? 1 : 0)}
      title={isExtended ? 'Extended hours ON — click for regular hours only' : 'Regular hours only — click to include pre & post market'}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        {/* Clock icon */}
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.3"/>
        <path d="M7 4v3l2 1.5" stroke="currentColor" strokeWidth="1.3"
          strokeLinecap="round" strokeLinejoin="round"/>
        {/* Extended hours indicator bars */}
        {isExtended && (
          <path d="M1 7H0M14 7h-1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        )}
      </svg>
    </button>
  );
}
