'use strict';
/* ============================================================
   TAOSCAN PRO — app.js  ·  Final clean version
   Auto-loads KV results on startup. No scan button.
   ============================================================ */

const WORKER_URL = 'https://taoscanpro.waddellb.workers.dev';

// ── SCORE TOOLTIP CONTENT ─────────────────────────────────────
const SCORE_TOOLTIPS = {
  M: {
    title: 'Momentum & Trigger (25%)',
    text: 'RSI is between 30 and 55 AND turned up from yesterday — a momentum hook.\n\nMACD histogram is either positive, or its negative bars have been shrinking for 2 consecutive days — selling exhaustion.\n\nHigher score = stronger hook off a lower RSI base with MACD confirming.'
  },
  T: {
    title: 'Trend & Support (25%)',
    text: 'Price is within 0.5%–2% above an upward-sloping 50-day EMA.\n\nThis identifies the high-probability zone where institutions tend to defend price — close enough to the EMA to be a dip buy, but above it confirming the trend is intact.\n\nHigher score = tighter to the EMA support level.'
  },
  V: {
    title: 'Volume Conviction (20%)',
    text: 'Current day volume versus the 20-day average volume.\n\nA reading of 1.5× or above means significantly more shares changed hands than usual — a sign that institutional money is participating, not just retail noise.\n\nHigher score = stronger volume surge above the average.'
  },
  S: {
    title: 'Volatility Squeeze (15%)',
    text: 'Bollinger Bandwidth measures how compressed price action has been.\n\nA squeeze occurs when bandwidth is in the bottom 25% of its own 20-day range — like a coiled spring before a move.\n\nHigher score = tighter consolidation, more energy stored for a potential breakout.'
  },
  Q: {
    title: 'Trend Quality (15%)',
    text: 'Three quality checks:\n\n1. Is the 50-day EMA itself sloping upward? (Filters dead cat bounces)\n2. Is price in the lower third of its 20-day range but closing strongly? (Accumulation signal)\n3. Did the stock move less than 3% today? (Avoids chasing gap-ups)\n\nHigher score = cleaner trend with no chase risk.'
  }
};

// ── STATE ─────────────────────────────────────────────────────
const STATE = {
  activeSymbol: null,
  activeTf:     30,
  overlays:     { ema20: true, ema50: true, ema200: true },
  ohlcvCache:   {},
  indCache:     {},
  lastScan:     JSON.parse(localStorage.getItem('tsp_lastScan') || 'null'),
  isMobile:     window.innerWidth <= 900
};

// ── INDICATOR MATH ────────────────────────────────────────────
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

  rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    let ag = 0, al = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i]-closes[i-1]; if(d>0) ag+=d; else al-=d; }
    ag /= period; al /= period;
    out[period] = 100 - 100 / (1 + ag / (al || 1e-10));
    for (let i = period+1; i < closes.length; i++) {
      const d = closes[i]-closes[i-1];
      ag = (ag*(period-1) + Math.max(d,0)) / period;
      al = (al*(period-1) + Math.max(-d,0)) / period;
      out[i] = 100 - 100 / (1 + ag / (al || 1e-10));
    }
    return out;
  },

  macd(closes, fast=12, slow=26, sig=9) {
    const ef = this.ema(closes, fast);
    const es = this.ema(closes, slow);
    const ml = ef.map((v,i) => (v!=null && es[i]!=null) ? v-es[i] : null);
    const sl = this.ema(ml.map(v => v??0), sig);
    const hs = ml.map((v,i) => (v!=null && sl[i]!=null) ? v-sl[i] : null);
    return { ml, sl, hs };
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
    const rsiArr    = this.rsi(closes);
    const ema20Arr  = this.ema(closes, 20);
    const ema50Arr  = this.ema(closes, 50);
    const ema200Arr = this.ema(closes, 200);
    const { ml: macdArr, sl: macdSigArr, hs: macdHistArr } = this.macd(closes);
    const volAvgArr = this.volAvg(vols);
    const n = candles.length - 1;
    return {
      price: closes[n], rsi: rsiArr[n],
      ema20: ema20Arr[n], ema50: ema50Arr[n], ema200: ema200Arr[n],
      macd: macdArr[n], macdSig: macdSigArr[n], macdHist: macdHistArr[n],
      vol: vols[n], volAvg: volAvgArr[n],
      rsiArr, ema20Arr, ema50Arr, ema200Arr, macdArr, macdSigArr, macdHistArr
    };
  },

  overall(ind) {
    let score = 0, total = 0;
    const add = (s, w) => { score += s * w; total += w; };
    if (ind.rsi != null)                         add(ind.rsi < 30 ? 1 : ind.rsi > 70 ? -1 : 0, 2);
    if (ind.price && ind.ema20)                  add(ind.price > ind.ema20  ? 1 : -1, 1);
    if (ind.price && ind.ema50)                  add(ind.price > ind.ema50  ? 1 : -1, 1);
    if (ind.price && ind.ema200)                 add(ind.price > ind.ema200 ? 1 : -1, 2);
    if (ind.macd != null && ind.macdSig != null) add(ind.macd > ind.macdSig ? 1 : -1, 1);
    const pct = total ? score / total : 0;
    if (pct > 0.25)  return 'BULLISH';
    if (pct < -0.25) return 'BEARISH';
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

  async health() {
    const res = await fetch(WORKER_URL + '/health');
    return res.json();
  },

  async scanResults() {
    const res = await fetch(WORKER_URL + '/scan');
    return res.json();
  },

  async aggs(symbol, days) {
    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days - 250);
    const from     = start.toISOString().slice(0,10);
    const to       = end.toISOString().slice(0,10);
    const timespan = days <= 10 ? 'hour' : 'day';
    const json = await this.polygon(
      `/v2/aggs/ticker/${symbol}/range/1/${timespan}/${from}/${to}`,
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
  main: null, rsi: null, macd: null,
  mainSeries: null, ema20S: null, ema50S: null, ema200S: null,
  rsiS: null, macdLineS: null, macdSigS: null, macdHistS: null,

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
    this.rsi  = LightweightCharts.createChart(g('rsiChart'),   { ...this.OPTS, width: g('rsiChart').offsetWidth,   height: g('rsiChart').offsetHeight   });
    this.macd = LightweightCharts.createChart(g('macdChart'),  { ...this.OPTS, width: g('macdChart').offsetWidth,  height: g('macdChart').offsetHeight  });

    this.mainSeries = this.main.addCandlestickSeries({ upColor:'#4caf7d', downColor:'#c94040', borderUpColor:'#4caf7d', borderDownColor:'#c94040', wickUpColor:'#4caf7d', wickDownColor:'#c94040' });
    this.ema20S  = this.main.addLineSeries({ color:'rgba(74,127,168,0.9)',  lineWidth:1, title:'EMA20'  });
    this.ema50S  = this.main.addLineSeries({ color:'rgba(200,136,42,0.8)',  lineWidth:1, title:'EMA50'  });
    this.ema200S = this.main.addLineSeries({ color:'rgba(201,64,64,0.7)',   lineWidth:1, title:'EMA200' });
    this.volS    = this.main.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      scaleMargins: { top: 0.8, bottom: 0 }
    });
    this.main.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    this.rsiS      = this.rsi.addLineSeries({ color:'#7a8fa6', lineWidth:1.5 });
    this.macdLineS = this.macd.addLineSeries({ color:'#4a7fa8', lineWidth:1.5 });
    this.macdSigS  = this.macd.addLineSeries({ color:'#c8882a', lineWidth:1.5 });
    this.macdHistS = this.macd.addHistogramSeries({ priceFormat: { type:'price', precision:4 } });

    const ro = new ResizeObserver(() => {
      if (this.main) this.main.resize(g('mainChart').offsetWidth, g('mainChart').offsetHeight);
      if (this.rsi)  this.rsi.resize(g('rsiChart').offsetWidth,   g('rsiChart').offsetHeight);
      if (this.macd) this.macd.resize(g('macdChart').offsetWidth,  g('macdChart').offsetHeight);
    });
    ['mainChart','rsiChart','macdChart'].forEach(id => ro.observe(g(id)));
  },

  toSeries(arr, candles, fn) {
    return arr.map((v,i) => (v!=null && candles[i]) ? { time:candles[i].time, ...fn(v) } : null).filter(Boolean);
  },

  render(candles, ind) {
    if (!candles?.length) return;
    if (!this.mainSeries || !this.rsiS || !this.macdLineS) return; // guard if init failed
    const tv = v => ({ value: v });
    this.mainSeries.setData(candles);
    this.ema20S.setData(STATE.overlays.ema20   ? this.toSeries(ind.ema20Arr,  candles, tv) : []);
    this.ema50S.setData(STATE.overlays.ema50   ? this.toSeries(ind.ema50Arr,  candles, tv) : []);
    this.ema200S.setData(STATE.overlays.ema200 ? this.toSeries(ind.ema200Arr, candles, tv) : []);
    // Volume histogram — green up days, red down days, bottom 20% of chart
    if (this.volS) {
      this.volS.setData(candles.map(c => ({
        time:  c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(76,175,125,0.4)' : 'rgba(201,64,64,0.4)'
      })));
    }
    this.rsiS.setData(this.toSeries(ind.rsiArr, candles, tv));
    this.macdLineS.setData(this.toSeries(ind.macdArr,    candles, tv));
    this.macdSigS.setData(this.toSeries(ind.macdSigArr,  candles, tv));
    this.macdHistS.setData(this.toSeries(ind.macdHistArr, candles, v => ({
      value: v, color: v >= 0 ? 'rgba(76,175,125,0.65)' : 'rgba(201,64,64,0.65)'
    })));
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
  setSig(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'ind-sig ' + (cls || '');
  },
  toast(msg, isErr) {
    const el = document.getElementById('saveToast');
    el.textContent = msg;
    el.style.borderColor = isErr ? 'var(--red-dim)' : 'var(--sheen)';
    el.style.color = isErr ? 'var(--red)' : 'var(--silver)';
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3500);
  },
  loading(show, msg) {
    document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none';
    if (msg) document.getElementById('loadingText').textContent = msg;
  },
  workerStatus(ok, missingKeys) {
    const dot = document.getElementById('apiDot');
    const lbl = document.getElementById('apiLabel');
    if (ok && !missingKeys) { dot.className = 'api-dot ok';  lbl.textContent = 'Connected'; }
    else if (ok)             { dot.className = 'api-dot err'; lbl.textContent = 'Missing secrets'; }
    else                     { dot.className = 'api-dot err'; lbl.textContent = 'Worker error'; }
  },

  showDataWarning(type, text) {
    const el   = document.getElementById('dataWarning');
    const icon = document.getElementById('dataWarningIcon');
    const txt  = document.getElementById('dataWarningText');
    el.className  = 'data-warning ' + type;
    icon.textContent = type === 'failed' ? '✕' : '⚠';
    txt.textContent  = text;
    el.style.display = 'flex';
  },

  hideDataWarning() {
    document.getElementById('dataWarning').style.display = 'none';
  },

  updateScannerMeta(data) {
    const el = document.getElementById('scannerLastRun');
    if (!el || !data?.scanDate) return;
    const scanDate    = new Date(data.scanDate + 'T12:00:00Z');
    const completedAt = data.completedAt ? new Date(data.completedAt) : null;
    const dateStr     = scanDate.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
    const timeStr     = completedAt ? completedAt.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }) + ' UTC' : '';
    el.textContent = `Last scan: ${dateStr}${timeStr ? ' · ' + timeStr : ''} · ${data.scanned?.toLocaleString() || '—'} stocks screened · ${data.phase2 || '—'} deep analysed`;
  },

  isStale(scanDate) {
    if (!scanDate) return false;
    const scan    = new Date(scanDate + 'T12:00:00Z');
    const now     = new Date();
    const diffMs  = now - scan;
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays > 1.5; // stale if more than 1.5 calendar days old
  },

  updateIndicators(ind) {
    const { price, rsi, ema20, ema50, ema200, macd, macdSig, macdHist, vol, volAvg } = ind;
    this.set('ib-rsi', this.fmt(rsi));
    if (rsi != null) {
      document.getElementById('rsiFill').style.width = Math.min(100, rsi) + '%';
      this.setSig('ib-rsi-sig', rsi < 30 ? 'Oversold' : rsi > 70 ? 'Overbought' : 'Neutral', rsi < 30 ? 'bull' : rsi > 70 ? 'bear' : 'neutral');
    }
    const ab = (p, e, id, sid) => {
      this.set(id, '$' + this.fmt(e));
      this.setSig(sid, p && e ? (p > e ? 'Price above' : 'Price below') : '—', p && e ? (p > e ? 'bull' : 'bear') : '');
    };
    ab(price, ema20,  'ib-ema20',  'ib-ema20-sig');
    ab(price, ema50,  'ib-ema50',  'ib-ema50-sig');
    ab(price, ema200, 'ib-ema200', 'ib-ema200-sig');
    this.set('ib-macd', this.fmt(macd, 4));
    this.setSig('ib-macd-sig', macd!=null&&macdSig!=null ? (macd>macdSig ? 'Above signal' : 'Below signal') : '—', macd!=null&&macdSig!=null ? (macd>macdSig ? 'bull' : 'bear') : '');
    this.set('ib-macdh', this.fmt(macdHist, 4));
    this.setSig('ib-macdh-sig', macdHist!=null ? (macdHist>0 ? 'Positive' : 'Negative') : '—', macdHist!=null ? (macdHist>0 ? 'bull' : 'bear') : '');
    this.set('ib-vol', this.fmtVol(vol));
    const ratio = vol && volAvg ? vol / volAvg : null;
    this.set('ib-volavg', ratio ? ratio.toFixed(2)+'×' : '—');
    if (ratio) this.setSig('ib-volavg-sig', ratio > 1.5 ? 'Volume surge' : ratio > 1 ? 'Above avg' : 'Below avg', ratio > 1.5 ? 'bull' : 'neutral');
    const ov = Ind.overall(ind);
    const ovEl = document.getElementById('overallSignal');
    if (ovEl) { ovEl.textContent = ov; ovEl.className = 'os-val ' + ov.toLowerCase(); }
    this.set('rsiCurrentVal',  this.fmt(rsi));
    this.set('macdCurrentVal', this.fmt(macd, 4));
  },

  updateOHLCV(candles) {
    if (!candles?.length) return;
    const c = candles[candles.length-1];
    this.set('ohlc-o', '$' + this.fmt(c.open));
    this.set('ohlc-h', '$' + this.fmt(c.high));
    this.set('ohlc-l', '$' + this.fmt(c.low));
    this.set('ohlc-c', '$' + this.fmt(c.close));
    this.set('ohlc-v', this.fmtVol(c.volume));
    this.set('ohlc-d', new Date(c.time*1000).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }));
  },

  updateChartHeader(sym, price, changePct) {
    this.set('chartSymbol', sym);
    this.set('chartPrice',  price ? '$' + this.fmt(price) : '');
    this.set('indSymLabel', sym);
    const chEl = document.getElementById('chartChange');
    if (chEl) {
      if (changePct != null) {
        chEl.textContent = (changePct >= 0 ? '+' : '') + this.fmt(changePct) + '%';
        chEl.className   = 'chart-change ' + (changePct >= 0 ? 'pos' : 'neg');
      } else { chEl.textContent = ''; chEl.className = 'chart-change'; }
    }
  }
};

// ── LOAD SYMBOL (chart) ───────────────────────────────────────
async function loadSymbol(symbol) {
  STATE.activeSymbol = symbol;

  // Highlight active card
  document.querySelectorAll('.scan-card').forEach(c =>
    c.classList.toggle('active', c.dataset.ticker === symbol)
  );

  // Only auto-scroll on desktop
  if (!STATE.isMobile) {
    const chartSection = document.getElementById('chartSection');
    if (chartSection) chartSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  UI.loading(true, `Loading ${symbol}...`);

  try {
    const cacheKey = `${symbol}_${STATE.activeTf}`;
    if (!STATE.ohlcvCache[cacheKey]) {
      STATE.ohlcvCache[cacheKey] = await API.aggs(symbol, STATE.activeTf);
    }
    const candles = STATE.ohlcvCache[cacheKey];
    const ind     = Ind.compute(candles);
    STATE.indCache[cacheKey] = ind;

    const pc = await API.prevClose(symbol);
    Charts.render(candles, ind);
    UI.updateIndicators(ind);
    UI.updateOHLCV(candles);
    UI.updateChartHeader(symbol, ind.price, pc?.changePct);

  } catch (err) {
    console.error(err);
    UI.toast(err.message, true);
  }

  UI.loading(false);
}

// ── AUTO-LOAD SCAN RESULTS ────────────────────────────────────
async function loadScanResults() {
  const grid = document.getElementById('scanResultsGrid');

  try {
    const data = await API.scanResults();

    if (data.ok && data.results?.length) {
      localStorage.setItem('tsp_lastScan', JSON.stringify(data));
      STATE.lastScan = data;
      renderScanResults(data);
      return;
    }

    // KV empty but scan failed flag?
    if (data.scanFailed) {
      UI.showDataWarning('failed', 'Last overnight scan failed — showing previous results if available. ' + (data.failReason || ''));
    }

    // Fall back to localStorage
    if (STATE.lastScan?.results?.length) {
      renderScanResults(STATE.lastScan);
      UI.toast('Showing previous scan · ' + (STATE.lastScan.scanDate || ''));
      return;
    }

    // Nothing yet
    grid.innerHTML = `
      <div class="scan-empty">
        <div class="scan-empty-icon">道</div>
        <div class="scan-empty-title">No results yet</div>
        <div class="scan-empty-sub">The overnight scan runs at midnight UTC.<br>Come back after 7am UK time for today's recommendations.</div>
      </div>`;

  } catch (e) {
    // Worker unreachable — fall back to localStorage
    if (STATE.lastScan?.results?.length) {
      renderScanResults(STATE.lastScan);
      UI.toast('Offline — showing last saved scan');
    } else {
      grid.innerHTML = `
        <div class="scan-empty">
          <div class="scan-empty-icon">⚠</div>
          <div class="scan-empty-title">Connection error</div>
          <div class="scan-empty-sub">${e.message}</div>
        </div>`;
    }
  }
}

// ── RENDER SCAN RESULTS ───────────────────────────────────────
function renderScanResults(data) {
  const grid = document.getElementById('scanResultsGrid');

  // Update meta subtitle
  UI.updateScannerMeta(data);

  // Stale data warning
  if (UI.isStale(data.scanDate)) {
    UI.showDataWarning('stale',
      `Scan data is from ${data.scanDate} — this may be from a previous session. Results refresh nightly at midnight UTC.`
    );
  } else if (!data.scanFailed) {
    UI.hideDataWarning();
  }

  if (!data.results?.length) {
    grid.innerHTML = `
      <div class="scan-empty">
        <div class="scan-empty-icon">道</div>
        <div class="scan-empty-title">No setups found</div>
        <div class="scan-empty-sub">No tickers met all scoring criteria on ${data.scanDate || 'last scan'}.<br>Results refresh nightly.</div>
      </div>`;
    return;
  }

  grid.innerHTML = data.results.map((r, i) => renderScanCard(r, i)).join('');

  // Click handlers
  grid.querySelectorAll('.scan-card').forEach(card => {
    card.addEventListener('click', () => loadSymbol(card.dataset.ticker));
  });

  // Auto-load top result on desktop only
  if (!STATE.isMobile && data.results[0]) {
    loadSymbol(data.results[0].ticker);
  }
}

// ── RENDER SCAN CARD ──────────────────────────────────────────
function renderScanCard(r, i) {
  const scoreClass = r.compositeScore >= 65 ? 'high' : r.compositeScore >= 45 ? 'mid' : '';
  const rrClass = r.rr >= 3 ? 'rr-good' : r.rr >= 2 ? 'rr-ok' : 'rr-low';

  const signals = (r.signals || [])
    .map(s => `<span class="scan-sig-tag">${s}</span>`)
    .join('');

  // NOTICE THE BACKTICK ON THE LINE BELOW
  return `
    <div class="scan-card" data-ticker="${r.ticker}" style="animation-delay:${i * 0.05}s">
      <div class="scan-card-header">
        <div class="scan-card-left">
          <span class="scan-rank">#${r.rank}</span>
          <span class="scan-ticker">${r.ticker}</span>
        </div>
        <div class="scan-card-right">
          <span class="scan-score-badge ${scoreClass}">${r.compositeScore}/100</span>
        </div>
      </div>

      <div class="scan-levels">
        <div class="scan-level entry">
          <span class="scan-level-lbl">Entry</span>
          <span class="scan-level-val">$${r.entry}</span>
        </div>
        <div class="scan-level target">
          <span class="scan-level-lbl">Target</span>
          <span class="scan-level-val">$${r.target}</span>
        </div>
        <div class="scan-level stop">
          <span class="scan-level-lbl">Stop</span>
          <span class="scan-level-val">$${r.stopLoss}</span>
        </div>
      </div>

      <div class="scan-stats-row">
        <span>R:R <span class="scan-rr-val ${rrClass}">${r.rr}:1</span></span>
        <span class="scan-stat-sep">·</span>
        <span>RSI ${r.rsi}</span>
        <span class="scan-stat-sep">·</span>
        <span>Vol ${r.volRatio}×</span>
        <span class="scan-stat-sep">·</span>
        <span>${r.dailyReturn >= 0 ? '+' : ''}${r.dailyReturn}%</span>
      </div>

      <div class="scan-signals">${signals}</div>
    </div>
  `; // NOTICE THE CLOSING BACKTICK AND SEMICOLON HERE
}

// ── SCORE TOOLTIP ─────────────────────────────────────────────
function showScoreTooltip(key, event) {
  event.stopPropagation(); // prevent card click loading chart
  const t = SCORE_TOOLTIPS[key];
  if (!t) return;
  document.getElementById('scoreTooltipTitle').textContent = t.title;
  document.getElementById('scoreTooltipText').textContent  = t.text;
  document.getElementById('scoreTooltip').classList.add('open');
}
function closeScoreTooltip() {
  document.getElementById('scoreTooltip').classList.remove('open');
}

// ── GEMINI AI SUMMARY ─────────────────────────────────────────
async function generateAISummary() {
  if (!STATE.activeSymbol) { UI.toast('Tap a result above first', true); return; }
  const cacheKey = `${STATE.activeSymbol}_${STATE.activeTf}`;
  const ind = STATE.indCache[cacheKey];
  if (!ind) { UI.toast('Load chart data first', true); return; }

  const btn     = document.getElementById('btnAnalyze');
  const content = document.getElementById('aiContent');
  const status  = document.getElementById('aiStatus');
  btn.disabled  = true;
  status.textContent = 'Generating...';
  content.innerHTML  = '<span class="ai-typing">Analysing indicators</span>';

  const overall = Ind.overall(ind);
  const tfLabel = STATE.activeTf <= 10 ? 'intraday' : STATE.activeTf <= 30 ? '1-month' : STATE.activeTf <= 90 ? '3-month' : '1-year';

  const prompt = `You are a sharp technical analyst. In 3 concise sentences, give a plain English trade summary for ${STATE.activeSymbol} based on these ${tfLabel} indicators:

RSI(14): ${UI.fmt(ind.rsi)} ${ind.rsi < 30 ? '(oversold)' : ind.rsi > 70 ? '(overbought)' : '(neutral range)'}
EMA20: $${UI.fmt(ind.ema20)} | EMA50: $${UI.fmt(ind.ema50)} | EMA200: $${UI.fmt(ind.ema200)}
Price: $${UI.fmt(ind.price)} — ${ind.price > (ind.ema200||0) ? 'ABOVE' : 'BELOW'} EMA200
MACD: ${UI.fmt(ind.macd,4)} vs Signal ${UI.fmt(ind.macdSig,4)} — Hist ${UI.fmt(ind.macdHist,4)}
Volume: ${UI.fmtVol(ind.vol)} vs 20-day avg ${UI.fmtVol(ind.volAvg)} = ${ind.vol&&ind.volAvg?(ind.vol/ind.volAvg).toFixed(1)+'×':'N/A'} avg
Overall composite signal: ${overall}

Be direct and specific. Mention key price levels implied by the EMAs. Note momentum direction and any divergences. End with a clear bias and key level to watch.`;

  try {
    const result = await API.gemini(prompt);
    content.innerHTML = `<div class="ai-text">${result.text}</div>`;
    status.textContent = 'Analysis complete';
  } catch (e) {
    content.innerHTML = `<div class="ai-text" style="color:var(--red)">Error: ${e.message}</div>`;
    status.textContent = '';
  }
  btn.disabled = false;
}

// ── MARKET PILLS ──────────────────────────────────────────────
async function loadMarketPills() {
  for (const { sym, id } of [{ sym:'SPY', id:'spy-val' }, { sym:'QQQ', id:'qqq-val' }]) {
    try {
      const pc = await API.prevClose(sym);
      if (pc) {
        const el = document.getElementById(id);
        if (el) {
          el.textContent = '$' + UI.fmt(pc.price) + ' ' + (pc.changePct >= 0 ? '+' : '') + UI.fmt(pc.changePct) + '%';
          el.className   = 'pill-val ' + (pc.changePct >= 0 ? 'pos' : 'neg');
        }
      }
    } catch {}
  }
}

// ── HEALTH CHECK ──────────────────────────────────────────────
async function checkWorkerHealth() {
  try {
    const h = await API.health();
    UI.workerStatus(h.ok, !h.polygon || !h.gemini);

    // Show failure warning from health endpoint
    if (h.scanFailed) {
      UI.showDataWarning('failed',
        'Last overnight scan failed — ' + (h.failReason || 'unknown error') + '. Previous results shown if available.'
      );
    }
  } catch {
    UI.workerStatus(false, false);
  }
}

// ── INIT ──────────────────────────────────────────────────────
function init() {
  Charts.init();

  // Detect mobile on resize
  window.addEventListener('resize', () => {
    STATE.isMobile = window.innerWidth <= 900;
  });

  // Timeframe buttons
  document.querySelectorAll('.tf-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    STATE.activeTf = parseInt(btn.dataset.tf);
    if (STATE.activeSymbol) loadSymbol(STATE.activeSymbol);
  }));

  // Overlay toggles
  document.querySelectorAll('.ov-btn').forEach(btn => btn.addEventListener('click', () => {
    const ov = btn.dataset.ov;
    STATE.overlays[ov] = !STATE.overlays[ov];
    btn.classList.toggle('active', STATE.overlays[ov]);
    const ck = STATE.activeSymbol + '_' + STATE.activeTf;
    if (STATE.ohlcvCache[ck] && STATE.indCache[ck]) Charts.render(STATE.ohlcvCache[ck], STATE.indCache[ck]);
  }));

  // Run on startup
  checkWorkerHealth();
  loadScanResults();
  loadMarketPills();
}

document.addEventListener('DOMContentLoaded', init);
