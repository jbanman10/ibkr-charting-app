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
}

export default function DrawingToolbar({
  activeTool,
  onToolChange,
  onClearDrawings,
  drawingCount,
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
