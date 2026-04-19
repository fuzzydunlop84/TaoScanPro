'use strict';
/* ============================================================
   TAOSCAN PRO — app.js
   Polygon.io OHLCV · Client-side RSI/EMA/MACD/Volume
   TradingView Lightweight Charts · Gemini AI summaries
   ============================================================ */

// ── CONFIG ────────────────────────────────────────────────────
const CONFIG = {
  load() {
    this.polygonKey = localStorage.getItem('tsp_polygon') || '';
    this.geminiKey  = localStorage.getItem('tsp_gemini') || '';
    this.proxyUrl   = localStorage.getItem('tsp_proxy') || '';
  },
  save(poly, gemini, proxy) {
    localStorage.setItem('tsp_polygon', poly);
    localStorage.setItem('tsp_gemini', gemini);
    localStorage.setItem('tsp_proxy', proxy);
    this.polygonKey = poly;
    this.geminiKey  = gemini;
    this.proxyUrl   = proxy;
  },
  polygonKey: '', geminiKey: '', proxyUrl: ''
};
CONFIG.load();

// ── STATE ─────────────────────────────────────────────────────
const STATE = {
  watchlist:     JSON.parse(localStorage.getItem('tsp_watchlist') || 'null') || ['AAPL','MSFT','NVDA','TSLA','META','AMZN','GOOGL','SPY','QQQ'],
  activeSymbol:  null,
  activeTf:      30,
  overlays:      { ema20: true, ema50: true, ema200: true },
  priceCache:    {},
  ohlcvCache:    {},
  indCache:      {}
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
      const s = vols.slice(i-period+1, i+1).reduce((a,b) => a+b, 0);
      out[i] = s / period;
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
      price:    closes[n],
      rsi:      rsiArr[n],
      ema20:    ema20Arr[n],
      ema50:    ema50Arr[n],
      ema200:   ema200Arr[n],
      macd:     macdArr[n],
      macdSig:  macdSigArr[n],
      macdHist: macdHistArr[n],
      vol:      vols[n],
      volAvg:   volAvgArr[n],
      // arrays for charts
      rsiArr, ema20Arr, ema50Arr, ema200Arr,
      macdArr, macdSigArr, macdHistArr
    };
  },

  overall(ind) {
    let score = 0, total = 0;
    const add = (s, w) => { score += s * w; total += w; };
    if (ind.rsi != null) {
      add(ind.rsi < 30 ? 1 : ind.rsi > 70 ? -1 : 0, 2);
    }
    if (ind.price && ind.ema20) add(ind.price > ind.ema20 ? 1 : -1, 1);
    if (ind.price && ind.ema50) add(ind.price > ind.ema50 ? 1 : -1, 1);
    if (ind.price && ind.ema200) add(ind.price > ind.ema200 ? 1 : -1, 2);
    if (ind.macd != null && ind.macdSig != null) add(ind.macd > ind.macdSig ? 1 : -1, 1);
    if (ind.vol && ind.volAvg && ind.vol > ind.volAvg * 1.5) add(0.5, 1);
    const pct = total ? score / total : 0;
    if (pct > 0.25) return 'BULLISH';
    if (pct < -0.25) return 'BEARISH';
    return 'NEUTRAL';
  }
};

// ── POLYGON API ───────────────────────────────────────────────
const Poly = {
  base: 'https://api.polygon.io',

  url(path, params = {}) {
    if (!CONFIG.polygonKey) throw new Error('No Polygon API key — open Settings');
    const u = new URL(this.base + path);
    u.searchParams.set('apiKey', CONFIG.polygonKey);
    Object.entries(params).forEach(([k,v]) => u.searchParams.set(k, v));
    if (CONFIG.proxyUrl) {
      return CONFIG.proxyUrl.replace(/\/$/, '') + '?target=' + encodeURIComponent(u.toString());
    }
    return u.toString();
  },

  async aggs(symbol, days) {
    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days - 250); // extra warmup for EMA200
    const from = start.toISOString().slice(0,10);
    const to   = end.toISOString().slice(0,10);
    const timespan = days <= 10 ? 'hour' : 'day';
    const path = `/v2/aggs/ticker/${symbol}/range/1/${timespan}/${from}/${to}`;
    const r = await fetch(this.url(path, { adjusted: 'true', sort: 'asc', limit: 5000 }));
    if (!r.ok) throw new Error(`Polygon ${r.status}: ${r.statusText}`);
    const j = await r.json();
    if (!j.results?.length) throw new Error(j.error || `No data for ${symbol}`);
    return j.results.map(c => ({
      time:   Math.floor(c.t / 1000),
      open:   c.o, high: c.h, low: c.l, close: c.c, volume: c.v
    }));
  },

  async prevClose(symbol) {
    try {
      const r = await fetch(this.url(`/v2/aggs/ticker/${symbol}/prev`));
      const j = await r.json();
      const d = j.results?.[0];
      if (!d) return null;
      const changePct = ((d.c - d.o) / d.o) * 100;
      return { price: d.c, changePct };
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
      textColor: '#6b7585',
      fontSize: 10,
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
    const mainEl = document.getElementById('mainChart');
    const rsiEl  = document.getElementById('rsiChart');
    const macdEl = document.getElementById('macdChart');

    this.main = LightweightCharts.createChart(mainEl, {
      ...this.OPTS, width: mainEl.offsetWidth, height: mainEl.offsetHeight
    });
    this.rsi = LightweightCharts.createChart(rsiEl, {
      ...this.OPTS, width: rsiEl.offsetWidth, height: rsiEl.offsetHeight
    });
    this.macd = LightweightCharts.createChart(macdEl, {
      ...this.OPTS, width: macdEl.offsetWidth, height: macdEl.offsetHeight
    });

    // Candles — green/red matching TaoScan signal colors
    this.mainSeries = this.main.addCandlestickSeries({
      upColor:        '#4caf7d', downColor:       '#c94040',
      borderUpColor:  '#4caf7d', borderDownColor: '#c94040',
      wickUpColor:    '#4caf7d', wickDownColor:   '#c94040'
    });

    // EMA overlays — blue (TaoScan blue)
    this.ema20S  = this.main.addLineSeries({ color: 'rgba(74,127,168,0.9)',  lineWidth: 1, title: 'EMA20' });
    this.ema50S  = this.main.addLineSeries({ color: 'rgba(200,136,42,0.8)',  lineWidth: 1, title: 'EMA50' });
    this.ema200S = this.main.addLineSeries({ color: 'rgba(201,64,64,0.7)',   lineWidth: 1, title: 'EMA200' });

    // RSI
    this.rsiS = this.rsi.addLineSeries({ color: '#7a8fa6', lineWidth: 1.5 });

    // MACD
    this.macdLineS = this.macd.addLineSeries({ color: '#4a7fa8', lineWidth: 1.5, title: 'MACD' });
    this.macdSigS  = this.macd.addLineSeries({ color: '#c8882a', lineWidth: 1.5, title: 'Signal' });
    this.macdHistS = this.macd.addHistogramSeries({ priceFormat: { type: 'price', precision: 4 } });

    // Resize observer
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(mainEl); ro.observe(rsiEl); ro.observe(macdEl);
  },

  resize() {
    const mainEl = document.getElementById('mainChart');
    const rsiEl  = document.getElementById('rsiChart');
    const macdEl = document.getElementById('macdChart');
    if (this.main) this.main.resize(mainEl.offsetWidth, mainEl.offsetHeight);
    if (this.rsi)  this.rsi.resize(rsiEl.offsetWidth,  rsiEl.offsetHeight);
    if (this.macd) this.macd.resize(macdEl.offsetWidth, macdEl.offsetHeight);
  },

  toSeries(arr, candles, transform) {
    return arr
      .map((v, i) => (v != null && candles[i]) ? { time: candles[i].time, ...transform(v) } : null)
      .filter(Boolean);
  },

  render(candles, ind) {
    if (!candles?.length) return;
    this.mainSeries.setData(candles);

    const toVal = v => ({ value: v });
    this.ema20S.setData(STATE.overlays.ema20  ? this.toSeries(ind.ema20Arr,  candles, toVal) : []);
    this.ema50S.setData(STATE.overlays.ema50  ? this.toSeries(ind.ema50Arr,  candles, toVal) : []);
    this.ema200S.setData(STATE.overlays.ema200 ? this.toSeries(ind.ema200Arr, candles, toVal) : []);

    this.rsiS.setData(this.toSeries(ind.rsiArr, candles, toVal));

    this.macdLineS.setData(this.toSeries(ind.macdArr,    candles, toVal));
    this.macdSigS.setData(this.toSeries(ind.macdSigArr,  candles, toVal));
    this.macdHistS.setData(this.toSeries(ind.macdHistArr, candles, v => ({
      value: v,
      color: v >= 0 ? 'rgba(76,175,125,0.65)' : 'rgba(201,64,64,0.65)'
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

  set(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  },

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
    el.style.color = isError ? 'var(--red)' : 'var(--silver)';
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
  },

  loading(show, msg) {
    document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none';
    if (msg) document.getElementById('loadingText').textContent = msg;
  },

  apiStatus(ok) {
    const dot = document.getElementById('apiDot');
    const lbl = document.getElementById('apiLabel');
    dot.className = 'api-dot ' + (ok ? 'ok' : (CONFIG.polygonKey ? 'err' : ''));
    lbl.textContent = ok ? 'Connected' : CONFIG.polygonKey ? 'API Error' : 'No Key';
  },

  updateIndicators(ind) {
    if (!ind) return;
    const { price, rsi, ema20, ema50, ema200, macd, macdSig, macdHist, vol, volAvg } = ind;

    this.set('ib-rsi', this.fmt(rsi));
    if (rsi != null) {
      document.getElementById('rsiFill').style.width = Math.min(100, rsi) + '%';
      const sig = rsi < 30 ? 'Oversold' : rsi > 70 ? 'Overbought' : 'Neutral';
      const cls = rsi < 30 ? 'bull' : rsi > 70 ? 'bear' : 'neutral';
      this.setSig('ib-rsi-sig', sig, cls);
    }

    this.set('ib-ema20',  '$' + this.fmt(ema20));
    this.setSig('ib-ema20-sig', price && ema20 ? (price > ema20 ? 'Price above' : 'Price below') : '—',
      price && ema20 ? (price > ema20 ? 'bull' : 'bear') : '');

    this.set('ib-ema50',  '$' + this.fmt(ema50));
    this.setSig('ib-ema50-sig', price && ema50 ? (price > ema50 ? 'Price above' : 'Price below') : '—',
      price && ema50 ? (price > ema50 ? 'bull' : 'bear') : '');

    this.set('ib-ema200', '$' + this.fmt(ema200));
    this.setSig('ib-ema200-sig', price && ema200 ? (price > ema200 ? 'Price above' : 'Price below') : '—',
      price && ema200 ? (price > ema200 ? 'bull' : 'bear') : '');

    this.set('ib-macd',  this.fmt(macd, 4));
    this.setSig('ib-macd-sig', macd != null && macdSig != null
      ? (macd > macdSig ? 'Above signal — bull' : 'Below signal — bear') : '—',
      macd != null && macdSig != null ? (macd > macdSig ? 'bull' : 'bear') : '');

    this.set('ib-macdh', this.fmt(macdHist, 4));
    this.setSig('ib-macdh-sig', macdHist != null
      ? (macdHist > 0 ? 'Positive' : 'Negative') : '—',
      macdHist != null ? (macdHist > 0 ? 'bull' : 'bear') : '');

    this.set('ib-vol',    this.fmtVol(vol));
    this.setSig('ib-vol-sig', '—', '');

    const ratio = vol && volAvg ? vol / volAvg : null;
    this.set('ib-volavg', ratio ? ratio.toFixed(2) + '×' : '—');
    if (ratio) {
      const sig = ratio > 1.5 ? 'Volume surge' : ratio > 1 ? 'Above average' : 'Below average';
      this.setSig('ib-volavg-sig', sig, ratio > 1.5 ? 'bull' : 'neutral');
    }

    const ov = Ind.overall(ind);
    const ovEl = document.getElementById('overallSignal');
    if (ovEl) {
      ovEl.textContent = ov;
      ovEl.className = 'os-val ' + ov.toLowerCase();
    }

    // sub-chart vals
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
    this.set('ohlc-d', new Date(c.time * 1000).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}));
  },

  updateChartHeader(sym, price, changePct) {
    this.set('chartSymbol', sym);
    this.set('chartPrice',  price ? '$' + this.fmt(price) : '');
    this.set('indSymLabel', sym);
    const chEl = document.getElementById('chartChange');
    if (chEl) {
      if (changePct != null) {
        const s = changePct >= 0 ? '+' : '';
        chEl.textContent = s + this.fmt(changePct) + '%';
        chEl.className = 'chart-change ' + (changePct >= 0 ? 'pos' : 'neg');
      } else {
        chEl.textContent = '';
        chEl.className = 'chart-change';
      }
    }
  },

  renderWatchlist() {
    const list = document.getElementById('tickerList');
    list.innerHTML = '';
    STATE.watchlist.forEach(sym => {
      const pc = STATE.priceCache[sym];
      const priceStr = pc ? '$' + this.fmt(pc.price) : '—';
      const chgStr   = pc ? (pc.changePct >= 0 ? '+' : '') + this.fmt(pc.changePct) + '%' : '—';
      const chgClass = pc ? (pc.changePct >= 0 ? 'pos' : 'neg') : '';

      const row = document.createElement('div');
      row.className = 'ticker-row' + (sym === STATE.activeSymbol ? ' active' : '');
      row.innerHTML = `
        <span class="tr-sym">${sym}</span>
        <span class="tr-price">${priceStr}</span>
        <span class="tr-chg ${chgClass}">${chgStr}</span>
        <button class="tr-del" data-sym="${sym}" title="Remove">✕</button>
      `;
      row.addEventListener('click', e => {
        if (e.target.classList.contains('tr-del')) {
          removeFromWatchlist(e.target.dataset.sym);
        } else {
          loadSymbol(sym);
        }
      });
      list.appendChild(row);
    });
  }
};

// ── LOAD SYMBOL ───────────────────────────────────────────────
async function loadSymbol(symbol) {
  if (!CONFIG.polygonKey) {
    openSettings();
    UI.toast('Add your Polygon.io API key first', true);
    return;
  }

  STATE.activeSymbol = symbol;
  UI.renderWatchlist();
  UI.loading(true, `Fetching ${symbol}...`);

  try {
    const cacheKey = `${symbol}_${STATE.activeTf}`;

    if (!STATE.ohlcvCache[cacheKey]) {
      const candles = await Poly.aggs(symbol, STATE.activeTf);
      STATE.ohlcvCache[cacheKey] = candles;
    }

    const candles = STATE.ohlcvCache[cacheKey];
    const ind = Ind.compute(candles);
    STATE.indCache[cacheKey] = ind;

    if (!STATE.priceCache[symbol]) {
      const pc = await Poly.prevClose(symbol);
      if (pc) STATE.priceCache[symbol] = pc;
    }
    const pc = STATE.priceCache[symbol];

    Charts.render(candles, ind);
    UI.updateIndicators(ind);
    UI.updateOHLCV(candles);
    UI.updateChartHeader(symbol, ind.price, pc?.changePct);
    UI.renderWatchlist();
    UI.apiStatus(true);

  } catch (err) {
    console.error(err);
    UI.toast(err.message, true);
    UI.apiStatus(false);
  }

  UI.loading(false);
}

// ── WATCHLIST ─────────────────────────────────────────────────
function addToWatchlist(sym) {
  sym = sym.trim().toUpperCase().replace(/[^A-Z.]/g, '');
  if (!sym || STATE.watchlist.includes(sym)) return;
  STATE.watchlist.push(sym);
  saveWatchlist();
  UI.renderWatchlist();
}

function removeFromWatchlist(sym) {
  STATE.watchlist = STATE.watchlist.filter(s => s !== sym);
  if (STATE.activeSymbol === sym) {
    STATE.activeSymbol = null;
    UI.updateChartHeader('Select a ticker', null, null);
  }
  saveWatchlist();
  UI.renderWatchlist();
}

function saveWatchlist() {
  localStorage.setItem('tsp_watchlist', JSON.stringify(STATE.watchlist));
}

// ── SCREENER SCAN ─────────────────────────────────────────────
async function runScreenerScan() {
  if (!CONFIG.polygonKey) { openSettings(); return; }
  const preset  = document.getElementById('scanPreset').value;
  const btn     = document.getElementById('btnScan');
  const textEl  = document.getElementById('scanBtnText');
  btn.disabled  = true;
  btn.classList.add('loading');
  textEl.style.opacity = '0';

  const results = [];

  for (const sym of STATE.watchlist) {
    try {
      const cacheKey = `${sym}_${STATE.activeTf}`;
      if (!STATE.ohlcvCache[cacheKey]) {
        const candles = await Poly.aggs(sym, STATE.activeTf);
        STATE.ohlcvCache[cacheKey] = candles;
        await new Promise(r => setTimeout(r, 250)); // free tier rate limit
      }
      const candles = STATE.ohlcvCache[cacheKey];
      if (!candles?.length) continue;
      const ind = Ind.compute(candles);
      STATE.indCache[cacheKey] = ind;

      let match = false, label = '', type = '', val = '';
      switch (preset) {
        case 'rsi_oversold':
          if (ind.rsi < 30) { match=true; label='OVERSOLD'; type='bull'; val='RSI '+UI.fmt(ind.rsi); } break;
        case 'rsi_overbought':
          if (ind.rsi > 70) { match=true; label='OVERBOUGHT'; type='bear'; val='RSI '+UI.fmt(ind.rsi); } break;
        case 'macd_bullish':
          if (ind.macd > ind.macdSig) { match=true; label='MACD BULL'; type='bull'; val=UI.fmt(ind.macdHist,4); } break;
        case 'macd_bearish':
          if (ind.macd < ind.macdSig) { match=true; label='MACD BEAR'; type='bear'; val=UI.fmt(ind.macdHist,4); } break;
        case 'above_ema20':
          if (ind.price > ind.ema20) { match=true; label='> EMA20'; type='bull'; val='+'+((ind.price/ind.ema20-1)*100).toFixed(1)+'%'; } break;
        case 'below_ema20':
          if (ind.price < ind.ema20) { match=true; label='< EMA20'; type='bear'; val=((ind.price/ind.ema20-1)*100).toFixed(1)+'%'; } break;
        case 'volume_surge':
          if (ind.vol > ind.volAvg * 1.5) { match=true; label='VOL SURGE'; type='bull'; val=(ind.vol/ind.volAvg).toFixed(1)+'× avg'; } break;
        case 'golden_cross':
          if (ind.ema20 > ind.ema50 && ind.price > ind.ema200) { match=true; label='GOLDEN ✕'; type='bull'; val='EMA20>EMA50'; } break;
      }
      if (match) results.push({ sym, label, type, val });
    } catch (e) { console.warn(sym, e.message); }
  }

  const container = document.getElementById('scanResults');
  document.getElementById('scanCount').textContent = results.length + ' matches';
  container.innerHTML = '';
  if (!results.length) {
    container.innerHTML = '<div class="sidebar-empty">No matches in watchlist.</div>';
  } else {
    results.forEach(r => {
      const row = document.createElement('div');
      row.className = 'scan-result-row';
      row.innerHTML = `
        <span class="srr-sym">${r.sym}</span>
        <span class="srr-badge ${r.type}">${r.label}</span>
        <span class="srr-val">${r.val}</span>
      `;
      row.addEventListener('click', () => loadSymbol(r.sym));
      container.appendChild(row);
    });
  }

  btn.disabled = false;
  btn.classList.remove('loading');
  textEl.style.opacity = '1';
}

// ── GEMINI AI SUMMARY ─────────────────────────────────────────
async function generateAISummary() {
  if (!STATE.activeSymbol) {
    UI.toast('Select a ticker first', true); return;
  }
  if (!CONFIG.geminiKey) {
    openSettings();
    UI.toast('Add your Gemini API key in Settings', true);
    return;
  }

  const cacheKey = `${STATE.activeSymbol}_${STATE.activeTf}`;
  const ind = STATE.indCache[cacheKey];
  if (!ind) { UI.toast('Load chart data first', true); return; }

  const btn = document.getElementById('btnAnalyze');
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
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${CONFIG.geminiKey}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: 300
        }
      })
    });
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.error?.message || 'Gemini error ' + res.status);
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
    content.innerHTML = `<div class="ai-text">${text}</div>`;
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
      const pc = await Poly.prevClose(sym);
      if (pc) {
        const el = document.getElementById(id);
        const pill = el?.closest('.market-pill');
        if (el) {
          const s = pc.changePct >= 0 ? '+' : '';
          el.textContent = '$' + UI.fmt(pc.price) + ' ' + s + UI.fmt(pc.changePct) + '%';
          el.className = 'pill-val ' + (pc.changePct >= 0 ? 'pos' : 'neg');
        }
      }
    } catch {}
  }
}

// ── SETTINGS ─────────────────────────────────────────────────
function openSettings() {
  document.getElementById('polygonKey').value = CONFIG.polygonKey;
  document.getElementById('geminiKey').value  = CONFIG.geminiKey;
  document.getElementById('proxyUrl').value   = CONFIG.proxyUrl;
  document.getElementById('settingsModal').classList.add('open');
}
function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');
}
function closeTooltip() {
  document.getElementById('tooltipOverlay').classList.remove('open');
}

// ── SIDEBAR TABS ──────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.stab').forEach((el, i) => {
    el.classList.toggle('active', ['watchlist','screener'][i] === tab);
  });
  document.querySelectorAll('.sidebar-panel').forEach(el => el.classList.remove('active'));
  document.getElementById(`panel-${tab}`)?.classList.add('active');
}

// ── INIT ──────────────────────────────────────────────────────
function init() {
  Charts.init();
  UI.renderWatchlist();
  UI.apiStatus(!!CONFIG.polygonKey);

  // Save config
  document.getElementById('saveConfig').addEventListener('click', () => {
    const poly   = document.getElementById('polygonKey').value.trim();
    const gemini = document.getElementById('geminiKey').value.trim();
    const proxy  = document.getElementById('proxyUrl').value.trim();
    CONFIG.save(poly, gemini, proxy);
    closeSettings();
    UI.toast('Configuration saved ✓');
    UI.apiStatus(!!poly);
    if (poly) {
      if (STATE.watchlist.length) loadSymbol(STATE.watchlist[0]);
      loadMarketPills();
    }
  });

  // Add ticker
  const addInput = document.getElementById('addTickerInput');
  const addBtn   = document.getElementById('btnAddTicker');
  const doAdd = () => {
    const v = addInput.value.trim();
    if (v) { addToWatchlist(v); addInput.value = ''; }
  };
  addBtn.addEventListener('click', doAdd);
  addInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });

  // Timeframe buttons
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      STATE.activeTf = parseInt(btn.dataset.tf);
      if (STATE.activeSymbol) loadSymbol(STATE.activeSymbol);
    });
  });

  // Overlay toggles
  document.querySelectorAll('.ov-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ov = btn.dataset.ov;
      STATE.overlays[ov] = !STATE.overlays[ov];
      btn.classList.toggle('active', STATE.overlays[ov]);
      const ck = STATE.activeSymbol + '_' + STATE.activeTf;
      const candles = STATE.ohlcvCache[ck];
      const ind     = STATE.indCache[ck];
      if (candles && ind) Charts.render(candles, ind);
    });
  });

  // Auto start
  if (!CONFIG.polygonKey) {
    setTimeout(openSettings, 400);
  } else {
    if (STATE.watchlist.length) loadSymbol(STATE.watchlist[0]);
    loadMarketPills();
  }
}

document.addEventListener('DOMContentLoaded', init);
