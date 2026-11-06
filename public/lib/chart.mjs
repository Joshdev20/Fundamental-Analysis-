// Canvas chart for the analysis lab. Candles or a line, with the structure the
// models reason about drawn on top: key levels, OCLs, MSNR zones, imbalances,
// rejection wicks, BOS/CHoCH markers and head-and-shoulders patterns.
//
// Dependency-free on purpose — the app is static and hosted on Vercel, so a
// charting library would be the largest thing we ship.

const UP = '#3ddc97', DOWN = '#ff6b6b';

export function drawChart(canvas, series, opts = {}) {
  const {
    mode = 'candles',          // 'candles' | 'line'
    bars = 160,                // how many bars to show, ending at `end`
    end = series.length - 1,
    levels = [],
    ocls = [],
    zones = [],
    fvgs = [],
    marks = [],                // { i, kind, dir, label }
    levels_tf = '',
    theme = {},
  } = opts;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  const cssH = canvas.clientHeight || 360;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const ink = theme.ink || '#e8ecf3';
  const dim = theme.dim || '#7b8798';
  const line = theme.line || '#232c3a';
  const panel = theme.panel || '#0f141d';

  const padL = 8, padR = 62, padT = 12, padB = 20;
  const from = Math.max(0, end - bars + 1);
  const view = series.slice(from, end + 1);
  if (!view.length) return;

  let lo = Infinity, hi = -Infinity;
  for (const b of view) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
  for (const lv of levels) { if (lv.price > lo && lv.price < hi * 1.5) { lo = Math.min(lo, lv.price); hi = Math.max(hi, lv.price); } }
  for (const z of zones) { lo = Math.min(lo, z.lo); hi = Math.max(hi, z.hi); }
  const pad = (hi - lo) * 0.06 || hi * 0.001;
  lo -= pad; hi += pad;

  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const x = (i) => padL + ((i - from) / Math.max(1, view.length - 1)) * plotW;
  const y = (p) => padT + (1 - (p - lo) / (hi - lo)) * plotH;

  // Grid + price axis
  g.strokeStyle = line; g.lineWidth = 1;
  g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  g.fillStyle = dim; g.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const p = lo + ((hi - lo) * k) / 4;
    const yy = Math.round(y(p)) + 0.5;
    g.beginPath(); g.moveTo(padL, yy); g.lineTo(cssW - padR, yy); g.stroke();
    g.fillText(fmt(p), cssW - padR + 6, yy);
  }

  // Zones behind everything
  for (const z of zones) {
    g.fillStyle = z.kind === 'supply' ? 'rgba(255,107,107,.10)' : 'rgba(61,220,151,.10)';
    const y0 = y(Math.min(hi, z.hi)), y1 = y(Math.max(lo, z.lo));
    g.fillRect(padL, y0, plotW, Math.max(1, y1 - y0));
  }
  // Imbalances
  for (const f of fvgs) {
    g.fillStyle = f.dir > 0 ? 'rgba(61,220,151,.07)' : 'rgba(255,107,107,.07)';
    const i0 = f.i - from;
    if (i0 < 0) continue;
    const w = Math.max(2, plotW / view.length);
    g.fillRect(x(f.i) - w / 2, y(Math.max(f.hi, f.lo)), w, Math.abs(y(f.lo) - y(f.hi)));
  }

  // Key levels
  for (const lv of levels) {
    if (lv.price < lo || lv.price > hi) continue;
    const yy = Math.round(y(lv.price)) + 0.5;
    g.strokeStyle = lv.kind === 'resistance' ? 'rgba(255,107,107,.75)' : 'rgba(61,220,151,.75)';
    g.setLineDash(lv.shape === 'A' ? [] : [4, 3]);
    g.beginPath(); g.moveTo(padL, yy); g.lineTo(cssW - padR, yy); g.stroke();
    g.setLineDash([]);
    g.fillStyle = g.strokeStyle;
    g.fillText(`${lv.shape}`, padL + 2, yy - 7);
  }
  // OCLs
  for (const oc of ocls) {
    if (oc.price < lo || oc.price > hi) continue;
    const yy = Math.round(y(oc.price)) + 0.5;
    g.strokeStyle = oc.disrespected ? 'rgba(255,200,87,.8)' : 'rgba(127,178,255,.8)';
    g.setLineDash([2, 4]);
    g.beginPath(); g.moveTo(padL, yy); g.lineTo(cssW - padR, yy); g.stroke();
    g.setLineDash([]);
  }

  // Price
  if (mode === 'line') {
    g.strokeStyle = ink; g.lineWidth = 1.4; g.beginPath();
    view.forEach((b, k) => { const xx = x(from + k), yy = y(b.c); k ? g.lineTo(xx, yy) : g.moveTo(xx, yy); });
    g.stroke();
    g.lineTo(x(cssW), y(view.at(-1).c)); g.lineTo(x(cssW), padT + plotH); g.lineTo(padL, padT + plotH); g.closePath();
    g.fillStyle = 'rgba(232,236,243,.05)'; g.fill();
  } else {
    const w = Math.max(1.5, (plotW / view.length) * 0.62);
    view.forEach((b, k) => {
      const xx = x(from + k);
      const up = b.c >= b.o;
      g.strokeStyle = up ? UP : DOWN; g.fillStyle = up ? UP : DOWN;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(xx, y(b.h)); g.lineTo(xx, y(b.l)); g.stroke();
      const yo = y(b.o), yc = y(b.c);
      g.fillRect(xx - w / 2, Math.min(yo, yc), w, Math.max(1, Math.abs(yc - yo)));
    });
  }

  // Rejection / BOS / CHoCH marks
  for (const m of marks) {
    const k = m.i - from;
    if (k < 0 || k >= view.length) continue;
    const xx = x(m.i);
    const b = series[m.i];
    if (m.kind === 'reject') {
      const yy = m.dir > 0 ? y(b.l) + 10 : y(b.h) - 10;
      g.fillStyle = m.dir > 0 ? UP : DOWN;
      g.beginPath();
      g.moveTo(xx, yy); g.lineTo(xx - 4, yy + (m.dir > 0 ? -8 : 8)); g.lineTo(xx + 4, yy + (m.dir > 0 ? -8 : 8));
      g.closePath(); g.fill();
    } else {
      const yy = m.dir > 0 ? y(b.l) + 16 : y(b.h) - 16;
      g.fillStyle = m.kind === 'hs' ? '#c39bff' : '#7fb2ff';
      g.font = '9px ui-monospace, monospace';
      g.fillText(m.label || (m.kind === 'hs' ? 'H&S' : m.dir > 0 ? 'BOS▲' : 'BOS▼'), xx - 10, yy);
    }
  }

  // Last price tag
  const last = view.at(-1);
  const yl = y(last.c);
  g.fillStyle = last.c >= last.o ? UP : DOWN;
  g.fillRect(cssW - padR + 1, yl - 7, padR - 2, 14);
  g.fillStyle = panel;
  g.font = 'bold 10px ui-monospace, monospace';
  g.fillText(fmt(last.c), cssW - padR + 5, yl);
}

function fmt(v) {
  if (v == null) return '—';
  if (Math.abs(v) >= 1000) return v.toFixed(1);
  if (Math.abs(v) >= 100) return v.toFixed(2);
  if (Math.abs(v) >= 1) return v.toFixed(4);
  return v.toFixed(5);
}
