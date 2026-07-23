/**
 * EarningsPrimitive
 *
 * Draws TradingView-style earnings badges pinned to the BOTTOM of the chart
 * pane (native series markers can only sit above/below/in a bar, which makes
 * them bob around with price). Past reports are placed by bar time; the
 * upcoming report is placed past the last bar via logical coordinates, so it
 * lands in the future whitespace and tracks zoom/pan correctly.
 *
 * Green = beat, red = miss, purple = upcoming (dashed border when the date is
 * only an estimate).
 */

import type { IChartApi, ISeriesApi, ISeriesPrimitive, SeriesType, Time } from 'lightweight-charts';

/** Everything the click-popover shows for a badge. */
export interface EarningsMarkDetail {
  dateLabel: string;
  fiscalQtr?: string;
  eps?: number | null;
  consensus?: number | null;
  surprisePct?: number | null;
  timing?: string | null;
  estimated?: boolean;
}

export interface EarningsMark {
  /** Past report: the bar time it sits on. */
  time?: Time;
  /** Upcoming report: bars beyond the last bar (logical offset). */
  barsAhead?: number;
  kind: 'beat' | 'miss' | 'upcoming';
  estimated?: boolean;
  detail?: EarningsMarkDetail;
}

interface MediaScope {
  context: CanvasRenderingContext2D;
  mediaSize: { width: number; height: number };
}
interface RenderTarget {
  useMediaCoordinateSpace(cb: (scope: MediaScope) => void): void;
}

const COLORS: Record<EarningsMark['kind'], string> = {
  beat: '#0bd9a2',
  miss: '#f97066',
  upcoming: '#c084fc',
};

const BADGE_W = 17;
const BADGE_H = 15;
const BOTTOM_GAP = 4; // px above the pane's bottom edge

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class EarningsPrimitive implements ISeriesPrimitive<Time> {
  private marks: EarningsMark[] = [];
  private lastLogical: number | null = null;
  private chart: IChartApi | null = null;
  private requestUpdate: (() => void) | null = null;
  // Where each badge was last painted (pane pixels), for click hit-testing.
  private drawn: Array<{ x: number; y: number; mark: EarningsMark }> = [];

  private readonly _paneViews = [
    {
      zOrder: () => 'top' as const,
      renderer: () => ({
        draw: (target: RenderTarget) => {
          const chart = this.chart;
          if (!chart || !this.marks.length) return;
          const ts = chart.timeScale();
          target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            const y = mediaSize.height - BADGE_H - BOTTOM_GAP;
            this.drawn = [];
            for (const m of this.marks) {
              let x: number | null = null;
              if (m.time != null) {
                x = ts.timeToCoordinate(m.time);
              } else if (m.barsAhead != null && this.lastLogical != null) {
                x = ts.logicalToCoordinate((this.lastLogical + m.barsAhead) as never);
              }
              if (x == null) continue;
              // Skip badges scrolled off the plot area.
              if (x < -BADGE_W || x > mediaSize.width + BADGE_W) continue;

              const color = COLORS[m.kind];
              const left = x - BADGE_W / 2;
              this.drawn.push({ x, y, mark: m });
              ctx.save();
              roundRect(ctx, left, y, BADGE_W, BADGE_H, 3);
              ctx.fillStyle = 'rgba(19,23,34,0.85)';
              ctx.fill();
              ctx.strokeStyle = color;
              ctx.lineWidth = 1.2;
              if (m.estimated) ctx.setLineDash([3, 2]);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.fillStyle = color;
              ctx.font = '600 10px JetBrains Mono, monospace';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText('E', x, y + BADGE_H / 2 + 0.5);
              ctx.restore();
            }
          });
        },
      }),
    },
  ];

  attached(param: { chart: IChartApi; series: ISeriesApi<SeriesType>; requestUpdate: () => void }): void {
    this.chart = param.chart;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.requestUpdate = null;
  }

  /** `lastLogical` is the logical index of the newest bar (data.length - 1). */
  setMarks(marks: EarningsMark[], lastLogical: number | null): void {
    this.marks = marks;
    this.lastLogical = lastLogical;
    this.drawn = [];
    this.requestUpdate?.();
  }

  /**
   * The badge under a pane-relative point, if any. The hit box is padded a
   * little so the small badges are comfortable to click.
   */
  hitTest(point: { x: number; y: number }): EarningsMark | null {
    const PAD = 4;
    for (const d of this.drawn) {
      const left = d.x - BADGE_W / 2 - PAD;
      const right = d.x + BADGE_W / 2 + PAD;
      if (point.x >= left && point.x <= right && point.y >= d.y - PAD && point.y <= d.y + BADGE_H + PAD) {
        return d.mark;
      }
    }
    return null;
  }

  updateAllViews(): void {}

  paneViews() {
    return this._paneViews;
  }
}
