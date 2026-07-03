/**
 * DrawingsPrimitive
 *
 * Renders committed drawings (trendlines, hlines, rectangles) inside the chart's
 * own render loop via a lightweight-charts series primitive. Because the chart
 * calls draw() every frame it renders — including during price-scale (Y axis)
 * drags — the drawings stay perfectly locked to the candles with no lag/jitter
 * (unlike a separate canvas overlay, which has no price-scale change event).
 *
 * Reuses the existing renderDrawings() geometry so behaviour matches exactly.
 */

import type { IChartApi, ISeriesApi, ISeriesPrimitive, SeriesType, Time } from 'lightweight-charts';
import type { Drawing, DataTimeRange } from './drawings';
import { renderDrawings } from './drawings';

interface MediaScope {
  context: CanvasRenderingContext2D;
  mediaSize: { width: number; height: number };
}
interface RenderTarget {
  useMediaCoordinateSpace(cb: (scope: MediaScope) => void): void;
}

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private drawings: Drawing[] = [];
  private selectedId: string | null = null;
  // While a drawing is being dragged, the DrawingCanvas overlay paints its live
  // preview; we hide the committed copy here so it doesn't render twice.
  private hiddenId: string | null = null;
  private range: DataTimeRange | null = null;
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;

  private readonly _paneViews = [
    {
      zOrder: () => 'top' as const,
      renderer: () => ({
        draw: (target: RenderTarget) => {
          const chart = this.chart, series = this.series;
          if (!chart || !series) return;
          target.useMediaCoordinateSpace(({ context, mediaSize }) => {
            const visible = this.hiddenId
              ? this.drawings.filter((d) => d.id !== this.hiddenId)
              : this.drawings;
            renderDrawings(
              context,
              visible,
              chart,
              series as unknown as { priceToCoordinate: (p: number) => number | null },
              this.selectedId,
              mediaSize.width,
              mediaSize.height,
              this.range,
              mediaSize.width // pane width already excludes the price axis
            );
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

  setState(drawings: Drawing[], selectedId: string | null, range: DataTimeRange | null, hiddenId: string | null = null): void {
    this.drawings = drawings;
    this.selectedId = selectedId;
    this.range = range;
    this.hiddenId = hiddenId;
    this.requestUpdate?.();
  }

  updateAllViews(): void {}

  paneViews() {
    return this._paneViews;
  }
}
