import { buildSignals, buildForecastSignals, zOf } from './lib/engine.mjs';
import { msnrPlan } from './lib/alchemist.mjs';
import { drawChart } from './lib/chart.mjs';
import { classify as classifyTitle, newsTypeOf as newsTypeLabel } from './lib/polarity.mjs';
import { prepare as tncPrepare, TNC_LADDER } from './lib/tnc.mjs';
import { prepareApa, apaSignals, apaComponents } from './lib/apa.mjs';
import { PAIRS } from './lib/pairs.mjs';
import { fetchQuotes, withLiveClose } from './lib/live.mjs';

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
  quotes: {},
  quotesAt: null,
  liveTimer: null,
  liveOn: true,
  forecastLookahead: 7,
  forecastSignals: [],
  entryStyle: 'confirm',
  confirmAtr: 0.25,
  confirmWindow: 3,
  msnr: { plan: msnrPlan },
  msnrOn: true,
  msnrRequire: false,
  msnrGoal: 'winrate',
  strategy: 'fund',
  chartSymbol: null,
  chartMode: 'candles',
  chartBars: 160,
  chartShow: { levels: true, ocls: true, zones: true, fvgs: true, marks: true },
  msnrScope: 'fx',
  analysisFilter: 'signal',
  pip: { slPips: 30, tpPips: 30, slAtr: 0.75, confirmAtr: 0.25, confirmWindow: 3 },
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
  // TradingView sends a rounded display value (`forecast`: 65) alongside the raw
  // one (`forecastRaw`: 65000). The model is fitted on raw units, so taking the
  // display value shrinks every live surprise by the scale factor — a 60k NFP
  // surprise becomes 60 — and no live release can ever clear the z threshold.
  // The historical pipeline already prefers raw; this side did not.
  const num = (v) => (v == null || v === '' ? null : Number(v));
  return {
    id: String(r.id ?? r.event_id ?? `${r.title}-${ts}`),
    title: r.title || r.event || 'Event',
    indicator: r.indicator || r.title || '',
    currency: (r.currency || r.country || '').toUpperCase().slice(0, 3),
    importance: r.importance ?? r.impact ?? 0,
    ts,
    actual: num(r.actualRaw ?? r.actual),
    forecast: num(r.forecastRaw ?? r.forecast),
    previous: num(r.previousRaw ?? r.previous),
    unit: r.unit || '',
    scale: r.scale || '',
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

// Human wording for when a release happened, so a card is never ambiguous.
function fmtWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date(state.asOf);
  const days = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86400000);
  const time = d.toISOString().slice(11, 16);
  if (days === 0) return `today ${time}`;
  if (days === -1) return `yesterday ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 0) return `${-days} days ago (${d.toISOString().slice(5, 10)} ${time})`;
  return `in ${days} days (${d.toISOString().slice(5, 10)} ${time})`;
}

// Releases that are scheduled but have not printed. Each one now carries a
// consensus lean — the direction the forecast implies, from the same
// classification the post-release model uses. This is what lets the platform
// say something before NFP rather than going silent until the number lands.
//
// The lean is explicitly NOT backtested, and the panel says so: the
// consensus-change direction has no measured edge on this data (49-52% across
// horizons). It is a heads-up, not a call. The traded call is still the
// post-release one.
function renderUpcoming() {
  const host = $('#upcoming');
  if (!host) return;
  const now = state.asOf;
  const horizon = now + 7 * 86400000;
  const rows = state.events
    .filter((e) => e.importance === 1 && e.actual == null && e.ts > now && e.ts <= horizon)
    .sort((a, b) => a.ts - b.ts);
  const seen = new Set();
  const uniq = rows.filter((e) => (seen.has(e.title + e.ts) ? false : (seen.add(e.title + e.ts), true)));

  // Index the pre-release leans by release so each row can show its direction.
  const leans = new Map();
  for (const s of state.forecastSignals || []) {
    const key = `${s.release}|${s.scheduledAt}`;
    if (!leans.has(key)) leans.set(key, []);
    leans.get(key).push(s);
  }

  $('#upcoming-sub').textContent = uniq.length ? `${uniq.length} scheduled in the next 7 days` : 'Nothing high-impact scheduled in the next 7 days';
  if (!uniq.length) {
    host.innerHTML = `<p class="empty">No high-impact releases are scheduled in the next 7 days. When one is, it appears here with its consensus forecast so you can see it coming.</p>`;
    return;
  }
  host.innerHTML = uniq.map((e) => {
    const { tag } = classifyTitle(e.title, e.indicator);
    const f = e.forecast == null ? '—' : e.forecast;
    const p = e.previous == null ? '—' : e.previous;
    const lean = (leans.get(`${e.title}|${e.ts}`) || [])[0];
    const leanBlock = lean
      ? `<div class="lane-body">
          <span class="news-type">${esc(newsTypeLabel(tag))}</span>
          <span class="lean ${lean.action === 'BUY' ? 'up' : 'down'}">consensus leans ${lean.action}</span>
          <span class="dim">e.g. ${esc(lean.label)}</span>
        </div>
        <p class="hint">Pre-release lean from the consensus vs the previous print (${lean.top.z > 0 ? '+' : ''}${lean.top.z.toFixed(1)}σ). <b>Not backtested</b> — the consensus alone has no measured edge here. The traded call is the post-release one.</p>`
      : `<div class="lane-body">
          <span class="news-type">${esc(newsTypeLabel(tag))}</span>
          <span>consensus ${esc(String(f))} · previous ${esc(String(p))}</span>
        </div>
        <p class="hint">No consensus lean: the consensus moved less than one standard deviation from the previous print, so there is no direction to lean on.</p>`;
    return `<div class="sig upcoming">
      <div class="sig-head">
        <div><span class="sym">${esc(e.title)}</span> <span class="kind">${esc(e.currency)}</span></div>
        <div class="when">${esc(fmtWhen(e.ts))}</div>
      </div>
      ${leanBlock}
    </div>`;
  }).join('');
}

// Market plans fill at the close, so their entry tracks the live price and the
// displayed plan sits where you could actually fill it. Trigger and limit plans
// are fixed levels by definition: a confirmation stop is a break of the release
// bar, so moving it to the live price would silently change what the backtest
// measured. Those keep their levels and just report the live price alongside.
function withLivePlan(x) {
  const p = x.plan;
  const q = state.quotes[x.symbol];
  if (!p || !q || !q.price) return p;
  const priced = { ...p, current: q.price };
  if (p.kind !== 'pip' || !(p.entry > 0) || !(p.risk > 0)) return priced;
  const dir = x.action === 'BUY' ? 1 : -1;
  const entry = q.price;
  const dp = (v) => (v >= 100 ? +v.toFixed(2) : v >= 1 ? +v.toFixed(4) : +v.toFixed(5));
  return {
    ...priced,
    entry: dp(entry),
    stop: dp(dir > 0 ? entry - p.risk : entry + p.risk),
    take: dp(dir > 0 ? entry + p.reward : entry - p.reward),
    live: true,
  };
}

// One sentence per card saying what the call is and whether to act on it.
function verdictOf(x) {
  const what = x.fundOk
    ? `The ${x.newsType.toLowerCase()} release came in ${x.top && x.top.z > 0 ? 'above' : 'below'} consensus, which points ${x.fundAction.toLowerCase()} on ${x.label}.`
    : `The ${x.newsType.toLowerCase()} release was a surprise, but this news type has not beaten a coin flip on this instrument.`;
  const chart = x.tech ? (x.techOk ? ' The chart agrees.' : ' The chart does not confirm.') : '';
  const action = x.analysis === 'confluence'
    ? 'Both tests pass — this is a tradeable call.'
    : x.analysis === 'technical'
      ? 'Only the chart agrees, with no fundamental driver — treat as a technical setup.'
      : x.analysis === 'conflict'
        ? 'Fundamentals and the chart disagree — stand aside.'
        : x.analysis === 'fundamental'
          ? 'Fundamental only, unconfirmed by the chart — watch rather than trade.'
          : 'Neither test passes — not a trade.';
  return what + chart + ' ' + action;
}

function renderSignals() {
  const host = $('#signals');
  const sub = $('#signals-sub');
  const all = state.signals;
  const counts = all.reduce((a, x) => { a[x.analysis] = (a[x.analysis] || 0) + 1; return a; }, {});
  const f = state.analysisFilter;
  const s = f === 'all' ? all : all.filter((x) => f === 'signal' ? (x.analysis === 'confluence' || x.analysis === 'technical') : x.analysis === f);
  const tradeable = (counts.confluence || 0) + (counts.technical || 0);
  sub.textContent = s.length === all.length
    ? `${all.length} calls in the last ${state.windowDays} days · ${tradeable} tradeable · ${state.horizonDays}-day hold`
    : `${s.length} of ${all.length} calls · ${tradeable} tradeable in total`;
  if (!s.length) {
    const latest = all.length ? ` The most recent call was ${fmtWhen(all[0].releasedAt)}.` : '';
    host.innerHTML = `<p class="empty"><b>Nothing to trade here.</b> A call is only made when a release beats consensus by at least ${state.minZ}σ. In the last ${state.windowDays} days ${all.length ? `there ${all.length === 1 ? 'was' : 'were'} ${all.length} such release${all.length === 1 ? '' : 's'}, but none passed the ${f === 'signal' ? 'confirmation' : 'filter'} test` : 'no release was that large'}.${latest}${f === 'signal' ? ' Switch the filter to <b>All</b> to see the weaker calls.' : ''}${state.windowDays < 60 ? ' Or widen the window.' : ''}</p>`;
    return;
  }
  host.innerHTML = s.map((x) => {
    const pct = Math.max(0, Math.min(100, x.confidence));
    const cls = x.action === 'BUY' ? 'buy' : 'sell';
    const badge = x.hasEdge
      ? `<span class="badge edge" title="This news type beat a coin flip on this instrument, on at least 30 past releases">historically > 50%</span>`
      : `<span class="badge soft" title="This news type has not beaten a coin flip on this instrument — the direction is not reliable">no measured edge</span>`;
    const kind = x.kind && x.kind !== 'fx' ? `<span class="kind">${esc(x.kind)}</span>` : '';

    const ANALYSIS = {
      confluence: ['confluence', 'Fundamental + technical agree'],
      fundamental: ['fund', 'Fundamental only — no chart confirmation'],
      technical: ['tech', 'Technical only — no fundamental driver'],
      conflict: ['conflict', 'Conflict — fundamentals and chart disagree'],
      weak: ['weak', 'Weak — neither test is met'],
    };
    const [aCls, aLabel] = ANALYSIS[x.analysis] || ANALYSIS.weak;
    const tag = `<span class="tag ${aCls}" title="${esc(aLabel)}">${aLabel}</span>`;
    const verdict = `<p class="verdict">${esc(verdictOf(x))}</p>`;

    // Fundamental block: the release, its surprise, and the measured edge.
    const fundRow = `<div class="lane fund">
      <div class="lane-head"><span class="lane-name">Fundamental</span>
        <span class="lane-call ${x.fundAction === 'BUY' ? 'buy' : 'sell'}">${x.fundAction}</span></div>
      <div class="lane-body">
        <span class="news-type">${esc(x.newsType || 'Other')}</span>
        <span>surprise ${x.top ? x.top.z.toFixed(1) : '—'}σ · expected ${fmtBps(x.scoreBps)} · from ${fmtNum(x.top?.hitSample)} past releases</span>
      </div>
      <div class="lane-body muted"><span>${esc(x.release || 'Release')} · released ${fmtWhen(x.releasedAt)}</span></div>
    </div>`;

    // Technical block: MSNR confluence, structure, and the factors that fired.
    let techRow = `<div class="lane tech muted">
      <div class="lane-head"><span class="lane-name">Technical (MSNR)</span>
        <span class="lane-call none">—</span></div>
      <div class="lane-body"><span>no chart data</span></div>
    </div>`;
    if (x.tech) {
      const t = x.tech;
      const chips = t.factors.map((f) => `<span class="chip" title="${esc(f.detail || '')}">${esc(f.name)}</span>`).join('');
      techRow = `<div class="lane tech">
        <div class="lane-head"><span class="lane-name">Technical (MSNR)</span>
          <span class="lane-call ${x.techAction === 'BUY' ? 'buy' : 'sell'}">${x.techAction}</span></div>
        <div class="lane-body"><span>confluence ${t.score} · ${esc(t.structure)}</span>
          <span>${x.techOk ? 'chart confirms' : 'below threshold'}</span></div>
        <div class="chips">${chips || '<span class="chip muted">no confluence</span>'}</div>
      </div>`;
    }

    let planBlock = '';
    if (x.plan) {
      const p = withLivePlan(x);
      const dp = (v) => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(5));
      const order = p.order ? `<span class="order">${esc(p.order)}</span>` : '';
      const pipLine = p.pips ? `<div class="sig-row"><span class="lbl">Distances</span><span class="sig-meta">stop ${p.pips.sl} pips · target ${p.pips.tp} pips</span></div>` : '';
      const isTrigger = p.kind === 'confirm' || p.kind === 'fib';
      const currentRow = isTrigger && p.current
        ? `<div class="sig-row"><span class="lbl">Now</span><span class="sig-meta">${dp(p.current)}${p.current !== p.entry ? ` · ${x.action === 'BUY' ? (p.current < p.entry ? 'waiting for the break up' : 'trigger already met') : (p.current > p.entry ? 'waiting for the break down' : 'trigger already met')}` : ''}</span></div>`
        : '';
      const entryLabel = p.kind === 'confirm' ? 'Trigger' : p.kind === 'fib' ? 'Limit' : 'Entry';
      const liveTag = p.live ? ' (live)' : isTrigger && p.current ? ' (fixed)' : '';
      planBlock = `<div class="plan">
        <div class="plan-cell"><span class="lbl">${entryLabel}${liveTag}</span><b>${dp(p.entry)}</b></div>
        <div class="plan-cell stop"><span class="lbl">Stop</span><b>${dp(p.stop)}</b></div>
        <div class="plan-cell take"><span class="lbl">Target</span><b>${dp(p.take)}</b></div>
        <div class="plan-cell"><span class="lbl">R:R</span><b>${p.rr.toFixed(1)}</b></div>
      </div>
      ${pipLine}
      <div class="sig-row"><span class="lbl">Risk</span><span class="sig-meta">${p.riskPct}% of price ${order}</span></div>${currentRow}`;
    }

    return `<article class="sig ${cls}">
      <div class="sig-head">
        <span class="sig-pair">${esc(x.label)}${kind}</span>
        <span class="sig-act">${x.action}</span>
      </div>
      <div class="tags">${tag}</div>
      ${verdict}
      ${fundRow}
      ${techRow}
      ${planBlock}
      <div class="sig-foot">
        <span>${badge}</span>
        <span>Confidence ${x.confidence}%</span>
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

// One batched quote fetch, applied to the chart series and to the rendered
// signals. Failures are silent by design: the bundled snapshot stays on screen
// and the freshness line keeps reporting its age.
async function refreshQuotes() {
  if (!state.liveOn) return;
  try {
    const quotes = await fetchQuotes(PAIRS);
    state.quotes = quotes;
    state.quotesAt = Date.now();
    renderChart();
    renderSignals();
    renderFreshness();
  } catch (err) {
    state.quotesError = err.message;
    renderFreshness();
  }
}

function startLivePolling() {
  if (state.liveTimer) clearInterval(state.liveTimer);
  state.liveTimer = setInterval(refreshQuotes, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshQuotes();
  });
  window.addEventListener('focus', refreshQuotes);
  // Keep the "updated Xs ago" figure honest between polls without refetching.
  setInterval(renderFreshness, 5000);
}

// The freshness line states exactly what is live and what is a snapshot, so a
// "Live" badge never sits next to a stale level.
function renderFreshness() {
  const host = $('#freshness');
  if (!host) return;
  const series = Object.values(state.bars || {}).find((b) => b && b.length);
  const lastBar = series ? series[series.length - 1].t : null;
  const barAgeD = lastBar ? Math.floor((Date.now() - lastBar) / 86400000) : null;
  const qAgeS = state.quotesAt ? Math.round((Date.now() - state.quotesAt) / 1000) : null;
  const pricePart = qAgeS == null
    ? (lastBar ? `Prices: daily bars to ${new Date(lastBar).toISOString().slice(0, 10)}${barAgeD > 0 ? ` (${barAgeD}d old)` : ''}` : 'Prices unavailable')
    : `Prices live (updated ${qAgeS}s ago)`;
  // The entry style decides what the live price does to a plan. A market plan
  // re-anchors to it; a confirmation stop is a fixed break of the release bar and
  // must not move, or the displayed plan stops matching the measured win rate.
  const triggerEntry = state.entryStyle !== 'pip';
  const planPart = qAgeS == null
    ? 'plans anchored to the last close'
    : triggerEntry
      ? 'trigger levels fixed at the release bar, signal logic stays on daily bars'
      : 'plan entries follow the live price, signal logic stays on daily bars';
  host.textContent = `${pricePart} · calendar live · ${planPart}`;
}

function renderAll() {
  renderKPIs();
  renderSignals();
  renderTrackStats();
  renderLedger();
  renderCalendar();
  renderBacktest();
  renderMsnr();
  renderUpcoming();
  renderFreshness();
  renderStrategies();
  renderChartToggles();
  renderChart();
}

function renderMsnr() {
  const m = state.msnrBacktest;
  if (!m || !m.goals) return;
  const goal = m.goals[state.msnrGoal] || m.goals.winrate || m.goals.balanced;
  const scope = state.msnrScope === 'fx' ? goal.fx : goal.all;
  const o = scope.overall;
  const stat = (k, v, s = '', cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="m">${s}</div></div>`;
  $('#msnr-stats').innerHTML = [
    stat('Win rate', `${o.resolvedWinRate}%`, `${o.tp} hit target · ${o.sl} stopped`, o.resolvedWinRate > 50 ? 'up' : ''),
    stat('Profit factor', o.profitFactor, `after costs`),
    stat('Expectancy', `${o.expectancyR}R`, 'per call'),
    stat('Avg stop', `${o.avgRiskPct}%`, 'of price'),
    stat('Pips / trade', o.pipsPerTrade, 'net of stop and target'),
    stat('Profitable years', `${scope.profitableYears}/${scope.yearsWithData}`, 'of years with data'),
  ].join('');
  const cfg = goal.config;
  $('#msnr-note').innerHTML = `A call must clear <b>|z| ≥ ${m.gate.minZ}</b> and the chart must agree at MSNR confluence ≥ ${m.gate.minConfluence}. The stop is the smaller of <b>${cfg.slAtr}× ATR</b> and the pip cap, floored at <b>${cfg.slPips} pips</b>; the target is at least <b>${cfg.tpPips} pips</b> and at least <b>${cfg.minRR}:1</b>. Resolved bar by bar over a ${cfg.horizon}-day hold. An unresolved trade is marked to market — it is never counted as a win.`;
  $('#msnr-range').textContent = `${m.range.from}–${m.range.to} · walk-forward · ${o.n} calls · ${goal.label}`;
  const rows = Object.entries(scope.byYear).map(([y, v]) => {
    const cls = v.profitFactor > 1 ? 'up' : 'down';
    return `<tr><td>${y}</td><td class="num"><span class="pill ${cls}">${v.resolvedWinRate}%</span></td><td class="num">${v.profitFactor}</td><td class="num">${v.expectancyR}R</td><td class="num">${v.n}</td><td class="num">${v.avgRiskPct}%</td></tr>`;
  }).join('');
  $('#msnr-year').innerHTML = `<table>
    <thead><tr><th>Year</th><th class="num">Win rate</th><th class="num">PF</th><th class="num">Exp.</th><th class="num">Calls</th><th class="num">Avg stop</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/* ---------------- strategy comparison ---------------- */

// One table across every model, all measured on the same walk-forward basis.
// The honest headline: nothing clears 70% at a 1:3 reward, and the highest win
// rate belongs to the fundamental model with a category filter.
function renderStrategies() {
  const f = state.fundBacktest, a = state.apaBacktest, t = state.tncBacktest, m = state.msnrBacktest;
  if (!f && !a) return;
  const rows = [];
  const push = (name, note, s, extra = '') => { if (s && s.n >= 40) rows.push({ name, note, ...s, extra }); };

  if (f) {
    push('Fundamentals + chart (category filter)', 'news category proven on prior years', f.chosen?.overall);
    push('Fundamentals + chart (no filter)', 'every large surprise the chart agreed with', f.baseline?.fx);
  }
  if (m?.goals?.winrate) push('Fundamentals + MSNR, 1:1 target', 'pip stop, 30 pip target', m.goals.winrate.fx?.overall);
  if (m?.goals?.balanced) push('Fundamentals + MSNR, 1:2 target', 'pip stop, 70 pip target', m.goals.balanced.fx?.overall);
  if (t?.side?.['h20_rr1']) {
    push('TNC key levels — short side', 'A-shaped level or bearish OCL', t.side['h20_rr1'].shortCore);
    push('TNC key levels — long side', 'V-shaped level or bullish OCL', t.side['h20_rr1'].longCore);
  }
  if (a?.grid) {
    const rows2 = Object.entries(a.grid).map(([k, v]) => ({ k, ...v })).filter((r) => r.n >= 200);
    const hi = [...rows2].sort((x, y) => y.resolvedWinRate - x.resolvedWinRate)[0];
    const bestExp = [...rows2].filter((r) => r.expectancyR > 0).sort((x, y) => y.expectancyR - x.expectancyR)[0];
    if (hi) push(`APA ${hi.k.split('|')[0]} — highest hit rate`, `${hi.k.split('|')[1]} · small target, thin edge`, hi);
    if (bestExp) push(`APA ${bestExp.k.split('|')[0]} — best edge`, bestExp.k.split('|')[1], bestExp);
  }

  rows.sort((x, y) => y.resolvedWinRate - x.resolvedWinRate);
  const best = rows[0];
  $('#strat-table').innerHTML = `<table>
    <thead><tr><th>Strategy</th><th class="num">Calls</th><th class="num">Win rate</th><th class="num">PF</th><th class="num">Exp.</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="${r === best ? 'best' : ''}">
      <td class="name">${esc(r.name)}<div class="sig-meta">${esc(r.note || '')}</div></td>
      <td class="num">${fmtNum(r.n)}</td>
      <td class="num"><span class="pill ${r.resolvedWinRate >= 60 ? 'up' : r.resolvedWinRate >= 50 ? '' : 'down'}">${r.resolvedWinRate}%</span></td>
      <td class="num">${r.profitFactor}</td>
      <td class="num">${r.expectancyR}R</td>
    </tr>`).join('')}</tbody></table>`;
  $('#strat-range').textContent = f ? `${f.range.from}–${f.range.to} · walk-forward · resolved trades only` : '';
  $('#strat-note').innerHTML = 'Win rate counts only trades that reached the target or the stop. Trades still open at the horizon are marked to market and excluded from the hit rate, so the number is not flattered.';
  const v = [];
  if (best) v.push(`Highest measured win rate: <b>${esc(best.name)}</b> at <b>${best.resolvedWinRate}%</b> over ${fmtNum(best.n)} calls (PF ${best.profitFactor}, expectancy ${best.expectancyR}R).`);
  v.push('Nothing here reaches 70% at a 1:3 reward:risk. That combination does not exist on this data. A high hit rate needs a target close to the stop — the APA row with a 1:0.5 target hits about 64% but the expectancy is negative, so it loses money. The fundamental model with a category filter is the best balance of win rate and profitability.');
  $('#strat-verdict').innerHTML = v.join(' ');
}

/* ---------------- chart lab ---------------- */

const CHART_TOGGLES = [['levels', 'Key levels'], ['ocls', 'OCLs'], ['zones', 'MSNR zones'], ['fvgs', 'Imbalances'], ['marks', 'BOS / H&S']];

function renderChartToggles() {
  $('#chart-toggles').innerHTML = CHART_TOGGLES.map(([k, label]) =>
    `<span class="chip ${state.chartShow[k] ? '' : 'off'}" data-key="${k}">${label}</span>`).join('');
  $('#chart-toggles').className = 'chips toggle';
}

function renderChart() {
  const sym = state.chartSymbol;
  const base = state.hourly?.[sym];
  const series = base && state.quotes[sym] ? withLiveClose(base, state.quotes[sym]) : base;
  const canvas = $('#chart');
  if (!canvas) return;
  if (!series || series.length < 60) {
    $('#chart-read').textContent = 'No hourly series bundled for this instrument.';
    return;
  }
  const end = series.length - 1;
  const show = state.chartShow;
  const ctx = tncPrepare(series);
  const opts = { mode: state.chartMode, bars: state.chartBars, end };
  if (show.levels) opts.levels = tncLevels(ctx, end);
  if (show.ocls) opts.ocls = tncOcls(ctx, end);
  if (show.zones) opts.zones = zonesAt(ctx, end);
  if (show.fvgs) opts.fvgs = fvgsAt(ctx, end);
  if (show.marks) opts.marks = marksAt(ctx, end);
  drawChart(canvas, series, opts);
  const isLive = !!(base && state.quotes[sym] && series[series.length - 1]?.live);
  $('#chart-range').textContent = `${sym} · ${state.chartMode} · last ${state.chartBars} bars${isLive ? ' · live' : ''}`;
  $('#chart-read').innerHTML = readChart(ctx, end, series);
}

// The pieces the chart draws are the same ones the TNC model reads.
function tncLevels(ctx, end) {
  const out = [];
  for (const tf of ['D', '4H']) {
    const bars = ctx[tf];
    const sw = ctx.swings[tf];
    for (const s of sw.hi.slice(-6)) if (s.idx <= end - 2) out.push({ price: s.price, shape: 'A', kind: 'resistance' });
    for (const s of sw.lo.slice(-6)) if (s.idx <= end - 2) out.push({ price: s.price, shape: 'V', kind: 'support' });
    void bars;
  }
  return out.slice(-16);
}

function tncOcls(ctx, end) {
  const out = [];
  for (const tf of ['D', '4H']) {
    const bars = ctx[tf], sw = ctx.swings[tf];
    for (const s of sw.hi.slice(-5)) if (s.idx <= end) out.push({ price: bars[s.idx].o, side: 'bearish', disrespected: false });
    for (const s of sw.lo.slice(-5)) if (s.idx <= end) out.push({ price: bars[s.idx].o, side: 'bullish', disrespected: false });
  }
  return out.slice(-12);
}

function zonesAt(ctx, end) {
  const apa = prepareApa(ctx.H1);
  const c = apaComponentsSafe(apa, end);
  const out = [];
  const atr = apa.atr['1H'][end] || 0;
  if (c && atr) {
    if (c.dirs[-1].sweep) out.push({ kind: 'supply', lo: c.dirs[-1].sweep.level, hi: c.dirs[-1].sweep.level + atr * 0.5 });
    if (c.dirs[1].sweep) out.push({ kind: 'demand', lo: c.dirs[1].sweep.level - atr * 0.5, hi: c.dirs[1].sweep.level });
  }
  return out;
}

function fvgsAt(ctx, end) {
  const apa = prepareApa(ctx.H1);
  return apa.fvgs['1H'].filter((f) => f.i <= end && end - f.i < 120).slice(-8)
    .map((f) => ({ i: f.i, lo: f.lo, hi: f.hi, dir: f.type === 'demand' ? 1 : -1 }));
}

function marksAt(ctx, end) {
  const out = [];
  for (const e of ctx.events['4H']) if (e.i <= end && end - e.i < 400) out.push({ i: e.i * 4, kind: e.kind, dir: e.dir, label: e.kind === 'hs' ? 'H&S' : e.dir > 0 ? 'BOS▲' : 'BOS▼' });
  for (const e of ctx.events['1H']) if (e.i <= end && end - e.i < 160) out.push({ i: e.i, kind: e.kind, dir: e.dir, label: e.kind === 'hs' ? 'H&S' : e.dir > 0 ? 'BOS▲' : 'BOS▼' });
  return out.filter((m) => m.i <= end);
}

function apaComponentsSafe(ctx, at) {
  try { return apaComponents(ctx, at); } catch { return null; }
}

// A plain-language read of the current chart, built from the same checks.
function readChart(ctx, end, series) {
  const apa = prepareApa(ctx.H1);
  const sigs = apaSignals(apa, end, { requireTrend: false, requireSweep: false, requireFvg: false });
  const h1 = ctx.H1;
  const atr = apa.atr['1H'][end];
  const parts = [];
  parts.push(`<b>${state.chartSymbol}</b> last close ${h1[end].c.toFixed(5)}, ATR(14) ${atr ? atr.toFixed(5) : '—'}.`);
  const c = apaComponentsSafe(apa, end);
  if (c) {
    parts.push(`Structure: ${esc(c.structure)}.`);
    for (const dir of [1, -1]) {
      const d = c.dirs[dir];
      const bits = [];
      if (d.sweep) bits.push(`sweep of ${d.sweep.level.toFixed(5)}`);
      if (d.fvg) bits.push(`returning into a ${d.fvg.type} imbalance`);
      if (d.bos) bits.push('break of structure');
      if (bits.length) parts.push(`${dir > 0 ? 'Buy' : 'Sell'} case: ${bits.join(', ')}.`);
    }
  }
  if (sigs.length) parts.push(`A full APA setup is live on this bar (${sigs.map((s) => s.action).join(', ')}).`);
  void series;
  return parts.join(' ');
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function fillChartSymbols() {
  const sel = $('#chart-symbol');
  if (!sel) return;
  const syms = Object.keys(state.hourly || {}).sort();
  sel.innerHTML = syms.map((s) => `<option value="${s}"${s === state.chartSymbol ? ' selected' : ''}>${s}</option>`).join('');
  if (!state.chartSymbol && syms.length) state.chartSymbol = syms[0];
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
  $('#stop-profile')?.addEventListener('change', (e) => { state.stopProfile = e.target.value; refreshSignals(); renderAll(); });
  $('#sl-pips').addEventListener('change', (e) => { state.pip.slPips = +e.target.value; refreshSignals(); renderAll(); });
  $('#tp-pips').addEventListener('change', (e) => { state.pip.tpPips = +e.target.value; refreshSignals(); renderAll(); });
  $('#sl-atr').addEventListener('change', (e) => { state.pip.slAtr = +e.target.value; refreshSignals(); renderAll(); });
  $('#msnr-goal').addEventListener('change', (e) => { state.msnrGoal = e.target.value; renderMsnr(); });
  $('#msnr-scope').addEventListener('change', (e) => { state.msnrScope = e.target.value; renderMsnr(); });
  $('#analysis-filter').addEventListener('change', (e) => { state.analysisFilter = e.target.value; renderSignals(); });
  $('#chart-symbol').addEventListener('change', (e) => { state.chartSymbol = e.target.value; renderChart(); });
  $('#chart-mode').addEventListener('change', (e) => { state.chartMode = e.target.value; renderChart(); });
  $('#chart-bars').addEventListener('change', (e) => { state.chartBars = +e.target.value; renderChart(); });
  $('#chart-toggles').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const k = chip.dataset.key;
    state.chartShow[k] = !state.chartShow[k];
    renderChartToggles();
    renderChart();
  });
  window.addEventListener('resize', debounce(() => renderChart(), 150));
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
    // These must mirror the confirmation goal in tools/backtest-msnr.mjs exactly,
    // or the card shows a plan the measured numbers never described. minRR in
    // particular defaults to 3 upstream, which would turn the measured 1:1 into a
    // 1:3 the win rate does not apply to.
    msnrOptions: { planStyle: state.entryStyle, minConfluence: 4, horizon: 5, requireStructure: true, requireTech: state.msnrRequire, minRR: 1, maxRiskPct: 3, ...state.pip },
  });
  // Pre-release calls from the consensus alone, shown so the platform has
  // something to say before a release prints. Kept in their own list so they can
  // never be mixed into the validated ledger.
  state.forecastSignals = buildForecastSignals(state.events, state.model, {
    asOf: state.asOf,
    lookaheadDays: state.forecastLookahead,
    minScoreBps: state.minScoreBps,
    minZ: 1,
  });
}

async function boot() {
  try {
    const [model, events, backtest, track, bars, msnrBacktest, fundBacktest, apaBacktest, tncBacktest, hourly] = await Promise.all([
      getJSON('./data/model.json'),
      getJSON('./data/events-recent.json'),
      getJSON('./data/backtest.json'),
      getJSON('./data/track-record.json'),
      getJSON('./data/bars.json').catch(() => ({})),
      getJSON('./data/msnr-backtest.json').catch(() => null),
      getJSON('./data/fund-backtest.json').catch(() => null),
      getJSON('./data/apa-backtest.json').catch(() => null),
      getJSON('./data/tnc-backtest.json').catch(() => null),
      getJSON('./data/hourly.json').catch(() => null),
    ]);
    state.model = model;
    state.events = events;
    state.backtest = backtest;
    state.track = track;
    state.bars = bars || {};
    state.msnrBacktest = msnrBacktest;
    state.fundBacktest = fundBacktest;
    state.apaBacktest = apaBacktest;
    state.tncBacktest = tncBacktest;
    state.hourly = hourly || {};
    state.chartSymbol = state.chartSymbol || Object.keys(state.hourly)[0] || null;
    refreshSignals();
    fillInstrumentFilter();
    wire();
    fillChartSymbols();
    renderAll();
    $('#live-dot').classList.add('on');
    $('#status-text').textContent = 'Live';
    $('#updated').textContent = new Date(state.asOf).toISOString().slice(0, 16).replace('T', ' ');
    renderFreshness();
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

  await refreshQuotes();
  startLivePolling();
}

boot();
