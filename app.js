'use strict';

const WORKER_URL = 'https://taoscanpro.waddellb.workers.dev';

const STATE = {
  activeSymbol: null,
  activeTf:     30,
  overlays:     { ema20: true, ema50: true, ema200: true },
  ohlcvCache:   {},
  indCache:     {}
};

// ── INDICATOR MATH ENGINE ─────────────────────────────────────
const Ind = {
  ema(arr, period) {
    const k = 2 / (period + 1);
    const out = new Array(arr.length).fill(null);
    let sum = 0, cnt = 0;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] == null) continue;
      if (cnt < period) {
        sum += arr[i]; cnt++;
        if (cnt === period) out[i] = sum / period;
      } else {
        out[i] = arr[i] * k + out[i-1] * (1 - k);
      }
    }
    return out;
  },

  rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    let ag = 0, al = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i-1];
      if (d > 0) ag += d; else al -= d;
    }
    ag /= period; al /= period;
    out[period] = 100 - 100 / (1 + ag / (al || 1e-10));
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i-1];
      ag = (ag * (period-1) + Math.max(d, 0)) / period;
      al = (al * (period-1) + Math.max(-d, 0)) / period;
      out[i] = 100 - 100 / (1 + ag / (al || 1e-10));
    }
    return out;
  },

  macd(closes, fast=12, slow=26, sig=9) {
    const ef = this.ema(closes, fast);
    const es = this.ema(closes, slow);
    const ml = ef.map((v,i) => (v != null && es[i] != null) ? v - es[i] : null);
    const sl = this.ema(ml.map(v => v ?? 0), sig);
    const hs = ml.map((v,i) => (v != null && sl[i] != null) ? v - sl[i] : null);
    return { ml, sl, hs };
  },

  volAvg(vols, period=20) {
    const out = new Array(vols.length).fill(null);
    for (let i = period-1; i < vols.length; i++) {
      out[i] = vols.slice(i-period+1, i+1).reduce((a,b) => a+b, 0) / period;
    }
    return out;
  },

  calcATR(highs, lows, closes, period = 14) {
    const trs = [];
    for (let i = 1; i < closes.length; i++) {
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i-1]);
      const lc = Math.abs(lows[i] - closes[i-1]);
      trs.push(Math.max(hl, hc, lc));
    }
    if (trs.length < period) return trs[trs.length - 1] || 0;
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
  },

  calcBollingerBandwidth(closes, period = 20, stdDevMult = 2) {
    const bandwidthHistory = [];
    let bandwidth = null;
    for (let i = period - 1; i < closes.length; i++) {
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
      const std = Math.sqrt(variance);
      const upper = mean + stdDevMult * std;
      const lower = mean - stdDevMult * std;
      const bw = mean > 0 ? (upper - lower) / mean : 0;
      bandwidthHistory.push(bw);
      bandwidth = bw;
    }
    return { bandwidth, bandwidthHistory };
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
      rsiArr, ema20Arr, ema50Arr, ema200Arr,
      macdArr, macdSigArr, macdHistArr
    };
  },

  overall(ind) {
    let score = 0, total = 0;
    const add = (s, w) => { score += s * w; total += w; };
    if (ind.rsi != null)                        add(ind.rsi < 30 ? 1 : ind.rsi > 70 ? -1 : 0, 2);
    if (ind.price && ind.ema20)                 add(ind.price > ind.ema20  ? 1 : -1, 1);
    if (ind.price && ind.ema50)                 add(ind.price > ind.ema50  ? 1 : -1, 1);
    if (ind.price && ind.ema200)                add(ind.price > ind.ema200 ? 1 : -1, 2);
    if (ind.macd != null && ind.macdSig != null) add(ind.macd > ind.macdSig ? 1 : -1, 1);
    if (ind.vol && ind.volAvg && ind.vol > ind.volAvg * 1.5) add(0.5, 1);
    const pct = total ? score / total : 0;
    if (pct > 0.25)  return 'BULLISH';
    if (pct < -0.25) return 'BEARISH';
    return 'NEUTRAL';
  }
};

// ── WORKER BACKEND ROUTING ────────────────────────────────────
const API = {
  base() {
    if (!WORKER_URL || WORKER_URL.includes('YOUR_WORKER')) {
      throw new Error('Worker URL structural mismatch initialization string missing.');
    }
    return WORKER_URL.replace(/\/$/, '');
  },

  async polygon(path, params = {}) {
    const url = new URL(this.base() + '/polygon');
    url.searchParams.set('path', path);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `Polygon failure protocol code ${res.status}`);
    }
    return res.json();
  },

  async gemini(prompt) {
    const res = await fetch(this.base() + '/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `Gemini backend drop error status ${res.status}`);
    }
    return res.json();
  },

  async health() {
    const res = await fetch(this.base() + '/health');
    return res.json();
  },

  async aggs(symbol, days) {
    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days - 250); 
    const from     = start.toISOString().slice(0,10);
    const to       = end.toISOString().slice(0,10);
    const timespan = days <= 10 ? 'hour' : 'day';
    const path     = `/v2/aggs/ticker/${symbol}/range/1/${timespan}/${from}/${to}`;
    const json = await this.polygon(path, { adjusted: 'true', sort: 'asc', limit: '5000' });
    if (!json.results?.length) throw new Error(json.error || `Failed structural buffer for ${symbol}`);
    return json.results.map(c => ({
      time: Math.floor(c.t / 1000),
      open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v
    }));
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

// ── CHART CORE WRAPPER ENGINE ─────────────────────────────────
const Charts = {
  main: null, rsi: null, macd: null,
  mainSeries: null,
  ema20S: null, ema50S: null, ema200S: null,
  rsiS: null,
  macdLineS: null, macdSigS: null, macdHistS: null,

  OPTS: {
    layout: {
      background: { type: 'solid', color: '#0d0e10' },
      textColor: '#6b7585', fontSize: 10,
      fontFamily: "'Share Tech Mono', monospace"
    },
    grid: { vertLines: { color: 'rgba(74,80,96,0.3)' }, horzLines: { color: 'rgba(74,80,96,0.3)' } },
    crosshair: {
      vertLine: { color: 'rgba(122,143,166,0.5)', width: 1, style: 3 },
      horzLine: { color: 'rgba(122,143,166,0.5)', width: 1, style: 3 }
    },
    rightPriceScale: { borderColor: 'rgba(74,80,96,0.6)' },
    timeScale: { borderColor: 'rgba(74,80,96,0.6)', timeVisible: true }
  },

  init() {
    const el = id => document.getElementById(id);
    this.main = LightweightCharts.createChart(el('mainChart'),  { ...this.OPTS, width: el('mainChart').offsetWidth,  height: el('mainChart').offsetHeight  });
    this.rsi  = LightweightCharts.createChart(el('rsiChart'),   { ...this.OPTS, width: el('rsiChart').offsetWidth,   height: el('rsiChart').offsetHeight   });
    this.macd = LightweightCharts.createChart(el('macdChart'),  { ...this.OPTS, width: el('macdChart').offsetWidth,  height: el('macdChart').offsetHeight  });

    this.mainSeries = this.main.addCandlestickSeries({ upColor: '#4caf7d', downColor: '#c94040' });
    this.ema20S  = this.main.addLineSeries({ color: 'rgba(74,127,168,0.9)',  lineWidth: 1 });
    this.ema50S  = this.main.addLineSeries({ color: 'rgba(200,136,42,0.8)',  lineWidth: 1 });
    this.ema200S = this.main.addLineSeries({ color: 'rgba(201,64,64,0.7)',   lineWidth: 1 });
    this.rsiS       = this.rsi.addLineSeries({ color: '#7a8fa6', lineWidth: 1.5 });
    this.macdLineS  = this.macd.addLineSeries({ color: '#4a7fa8', lineWidth: 1.5 });
    this.macdSigS   = this.macd.addLineSeries({ color: '#c8882a', lineWidth: 1.5 });
    this.macdHistS  = this.macd.addHistogramSeries({ priceFormat: { type: 'price', precision: 4 } });

    const ro = new ResizeObserver(() => this.resize());
    ['mainChart','rsiChart','macdChart'].forEach(id => ro.observe(el(id)));
  },

  resize() {
    const el = id => document.getElementById(id);
    if (this.main) this.main.resize(el('mainChart').offsetWidth, el('mainChart').offsetHeight);
    if (this.rsi)  this.rsi.resize(el('rsiChart').offsetWidth,  el('rsiChart').offsetHeight);
    if (this.macd) this.macd.resize(el('macdChart').offsetWidth, el('macdChart').offsetHeight);
  },

  toSeries(arr, candles, transform) {
    return arr.map((v,i) => (v != null && candles[i]) ? { time: candles[i].time, ...transform(v) } : null).filter(Boolean);
  },

  render(candles, ind) {
    if (!candles?.length) return;
    const toVal = v => ({ value: v });
    this.mainSeries.setData(candles);
    this.ema20S.setData(STATE.overlays.ema20   ? this.toSeries(ind.ema20Arr,  candles, toVal) : []);
    this.ema50S.setData(STATE.overlays.ema50   ? this.toSeries(ind.ema50Arr,  candles, toVal) : []);
    this.ema200S.setData(STATE.overlays.ema200 ? this.toSeries(ind.ema200Arr, candles, toVal) : []);
    this.rsiS.setData(this.toSeries(ind.rsiArr, candles, toVal));
    this.macdLineS.setData(this.toSeries(ind.macdArr,    candles, toVal));
    this.macdSigS.setData(this.toSeries(ind.macdSigArr,  candles, toVal));
    this.macdHistS.setData(this.toSeries(ind.macdHistArr, candles, v => ({
      value: v, color: v >= 0 ? 'rgba(76,175,125,0.65)' : 'rgba(201,64,64,0.65)'
    })));
    this.main.timeScale().fitContent();
  }
};

// ── INTERFACE LAYER CONTROL ───────────────────────────────────
const UI = {
  fmt: (n, d=2) => n == null ? '—' : Number(n).toFixed(d),
  fmtVol(n) {
    if (!n) return '—';
    if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
    if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
    return String(n);
  },
  set(id, val)     { const el = document.getElementById(id); if (el) el.textContent = val; },
  setSig(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'ind-sig ' + (cls || '');
  },
  toast(msg, isError) {
    const el = document.getElementById('saveToast');
    el.textContent = msg;
    el.style.borderColor = isError ? 'var(--red-dim)' : 'var(--sheen)';
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
  },
  workerStatus(ok, missing) {
    const dot = document.getElementById('apiDot');
    const lbl = document.getElementById('apiLabel');
    if (ok && !missing) { dot.className = 'api-dot ok';  lbl.textContent = 'Connected'; }
    else { dot.className = 'api-dot err'; lbl.textContent = 'Error/Missing'; }
  },

  updateIndicators(ind) {
    const { price, rsi, ema20, ema50, ema200, macd, macdSig, macdHist, vol, volAvg } = ind;
    this.set('ib-rsi', this.fmt(rsi));
    if (rsi != null) {
      document.getElementById('rsiFill').style.width = Math.min(100, rsi) + '%';
      this.setSig('ib-rsi-sig', rsi < 30 ? 'Oversold' : rsi > 70 ? 'Overbought' : 'Neutral', rsi < 30 ? 'bull' : rsi > 70 ? 'bear' : 'neutral');
    }
    const aboveBelow = (p, e, id, sigId) => {
      this.set(id, '$' + this.fmt(e));
      this.setSig(sigId, p && e ? (p > e ? 'Price above' : 'Price below') : '—', p && e ? (p > e ? 'bull' : 'bear') : '');
    };
    aboveBelow(price, ema20,  'ib-ema20',  'ib-ema20-sig');
    aboveBelow(price, ema50,  'ib-ema50',  'ib-ema50-sig');
    aboveBelow(price, ema200, 'ib-ema200', 'ib-ema200-sig');

    this.set('ib-macd', this.fmt(macd, 4));
    this.setSig('ib-macd-sig', macd > macdSig ? 'Above — bull' : 'Below — bear', macd > macdSig ? 'bull' : 'bear');
    this.set('ib-macdh', this.fmt(macdHist, 4));
    this.setSig('ib-macdh-sig', macdHist > 0 ? 'Positive' : 'Negative', macdHist > 0 ? 'bull' : 'bear');
    this.set('ib-vol', this.fmtVol(vol));
    
    const ratio = vol && volAvg ? vol / volAvg : null;
    this.set('ib-volavg', ratio ? ratio.toFixed(2) + '×' : '—');
    
    const ov = Ind.overall(ind);
    const ovEl = document.getElementById('overallSignal');
    if (ovEl) { ovEl.textContent = ov; ovEl.className = 'os-val ' + ov.toLowerCase(); }
    this.set('rsiCurrentVal', this.fmt(rsi));
    this.set('macdCurrentVal', this.fmt(macd, 4));
  },

  updateChartHeader(sym, price, changePct) {
    this.set('chartSymbol', sym);
    this.set('chartPrice',  price ? '$' + this.fmt(price) : '');
    this.set('indSymLabel', sym);
    const chEl = document.getElementById('chartChange');
    if (chEl && changePct != null) {
      chEl.textContent = (changePct >= 0 ? '+' : '') + this.fmt(changePct) + '%';
      chEl.className   = 'chart-change ' + (changePct >= 0 ? 'pos' : 'neg');
    }
  }
};

// ── CORE SYMBOL MOUNT ROUTINE ──────────────────────────────────
async function loadSymbol(symbol) {
  STATE.activeSymbol = symbol;
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
    UI.updateChartHeader(symbol, ind.price, pc?.changePct);
  } catch (err) {
    UI.toast(err.message, true);
  }
}

// ── CLIENT-SIDE SCAN ENGINES ──────────────────────────────────
async function runAutonomousScan() {
  const btn         = document.getElementById('btnRunScan');
  const textEl      = document.getElementById('runScanText');
  const progress    = document.getElementById('scannerProgress');
  const fillEl      = document.getElementById('progressFill');
  const labelEl     = document.getElementById('progressLabel');
  const subLabelEl  = document.getElementById('progressSubLabel');
  const results     = document.getElementById('scannerResults');
  const metaEl      = document.getElementById('scannerMeta');

  btn.disabled = true; textEl.style.opacity = '0'; progress.style.display = 'block';
  results.innerHTML = ''; fillEl.style.width = '5%';
  labelEl.textContent = 'Requesting snapshot...';

  try {
    const scanResponse = await fetch(`${WORKER_URL}/scan`);
    const scanData     = await scanResponse.json();
    if (scanData.error) throw new Error(scanData.error);

    const top20 = scanData.results || [];
    if (!top20.length) {
      results.innerHTML = '<div class="dashboard-empty">No trading market files compiled.</div>';
      return;
    }

    const histories = {};
    const batchSize = 5;
    const endObj = new Date(scanData.scanDate + 'T12:00:00Z');
    const startObj = new Date(endObj.getTime());
    startObj.setUTCDate(startObj.getUTCDate() - 120);

    const formatDateStr = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    const startDate = formatDateStr(startObj);
    const endDate = scanData.scanDate;

    for (let i = 0; i < top20.length; i += batchSize) {
      const currentBatch = top20.slice(i, i + batchSize);
      labelEl.textContent = `Batch execution run ${Math.floor(i/batchSize)+1}...`;
      fillEl.style.width = (10 + (i / top20.length) * 80) + '%';

      await Promise.all(currentBatch.map(async (candidate) => {
        try {
          const path = `/v2/aggs/ticker/${candidate.ticker}/range/1/day/${startDate}/${endDate}`;
          const hData = await API.polygon(path, { adjusted: 'true', sort: 'asc', limit: '150' });
          if (hData?.results?.length >= 20) histories[candidate.ticker] = hData.results;
        } catch {}
      }));

      if (i + batchSize < top20.length) await new Promise(r => setTimeout(r, 2000));
    }

    // Mathematical loop mapping overlays matrix variables
    const finalScored = [];
    for (const candidate of top20) {
      const hist = histories[candidate.ticker];
      if (!hist || hist.length < 30) continue;

      const closes = hist.map(d => d.c);
      const highs = hist.map(d => d.h);
      const lows = hist.map(d => d.l);
      const n = closes.length - 1;

      const ema50arr = Ind.ema(closes, 50);
      const ema50 = ema50arr[n];
      const ema50Slope = ema50 && ema50arr[n-1] ? (ema50 - ema50arr[n-1]) / ema50arr[n-1] * 100 : 0;
      const rsiArr = Ind.rsi(closes, 14);
      const rsi = rsiArr[n];
      const { hs: histogram } = Ind.macd(closes, 12, 26, 9);
      const macdHist = histogram[n];
      const { bandwidth } = Ind.calcBollingerBandwidth(closes, 20, 2);
      const vol20 = hist.slice(Math.max(0, n - 19)).reduce((a, b) => a + b.v, 0) / 20;
      const volRatio = candidate.volume / vol20;

      // Composite weight allocation strategy
      let score = 50; 
      if (rsi >= 30 && rsi <= 55 && rsi > rsiArr[n-1]) score += 15;
      if (macdHist > 0) score += 15;
      if (ema50Slope > 0) score += 10;
      if (volRatio > 1.5) score += 10;

      finalScored.push({
        ticker: candidate.ticker, close: candidate.close, rsi, volRatio, ema50, bandwidth,
        swingLow5: Math.min(...lows.slice(Math.max(0, n - 4))),
        resistance20: Math.max(...highs.slice(Math.max(0, n - 19), n)),
        atr14: Ind.calcATR(highs, lows, closes, 14),
        compositeScore: Math.min(100, score)
      });
    }

    finalScored.sort((a,b) => b.compositeScore - a.compositeScore);
    const top10 = finalScored.slice(0, 10);

    metaEl.textContent = `${scanData.scanned?.toLocaleString()} scanned · ${top10.length} setups compiled · ${scanData.scanDate}`;
    results.innerHTML = top10.map((s, i) => {
      const entry = s.close;
      const stopLoss = (entry - s.swingLow5) / entry * 100 <= 8 ? s.swingLow5 : entry - (s.atr14 * 1.5);
      const target = s.resistance20 > entry ? s.resistance20 : entry + ((entry - stopLoss) * 2);
      const rr = (target - entry) / (entry - stopLoss || 1);

      return `
        <div class="scan-card" data-ticker="${s.ticker}">
          <div class="scan-card-top">
            <span class="scan-ticker">#${i+1} ${s.ticker}</span>
            <span class="scan-score">${s.compositeScore}</span>
          </div>
          <div class="scan-levels">
            <div class="scan-level"><span>Entry</span><strong>$${entry.toFixed(2)}</strong></div>
            <div class="scan-level"><span>Target</span><strong>$${target.toFixed(2)}</strong></div>
            <div class="scan-level"><span>Stop</span><strong>$${stopLoss.toFixed(2)}</strong></div>
          </div>
          <div class="scan-rr">R:R <span>${rr.toFixed(1)}:1</span> · Vol Ratio <span>${s.volRatio.toFixed(1)}×</span></div>
        </div>`;
    }).join('');

    results.querySelectorAll('.scan-card').forEach(card => {
      card.addEventListener('click', () => loadSymbol(card.dataset.ticker));
    });

  } catch (e) {
    results.innerHTML = `<div class="dashboard-empty" style="color:var(--red)">Scan structural error: ${e.message}</div>`;
  }

  fillEl.style.width = '100%';
  setTimeout(() => { progress.style.display = 'none'; }, 1000);
  btn.disabled = false; textEl.style.opacity = '1';
}

// ── GEMINI INSIGHTS GENERATION ────────────────────────────────
async function generateAISummary() {
  if (!STATE.activeSymbol) return UI.toast('Select a setup ticker target first', true);
  const cacheKey = `${STATE.activeSymbol}_${STATE.activeTf}`;
  const ind = STATE.indCache[cacheKey];
  if (!ind) return UI.toast('Initialize system technical arrays first', true);

  const btn = document.getElementById('btnAnalyze');
  const content = document.getElementById('aiContent');
  btn.disabled = true; content.innerHTML = '<span class="ai-typing">Analyzing indicators matrix...</span>';

  const prompt = `Give a technical analysis brief summary for ${STATE.activeSymbol}. Close: $${ind.price}, RSI: ${ind.rsi.toFixed(1)}, MACD Hist: ${ind.macdHist.toFixed(4)}. Keep under three sentences. Outline the clear momentum direction bias.`;

  try {
    const result = await API.gemini(prompt);
    content.innerHTML = `<div class="ai-text">${result.text}</div>`;
  } catch (e) {
    content.innerHTML = `<div class="ai-text" style="color:var(--red)">Error processing prompt payload.</div>`;
  }
  btn.disabled = false;
}

async function loadMarketPills() {
  for (const sym of ['SPY', 'QQQ']) {
    const pc = await API.prevClose(sym);
    if (pc) {
      const el = document.getElementById(`${sym.toLowerCase()}-val`);
      if (el) el.textContent = `$${pc.price.toFixed(2)} (${pc.changePct >= 0 ? '+' : ''}${pc.changePct.toFixed(2)}%)`;
    }
  }
}

function openSettings()  { document.getElementById('settingsModal').classList.add('open'); }
function closeSettings() { document.getElementById('settingsModal').classList.remove('open'); }

function init() {
  Charts.init();
  loadMarketPills();
}
document.addEventListener('DOMContentLoaded', init);
