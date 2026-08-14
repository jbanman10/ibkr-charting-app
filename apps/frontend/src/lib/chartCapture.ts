/**
 * chartCapture — snapshot the chart grid as a single PNG.
 *
 * Charts are drawn on <canvas>, so the grid can be rebuilt by compositing those
 * canvases onto one output canvas rather than reaching for a screenshot API.
 * That keeps it working identically in the packaged app and in a browser, with
 * no Electron IPC bridge (the preload is deliberately a stub) and no permission
 * prompt — and it picks up drawings, indicators, bands and trade arrows for
 * free, since all of those are painted into the chart's own canvases.
 *
 * What it can't pick up is DOM chrome: the panel toolbars, symbol search and
 * price readouts are HTML, not canvas. Each panel therefore gets a drawn header
 * with its symbol and timeframe, so a capture is still self-describing.
 */

const HEADER_H = 22;
const GAP = 8;
const PAD = 10;

export interface CaptureOptions {
  /** Page background, so transparent canvas regions aren't black. */
  background?: string;
  text?: string;
  border?: string;
  /** Cap on output width; the grid is scaled down to fit. */
  maxWidth?: number;
}

export interface CapturePanel {
  el: HTMLElement;
  label: string;
}

/** The chart panels currently on screen, in grid order. */
export function findChartPanels(): CapturePanel[] {
  const panels = [...document.querySelectorAll<HTMLElement>('[id^="chart-panel-"]')];
  return panels
    .filter((el) => el.offsetWidth > 0 && el.offsetHeight > 0)
    .map((el) => {
      // The toolbar's symbol + timeframe, read off the DOM so the header matches
      // what the user was looking at.
      const symbol = el.querySelector('[class*="symbolButton"], [class*="symbolText"]')?.textContent?.trim()
        ?? el.innerText.split('\n')[0]?.trim()
        ?? '';
      const tf = el.querySelector('[class*="tfActive"], [class*="active"]')?.textContent?.trim() ?? '';
      return { el, label: [symbol, tf].filter(Boolean).join('  ·  ') };
    });
}

/**
 * Composite every canvas inside `panel` onto `ctx`, positioned relative to the
 * panel's own box. Canvases are HiDPI (backing store = css × dpr), so they are
 * drawn at their CSS size and the output canvas carries the scaling.
 */
function drawPanelCanvases(
  ctx: CanvasRenderingContext2D,
  panel: HTMLElement,
  dx: number,
  dy: number,
  scale: number
): number {
  const base = panel.getBoundingClientRect();
  const canvases = [...panel.querySelectorAll('canvas')];
  let drawn = 0;
  for (const c of canvases) {
    if (!c.width || !c.height) continue;
    const r = c.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    try {
      ctx.drawImage(
        c,
        dx + (r.left - base.left) * scale,
        dy + (r.top - base.top) * scale,
        r.width * scale,
        r.height * scale
      );
      drawn++;
    } catch {
      // A tainted canvas can't be read; skip it rather than losing the capture.
    }
  }
  return drawn;
}

export interface CaptureResult {
  dataUrl: string;
  width: number;
  height: number;
  panels: number;
  /** Canvases successfully composited — 0 means nothing was painted. */
  layers: number;
}

/**
 * Render the current chart grid to a PNG data URL.
 * Returns null when there are no visible panels.
 */
export function captureChartGrid(opts: CaptureOptions = {}): CaptureResult | null {
  const panels = findChartPanels();
  if (!panels.length) return null;

  const css = getComputedStyle(document.documentElement);
  const cssVar = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const background = opts.background ?? cssVar('--bg-base', '#131722');
  const text = opts.text ?? cssVar('--text-primary', '#d1d4dc');
  const border = opts.border ?? cssVar('--border-subtle', '#2a2e39');

  // Lay the panels out on the same geometry they occupy on screen, so a 2×2
  // grid captures as a 2×2 grid.
  const boxes = panels.map((p) => p.el.getBoundingClientRect());
  const minX = Math.min(...boxes.map((b) => b.left));
  const minY = Math.min(...boxes.map((b) => b.top));
  const maxX = Math.max(...boxes.map((b) => b.right));
  const maxY = Math.max(...boxes.map((b) => b.bottom));
  const gridW = Math.max(1, maxX - minX);
  const gridH = Math.max(1, maxY - minY);

  const maxWidth = opts.maxWidth ?? 2400;
  const scale = Math.min(2, maxWidth / gridW); // 2× for crisp text, capped by maxWidth

  const outW = Math.round(gridW * scale + PAD * 2);
  const outH = Math.round(gridH * scale + PAD * 2 + HEADER_H * scale);

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, outW, outH);

  // Timestamp strip across the top.
  ctx.fillStyle = text;
  ctx.font = `${Math.round(12 * scale)}px 'JetBrains Mono', monospace`;
  ctx.textBaseline = 'middle';
  ctx.fillText(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }) + ' ET',
    PAD,
    PAD + (HEADER_H * scale) / 2
  );

  const top = PAD + HEADER_H * scale;
  let layers = 0;

  for (let i = 0; i < panels.length; i++) {
    const b = boxes[i];
    const dx = PAD + (b.left - minX) * scale;
    const dy = top + (b.top - minY) * scale;

    layers += drawPanelCanvases(ctx, panels[i].el, dx, dy, scale);

    // Panel label + frame, since the real toolbar is DOM and can't be composited.
    if (panels[i].label) {
      ctx.fillStyle = text;
      ctx.font = `${Math.round(11 * scale)}px 'JetBrains Mono', monospace`;
      ctx.fillText(panels[i].label, dx + 6 * scale, dy + 9 * scale);
    }
    ctx.strokeStyle = border;
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeRect(dx, dy, b.width * scale, b.height * scale);
  }

  return { dataUrl: out.toDataURL('image/png'), width: outW, height: outH, panels: panels.length, layers };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/** ET calendar day — captures file under the trading day, like everything else. */
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
export const todayEt = (): string => ET_DAY.format(new Date());

export async function saveCapture(date: string, dataUrl: string): Promise<void> {
  const res = await fetch(`/api/journal/day/${date}/image`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: dataUrl }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `save failed (${res.status})`);
  }
}
