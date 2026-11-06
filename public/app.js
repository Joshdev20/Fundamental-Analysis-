import { buildSignals, zOf } from './lib/engine.mjs';
import { msnrPlan } from './lib/alchemist.mjs';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmtBps = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} bp`;
const fmtNum = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PAGE = 20;

const state = {
  model: null,
  events: [],
  bars: {},
  msnr: { plan: msnrPlan },
  msnrOn: true,
  msnrRequire: false,
  backtest: null,
  track: null,
  msnrBacktest: null,
  signals: [],
  asOf: Date.now(),
  windowDays: 30,
  horizonDays: 5,
  minZ: 2,
  minScoreBps: 2,
  requireEdge: false,
  trackFilter: 'all',
  trackInstrument: 'all',
  page: 1,
};

/* ---------------- data ---------------- */
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function liveCalendar() {
  const base = new Date(state.asOf);
  const from = new Date(base.getTime() - 10 * 86400000).toISOString().slice(0, 10);
  const to = new Date(base.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  try {
    const r = await fetch(`/api/proxy?url=${encodeURIComponent(`https://economic-calendar.tradingview.com/events?from=${from}&to=${to}&countries=US,EU,GB,JP,AU,CA,CH,NZ`)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const rows = (j.result || j.data || []).map(normalize).filter(Boolean);
    if (rows.length) return rows;
    throw new Error('empty');
  } catch {
    return state.events;
  }
}

function normalize(r) {
  const ts = Date.parse(r.date || r.time || r.timestamp);
  if (!Number.isFinite(ts)) return null;
  const num = (v) => (v == null || v === '' ? null : Number(v));
  return {
    id: String(r.id ?? r.event_id ?? `${r.title}-${ts}`),
    title: r.title || r.event || 'Event',
    indicator: r.indicator || r.title || '',
    currency: (r.currency || r.country || '').toUpperCase().slice(0, 3),
    importance: r.importance ?? r.impact ?? 0,
    ts,
    actual: num(r.actual ?? r.actualRaw),
    forecast: num(r.forecast ?? r.forecastRaw),
    previous: num(r.previous ?? r.previousRaw),
    unit: r.unit || '',
  };
}

/* ---------------- render ---------------- */
function renderKPIs() {
  const t = state.track?.summary;
  const open = state.signals.length;
  const buys = state.signals.filter((s) => s.action === 'BUY').length;
  const strongest = state.signals.slice().sort((a, b) => Math.abs(b.scoreBps) - Math.abs(a.scoreBps))[0];
  const kpi = (k, v, m = '') => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="m">${m}</div></div>`;
  $('#kpis').innerHTML = [
    kpi('Open calls', open, `${buys} buy · ${open - buys} sell`),
    kpi('Strongest', strongest ? strongest.label : '—', strongest ? `${strongest.action} · ${fmtBps(strongest.scoreBps)}` : 'none above threshold'),
    kpi('Logged win rate', t ? `${t.winRate}%` : '—', t ? `${t.resolved} resolved · PF ${t.profitFactor}` : ''),
    kpi('Backtest range', state.backtest ? `${new Date(state.backtest.range.from).getUTCFullYear()}–${new Date(state.backtest.range.to).getUTCFullYear()}` : '—', state.backtest ? `${fmtNum(state.backtest.range.events)} releases` : ''),
  ].join('');
}

function renderSignals() {
  const host = $('#signals');
  const sub = $('#signals-sub');
  const s = state.signals;
  sub.textContent = `${s.length} call${s.length === 1 ? '' : 's'} · ${state.horizonDays}-day hold · |z| ≥ ${state.minZ}`;
  if (!s.length) {
    host.innerHTML = `<p class="empty">No high-conviction calls in this window. That is normal — the model only fires on large surprises (|z| ≥ ${state.minZ}). Widen the window or lower the surprise threshold.</p>`;
    return;
  }
  host.innerHTML = s.map((x) => {
    const pct = Math.max(0, Math.min(100, x.confidence));
    const cls = x.action === 'BUY' ? 'buy' : 'sell';
    const badge = x.hasEdge ? `<span class="badge edge">proven edge</span>` : `<span class="badge soft">unproven</span>`;
    const kind = x.kind && x.kind !== 'fx' ? `<span class="kind">${esc(x.kind)}</span>` : '';

    let techBlock = '';
    if (x.tech) {
      const t = x.tech;
      const chips = t.factors.map((f) => `<span class="chip" title="${esc(f.detail || '')}">${esc(f.name)}</span>`).join('');
      techBlock = `<div class="sig-row"><span class="lbl">MSNR</span><span class="sig-meta">${t.score} · ${esc(t.structure)}</span></div>
        <div class="chips">${chips || '<span class="chip muted">no confluence</span>'}</div>`;
    }

    let planBlock = '';
    if (x.plan) {
      const p = x.plan;
      const dp = (v) => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(5));
      planBlock = `<div class="plan">
        <div class="plan-cell"><span class="lbl">Entry</span><b>${dp(p.entry)}</b></div>
        <div class="plan-cell stop"><span class="lbl">Stop</span><b>${dp(p.stop)}</b></div>
        <div class="plan-cell take"><span class="lbl">Target</span><b>${dp(p.take)}</b></div>
        <div class="plan-cell"><span class="lbl">R:R</span><b>${p.rr.toFixed(1)}</b></div>
      </div>
      <div class="sig-row"><span class="lbl">Risk</span><span class="sig-meta">${p.riskPct}% of price · ${x.plan.rr >= 1 ? 'R:R ' + p.rr.toFixed(1) : ''}</span></div>`;
    }

    return `<article class="sig ${cls}">
      <div class="sig-head">
        <span class="sig-pair">${esc(x.label)}${kind}</span>
        <span class="sig-act">${x.action}</span>
      </div>
      <div class="sig-row"><span class="lbl">Confidence</span><span class="sig-meta">${x.confidence}%</span></div>
      <div class="meter" role="img" aria-label="confidence ${x.confidence}%"><i style="width:${pct}%"></i></div>
      <div class="sig-row"><span class="lbl">Expected move</span><span class="sig-meta">${fmtBps(x.scoreBps)}</span></div>
      ${techBlock}
      ${planBlock}
      <div class="sig-foot">
        <span>${badge}</span>
        <span>${esc(x.top?.tag || '')} · z ${x.top ? x.top.z.toFixed(1) : '—'} · n ${fmtNum(x.top?.hitSample)}</span>
      </div>
    </article>`;
  }).join('');
}

function renderTrackStats() {
  const t = state.track?.summary;
  if (!t) return;
  const stat = (k, v, m = '', cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="m">${m}</div></div>`;
  $('#track-stats').innerHTML = [
    stat('Win rate', `${t.winRate}%`, `${t.resolved} calls`, t.winRate > 50 ? 'up' : ''),
    stat('Profit factor', t.profitFactor, `after ${t.costBps} bp cost`),
    stat('Avg per call', fmtBps(t.avgBps), `${fmtNum(t.wins)}W / ${fmtNum(t.losses)}L`),
    stat('Buy', `${t.buy.winRate}%`, `n=${t.buy.n}`),
    stat('Sell', `${t.sell.winRate}%`, `n=${t.sell.n}`),
  ].join('');
  $('#track-sub').textContent = `${t.calls} calls scored · ${t.from} → ${t.to}`;
}

function filteredCalls() {
  let rows = state.track?.calls || [];
  if (state.trackFilter === 'win') rows = rows.filter((c) => c.w === 1);
  else if (state.trackFilter === 'loss') rows = rows.filter((c) => c.w === 0);
  else if (state.trackFilter === 'proven') rows = rows.filter((c) => c.proven === 1);
  if (state.trackInstrument !== 'all') rows = rows.filter((c) => c.s === state.trackInstrument);
  return rows;
}

function renderLedger() {
  const rows = filteredCalls();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  if (state.page > pages) state.page = pages;
  const slice = rows.slice((state.page - 1) * PAGE, state.page * PAGE);
  const host = $('#track');

  if (!rows.length) {
    host.innerHTML = `<p class="empty">No calls match this filter.</p>`;
    $('#track-pager').innerHTML = '';
    return;
  }
  host.innerHTML = slice.map((c) => {
    const stamp = c.w === 1 ? 'w' : c.w === 0 ? 'l' : 'o';
    const label = c.w === 1 ? 'win' : c.w === 0 ? 'loss' : 'open';
    const bpsCls = c.bps > 0 ? 'up' : c.bps < 0 ? 'down' : '';
    const actCls = c.a === 'BUY' ? 'b' : 's';
    return `<div class="call">
      <span class="date">${esc(c.d)}</span>
      <span class="pair">${esc(c.l)}<span class="act ${actCls}">${esc(c.a)}</span><span class="tag">${esc(c.tag)}</span></span>
      <span class="res ${stamp}">${label}</span>
      <span class="bps ${bpsCls}">${fmtBps(c.bps)}</span>
    </div>`;
  }).join('');

  renderPager(pages, rows.length);
}

function renderPager(pages, total) {
  const p = state.page;
  const btn = (n, label = n, on = n === p, dis = false) =>
    `<button type="button" data-p="${n}" class="${on ? 'on' : ''}" ${dis ? 'disabled' : ''} aria-label="Page ${n}" ${on ? 'aria-current="page"' : ''}>${label}</button>`;
  const nums = [];
  const push = (n) => nums.push(n);
  push(1);
  for (let n = p - 1; n <= p + 1; n++) if (n > 1 && n < pages) push(n);
  if (pages > 1) push(pages);
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  let out = btn(p - 1, '‹', false, p === 1);
  let last = 0;
  for (const n of uniq) {
    if (last && n - last > 1) out += `<span class="gap">…</span>`;
    out += btn(n);
    last = n;
  }
  out += btn(p + 1, '›', false, p === pages);
  $('#track-pager').innerHTML = `<span class="dim" style="font-size:12px;margin-right:8px">${total} calls</span>${out}`;
}

function renderCalendar() {
  const onlyHigh = $('#only-high').checked;
  const from = state.asOf - 14 * 86400000;
  let rows = state.events.filter((e) => e.ts >= from && e.ts <= state.asOf + 3 * 86400000);
  if (onlyHigh) rows = rows.filter((e) => e.importance === 1);
  rows.sort((a, b) => b.ts - a.ts);
  const tbody = $('#calendar tbody');
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="7" class="empty">No releases.</td></tr>`; return; }
  tbody.innerHTML = rows.slice(0, 60).map((e) => {
    const z = zOf(e, state.model);
    const zCls = z == null ? 'flat' : z > 0.5 ? 'up' : z < -0.5 ? 'down' : 'flat';
    const imp = e.importance === 1 ? 'hi' : 'flat';
    const d = new Date(e.ts);
    const when = `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}`;
    return `<tr>
      <td class="time">${when}</td>
      <td class="cur">${esc(e.currency)}</td>
      <td class="event">${esc(e.title)} <span class="pill ${imp}">${e.importance === 1 ? 'high' : 'med'}</span></td>
      <td class="num">${e.actual == null ? '—' : fmtNum(e.actual, 2)}</td>
      <td class="num">${e.forecast == null ? '—' : fmtNum(e.forecast, 2)}</td>
      <td class="num">${e.previous == null ? '—' : fmtNum(e.previous, 2)}</td>
      <td class="num"><span class="pill ${zCls}">${z == null ? '—' : (z > 0 ? '+' : '') + z.toFixed(2)}</span></td>
    </tr>`;
  }).join('');
}

function renderBacktest() {
  const b = state.backtest;
  if (!b) return;
  const h = b.hitRates[`model|${state.horizonDays}`] || b.hitRates['model|5'];
  $('#bt-range').textContent = `${new Date(b.range.from).getUTCFullYear()}–${new Date(b.range.to).getUTCFullYear()} · walk-forward`;
  $('#bt-note').innerHTML = `Win rate over a ${state.horizonDays}-day hold, after ${b.costBps} bp round-trip cost. Walk-forward: each call only uses earlier data.`;
  const zOrder = ['lt0.5', '0.5-1', '1-1.5', '1.5-2', '2-2.5', '2.5-3', 'gte3'];
  const label = (k) => (k === 'lt0.5' ? '< 0.5' : k === 'gte3' ? '≥ 3' : k.replace('-', '–'));
  const rows = zOrder.map((k) => {
    const v = h?.byZ?.[k];
    if (!v) return '';
    const cls = v.winRate >= 52 ? 'up' : v.winRate < 48 ? 'down' : 'flat';
    return `<tr><td>${label(k)}</td><td class="num"><span class="pill ${cls}">${v.winRate}%</span></td><td class="num">${fmtBps(v.avgBps)}</td><td class="num">${fmtNum(v.n)}</td></tr>`;
  }).join('');
  $('#backtest').innerHTML = `<table>
    <thead><tr><th>Surprise (|z|)</th><th class="num">Win rate</th><th class="num">Avg move</th><th class="num">Sample</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function renderAll() {
  renderKPIs();
  renderSignals();
  renderTrackStats();
  renderLedger();
  renderCalendar();
  renderBacktest();
  renderMsnr();
}

function renderMsnr() {
  const m = state.msnrBacktest;
  if (!m) return;
  const o = m.overall;
  const stat = (k, v, s = '', cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="m">${s}</div></div>`;
  $('#msnr-stats').innerHTML = [
    stat('Win rate', `${o.winRate}%`, `${o.n} chart-confirmed calls`, o.winRate > 50 ? 'up' : ''),
    stat('Profit factor', o.profitFactor, `${o.tp} hit target · ${o.sl} stopped`),
    stat('Avg risk', `${o.avgRiskPct}%`, 'of price, per call'),
    stat('Reward:risk', o.avgRR.toFixed(2), 'planned per call'),
    stat('Profitable years', `${m.profitableYears}/${m.yearsWithData}`, 'of years with data'),
  ].join('');
  $('#msnr-note').innerHTML = `A call must clear <b>|z| ≥ ${m.config.minZ}</b> <i>and</i> agree with MSNR structure (a fresh supply/demand zone, an imbalance, or a liquidity sweep) at confluence ≥ ${m.config.minConfluence}. Stops sit just beyond the zone, clamped so risk stays near ${o.avgRiskPct}% of price; the target is the opposing zone or ${m.config.rr}R. Resolved bar by bar over a ${m.config.horizon}-day hold — the same walk-forward discipline as the rest of the app.`;
  $('#msnr-range').textContent = `${m.range.from}–${m.range.to} · walk-forward · ${o.n} calls`;
  const rows = Object.entries(m.byYear).map(([y, v]) => {
    const cls = v.profitFactor > 1 ? 'up' : 'down';
    return `<tr><td>${y}</td><td class="num"><span class="pill ${cls}">${v.winRate}%</span></td><td class="num">${v.profitFactor}</td><td class="num">${v.n}</td><td class="num">${v.avgRiskPct}%</td></tr>`;
  }).join('');
  $('#msnr-year').innerHTML = `<table>
    <thead><tr><th>Year</th><th class="num">Win rate</th><th class="num">PF</th><th class="num">Calls</th><th class="num">Avg risk</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/* ---------------- wiring ---------------- */
function wire() {
  $('#window-days').addEventListener('change', (e) => { state.windowDays = +e.target.value; refreshSignals(); renderAll(); });
  $('#horizon-days').addEventListener('change', (e) => { state.horizonDays = +e.target.value; refreshSignals(); renderAll(); });
  $('#min-z').addEventListener('change', (e) => { state.minZ = +e.target.value; refreshSignals(); renderAll(); });
  $('#min-score').addEventListener('change', (e) => { state.minScoreBps = +e.target.value; refreshSignals(); renderAll(); });
  $('#proven-only').addEventListener('change', (e) => { state.requireEdge = e.target.checked; refreshSignals(); renderAll(); });
  $('#msnr-on').addEventListener('change', (e) => { state.msnrOn = e.target.checked; refreshSignals(); renderAll(); });
  $('#msnr-require').addEventListener('change', (e) => { state.msnrRequire = e.target.checked; refreshSignals(); renderAll(); });
  $('#stop-profile').addEventListener('change', (e) => { state.stopProfile = e.target.value; refreshSignals(); renderAll(); });
  $('#only-high').addEventListener('change', renderCalendar);

  $('#track-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    state.trackFilter = b.dataset.f;
    state.page = 1;
    $$('#track-filter button').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-selected', String(on)); });
    renderLedger();
  });
  $('#track-instrument').addEventListener('change', (e) => { state.trackInstrument = e.target.value; state.page = 1; renderLedger(); });
  $('#track-pager').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]');
    if (!b || b.disabled) return;
    state.page = +b.dataset.p;
    renderLedger();
    $('#track-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function fillInstrumentFilter() {
  const t = state.track?.summary?.byInstrument || {};
  const sel = $('#track-instrument');
  const items = Object.entries(t).sort((a, b) => b[1].n - a[1].n);
  sel.innerHTML = `<option value="all">All (${state.track?.summary.calls ?? 0})</option>` +
    items.map(([s, v]) => `<option value="${s}">${esc(v.label)} (${v.n})</option>`).join('');
}

function refreshSignals() {
  state.signals = buildSignals(state.events, state.model, {
    asOf: state.asOf,
    windowDays: state.windowDays,
    horizonDays: state.horizonDays,
    minScoreBps: state.minScoreBps,
    minZ: state.minZ,
    requireEdge: state.requireEdge,
    bars: state.msnrOn ? state.bars : null,
    msnr: state.msnrOn ? state.msnr : null,
    msnrOptions: { minConfluence: 4, horizon: 3, requireStructure: true, rr: 2, profile: state.stopProfile || 'balanced', requireTech: state.msnrRequire },
  });
}

async function boot() {
  try {
    const [model, events, backtest, track, bars, msnrBacktest] = await Promise.all([
      getJSON('./data/model.json'),
      getJSON('./data/events-recent.json'),
      getJSON('./data/backtest.json'),
      getJSON('./data/track-record.json'),
      getJSON('./data/bars.json').catch(() => ({})),
      getJSON('./data/msnr-backtest.json').catch(() => null),
    ]);
    state.model = model;
    state.events = events;
    state.backtest = backtest;
    state.track = track;
    state.bars = bars || {};
    state.msnrBacktest = msnrBacktest;
    refreshSignals();
    fillInstrumentFilter();
    wire();
    renderAll();
    $('#live-dot').classList.add('on');
    $('#status-text').textContent = 'Live';
    $('#updated').textContent = new Date(state.asOf).toISOString().slice(0, 16).replace('T', ' ');
  } catch (err) {
    $('#live-dot').classList.add('err');
    $('#status-text').textContent = 'Offline — bundled data';
    console.error(err);
  }

  try {
    const live = await liveCalendar();
    if (live && live.length) {
      const seen = new Map(state.events.map((e) => [e.id, e]));
      for (const e of live) seen.set(e.id, e);
      state.events = [...seen.values()];
      refreshSignals();
      renderAll();
      $('#status-text').textContent = 'Live calendar';
    }
  } catch { /* keep bundled data */ }
}

boot();
