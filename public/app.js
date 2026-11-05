import { buildSignals } from './lib/engine.mjs';

const state = {
  model: null,
  events: [],
  cached: [],
  lastLive: null,
  horizonDays: 5,
  windowDays: 3,
  minScore: 2,
  onlyHigh: true,
  provenOnly: false,
};

const $ = (sel) => document.querySelector(sel);
const fmtTime = (ts) =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

// Compact, readable number formatting for economic values.
function fmtVal(v, unit) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  let s;
  if (abs >= 1e9) s = `${(v / 1e9).toFixed(2)}B`;
  else if (abs >= 1e6) s = `${(v / 1e6).toFixed(2)}M`;
  else if (abs >= 1e4) s = `${(v / 1e3).toFixed(1)}K`;
  else s = `${Math.round(v * 100) / 100}`;
  return unit === '%' ? `${s}%` : s;
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// TradingView's calendar sends CORS headers, so try it directly first and fall
// back to the proxy if the browser blocks it.
async function fetchLiveCalendar() {
  const to = new Date(Date.now() + 7 * 86400000).toISOString();
  const from = new Date(Date.now() - 30 * 86400000).toISOString();
  const direct =
    `https://economic-calendar.tradingview.com/events?from=${from}&to=${to}` +
    `&countries=US,EU,GB,JP,CA,AU,NZ,CH`;
  const attempts = [direct, `/api/proxy?url=${encodeURIComponent(direct)}`];
  for (const url of attempts) {
    try {
      const data = await getJson(url);
      if (data && data.status === 'ok' && Array.isArray(data.result)) {
        return data.result.map(normalize).filter(Boolean);
      }
    } catch (err) {
      /* try next */
    }
  }
  return null;
}

function normalize(e) {
  if (!e || !e.title || !e.date) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id: String(e.id ?? ''),
    title: e.title,
    indicator: e.indicator || '',
    country: e.country || '',
    currency: e.currency || '',
    importance: typeof e.importance === 'number' ? e.importance : 0,
    category: e.category || '',
    period: e.period || '',
    unit: e.unit || '',
    date: e.date,
    ts: Date.parse(e.date),
    actual: num(e.actualRaw ?? e.actual),
    forecast: num(e.forecastRaw ?? e.forecast),
    previous: num(e.previousRaw ?? e.previous),
  };
}

function mergeEvents(live, cached) {
  const byId = new Map();
  for (const e of cached) byId.set(e.id, e);
  for (const e of live) byId.set(e.id, e); // live wins
  return [...byId.values()].sort((a, b) => a.ts - b.ts);
}

function render() {
  renderKpis();
  renderSignals();
  renderCalendar();
  renderBacktest();
}

function renderKpis() {
  const signals = buildSignals(state.events, state.model, {
    asOf: Date.now(),
    windowDays: state.windowDays,
    horizonDays: state.horizonDays,
    minScoreBps: state.minScore,
  });
  const buys = signals.filter((s) => s.action === 'BUY').length;
  const sells = signals.filter((s) => s.action === 'SELL').length;
  const top = signals[0];
  const strongest = top ? `${top.label} ${top.action}` : '—';
  const range = state.model?.range;

  const kpis = [
    { label: 'Active signals', value: signals.length, hint: `last ${state.windowDays} days` },
    { label: 'Buy / Sell', value: `${buys} / ${sells}`, hint: 'pairs with a directional call' },
    { label: 'Strongest', value: strongest, hint: top ? `${top.confidence}% confidence` : 'none', cls: top ? top.action.toLowerCase() : '' },
    { label: 'Model data', value: range ? `${(range.events / 1000).toFixed(0)}k` : '—', hint: range ? `${fmtDate(range.from)} – ${fmtDate(range.to)}` : '' },
  ];
  $('#kpis').innerHTML = kpis
    .map(
      (k) => `<div class="kpi"><div class="label">${k.label}</div>
      <div class="value ${k.cls || ''}">${k.value}</div>
      <div class="hint">${k.hint}</div></div>`
    )
    .join('');
}

function renderSignals() {
  let signals = buildSignals(state.events, state.model, {
    asOf: Date.now(),
    windowDays: state.windowDays,
    horizonDays: state.horizonDays,
    minScoreBps: state.minScore,
  });
  const total = signals.length;
  if (state.provenOnly) signals = signals.filter((s) => s.hasEdge);

  const el = $('#signals');
  if (!signals.length) {
    el.innerHTML = `<div class="empty">No ${state.provenOnly ? 'proven ' : ''}signals in the last ${state.windowDays} days clear the ${state.minScore} bp threshold${state.provenOnly ? ' with a historical edge' : ''}. Lower the threshold, widen the window, or untick "Proven edge only".</div>`;
    return;
  }
  const note = state.provenOnly
    ? ''
    : `<p class="note" style="grid-column:1/-1;margin:0 0 4px">${total - signals.filter((s) => s.hasEdge).length} of ${total} calls lack a proven historical edge and are marked <b>unproven</b>. Tick "Proven edge only" to hide them.</p>`;
  el.innerHTML =
    note +
    signals
      .slice(0, 24)
      .map((s) => {
        const act = s.action.toLowerCase();
        const drivers = s.drivers
          .slice(0, 4)
          .map(
            (d) => `<div class="driver">
            <span class="t"><span class="tag">${d.tag}</span> ${d.title} <span class="muted">(${d.currency})</span></span>
            <span class="v">z ${d.z.toFixed(1)} · ${d.contribution > 0 ? '+' : ''}${d.contribution} bp</span>
          </div>`
          )
          .join('');
        const badge = s.hasEdge
          ? `<span class="edge proven">proven edge</span>`
          : `<span class="edge unproven">unproven</span>`;
        return `<div class="signal ${act} ${s.hasEdge ? '' : 'weak'}">
        <div class="row1">
          <span class="pair">${s.label}</span>
          <span class="action ${act}">${s.action}</span>
        </div>
        <div class="meta">
          <span>Confidence <b>${s.confidence}%</b></span>
          <span>Expected <b>${s.expectedMoveBps} bp</b></span>
          <span>Hold <b>${state.horizonDays}d</b></span>
          ${s.top?.hitRate != null ? `<span>Hist. win <b>${s.top.hitRate}%</b> <span class="muted">(n=${s.top.hitSample})</span></span>` : ''}
          ${badge}
        </div>
        <div class="conf-bar"><div class="conf-fill" style="width:${s.confidence}%"></div></div>
        <div class="drivers">${drivers}</div>
      </div>`;
      })
      .join('');
}

function renderCalendar() {
  const now = Date.now();
  const rows = state.events
    .filter((e) => e.ts >= now - state.windowDays * 86400000 && e.ts <= now + 4 * 86400000)
    .filter((e) => (state.onlyHigh ? e.importance === 1 : e.importance >= 0))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 60);

  const tbody = $('#calendar tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">No events found.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((e) => {
      const surprise = e.actual != null && e.forecast != null ? e.actual - e.forecast : null;
      const cls = surprise == null ? 'none' : surprise > 0 ? 'pos' : surprise < 0 ? 'neg' : 'none';
      const imp = e.importance === 1 ? '<span class="pill high">HIGH</span>' : e.importance === 0 ? '<span class="pill med">MED</span>' : '';
      return `<tr>
        <td class="muted">${fmtTime(e.ts)}</td>
        <td class="cur">${e.currency || e.country}</td>
        <td>${imp} ${e.title}</td>
        <td>${fmtVal(e.actual, e.unit)}</td>
        <td class="muted">${fmtVal(e.forecast, e.unit)}</td>
        <td class="muted">${fmtVal(e.previous, e.unit)}</td>
        <td class="surp ${cls}">${surprise == null ? '—' : (surprise > 0 ? '+' : '') + fmtVal(surprise, e.unit)}</td>
      </tr>`;
    })
    .join('');
}

function renderBacktest() {
  const m = state.model;
  if (!m) return;
  $('#bt-range').textContent = `${fmtDate(m.range.from)} – ${fmtDate(m.range.to)} · ${m.range.events.toLocaleString()} releases`;

  const hold = state.horizonDays;
  const modelBlock = m.hitRates[`model|${hold}`];
  const fadeBlock = m.hitRates[`fade|${hold}`];
  const order = ['lt0.5', '0.5-1', '1-1.5', '1.5-2', '2-2.5', '2.5-3', 'gte3'];
  const label = { 'lt0.5': '|z| < 0.5', '0.5-1': '0.5–1', '1-1.5': '1–1.5', '1.5-2': '1.5–2', '2-2.5': '2–2.5', '2.5-3': '2.5–3', gte3: '≥ 3' };

  const cell = (v) => {
    if (!v || v.n < 30) return `<td class="muted">—</td>`;
    const cls = v.winRate > 50 ? 'good' : v.winRate < 50 ? 'bad' : '';
    return `<td class="${cls}">${v.winRate}% <span class="muted">n=${v.n}</span></td>`;
  };

  const rows = order
    .map((k) => {
      const a = modelBlock?.byZ?.[k];
      const b = fadeBlock?.byZ?.[k];
      return `<tr><td>${label[k] || k}</td>${cell(a)}<td class="muted">${a ? a.avgBps + ' bp' : '—'}</td>${cell(b)}<td class="muted">${b ? b.avgBps + ' bp' : '—'}</td></tr>`;
    })
    .join('');

  const globalRow = (name, block) => {
    if (!block) return '';
    const g = block.global;
    return `<tr><td><b>${name} — all signals</b></td><td class="${g.winRate > 50 ? 'good' : 'bad'}">${g.winRate}% <span class="muted">n=${g.n}</span></td><td class="muted">${g.avgBps} bp</td><td class="muted">PF ${g.profitFactor}</td><td></td></tr>`;
  };

  $('#backtest').innerHTML = `
    <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Surprise size</th>
          <th>Follow model (win)</th><th>avg</th>
          <th>Fade the move (win)</th><th>avg</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
        <tr><td colspan="5" style="border-bottom:1px solid var(--line)"></td></tr>
        ${globalRow('Follow model', modelBlock)}
        ${globalRow('Fade the move', fadeBlock)}
      </tbody>
    </table>
    </div>
    <p class="note">Walk-forward win rate over a ${hold}-day hold, after ${m.costBps} bp round-trip cost. Sample size (n) is shown for every bucket. Rows with n &lt; 30 are hidden.</p>`;

  $('#bt-note').textContent =
    'The edge concentrates in large surprises. Small surprises (|z| < 1.5) are close to a coin flip — treat those signals as noise.';
}

async function load() {
  setStatus('loading', 'Loading model…');
  try {
    state.model = await getJson('./data/model.json');
  } catch (err) {
    setStatus('error', 'Model failed to load');
    return;
  }
  try {
    state.cached = await getJson('./data/events-recent.json');
  } catch {
    state.cached = [];
  }
  state.events = mergeEvents([], state.cached);
  render();

  setStatus('loading', 'Fetching live calendar…');
  const live = await fetchLiveCalendar();
  if (live && live.length) {
    state.events = mergeEvents(live, state.cached);
    state.lastLive = Date.now();
    setStatus('live', 'Live');
    render();
  } else {
    setStatus('cached', 'Cached snapshot');
  }
  $('#updated').textContent = `· updated ${new Date().toLocaleTimeString()}`;
}

function setStatus(kind, text) {
  const dot = $('#live-dot');
  dot.className = 'dot' + (kind === 'live' ? ' live' : kind === 'error' ? ' err' : '');
  $('#status-text').textContent = text;
}

function wireControls() {
  $('#window-days').addEventListener('change', (e) => { state.windowDays = +e.target.value; render(); });
  $('#horizon-days').addEventListener('change', (e) => { state.horizonDays = +e.target.value; render(); });
  $('#min-score').addEventListener('change', (e) => { state.minScore = +e.target.value; render(); });
  $('#only-high').addEventListener('change', (e) => { state.onlyHigh = e.target.checked; renderCalendar(); });
  $('#proven-only').addEventListener('change', (e) => { state.provenOnly = e.target.checked; renderSignals(); });
}

wireControls();
load();
setInterval(() => {
  fetchLiveCalendar().then((live) => {
    if (live && live.length) {
      state.events = mergeEvents(live, state.cached);
      state.lastLive = Date.now();
      setStatus('live', 'Live');
      render();
      $('#updated').textContent = `· updated ${new Date().toLocaleTimeString()}`;
    }
  });
}, 60000);
