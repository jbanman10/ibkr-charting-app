/**
 * SessionShadingPrimitive
 *
 * A lightweight-charts ISeriesPrimitive that paints a subtle flat tint behind
 * the bars belonging to pre-market and post-market sessions, so those sessions
 * stand out from the regular session. Drawn on the background layer (zOrder
 * 'bottom') so candles render on top.
 */

import type { IChartApi, ISeriesApi, ISeriesPrimitive, SeriesType, Time } from 'lightweight-charts';
import type { SessionRegion } from './sessions';
import { SESSION_COLORS } from './chartTheme';

// fancy-canvas scope (typed loosely to avoid an extra dependency import)
interface MediaScope {
  context: CanvasRenderingContext2D;
  mediaSize: { width: number; height: number };
}
interface RenderTarget {
  useMediaCoordinateSpace(cb: (scope: MediaScope) => void): void;
}

export class SessionShadingPrimitive implements ISeriesPrimitive<Time> {
  private regions: SessionRegion[] = [];
  private chart: IChartApi | null = null;
  private requestUpdate: (() => void) | null = null;

  private readonly _paneViews = [
    {
      zOrder: () => 'bottom' as const,
      renderer: () => ({
        draw: () => {},
        drawBackground: (target: RenderTarget) => {
          const chart = this.chart;
          if (!chart || this.regions.length === 0) return;
          const ts = chart.timeScale();
          target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            for (const r of this.regions) {
              const x1 = ts.timeToCoordinate(r.from as Time);
              const x2 = ts.timeToCoordinate(r.to as Time);
              if (x1 == null || x2 == null) continue;
              const left = Math.min(x1, x2);
              const width = Math.max(1, Math.abs(x2 - x1));
              ctx.fillStyle = r.kind === 'pre' ? SESSION_COLORS.shadePre : SESSION_COLORS.shadePost;
              ctx.fillRect(left, 0, width, mediaSize.height);
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

  setRegions(regions: SessionRegion[]): void {
    this.regions = regions;
    this.requestUpdate?.();
  }

  updateAllViews(): void {}

  paneViews() {
    return this._paneViews;
  }
}
