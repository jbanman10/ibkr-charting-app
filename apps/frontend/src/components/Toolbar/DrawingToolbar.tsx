/**
 * DrawingToolbar
 *
 * Renders the drawing tool palette buttons.
 * Active tool is highlighted; clicking the active tool deactivates it.
 */

import type { DrawingToolType } from '../Chart/DrawingCanvas';
import styles from './DrawingToolbar.module.css';

interface Tool {
  type: DrawingToolType;
  label: string;
  title: string;
  icon: React.ReactNode;
}

const TOOLS: Tool[] = [
  {
    type: 'trendline',
    label: 'TL',
    title: 'Trend Line (click-drag, or click two points)',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <line x1="2" y1="11" x2="12" y2="3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="2" cy="11" r="1.5" fill="currentColor"/>
        <circle cx="12" cy="3" r="1.5" fill="currentColor"/>
      </svg>
    ),
  },
  {
    type: 'channel',
    label: 'Chan',
    title: 'Parallel Channel (drag the base edge along the highs or lows; drag the middle handle to set the width)',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2 10.5 12 4.5v3.5L2 14z" fill="rgba(61,126,255,0.18)" stroke="none"/>
        <line x1="2" y1="10.5" x2="12" y2="4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <line x1="2" y1="13" x2="12" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        <circle cx="2" cy="10.5" r="1.4" fill="currentColor"/>
        <circle cx="12" cy="4.5" r="1.4" fill="currentColor"/>
      </svg>
    ),
  },
  {
    type: 'hline',
    label: 'HL',
    title: 'Horizontal Line (click once)',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeDasharray="2 2"/>
      </svg>
    ),
  },
  {
    type: 'rectangle',
    label: 'Rect',
    title: 'Rectangle (click-drag, or click two corners)',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="2" y="3" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.3"
          fill="rgba(61,126,255,0.15)"/>
      </svg>
    ),
  },
  {
    type: 'callout',
    label: 'Text',
    title: 'Text bubble (click the spot to point at, or drag out to place the bubble)',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2 2.5h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6.5L3.5 12.5V9.5H2a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z"
          stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="rgba(61,126,255,0.15)"/>
        <path d="M3.5 5.2h7M3.5 7.2h4.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    type: 'position',
    label: 'Pos',
    title: 'Position (click at entry; drag stop/target — target below entry = short)',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="1.5" y="2" width="11" height="5" fill="rgba(8,153,129,0.35)" stroke="#089981" strokeWidth="1"/>
        <rect x="1.5" y="7" width="11" height="3.5" fill="rgba(242,54,69,0.35)" stroke="#f23645" strokeWidth="1"/>
        <line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor" strokeWidth="1.3"/>
      </svg>
    ),
  },
];

interface Props {
  activeTool: DrawingToolType;
  onToolChange: (tool: DrawingToolType) => void;
  onClearDrawings: () => void;
  drawingCount: number;
  canUndo: boolean;
  onUndo: () => void;
}

export default function DrawingToolbar({
  activeTool,
  onToolChange,
  onClearDrawings,
  drawingCount,
  canUndo,
  onUndo,
}: Props) {
  const handleToolClick = (type: DrawingToolType) => {
    // Toggle off if already active
    onToolChange(activeTool === type ? 'none' : type);
  };

  return (
    <div className={styles.root}>
      <div className={styles.divider} />

      {TOOLS.map((tool) => (
        <button
          key={tool.type}
          className={`${styles.btn} ${activeTool === tool.type ? styles.active : ''}`}
          onClick={() => handleToolClick(tool.type)}
          title={tool.title}
        >
          {tool.icon}
        </button>
      ))}

      <div className={styles.divider} />
      <button
        className={styles.btn}
        onClick={onUndo}
        disabled={!canUndo}
        title={canUndo ? 'Undo last drawing change (Ctrl+Z)' : 'Nothing to undo'}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M2.5 6.5h6a3 3 0 0 1 0 6H6" stroke="currentColor" strokeWidth="1.3"
            strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M4.8 4.2 2.4 6.5l2.4 2.3" stroke="currentColor" strokeWidth="1.3"
            strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {drawingCount > 0 && (
        <>
          <div className={styles.divider} />
          <button
            className={styles.clearBtn}
            onClick={onClearDrawings}
            title={`Clear all drawings (${drawingCount})`}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <span>{drawingCount}</span>
          </button>
        </>
      )}
    </div>
  );
}
