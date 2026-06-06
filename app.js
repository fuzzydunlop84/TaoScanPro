'use strict';
/* ============================================================
   TAOSCAN PRO — app.js
   All API calls route through your Cloudflare Worker.
   No API keys stored in the browser.
   ============================================================ */

// ── WORKER URL ────────────────────────────────────────────────
const WORKER_URL = 'https://taoscanpro.waddellb.workers.dev';

// ── STATE ─────────────────────────────────────────────────────
const STATE = {
  watchlist:    JSON.parse(localStorage.getItem('tsp_watchlist') || 'null') || ['AAPL','MSFT','NVDA','TSLA','META','AMZN','GOOGL','SPY','QQQ'],
  activeSymbol: null,
  activeTf:     30,
  overlays:     { ema20: true, ema50: true, ema200: true },
  priceCache:   {},
  ohlcvCache:   {},
  indCache:     {}
};

// ── INDICATOR MATH ────────────────────────────────────────────
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

// ── WORKER API ────────────────────────────────────────────────
const API = {
  base() {
    if (!WORKER_URL || WORKER_URL.includes('YOUR_WORKER')) {
      throw new Error('Worker URL not set — open app.js and replace WORKER_URL');
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
      throw new Error(e.error || `Polygon error ${res.status}`);
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
      throw new Error(e.error || `Gemini error ${res.status}`);
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
    if (!json.results?.length) throw new Error(json.error || `No data returned for ${symbol}`);
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

// ── CHART ENGINE ──────────────────────────────────────────────
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
    grid: {
      vertLines: { color: 'rgba(74,80,96,0.4)' },
      horzLines: { color: 'rgba(74,80,96,0.4)' }
    },
    crosshair: {
      vertLine: { color: 'rgba(122,143,166,0.5)', width: 1, style: 3 },
      horzLine: { color: 'rgba(122,143,166,0.5)', width: 1, style: 3 }
    },
    rightPriceScale: { borderColor: 'rgba(74,80,96,0.6)' },
    timeScale: { borderColor: 'rgba(74,80,96,0.6)', timeVisible: true, secondsVisible: false }
  },

  init() {
    const el = id => document.getElementById(id);
    this.main = LightweightCharts.createChart(el('mainChart'),  { ...this.OPTS, width: el('mainChart').offsetWidth,  height: el('mainChart').offsetHeight  });
    this.rsi  = LightweightCharts.createChart(el('rsiChart'),   { ...this.OPTS, width: el('rsiChart').offsetWidth,   height: el('rsiChart').offsetHeight   });
    this.macd = LightweightCharts.createChart(el('macdChart'),  { ...this.OPTS, width: el('macdChart').offsetWidth,  height: el('macdChart').offsetHeight  });

    this.mainSeries = this.main.addCandlestickSeries({
      upColor: '#4caf7d', downColor: '#c94040',
      borderUpColor: '#4caf7d
