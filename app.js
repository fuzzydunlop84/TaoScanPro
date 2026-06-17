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
      out[i] = 100 - 100 / (1 + ag / (al
