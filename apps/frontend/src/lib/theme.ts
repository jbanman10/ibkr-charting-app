/**
 * theme.ts — colour themes for the whole app.
 *
 * A theme is the SAME nine fields chartthemes.com publishes, in the same order,
 * so a theme from that site can be transcribed (or pasted) one-for-one:
 *
 *   Candle colors   bearish body / wick / border, bullish body / wick / border
 *   General colors  background, foreground, text
 *
 * Nine values obviously can't name every surface in the UI, so the rest of the
 * palette is DERIVED: panels, elevated surfaces, borders and secondary text are
 * mixes of `background` toward `foreground`, and the ramp automatically inverts
 * for light backgrounds. That keeps a pasted theme coherent across the toolbar,
 * drawers and modals instead of only recolouring the candles.
 *
 * Everything here is pure — `themeStore` owns applying and persisting it.
 */

import type { DeepPartial, ChartOptions, CandlestickSeriesOptions } from 'lightweight-charts';
import { ColorType } from 'lightweight-charts';

export interface ChartTheme {
  id: string;
  name: string;
  // ─ Candle colors (chartthemes.com order) ─
  bearBody: string;
  bearWick: string;
  bearBorder: string;
  bullBody: string;
  bullWick: string;
  bullBorder: string;
  // ─ General colors ─
  background: string;
  foreground: string;
  text: string;
  /** UI highlight (active buttons, focus rings). Not part of the site's nine —
   *  defaults to the app blue and is only changed if the user wants to. */
  accent?: string;
}

export const DEFAULT_ACCENT = '#2962ff';

// ─── Colour maths ─────────────────────────────────────────────────────────────

interface Rgb { r: number; g: number; b: number }

/** Parse "#rgb", "#rrggbb", or "rgb(r,g,b)". Returns null when unparseable. */
export function parseColor(input: string): Rgb | null {
  const s = (input ?? '').trim();
  let m = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const [a, b, c] = m[1];
    return { r: parseInt(a + a, 16), g: parseInt(b + b, 16), b: parseInt(c + c, 16) };
  }
  m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  return null;
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function toHex(c: Rgb): string {
  return `#${[c.r, c.g, c.b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Blend `from` toward `to` by `amount` (0–1). */
export function mix(from: string, to: string, amount: number): string {
  const a = parseColor(from);
  const b = parseColor(to);
  if (!a || !b) return from;
  const t = Math.max(0, Math.min(1, amount));
  return toHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

export function rgba(color: string, alpha: number): string {
  const c = parseColor(color);
  if (!c) return color;
  return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

/** Relative luminance (0 = black, 1 = white), for light/dark decisions. */
export function luminance(color: string): number {
  const c = parseColor(color);
  if (!c) return 0;
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

export const isLightTheme = (t: ChartTheme): boolean => luminance(t.background) > 0.5;

// ─── Derived palette ──────────────────────────────────────────────────────────

/**
 * Expand the nine fields into every CSS custom property the UI uses.
 *
 * Surfaces step from `background` toward `foreground`, so a dark theme's panels
 * get lighter and a light theme's get darker without any special-casing — the
 * direction falls out of where `foreground` sits relative to `background`.
 */
export function deriveCssVars(t: ChartTheme): Record<string, string> {
  const bg = t.background;
  const fg = t.foreground;
  const tx = t.text;
  const accent = t.accent || DEFAULT_ACCENT;

  return {
    '--bg-base': bg,
    '--bg-panel': mix(bg, fg, 0.05),
    '--bg-elevated': mix(bg, fg, 0.11),
    '--bg-overlay': mix(bg, fg, 0.17),
    '--bg-input': mix(bg, fg, 0.03),

    '--border-subtle': mix(bg, fg, 0.14),
    '--border-muted': mix(bg, fg, 0.22),
    '--border-strong': mix(bg, fg, 0.32),

    '--text-primary': tx,
    '--text-secondary': mix(tx, bg, 0.42),
    '--text-tertiary': mix(tx, bg, 0.62),
    '--text-accent': mix(accent, tx, 0.25),

    '--candle-up': t.bullBody,
    '--candle-down': t.bearBody,
    '--candle-up-dim': rgba(t.bullBody, 0.15),
    '--candle-down-dim': rgba(t.bearBody, 0.15),

    '--accent': accent,
    '--accent-glow': rgba(accent, 0.2),
    '--accent-hover': mix(accent, '#ffffff', 0.18),
  };
}

// ─── lightweight-charts options ───────────────────────────────────────────────

export function toChartOptions(t: ChartTheme): DeepPartial<ChartOptions> {
  const grid = rgba(t.foreground, 0.07);
  const axis = rgba(t.foreground, 0.15);
  const label = mix(t.text, t.background, 0.35);
  return {
    layout: {
      background: { type: ColorType.Solid, color: t.background },
      textColor: label,
    },
    grid: {
      vertLines: { color: grid, style: 1 },
      horzLines: { color: grid, style: 1 },
    },
    crosshair: {
      vertLine: { color: rgba(t.foreground, 0.35), labelBackgroundColor: mix(t.background, t.foreground, 0.25) },
      horzLine: { color: rgba(t.foreground, 0.35), labelBackgroundColor: mix(t.background, t.foreground, 0.25) },
    },
    rightPriceScale: { borderColor: axis, textColor: label },
    timeScale: { borderColor: axis, textColor: label },
  };
}

export function toCandleOptions(t: ChartTheme): DeepPartial<CandlestickSeriesOptions> {
  return {
    upColor: t.bullBody,
    downColor: t.bearBody,
    borderUpColor: t.bullBorder,
    borderDownColor: t.bearBorder,
    wickUpColor: t.bullWick,
    wickDownColor: t.bearWick,
    priceLineColor: rgba(t.foreground, 0.35),
  };
}

export function toVolumeColors(t: ChartTheme): { upColor: string; downColor: string } {
  return { upColor: rgba(t.bullBody, 0.25), downColor: rgba(t.bearBody, 0.25) };
}

// ─── Pasting a theme ──────────────────────────────────────────────────────────

export const THEME_FIELDS: Array<{ key: keyof ChartTheme; label: string; group: 'candle' | 'general' }> = [
  { key: 'bearBody',   label: 'Bearish body',    group: 'candle' },
  { key: 'bearWick',   label: 'Bearish wick',    group: 'candle' },
  { key: 'bearBorder', label: 'Bearish border',  group: 'candle' },
  { key: 'bullBody',   label: 'Bullish body',    group: 'candle' },
  { key: 'bullWick',   label: 'Bullish wick',    group: 'candle' },
  { key: 'bullBorder', label: 'Bullish border',  group: 'candle' },
  { key: 'background', label: 'Background color', group: 'general' },
  { key: 'foreground', label: 'Foreground',      group: 'general' },
  { key: 'text',       label: 'Text color',      group: 'general' },
];

/**
 * Pull a theme out of pasted text.
 *
 * Deliberately tolerant: it takes the colours in the order they appear and maps
 * them onto THEME_FIELDS, which is chartthemes.com's own field order — so
 * copying that page's nine values in any shape (one per line, comma separated,
 * with or without labels) lands correctly. Returns null unless it finds at
 * least nine colours.
 */
export function parseThemeColors(text: string): Pick<
  ChartTheme,
  'bearBody' | 'bearWick' | 'bearBorder' | 'bullBody' | 'bullWick' | 'bullBorder' | 'background' | 'foreground' | 'text'
> | null {
  const found = (text ?? '').match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi) ?? [];
  const colors = found.map((c) => parseColor(c)).filter((c): c is Rgb => !!c).map(toHex);
  if (colors.length < 9) return null;
  const [bearBody, bearWick, bearBorder, bullBody, bullWick, bullBorder, background, foreground, text_] = colors;
  return { bearBody, bearWick, bearBorder, bullBody, bullWick, bullBorder, background, foreground, text: text_ };
}

// ─── Built-in presets ─────────────────────────────────────────────────────────
//
// Deliberately few: the point is that you bring a theme from chartthemes.com.
// These exist so there's always a known-good look to fall back to.

export const PRESETS: ChartTheme[] = [
  {
    id: 'mallard-dark',
    name: 'Mallard Dark',
    bearBody: '#f23645', bearWick: '#f23645', bearBorder: '#f23645',
    bullBody: '#089981', bullWick: '#089981', bullBorder: '#089981',
    background: '#131722', foreground: '#d1d4dc', text: '#d1d4dc',
    accent: DEFAULT_ACCENT,
  },
  {
    id: 'mallard-light',
    name: 'Mallard Light',
    bearBody: '#e0483c', bearWick: '#e0483c', bearBorder: '#e0483c',
    bullBody: '#1a9e6f', bullWick: '#1a9e6f', bullBorder: '#1a9e6f',
    background: '#ffffff', foreground: '#131722', text: '#131722',
    accent: '#1c62e8',
  },
  {
    id: 'graphite',
    name: 'Graphite',
    bearBody: '#8a8f98', bearWick: '#8a8f98', bearBorder: '#6f747d',
    bullBody: '#e8eaed', bullWick: '#e8eaed', bullBorder: '#ffffff',
    background: '#0e0e10', foreground: '#e0e0e0', text: '#e0e0e0',
    accent: '#7aa2f7',
  },
];

export const DEFAULT_THEME = PRESETS[0];
