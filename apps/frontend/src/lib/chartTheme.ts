import type { DeepPartial, ChartOptions, CandlestickSeriesOptions, LineSeriesOptions } from 'lightweight-charts';
import { ColorType } from 'lightweight-charts';

export const chartTheme: DeepPartial<ChartOptions> = {
  layout: {
    background: { type: ColorType.Solid, color: '#0b0e11' },
    textColor: '#8a95a8',
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    fontSize: 11,
  },
  grid: {
    vertLines: { color: 'rgba(255,255,255,0.04)', style: 1 },
    horzLines: { color: 'rgba(255,255,255,0.04)', style: 1 },
  },
  crosshair: {
    mode: 1, // CrosshairMode.Magnet
    vertLine: {
      color: 'rgba(255,255,255,0.3)',
      width: 1,
      style: 0,
      labelBackgroundColor: '#202840',
    },
    horzLine: {
      color: 'rgba(255,255,255,0.3)',
      width: 1,
      style: 0,
      labelBackgroundColor: '#202840',
    },
  },
  rightPriceScale: {
    borderColor: 'rgba(255,255,255,0.08)',
    textColor: '#8a95a8',
    scaleMargins: { top: 0.1, bottom: 0.2 },
  },
  timeScale: {
    borderColor: 'rgba(255,255,255,0.08)',
    textColor: '#8a95a8',
    timeVisible: true,
    secondsVisible: false,
    fixLeftEdge: false,
    fixRightEdge: false,
  },
  handleScroll: {
    mouseWheel: true,
    pressedMouseMove: true,
    horzTouchDrag: true,
    vertTouchDrag: true,
  },
  handleScale: {
    axisPressedMouseMove: true,
    mouseWheel: true,
    pinch: true,
  },
};

export const candlestickTheme: DeepPartial<CandlestickSeriesOptions> = {
  upColor:          '#089981',
  downColor:        '#f23645',
  borderUpColor:    '#089981',
  borderDownColor:  '#f23645',
  wickUpColor:      '#089981',
  wickDownColor:    '#f23645',
  borderVisible:    true,
  wickVisible:      true,
  priceLineVisible: true,
  priceLineColor:   'rgba(255,255,255,0.3)',
  priceLineWidth:   1,
  priceLineStyle:   2, // Dashed
};

export const volumeTheme = {
  upColor:   'rgba(8,153,129,0.25)',
  downColor: 'rgba(242,54,69,0.25)',
};

export const indicatorColors: Record<string, string> = {
  'SMA-20': '#f0b429',
  'SMA-50': '#a78bfa',
  'SMA-200':'#fb923c',
  'EMA-20': '#34d399',
  'EMA-50': '#60a5fa',
  'EMA-200':'#f472b6',
};

export function getIndicatorLineOptions(key: string): DeepPartial<LineSeriesOptions> {
  return {
    color: indicatorColors[key] ?? '#8a95a8',
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  };
}

// ─── Session level / shading colors ────────────────────────────────────────────
export const SESSION_COLORS = {
  prevDayHigh:  '#089981', // prev day high — solid green
  prevDayLow:   '#f23645', // prev day low — solid red
  premarket:    '#22d3ee', // pre-market high/low — cyan
  openingRange: '#c084fc', // first-5min high/low — purple
  shadePre:     'rgba(56,189,248,0.06)',  // pre-market background tint (cool)
  shadePost:    'rgba(168,85,247,0.06)',  // post-market background tint (violet)
} as const;

// ─── Rectangle color palette (border + low-alpha fill) ──────────────────────────
export interface RectColor { name: string; border: string; fill: string; }

export const RECT_PALETTE: RectColor[] = [
  { name: 'Blue',   border: '#3d7eff', fill: 'rgba(61,126,255,0.15)' },
  { name: 'Green',  border: '#089981', fill: 'rgba(8,153,129,0.15)' },
  { name: 'Red',    border: '#f23645', fill: 'rgba(242,54,69,0.15)' },
  { name: 'Amber',  border: '#f0b429', fill: 'rgba(240,180,41,0.15)' },
  { name: 'Purple', border: '#c084fc', fill: 'rgba(192,132,252,0.15)' },
  { name: 'Cyan',   border: '#22d3ee', fill: 'rgba(34,211,238,0.15)' },
  { name: 'Gray',   border: '#8a95a8', fill: 'rgba(138,149,168,0.15)' },
];

// ─── Drawing tool colors ──────────────────────────────────────────────────────
export const DRAWING_COLORS = {
  trendline:   '#3d7eff',
  hline:       '#f0b429',
  rectangle:   'rgba(61,126,255,0.15)',
  rectBorder:  '#3d7eff',
  handle:      '#ffffff',
  handleBg:    '#3d7eff',
} as const;
