'use strict';
/* ============================================================
   TAOSCAN PRO — app.js  ·  VPA Master Edition
   ============================================================ */

const WORKER_URL = 'https://taoscanpro.waddellb.workers.dev';

const SCORE_TOOLTIPS = {
  volPrice: {
    title: 'Volume Price Analysis (Effort vs Result)',
    text: 'Evaluates Anna Coulling’s VPA anomalies:\n\n1. Breakaway & Gap Fills: Validates institutional gaps and detects retail traps.\n2. Climaxes & Dojis: Flags selling climaxes (Hammers) and extreme indecision.\n3. Absorption: High volume with narrow spreads (Stopping Volume).\n4. Exhaustion: Low volume tests and "No Supply" pullbacks.'
  },
  'Shakeout Spring': {
    title: 'Wyckoff Shakeout / Spring',
    text: 'Institutional Action:\n\nMarket makers deliberately drive the price below key 20-day support levels to trigger retail panic stop-losses. This allows institutions to absorb those forced sell orders at wholesale prices right before launching the price back upward.'
  },
  'Breakaway Gap': {
    title: 'Breakaway Gap',
    text: 'Institutional Action:\n\nTrue trend initialization. Major funds are buying so aggressively at the opening bell that they clear out all available overhead supply instantly, creating a structural void of price action beneath them.'
  },
  'Gap Fill Bounce': {
    title: 'Gap Fill Bounce',
    text: 'Institutional Action:\n\nA successful retest of structural space. The stock gaps open, drifts down to test if aggressive sellers will emerge inside yesterday\'s territory, finds no opposition, and is forcefully bought back up by institutions defending the floor.'
  },
  'Stopping Vol': {
    title: 'Stopping Volume (Absorption)',
    text: 'Institutional Action:\n\nClassic insider absorption. A massive wave of retail or macro selling pressure is hitting the stock, but institutions step in with massive buy orders at a fixed level, capping the downside and stopping the fall.'
  },
  'Breakout': {
    title: 'Validated Breakout',
    text: 'Institutional Action:\n\nEffort is completely validated by result. High institutional money flow (effort) is perfectly synchronized with an exceptionally wide daily candlestick price spread (result) clearing overhead resistance.'
  },
  'The Test': {
    title: 'The Supply Test',
    text: 'Institutional Action:\n\nInsiders drop the price intentionally to probe for any remaining overhead supply. Because volume completely dries up on the dip, it proves to the market makers that no major sellers are left to fight them, signaling a green light to mark the price up.'
  },
  'No Supply': {
    title: 'No Supply Pullback',
    text: 'Institutional Action:\n\nSeller exhaustion. A minor downward consolidation day that prints on exceptionally low volume. This confirms that institutions are not liquidating their inventory; the minor selling is purely uncoordinated retail noise.'
  },
  'Continuation': {
    title: 'Trend Continuation',
    text: 'Institutional Action:\n\nA healthy, orderly day of trend continuation. While it lacks a massive structural anomaly or market maker manipulation footprint today, the stock exhibits robust moving average alignments and institutional volume support.'
  },
   'EMA20 Breakout': {
    title: 'EMA20 High-Volume Breakout',
    text: 'Institutional Action:\n\nHeavy institutional volume has forcefully driven the price back above the short-term 20-day moving average, signaling a sudden return of bullish momentum and the potential start of a new swing cycle.'
  },
  'EMA50 Breakout': {
    title: 'EMA50 High-Volume Breakout',
    text: 'Institutional Action:\n\nA major structural shift. Institutions have stepped in with massive volume to clear the 50-day moving average, absorbing overhead supply and signaling a highly probable mid-term trend reversal.'
  },
  'EMA200 Breakout': {
    title: 'EMA200 High-Volume Breakout',
    text: 'Institutional Action:\n\nA regime change. The stock has crossed the most important long-term institutional benchmark on heavy volume, triggering algorithmic buying programs across major funds.'
  }
};

const STATE = {
  activeSymbol: null,
  activeTf:     90,
  overlays:     { ema20: true, ema50: true, ema200: true },
  ohlcvCache:   {},
  indCache:     {},
  lastScan:     JSON.parse(localStorage.getItem('tsp_lastScan') || 'null'),
  isMobile:     window.innerWidth <= 900
};

// ── PURE VPA MATH ─────────────────────────────────────────────
const Ind = {
  ema(arr, period) {
    const k = 2 / (period + 1);
    const out = new Array(arr.length).fill(null);
    let sum = 0, cnt = 0;
    for (let i = 0; i < arr.length; i++) {
      if (cnt < period) { sum += arr[i]; cnt++; if (cnt === period) out[i] = sum / period; }
      else out[i] = arr[i] * k + out[i-1] * (1 - k);
    }
    return out;
  },
  volAvg(vols, period=20) {
    const out = new Array(vols.length).fill(null);
    for (let i = period-1; i < vols.length; i++) {
      out[i] = vols.slice(i-period+1, i+1).reduce((a,b) => a+b, 0) / period;
    }
    return out;
  },
  compute(candles) {
    const closes = candles.map(c => c.close);
    const vols   = candles.map(c => c.volume);
    const ema20Arr  = this.ema(closes, 20);
    const ema50Arr  = this.ema(closes, 50);
    const ema200Arr = this.ema(closes, 200);
    const volAvgArr = this.volAvg(vols);
    const n = candles.length - 1;
    return {
      price: closes[n], 
      ema20: ema20Arr[n], ema50: ema50Arr[n], ema200: ema200Arr[n],
      vol: vols[n], volAvg: volAvgArr[n],
      ema20Arr, ema50Arr, ema200Arr
    };
  },
  overall(ind) {
    let score = 0, total = 0;
    const add = (s, w) => { score += s * w; total += w; };
    if (ind.price && ind.ema20)  add(ind.price > ind.ema20  ? 1 : -1, 2);
    if (ind.price && ind.ema50)  add(ind.price > ind.ema50  ? 1 : -1, 1);
    if (ind.price && ind.ema200) add(ind.price > ind.ema200 ? 1 : -1, 1);
    if (ind.vol && ind.volAvg) {
      const volRatio = ind.vol / ind.volAvg;
      if (volRatio > 1.5) add(ind.price > ind.ema20 ? 2 : -2, 2); 
    }
    const pct = total ? score / total : 0;
    if (pct >= 0.4)  return 'BULLISH';
    if (pct <= -0.4) return 'BEARISH';
    return 'NEUTRAL';
  }
};

// ── WORKER API ────────────────────────────────────────────────
const API = {
  async polygon(path, params = {}) {
    const url = new URL(WORKER_URL + '/polygon');
    url.searchParams.set('path', path);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || `Error ${res.status}`); }
    return res.json();
  },
  async gemini(prompt) {
    const res = await fetch(WORKER_URL + '/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.error || `Error ${res.status}`); }
    return res.json();
  },
  async health() { const res = await fetch(WORKER_URL + '/health'); return res.json(); },
  async scanResults() { const res = await fetch(WORKER_URL + '/scan'); return res.json(); },
  async aggs(symbol, days) {
    const end = new Date(); const start = new Date(); start.setDate(start.getDate() - days - 250);
    const json = await this.polygon(
      `/v2/aggs/ticker/${symbol}/range/1/${days <= 10 ? 'hour' : 'day'}/${start.toISOString().slice(0,10)}/${end.toISOString().slice(0,10)}`,
      { adjusted: 'true', sort: 'asc', limit: '5000' }
    );
    if (!json.results?.length) throw new Error(`No data for ${symbol}`);
    return json.results.map(c => ({ time: Math.floor(c.t/1000), open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }));
  },
  async prevClose(symbol) {
    try {
      const json = await this.polygon(`/v2/aggs/ticker/${symbol}/prev`);
      const d = json.results?.[0];
      if (!d) return null;
      return { price: d.c, changePct: ((d.c - d.o) / d.o) * 100 };
    } catch { return null; }
  }
};

// ── CHART ENGINE ──────────────────────────────────────────────
const Charts = {
  main: null, mainSeries: null, ema20S: null, ema50S: null, ema200S: null, volS: null,
  OPTS: {
    layout: { background: { type: 'solid', color: '#0d0e10' }, textColor: '#6b7585', fontSize: 10, fontFamily: "'Share Tech Mono', monospace" },
    grid: { vertLines: { color: 'rgba(74,80,96,0.4)' }, horzLines: { color: 'rgba(74,80,96,0.4)' } },
    crosshair: { vertLine: { color: 'rgba(122,143,166,0.5)', width: 1, style: 3 }, horzLine: { color: 'rgba(122,143,166,0.5)', width: 1, style: 3 } },
    rightPriceScale: { borderColor: 'rgba(74,80,96,0.6)' },
    timeScale: { borderColor: 'rgba(74,80,96,0.6)', timeVisible: true, secondsVisible: false }
  },
  init() {
    const g = id => document.getElementById(id);
    this.main = LightweightCharts.createChart(g('mainChart'),  { ...this.OPTS, width: g('mainChart').offsetWidth,  height: g('mainChart').offsetHeight  });
    this.mainSeries = this.main.addCandlestickSeries({ upColor:'#4caf7d', downColor:'#c94040', borderUpColor:'#4caf7d', borderDownColor:'#c94040', wickUpColor:'#4caf7d', wickDownColor:'#c94040' });
    this.ema20S  = this.main.addLineSeries({ color:'rgba(74,127,168,0.9)',  lineWidth:1, title:'EMA20'  });
    this.ema50S  = this.main.addLineSeries({ color:'rgba(200,136,42,0.8)',  lineWidth:1, title:'EMA50'  });
    this.ema200S = this.main.addLineSeries({ color:'rgba(201,64,64,0.7)',   lineWidth:1, title:'EMA200' });
    this.volS    = this.main.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'volume', scaleMargins: { top: 0.8, bottom: 0 } });
    this.main.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    const ro = new ResizeObserver(entries => {
      if (!this.main || !entries.length) return;
      const { width, height } = entries[0].contentRect;
      this.main.resize(width, height);
    });
    ['mainChart'].forEach(id => ro.observe(g(id)));
  },
  toSeries(arr, candles, fn) { return arr.map((v,i) => (v!=null && candles[i]) ? { time:candles[i].time, ...fn(v) } : null).filter(Boolean); },
  render(candles, ind) {
    if (!candles?.length || !this.mainSeries) return; 
    const tv = v => ({ value: v });
    this.mainSeries.setData(candles);
    this.ema20S.setData(STATE.overlays.ema20   ? this.toSeries(ind.ema20Arr,  candles, tv) : []);
    this.ema50S.setData(STATE.overlays.ema50   ? this.toSeries(ind.ema50Arr,  candles, tv) : []);
    this.ema200S.setData(STATE.overlays.ema200 ? this.toSeries(ind.ema200Arr, candles, tv) : []);
    if (this.volS) {
      this.volS.setData(candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(76,175,125,0.4)' : 'rgba(201,64,64,0.4)' })));
    }
    this.main.timeScale().fitContent();
  }
};

// ── UI HELPERS ────────────────────────────────────────────────
const UI = {
  fmt: (n, d=2) => n == null ? '—' : Number(n).toFixed(d),
  fmtVol(n) {
    if (!n) return '—';
    if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
    if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
    if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
    return String(n);
  },
  set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; },
  toast(msg, isErr) {
    const el = document.getElementById('saveToast'); el.textContent = msg;
    el.style.borderColor = isErr ? 'var(--red-dim)' : 'var(--sheen)'; el.style.color = isErr ? 'var(--red)' : 'var(--silver)';
    el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 3500);
  },
  loading(show, msg) { document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none'; if (msg) document.getElementById('loadingText').textContent = msg; },
  workerStatus(ok, missingKeys) {
    const dot = document.getElementById('apiDot'), lbl = document.getElementById('apiLabel');
    if (ok && !missingKeys) { dot.className = 'api-dot ok';  lbl.textContent = 'Connected'; }
    else if (ok) { dot.className = 'api-dot err'; lbl.textContent = 'Missing secrets'; }
    else { dot.className = 'api-dot err'; lbl.textContent = 'Worker error'; }
  },
  showDataWarning(type, text) {
    const el = document.getElementById('dataWarning'), icon = document.getElementById('dataWarningIcon'), txt = document.getElementById('dataWarningText');
    el.className = 'data-warning ' + type; icon.textContent = type === 'failed' ? '✕' : '⚠'; txt.textContent = text; el.style.display = 'flex';
  },
  hideDataWarning() { document.getElementById('dataWarning').style.display = 'none'; },
  updateScannerMeta(data) {
    const el = document.getElementById('scannerLastRun');
    if (!el || !data?.scanDate) return;
    const scanDate = new Date(data.scanDate + 'T12:00:00Z'), completedAt = data.completedAt ? new Date(data.completedAt) : null;
    const dateStr = scanDate.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
    const timeStr = completedAt ? completedAt.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }) + ' UTC' : '';
    el.textContent = `Last scan: ${dateStr}${timeStr ? ' · ' + timeStr : ''} · ${data.scanned?.toLocaleString() || '—'} screened · ${data.phase2 || '—'} analysed`;
  },
  isStale(scanDate) {
    if (!scanDate) return false;
    return ((new Date() - new Date(scanDate + 'T12:00:00Z')) / (1000 * 60 * 60 * 24)) > 1.5; 
  },
  updateOHLCV(candles) {
    if (!candles?.length) return;
    const c = candles[candles.length-1];
    this.set('ohlc-o', '$' + this.fmt(c.open)); this.set('ohlc-h', '$' + this.fmt(c.high));
    this.set('ohlc-l', '$' + this.fmt(c.low)); this.set('ohlc-c', '$' + this.fmt(c.close));
    this.set('ohlc-v', this.fmtVol(c.volume));
    this.set('ohlc-d', new Date(c.time*1000).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }));
  },
  updateChartHeader(sym, price, changePct) {
    this.set('chartSymbol', sym); this.set('chartPrice',  price ? '$' + this.fmt(price) : '');
    const chEl = document.getElementById('chartChange');
    if (chEl) {
      if (changePct != null) { chEl.textContent = (changePct >= 0 ? '+' : '') + this.fmt(changePct) + '%'; chEl.className = 'chart-change ' + (changePct >= 0 ? 'pos' : 'neg'); } 
      else { chEl.textContent = ''; chEl.className = 'chart-change'; }
    }
  }
};

// ── APP LOGIC ─────────────────────────────────────────────────
async function loadSymbol(symbol) {
  STATE.activeSymbol = symbol;
  document.querySelectorAll('.scan-card').forEach(c => c.classList.toggle('active', c.dataset.ticker === symbol));
  if (STATE.isMobile) { const cs = document.getElementById('chartSection'); if (cs) cs.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  
  UI.loading(true, `Loading ${symbol}...`);
  try {
    const cacheKey = `${symbol}_${STATE.activeTf}`;
    if (!STATE.ohlcvCache[cacheKey]) STATE.ohlcvCache[cacheKey] = await API.aggs(symbol, STATE.activeTf);
    
    const candles = STATE.ohlcvCache[cacheKey];
    const ind = Ind.compute(candles);
    STATE.indCache[cacheKey] = ind;
    
    const pc = await API.prevClose(symbol);
    Charts.render(candles, ind);
    UI.updateOHLCV(candles);
    UI.updateChartHeader(symbol, ind.price, pc?.changePct);
  } catch (err) { UI.toast(err.message, true); }
  UI.loading(false);
}

async function loadScanResults() {
  const grid = document.getElementById('scanResultsGrid');
  try {
    const data = await API.scanResults();
    if (data.ok && data.results?.length) {
      localStorage.setItem('tsp_lastScan', JSON.stringify(data));
      STATE.lastScan = data; renderScanResults(data); return;
    }
    if (data.scanFailed) UI.showDataWarning('failed', 'Last overnight scan failed. Showing previous results. ' + (data.failReason || ''));
    if (STATE.lastScan?.results?.length) { renderScanResults(STATE.lastScan); UI.toast('Showing previous scan'); return; }
    
    grid.innerHTML = `<div class="scan-empty"><div class="scan-empty-icon">道</div><div class="scan-empty-title">No results yet</div><div class="scan-empty-sub">The scan runs at midnight UTC.</div></div>`;
  } catch (e) {
    if (STATE.lastScan?.results?.length) { renderScanResults(STATE.lastScan); UI.toast('Offline — showing last saved scan'); } 
    else { grid.innerHTML = `<div class="scan-empty"><div class="scan-empty-icon">⚠</div><div class="scan-empty-title">Connection error</div><div class="scan-empty-sub">${e.message}</div></div>`; }
  }
}

function renderScanResults(data) {
  const grid = document.getElementById('scanResultsGrid');
  UI.updateScannerMeta(data);
  if (UI.isStale(data.scanDate)) UI.showDataWarning('stale', `Data is from ${data.scanDate}. Results refresh nightly.`); else if (!data.scanFailed) UI.hideDataWarning();
  
  if (!data.results?.length) {
    grid.innerHTML = `<div class="scan-empty"><div class="scan-empty-icon">道</div><div class="scan-empty-title">No setups found</div><div class="scan-empty-sub">No tickers met criteria on ${data.scanDate}.</div></div>`; return;
  }
  
  grid.innerHTML = data.results.map((r, i) => renderScanCard(r, i)).join('');
  
  const chartSection = document.getElementById('chartSection'); if (chartSection) grid.appendChild(chartSection);
  const aiPanel = document.getElementById('aiPanelBox'); if (aiPanel) grid.appendChild(aiPanel);
  
  grid.querySelectorAll('.scan-card').forEach(card => card.addEventListener('click', () => loadSymbol(card.dataset.ticker)));
  if (!STATE.isMobile && data.results[0]) loadSymbol(data.results[0].ticker);
}

function renderScanCard(r, i) {
  const scoreClass = r.compositeScore >= 65 ? 'high' : r.compositeScore >= 45 ? 'mid' : '';
  const rrClass = r.rr >= 3 ? 'rr-good' : r.rr >= 2 ? 'rr-ok' : 'rr-low';
  
  const playType = r.signals.find(s => s.startsWith('VPA:')) || 'VPA: Continuation';
  const displayTag = playType.replace('VPA: ', '');

// Dynamic color router
  let colorClass = 'tag-grey';
  if (['Breakout', 'Breakaway Gap', 'EMA20 Breakout', 'EMA50 Breakout', 'EMA200 Breakout'].includes(displayTag)) colorClass = 'tag-green';
  else if (['Shakeout Spring', 'Gap Fill Bounce'].includes(displayTag)) colorClass = 'tag-blue';
  else if (['Stopping Vol', 'Gap Down Absorption'].includes(displayTag)) colorClass = 'tag-amber';
  else if (['The Test', 'No Supply'].includes(displayTag)) colorClass = 'tag-steel';

  return `
    <div class="scan-card" data-ticker="${r.ticker}" style="animation-delay:${i * 0.05}s">
      <div class="scan-card-header">
        <div class="scan-card-left">
          <span class="scan-rank">#${r.rank}</span>
          <span class="scan-ticker">${r.ticker}</span>
          <!-- Tooltip trigger and color class linked up here -->
          <span class="scan-play-tag ${colorClass}" onclick="showScoreTooltip('${displayTag}', event)">${displayTag}</span>
        </div>
        <div class="scan-card-right">
          <span class="scan-score-badge ${scoreClass}" onclick="showScoreTooltip('volPrice', event)">${r.compositeScore}/100</span>
        </div>
      </div>
      <div class="scan-levels">
        <div class="scan-level entry"><span class="scan-level-lbl">Entry</span><span class="scan-level-val">$${r.entry}</span></div>
        <div class="scan-level target"><span class="scan-level-lbl">Target</span><span class="scan-level-val">$${r.target}</span></div>
        <div class="scan-level stop"><span class="scan-level-lbl">Stop</span><span class="scan-level-val">$${r.stopLoss}</span></div>
      </div>
      <div class="scan-stats-row">
        <span>R:R <span class="scan-rr-val ${rrClass}">${r.rr}:1</span></span>
        <span class="scan-stat-sep">·</span>
        <span>Vol ${r.volRatio}×</span>
        <span class="scan-stat-sep">·</span>
        <span>${r.dailyReturn >= 0 ? '+' : ''}${r.dailyReturn}%</span>
      </div>
    </div>`; 
}

// ── VPA SCORE TOOLTIP & AI ────────────────────────────────────
function showScoreTooltip(key, event) {
  event.stopPropagation(); 
  const t = SCORE_TOOLTIPS[key]; if (!t) return;
  document.getElementById('scoreTooltipTitle').textContent = t.title;
  document.getElementById('scoreTooltipText').textContent  = t.text;
  document.getElementById('scoreTooltip').classList.add('open');
}
function closeScoreTooltip() { document.getElementById('scoreTooltip').classList.remove('open'); }

async function generateAISummary() {
  if (!STATE.activeSymbol) { UI.toast('Tap a result above first', true); return; }
  const cacheKey = `${STATE.activeSymbol}_${STATE.activeTf}`;
  const ind = STATE.indCache[cacheKey], candles = STATE.ohlcvCache[cacheKey];
  if (!ind || !candles || !candles.length) { UI.toast('Load chart data first', true); return; }

  const btn = document.getElementById('btnAnalyze'), content = document.getElementById('aiContent'), status = document.getElementById('aiStatus');
  btn.disabled = true; status.textContent = 'Generating...'; content.innerHTML = '<span class="ai-typing">Analysing VPA footprints...</span>';

  const overall = Ind.overall(ind);
  const currentCandle = candles[candles.length - 1];
  const spread = currentCandle.high - currentCandle.low;
  const closePos = spread > 0 ? (currentCandle.close - currentCandle.low) / spread : 0.5;
  const volRatio = ind.vol && ind.volAvg ? (ind.vol / ind.volAvg) : 1.0;
  const candleBody = currentCandle.close >= currentCandle.open ? "Green/Bullish" : "Red/Bearish";

  // Identify the exact VPA label generated by the worker to give the AI context
  const scanData = STATE.lastScan?.results?.find(r => r.ticker === STATE.activeSymbol);
  const playType = scanData?.signals?.find(s => s.startsWith('VPA:'))?.replace('VPA: ', '') || 'Setup';

  const prompt = `You are an expert technical analyst practicing Anna Coulling's Volume Price Analysis. Provide a 3-sentence institutional-grade trade thesis for ${STATE.activeSymbol} using ONLY these pure VPA parameters:

1. Effort (Volume Ratio): ${volRatio.toFixed(1)}x its 20-day average volume.
2. Result (Spread & Close): The candle is ${candleBody} with a total spread of $${UI.fmt(spread)}. It closed at the ${Math.round(closePos * 100)}% mark of its daily range (measured from absolute Low to High).
3. Structural Context: Current Close is $${UI.fmt(ind.price)} sitting relative to EMA supports (EMA20: $${UI.fmt(ind.ema20)}, EMA50: $${UI.fmt(ind.ema50)}).
4. System Classification: The scanner identified today's specific footprint as a "${playType}" anomaly in a "${overall}" macro environment.

Analyze the relationship between the Effort (volume) and Result (price spread/close position). If a Gap, Climax, Test, or Doji is flagged, explain the institutional mechanics behind it. End with a definitive directional bias and the key EMA level to watch.`;

  try {
    const result = await API.gemini(prompt);
    content.innerHTML = `<div class="ai-text">${result.text}</div>`; status.textContent = 'Analysis complete';
  } catch (e) { content.innerHTML = `<div class="ai-text" style="color:var(--red)">Error: ${e.message}</div>`; status.textContent = ''; }
  btn.disabled = false;
}

// ── INIT ──────────────────────────────────────────────────────
async function loadMarketPills() {
  for (const { sym, id } of [{ sym:'SPY', id:'spy-val' }, { sym:'QQQ', id:'qqq-val' }]) {
    try { const pc = await API.prevClose(sym); if (pc) { const el = document.getElementById(id); if (el) { el.textContent = '$' + UI.fmt(pc.price) + ' ' + (pc.changePct >= 0 ? '+' : '') + UI.fmt(pc.changePct) + '%'; el.className = 'pill-val ' + (pc.changePct >= 0 ? 'pos' : 'neg'); } } } catch {}
  }
}
async function checkWorkerHealth() {
  try {
    const h = await API.health(); UI.workerStatus(h.ok, !h.polygon || !h.gemini);
    if (h.scanFailed) UI.showDataWarning('failed', 'Last scan failed — ' + (h.failReason || 'unknown error') + '. Previous results shown if available.');
  } catch { UI.workerStatus(false, false); }
}

function init() {
  Charts.init();
  window.addEventListener('resize', () => { STATE.isMobile = window.innerWidth <= 900; });
  document.querySelectorAll('.tf-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active');
    STATE.activeTf = parseInt(btn.dataset.tf); if (STATE.activeSymbol) loadSymbol(STATE.activeSymbol);
  }));
  document.querySelectorAll('.ov-btn').forEach(btn => btn.addEventListener('click', () => {
    const ov = btn.dataset.ov; STATE.overlays[ov] = !STATE.overlays[ov]; btn.classList.toggle('active', STATE.overlays[ov]);
    const ck = STATE.activeSymbol + '_' + STATE.activeTf;
    if (STATE.ohlcvCache[ck] && STATE.indCache[ck]) Charts.render(STATE.ohlcvCache[ck], STATE.indCache[ck]);
  }));
  checkWorkerHealth(); loadScanResults(); loadMarketPills();
}

document.addEventListener('DOMContentLoaded', init);
