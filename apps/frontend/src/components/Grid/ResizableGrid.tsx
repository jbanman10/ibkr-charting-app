import { useRef, useCallback, useEffect, type ReactNode } from 'react';
import type { GridPreset, LayoutConfig } from '../../lib/layout';
import { buildGridColumns, buildGridRows } from '../../lib/layout';
import styles from './ResizableGrid.module.css';

interface Props {
  layout: LayoutConfig;
  preset: GridPreset;
  onColumnResize: (sizes: number[]) => void;
  onRowResize: (sizes: number[]) => void;
  children: ReactNode[];
}

export default function ResizableGrid({ layout, preset, onColumnResize, onRowResize, children }: Props) {
  const gridRef      = useRef<HTMLDivElement>(null);
  const colHandleRef = useRef<HTMLDivElement>(null);
  const rowHandleRef = useRef<HTMLDivElement>(null);

  // Draggable splitters only support a single 2-track split per axis. Grids with
  // 3+ tracks (e.g. the 2×3 grid) render as equal tracks without a splitter.
  const hasColSplit = preset.columns.length === 2;
  const hasRowSplit = preset.rows.length === 2;
  const colPct = layout.columnSizes[0] ?? 50;
  const rowPct = layout.rowSizes[0] ?? 50;

  useEffect(() => {
    if (colHandleRef.current) colHandleRef.current.style.left = `calc(${colPct}% - 5px)`;
  }, [colPct]);

  useEffect(() => {
    if (rowHandleRef.current) rowHandleRef.current.style.top = `calc(${rowPct}% - 5px)`;
  }, [rowPct]);

  const startColResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const grid = gridRef.current;
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const startX = e.clientX;
    const startPct = layout.columnSizes[0] ?? 50;
    const onMove = (ev: PointerEvent) => {
      const next = Math.round(Math.max(15, Math.min(85, startPct + ((ev.clientX - startX) / rect.width) * 100)));
      if (colHandleRef.current) colHandleRef.current.style.left = `calc(${next}% - 5px)`;
      if (gridRef.current) gridRef.current.style.gridTemplateColumns = buildGridColumns(preset, [next]);
    };
    const onUp = (ev: PointerEvent) => {
      const next = Math.round(Math.max(15, Math.min(85, startPct + ((ev.clientX - startX) / rect.width) * 100)));
      onColumnResize([next]);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [layout.columnSizes, onColumnResize, preset]);

  const startRowResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const grid = gridRef.current;
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const startY = e.clientY;
    const startPct = layout.rowSizes[0] ?? 50;
    const onMove = (ev: PointerEvent) => {
      const next = Math.round(Math.max(15, Math.min(85, startPct + ((ev.clientY - startY) / rect.height) * 100)));
      if (rowHandleRef.current) rowHandleRef.current.style.top = `calc(${next}% - 5px)`;
      if (gridRef.current) gridRef.current.style.gridTemplateRows = buildGridRows(preset, [next]);
    };
    const onUp = (ev: PointerEvent) => {
      const next = Math.round(Math.max(15, Math.min(85, startPct + ((ev.clientY - startY) / rect.height) * 100)));
      onRowResize([next]);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [layout.rowSizes, onRowResize, preset]);

  return (
    <div
      ref={gridRef}
      className={styles.grid}
      style={{
        gridTemplateAreas:   preset.areas,
        gridTemplateColumns: buildGridColumns(preset, layout.columnSizes),
        gridTemplateRows:    buildGridRows(preset, layout.rowSizes),
      }}
    >
      {preset.areaNames.map((area, i) => (
        <div key={area} className={styles.cell} style={{ gridArea: area }}>
          {children[i]}
        </div>
      ))}

      {hasColSplit && (
        <div
          ref={colHandleRef}
          className={styles.resizerCol}
          style={{ left: `calc(${colPct}% - 5px)` }}
          onPointerDown={startColResize}
        >
          <div className={styles.colLine} />
          <div className={styles.colGrip}><span/><span/><span/></div>
        </div>
      )}

      {hasRowSplit && (
        <div
          ref={rowHandleRef}
          className={styles.resizerRow}
          style={{ top: `calc(${rowPct}% - 5px)` }}
          onPointerDown={startRowResize}
        >
          <div className={styles.rowLine} />
          <div className={styles.rowGrip}><span/><span/><span/></div>
        </div>
      )}
    </div>
  );
}
