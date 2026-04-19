# TaoScan Pro — Technical Analysis Screener

> Real market data · Client-side indicators · TradingView charts · AI summaries

A steel-aesthetic technical analysis screener with real OHLCV data from Polygon.io,
client-side calculation of RSI, EMA, MACD, and volume indicators, TradingView
Lightweight Charts candlesticks, and Groq LLM trade summaries.

---

## 🚀 Quick Start (GitHub Pages)

```bash
# 1. Fork / clone this repo
git clone https://github.com/yourusername/taoscan-pro
cd taoscan-pro

# 2. Push to GitHub
git push origin main

# 3. Enable GitHub Pages
# Settings → Pages → Source: main / root
# Your site: https://yourusername.github.io/taoscan-pro
```

---

## 🔑 API Keys Required

### Polygon.io (market data)
- Free at [polygon.io](https://polygon.io) — sign up, copy your API key
- Free tier: 5 calls/min, unlimited historical data
- Costs: $0/month for basic use

### Groq (AI summaries)  
- Free at [console.groq.com](https://console.groq.com)
- Extremely fast inference, generous free tier
- Powers the plain English trade summaries

### Enter Keys in App
1. Click the ⚙ gear icon (top right)
2. Enter your Polygon.io API key
3. Enter your Groq API key
4. Click **SAVE CONFIGURATION**

Keys are stored in `localStorage` — never sent to any server (except the respective APIs directly).

---

## ☁️ Cloudflare Worker Proxy (Optional)

If you hit CORS issues calling Polygon.io from GitHub Pages, deploy the included proxy:

```bash
# Install Wrangler CLI
npm install -g wrangler
wrangler login

# Deploy the worker
wrangler publish worker.js --name taoscan-proxy
```

Or paste `worker.js` directly into [workers.cloudflare.com](https://workers.cloudflare.com).

Add your worker URL to Settings → **Cloudflare Worker Proxy URL**.

---

## 📊 Features

### Screener
- **RSI Oversold** — RSI(14) < 30
- **RSI Overbought** — RSI(14) > 70  
- **MACD Bullish Crossover** — MACD line > Signal
- **MACD Bearish Crossover** — MACD line < Signal
- **Above / Below EMA 20**
- **Volume Surge** — Volume > 1.5× 20-day average
- **Golden Cross** — EMA20 > EMA50 and price > EMA200

### Indicators (all client-side)
| Indicator | Parameters |
|-----------|-----------|
| RSI | 14-period |
| EMA | 20, 50, 200 |
| MACD | 12, 26, 9 |
| Volume Ratio | vs 20-day avg |

### Charts
- **Candlestick** via TradingView Lightweight Charts
- **EMA overlays** (toggleable: EMA20, EMA50, EMA200)
- **RSI sub-chart** with 30/70 levels
- **MACD sub-chart** with histogram
- **Timeframes**: 1D, 5D, 1M, 3M, 1Y

### AI Analysis
- Groq LLaMA-3 8B generates plain English trade summaries
- Uses all calculated indicators as context
- Identifies key EMA support/resistance levels
- Notes potential setups and divergences

---

## 🏗 Architecture

```
taoscan-pro/
├── index.html      # App shell + layout
├── style.css       # Metal aesthetic CSS
├── app.js          # Polygon API + indicators + charts + Groq
└── worker.js       # Cloudflare Worker CORS proxy
```

**Data flow:**
```
GitHub Pages → Polygon.io API → OHLCV data
                                     ↓
                            Client-side indicators
                            (RSI, EMA, MACD, vol)
                                     ↓
                          TradingView Lightweight Charts
                                     ↓
                          Groq API → AI plain-English summary
```

---

## 📝 Notes

- Free Polygon.io tier allows ~5 calls/min — the screener throttles requests at 300ms intervals
- All indicator math runs in the browser — no backend required for indicators
- Price data is cached per session to minimize API calls
- The app works fully offline for cached tickers

---

## License

MIT — use freely, modify freely.
