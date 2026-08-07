/**
 * BollingerFillPrimitive
 *
 * Paints the translucent region between a Bollinger upper and lower band —
 * the shaded channel TradingView draws behind its bands. lightweight-charts v4
 * has no band series, so this is an ISeriesPrimitive on the candle series,
 * drawn on the background layer (zOrder 'bottom') so candles stay on top.
 *
 * Frame-synced with the chart's own render loop, so the fill tracks pan, zoom
 * and price-scale drags exactly like the band lines it sits between.
 */

import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  LineData,
  SeriesType,
  Time,
} from 'lightweight-charts';

interface MediaScope {
  context: CanvasRenderingContext2D;
  mediaSize: { width: number; height: number };
}
interface RenderTarget {
  useMediaCoordinateSpace(cb: (scope: MediaScope) => void): void;
}

export interface BollingerBandFill {
  /** Config key the pair belongs to (e.g. "BB-20"). */
  group: string;
  upper: LineData[]; // ascending by time
  lower: LineData[];
  color: string;     // rgba fill
}

export class BollingerFillPrimitive implements ISeriesPrimitive<Time> {
  private bands: BollingerBandFill[] = [];
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;

  private readonly _paneViews = [
    {
      zOrder: () => 'bottom' as const,
      renderer: () => ({
        draw: () => {},
        drawBackground: (target: RenderTarget) => {
          const chart = this.chart;
          const series = this.series;
          if (!chart || !series || !this.bands.length) return;
          const ts = chart.timeScale();

          target.useMediaCoordinateSpace(({ context: ctx }) => {
            for (const band of this.bands) {
              // Walk the upper edge left→right, then the lower edge back
              // right→left, closing one polygon per contiguous run. Any point
              // that falls off-screen breaks the run so the fill can't bridge
              // a gap the lines themselves don't draw across.
              const n = Math.min(band.upper.length, band.lower.length);
              if (n < 2) continue;

              let run: Array<{ x: number; yUp: number; yLo: number }> = [];
              const flush = () => {
                if (run.length >= 2) {
                  ctx.beginPath();
                  ctx.moveTo(run[0].x, run[0].yUp);
                  for (let i = 1; i < run.length; i++) ctx.lineTo(run[i].x, run[i].yUp);
                  for (let i = run.length - 1; i >= 0; i--) ctx.lineTo(run[i].x, run[i].yLo);
                  ctx.closePath();
                  ctx.fillStyle = band.color;
                  ctx.fill();
                }
                run = [];
              };

              for (let i = 0; i < n; i++) {
                const up = band.upper[i];
                const lo = band.lower[i];
                const x = ts.timeToCoordinate(up.time);
                const yUp = series.priceToCoordinate(up.value);
                const yLo = series.priceToCoordinate(lo.value);
                if (x == null || yUp == null || yLo == null) { flush(); continue; }
                run.push({ x, yUp, yLo });
              }
              flush();
            }
          });
        },
      }),
    },
  ];

  attached(param: { chart: IChartApi; series: ISeriesApi<SeriesType>; requestUpdate: () => void }): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setBands(bands: BollingerBandFill[]): void {
    this.bands = bands;
    this.requestUpdate?.();
  }

  updateAllViews(): void {}

  paneViews() {
    return this._paneViews;
  }
}
