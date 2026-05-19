import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = "24.0.0";

const DEFAULT_SYMBOLS = [
  "SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL",
  "TSLA", "AMD", "AVGO", "JPM", "LLY", "UNH", "COST", "PLTR"
];

const DISCOVERY = [
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "AVGO", "TSLA",
  "LLY", "JPM", "V", "MA", "UNH", "COST", "HD", "WMT", "NFLX",
  "AMD", "CRM", "ADBE", "NOW", "ORCL", "PANW", "CRWD", "MU",
  "QCOM", "AMAT", "LRCX", "SMCI", "ARM", "VRT", "GE", "CAT",
  "DE", "UBER", "SHOP", "MELI", "AXP", "BKNG", "GS", "MS",
  "BAC", "XOM", "CVX", "LIN", "ISRG", "SPY", "QQQ", "DIA",
  "IWM", "XLK", "XLF", "XLE", "XLV", "SMH", "IBB"
];

const cache = new Map();

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false
}));

app.use(cors({ origin: "*" }));
app.use(compression());
app.use(express.json());

app.use(express.static(path.join(__dirname, "../public")));

const round = (n, d = 2) => Number.isFinite(Number(n)) ? Number(Number(n).toFixed(d)) : null;
const num = n => Number.isFinite(Number(n)) ? Number(n) : null;
const sma = (a, p) => a.length >= p ? a.slice(-p).reduce((s, v) => s + v, 0) / p : null;

function ema(a, p) {
  if (a.length < p) return null;

  const k = 2 / (p + 1);
  let e = sma(a.slice(0, p), p);

  for (let i = p; i < a.length; i++) {
    e = a[i] * k + e * (1 - k);
  }

  return e;
}

function rsi(a, p = 14) {
  if (a.length <= p) return null;

  let g = 0;
  let l = 0;

  for (let i = a.length - p; i < a.length; i++) {
    const d = a[i] - a[i - 1];

    if (d >= 0) {
      g += d;
    } else {
      l -= d;
    }
  }

  if (l === 0) return 100;

  const rs = g / l;
  return 100 - 100 / (1 + rs);
}

function atr(b, p = 14) {
  if (b.length <= p) return null;

  const tr = [];

  for (let i = 1; i < b.length; i++) {
    tr.push(Math.max(
      b[i].high - b[i].low,
      Math.abs(b[i].high - b[i - 1].close),
      Math.abs(b[i].low - b[i - 1].close)
    ));
  }

  return sma(tr.slice(-p), p);
}

function parseSymbols(s, fallback = DEFAULT_SYMBOLS) {
  return String(s || fallback.join(","))
    .split(",")
    .map(x => x.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 60);
}

async function yahooBars(symbol, range = "1y", interval = "1d") {
  const key = `${symbol}:${range}:${interval}`;
  const cached = cache.get(key);

  if (cached && Date.now() - cached.time < 180000) {
    return cached.bars;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;

  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!r.ok) {
    throw new Error(`${symbol} data HTTP ${r.status}`);
  }

  const j = await r.json();
  const res = j?.chart?.result?.[0];
  const q = res?.indicators?.quote?.[0];

  if (!res || !q) {
    throw new Error(`${symbol} no chart data`);
  }

  const bars = res.timestamp.map((t, i) => ({
    time: t * 1000,
    date: new Date(t * 1000).toISOString().slice(0, 10),
    open: num(q.open?.[i]),
    high: num(q.high?.[i]),
    low: num(q.low?.[i]),
    close: num(q.close?.[i]),
    volume: num(q.volume?.[i])
  })).filter(b =>
    Number.isFinite(b.close) &&
    Number.isFinite(b.high) &&
    Number.isFinite(b.low)
  );

  if (!bars.length) {
    throw new Error(`${symbol} no usable bars`);
  }

  cache.set(key, {
    time: Date.now(),
    bars
  });

  return bars;
}

function fallbackBars(symbol) {
  const seed = [...symbol].reduce((s, c) => s + c.charCodeAt(0), 0);
  const base = 80 + (seed % 600);
  const out = [];

  for (let i = 260; i >= 0; i--) {
    const close = base + (260 - i) * 0.15 + Math.sin(i / 9) * base * 0.035;

    out.push({
      time: Date.now() - i * 86400000,
      date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10),
      open: round(close * 0.997),
      high: round(close * 1.012),
      low: round(close * 0.988),
      close: round(close),
      volume: 1000000 + ((seed + i) % 60) * 50000
    });
  }

  return out;
}

async function getBars(symbol, range = "1y", interval = "1d") {
  try {
    return await yahooBars(symbol, range, interval);
  } catch (e) {
    console.warn(e.message);
    return fallbackBars(symbol);
  }
}

function scanOne(symbol, bars, spyBars, risk = 100) {
  const closes = bars.map(b => b.close);
  const vols = bars.map(b => b.volume || 0);
  const last = bars[bars.length - 1];
  const price = last.close;

  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const s200 = sma(closes, 200);
  const r14 = rsi(closes);
  const a14 = atr(bars);
  const avgv = sma(vols, 20);
  const vr = avgv ? last.volume / avgv : null;

  const hi20 = Math.max(...bars.slice(-20).map(b => b.high));

  const spy = spyBars?.map(b => b.close) || [];
  const spymove = spy.length > 21 ? (spy.at(-1) - spy.at(-21)) / spy.at(-21) * 100 : 0;
  const stockmove = closes.length > 21 ? (price - closes.at(-21)) / closes.at(-21) * 100 : 0;

  let score = 0;
  const reasons = [];
  const warnings = [];

  if (price > s200) {
    score += 18;
    reasons.push("Price is above the 200-day trend line.");
  } else {
    warnings.push("Price is below or near the 200-day trend line.");
  }

  if (e20 > e50) {
    score += 16;
    reasons.push("EMA20 is above EMA50.");
  }

  if (e50 > s200) {
    score += 12;
    reasons.push("EMA50 is above SMA200.");
  }

  if (price > e20) {
    score += 7;
    reasons.push("Price is holding above EMA20.");
  }

  if (r14 >= 50 && r14 <= 70) {
    score += 10;
    reasons.push("RSI is in a healthy bullish zone.");
  } else if (r14 > 70) {
    score += 3;
    warnings.push("RSI is stretched and may be too hot to chase.");
  }

  if (vr >= 1.5) {
    score += 13;
    reasons.push(`Relative volume is active at ${round(vr, 2)}x.`);
  } else if (vr < 0.8) {
    warnings.push("Relative volume is low.");
  }

  if (stockmove - spymove > 0) {
    score += 10;
    reasons.push("Relative strength is better than SPY.");
  }

  if (price >= hi20 * 0.985) {
    score += 8;
    reasons.push("Price is near or above the prior 20-day breakout area.");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const stop = round(price - (a14 ? a14 * 1.8 : price * 0.04));
  const target1 = round(price + Math.abs(price - stop) * 2);
  const target2 = round(price + Math.abs(price - stop) * 3);

  const buyLow = round(Math.min(price * 0.985, e20 ? e20 * 1.01 : price * 0.985));
  const buyHigh = round(price * 0.997);

  const inside = price >= buyLow && price <= buyHigh;
  const stretched = warnings.join(" ").toLowerCase().includes("stretched");

  let decision = "WATCH_LONG";
  let setupType = "Trend Watch";
  let summary = `${symbol} is worth watching, but it is not a clean entry yet.`;
  let actionPlan = `Watch only. A cleaner entry would be ${buyLow} to ${buyHigh}. Stop at ${stop}.`;

  if (score >= 82 && !stretched && inside) {
    decision = "ENTER_NOW";
    setupType = "Swing Entry";
    summary = `${symbol} has a strong swing setup and is inside the buy zone.`;
    actionPlan = `Entry can be considered near ${round(price)}. Stop at ${stop}. Targets are ${target1} and ${target2}.`;
  } else if (score >= 70) {
    decision = "WAIT_FOR_PULLBACK";
    setupType = "Pullback";
    summary = `${symbol} is strong but should not be chased. Wait for price to pull back into the buy zone.`;
    actionPlan = `Do not chase. Best buy zone is ${buyLow} to ${buyHigh}. If price enters that zone and the score remains strong, this can change to ENTER NOW. Stop at ${stop}. Targets are ${target1} and ${target2}.`;
  } else if (score >= 58) {
    decision = "WAIT_FOR_BREAKOUT";
    setupType = "Breakout Watch";
    summary = `${symbol} is not ready yet. Watch for a clean breakout confirmation.`;
    actionPlan = `Wait for price to break and hold above ${round(hi20)}. If it confirms, stop is ${stop}. Targets are ${target1} and ${target2}.`;
  } else {
    decision = "AVOID";
    setupType = "Avoid";
    summary = `${symbol} is not ready yet. Risk or trend quality is not strong enough.`;
    actionPlan = "Avoid for now. Wait for a better trend, volume, or support setup.";
  }

  reasons.push("Swing-first mode is active because the account should avoid PDT-style day trading.");

  const rr = round((target1 - price) / (price - stop), 2);
  const distance = price > buyHigh
    ? (price - buyHigh) / buyHigh * 100
    : price < buyLow
      ? -((buyLow - price) / buyLow * 100)
      : 0;

  let actionability = score;

  if (distance === 0) {
    actionability += 12;
  } else if (distance > 4) {
    actionability -= 25;
  } else if (distance > 1.5) {
    actionability -= 10;
  }

  if (stretched) {
    actionability -= 14;
  }

  if (rr >= 2) {
    actionability += 6;
  }

  actionability = Math.max(0, Math.min(100, Math.round(actionability)));

  return {
    symbol,
    mode: "swing",
    score,
    strengthScore: score,
    actionabilityScore: actionability,
    rankScore: Math.round(score * 0.55 + actionability * 0.45),
    setupType,
    decision,
    tradeDecision: decision,
    action: decision,
    signal: decision,
    confidence: score >= 82 ? "Strong" : score >= 70 ? "Good" : score >= 58 ? "Fair" : "Weak",
    price: round(price),
    currentPrice: round(price),
    entry: round(price),
    buyZoneLow: buyLow,
    buyZoneHigh: buyHigh,
    buyLow,
    buyHigh,
    entryStatus: distance === 0 ? "Inside buy zone" : distance > 0 ? `${round(distance, 1)}% above zone` : `${round(Math.abs(distance), 1)}% below zone`,
    distanceToBuyZonePct: round(distance, 2),
    breakoutLevel: round(hi20),
    stopLoss: stop,
    stop,
    sl: stop,
    invalidationLevel: stop,
    target1,
    targetPrice: target1,
    target2,
    tp: target1,
    riskPerShare: round(price - stop),
    rewardPerShare: round(target1 - price),
    riskReward: rr,
    suggestedShares: Math.max(1, Math.floor(Number(risk) / Math.max(0.01, price - stop))),
    maxRiskDollars: Number(risk),
    expectedHold: "1 to 5 trading days",
    summary,
    plainEnglish: summary,
    actionPlan,
    reasons,
    warnings,
    metrics: {
      ema20: round(e20),
      ema50: round(e50),
      sma200: round(s200),
      rsi14: round(r14),
      atr14: round(a14),
      volumeRatio: round(vr, 2),
      relativeStrength: round(stockmove - spymove, 2)
    },
    bars: bars.slice(-180),
    education: {
      timeframe: "1Y daily candles",
      chartRead: "The chart uses 1 year of daily candles and shows current price, buy zone, stop, target, and breakout level.",
      entryRule: decision === "WAIT_FOR_PULLBACK"
        ? `Do not enter immediately. If price pulls back into ${buyLow} to ${buyHigh} and the score stays above 70, the paper engine can change this to ENTER NOW.`
        : decision === "ENTER_NOW"
          ? "Entry is allowed because price is inside the buy zone and the trend rules are met."
          : "No entry yet. Wait for the rule shown in the action plan.",
      exitRule: `Exit if price hits the stop at ${stop}, reaches target, or scanner score falls below the danger level.`
    }
  };
}

async function makeScan(symbols, risk, source = "watchlist") {
  const start = Date.now();
  const spy = await getBars("SPY");
  const raw = [];
  const errors = [];

  for (const sym of symbols) {
    try {
      raw.push(scanOne(sym, sym === "SPY" ? spy : await getBars(sym), spy, risk));
    } catch (e) {
      errors.push({
        symbol: sym,
        error: e.message
      });
    }
  }

  raw.sort((a, b) => b.rankScore - a.rankScore || b.score - a.score);

  const spySignal = raw.find(s => s.symbol === "SPY");
  const market = spySignal?.price > spySignal?.metrics?.sma200 ? "Bullish" : "Neutral";

  return {
    ok: true,
    version: VERSION,
    app: "/",
    mode: "swing-first-pdt-safe",
    source,
    market,
    symbolsRequested: symbols,
    count: symbols.length,
    shown: raw.length,
    filteredOut: 0,
    message: "Swing-first scanner. Best choices are ranked by strength plus actionability.",
    summary: {
      plainEnglish: `Market backdrop is ${market}. ${raw.filter(s => s.score >= 70).length} stocks scored 70 or higher.`,
      entries: raw.filter(s => /ENTER/i.test(s.decision)).length,
      watches: raw.filter(s => /WAIT|WATCH|PULLBACK|BREAKOUT/i.test(s.decision)).length,
      highScoreCount: raw.filter(s => s.score >= 70).length,
      best: raw[0]?.symbol || null
    },
    errors,
    elapsedMs: Date.now() - start,
    updatedAt: new Date().toISOString(),
    signals: raw
  };
}

app.get("/", function(req, res) {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.get("/api/health", function(req, res) {
  res.json({
    ok: true,
    status: "ok",
    version: VERSION,
    app: "/",
    defaultSymbols: DEFAULT_SYMBOLS,
    cacheSeconds: 180,
    time: new Date().toISOString()
  });
});

app.get("/health", function(req, res) {
  res.json({
    ok: true,
    status: "ok",
    version: VERSION,
    time: new Date().toISOString()
  });
});

app.get("/api/keepalive", function(req, res) {
  res.json({
    ok: true,
    awake: true,
    version: VERSION,
    time: new Date().toISOString()
  });
});

app.get("/keepalive", function(req, res) {
  res.json({
    ok: true,
    awake: true,
    version: VERSION,
    time: new Date().toISOString()
  });
});

app.get("/api/scan", async function(req, res) {
  try {
    res.json(await makeScan(parseSymbols(req.query.symbols), Number(req.query.risk || 100), "watchlist"));
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

app.get("/scan", async function(req, res) {
  try {
    res.json(await makeScan(parseSymbols(req.query.symbols), Number(req.query.risk || 100), "watchlist"));
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

app.get("/api/discover", async function(req, res) {
  try {
    const exclude = new Set(parseSymbols(req.query.exclude || "", []));
    const limit = Math.max(3, Math.min(20, Number(req.query.limit || 10)));
    const symbols = DISCOVERY.filter(s => !exclude.has(s)).slice(0, 60);

    const out = await makeScan(symbols, Number(req.query.risk || 100), "discovery");

    out.signals = out.signals
      .filter(s => s.score >= 70 && s.actionabilityScore >= 58 && !/AVOID/i.test(s.decision))
      .slice(0, limit);

    out.shown = out.signals.length;

    res.json(out);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

app.get("/discover", async function(req, res) {
  try {
    const exclude = new Set(parseSymbols(req.query.exclude || "", []));
    const limit = Math.max(3, Math.min(20, Number(req.query.limit || 10)));
    const symbols = DISCOVERY.filter(s => !exclude.has(s)).slice(0, 60);

    const out = await makeScan(symbols, Number(req.query.risk || 100), "discovery");

    out.signals = out.signals
      .filter(s => s.score >= 70 && s.actionabilityScore >= 58 && !/AVOID/i.test(s.decision))
      .slice(0, limit);

    out.shown = out.signals.length;

    res.json(out);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

app.get("/api/bars", async function(req, res) {
  try {
    const symbol = String(req.query.symbol || "SPY").trim().toUpperCase();
    const range = String(req.query.range || "1y");
    const interval = String(req.query.interval || "1d");

    res.json({
      ok: true,
      symbol,
      range,
      interval,
      timeframe: `${range} ${interval}`,
      bars: await getBars(symbol, range, interval)
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

app.get("/bars", async function(req, res) {
  try {
    const symbol = String(req.query.symbol || "SPY").trim().toUpperCase();
    const range = String(req.query.range || "1y");
    const interval = String(req.query.interval || "1d");

    res.json({
      ok: true,
      symbol,
      range,
      interval,
      timeframe: `${range} ${interval}`,
      bars: await getBars(symbol, range, interval)
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

app.use(function(req, res) {
  res.status(404).json({
    ok: false,
    error: "route not found",
    path: req.path
  });
});

app.listen(PORT, function() {
  console.log(`US stock scanner backend v${VERSION} running on port ${PORT}`);
});
