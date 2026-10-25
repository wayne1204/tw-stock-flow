#!/usr/bin/env node
/**
 * Whole-market summary of the 回測 factors, for backtest.html.
 *
 *   node pipeline/build_market_backtest.js
 *
 * Reads every web/data/stocks/<code>.js (ETFs, codes 00xx, are left out) and
 * web/data/taiex-daily.json, and writes web/data/market-backtest.js
 * (window.MARKET_BACKTEST). Uses web/js/backtest.js, so a factor here is the
 * same factor the stock page scores. Two views of each factor:
 *
 *   per stock      the stock panel's statistics for every stock, then their
 *                  spread across stocks (IC box, average quintile returns)
 *   cross-section  on each session, the rank correlation across all stocks
 *                  of the factor with the forward return; averaged by month
 *
 * Lookback L and the MA are fixed at the stock panel's defaults (5, MA20).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const B = require("../web/js/backtest.js");

const HORIZONS = [5, 20, 60];
const LOOKBACK = 5, MA = 20;
const MIN_CROSS = 30;   // stocks needed on a session for a cross-sectional IC

const has = v => v !== null && v !== undefined && !Number.isNaN(v);
const r4 = v => has(v) ? Math.round(v * 1e4) / 1e4 : null;
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * @param stocks  stock objects as fetch_stocks.py writes them
 * @param taiex   TAIEX daily rows (for the relative view)
 * @returns       { stocks, span, lookback, ma, views: { "raw-20": [factor…], … } }
 */
function aggregate(stocks, taiex) {
  stocks = stocks.filter(s => !/^00/.test(s.code));
  const views = [];
  for (const rel of [false, true]) for (const h of HORIZONS)
    views.push({ key: `${rel ? "rel" : "raw"}-${h}`, h, market: rel ? taiex : null });

  // One column per session across the whole market, so a cross-section is a column
  const dates = [...new Set(stocks.flatMap(s => s.daily.map(r => r.date)))].sort();
  const col = new Map(dates.map((d, i) => [d, i]));
  const keys = B.FACTORS.map(f => f.key);
  const fx = Object.fromEntries(keys.map(k => [k, []]));        // [stock] Float32Array(dates)
  const fwd = Object.fromEntries(views.map(v => [v.key, []]));
  const per = Object.fromEntries(views.map(v => [v.key,
    Object.fromEntries(keys.map(k => [k, { ics: [], spreads: [], hits: [], qs: [[], [], [], [], []], ok: 0 }]))]));

  let used = 0, first = null, last = null;
  for (const s of stocks) {
    const rows = B.restore(s, true);
    if (rows.length < 120) continue;
    used++;
    if (!first || rows[0].date < first) first = rows[0].date;
    if (!last || rows[rows.length - 1].date > last) last = rows[rows.length - 1].date;
    const at = rows.map(r => col.get(r.date));
    const column = (pts, get) => {
      const a = new Float32Array(dates.length).fill(NaN);
      for (const p of pts) { const v = get(p); if (has(v)) a[at[p.i]] = v; }
      return a;
    };
    for (const f of B.factorSeries(rows, s.holders || [], { lookback: LOOKBACK, ma: MA }))
      fx[f.key].push(column(f.points, p => p.x));
    for (const v of views) {
      const ret = B.forwardReturns(rows, v.h, v.market);
      fwd[v.key].push(column(rows.map((_, i) => ({ i })), p => ret[p.i]));
      for (const f of B.run(rows, s.holders || [], { horizon: v.h, lookback: LOOKBACK, ma: MA, market: v.market }).factors) {
        if (f.status === "insufficient" || !has(f.ic)) continue;
        const a = per[v.key][f.key];
        a.ics.push(f.ic); a.ok += f.status === "ok";
        if (has(f.spread)) a.spreads.push(f.spread);
        if (has(f.hit)) a.hits.push(f.hit);
        f.quintiles.forEach((q, k) => { if (has(q.mean)) a.qs[k].push(q.mean); });
      }
    }
  }

  const out = { stocks: used, span: [first, last], lookback: LOOKBACK, ma: MA, views: {} };
  for (const v of views) {
    out.views[v.key] = B.FACTORS.map(f => {
      const a = per[v.key][f.key], ics = [...a.ics].sort((x, y) => x - y);
      // Cross-section: one IC per session, then the month's average
      const months = new Map(), daily = [];
      const X = fx[f.key], Y = fwd[v.key];
      for (let d = 0; d < dates.length; d++) {
        const xs = [], ys = [];
        for (let k = 0; k < X.length; k++) {
          const x = X[k][d], y = Y[k][d];
          if (!Number.isNaN(x) && !Number.isNaN(y)) { xs.push(x); ys.push(y); }
        }
        if (xs.length < MIN_CROSS) continue;
        const ic = B.spearman(xs, ys);
        if (!has(ic)) continue;
        daily.push(ic);
        const m = dates[d].slice(0, 7);
        (months.get(m) || months.set(m, []).get(m)).push(ic);
      }
      return {
        key: f.key, label: f.label, def: f.def({ lookback: LOOKBACK, ma: MA }), weekly: !!f.weekly,
        stocks: ics.length, ok: a.ok,
        meanIC: r4(mean(ics)), posShare: r4(ics.length ? ics.filter(x => x > 0).length / ics.length : null),
        box: [0.1, 0.25, 0.5, 0.75, 0.9].map(p => r4(quantile(ics, p))),
        quintiles: a.qs.map(q => r4(mean(q))),
        spread: r4(quantile([...a.spreads].sort((x, y) => x - y), 0.5)),
        hit: r4(mean(a.hits)),
        cross: {
          sessions: daily.length, meanIC: r4(mean(daily)),
          posShare: r4(daily.length ? daily.filter(x => x > 0).length / daily.length : null),
          months: [...months].map(([m, xs]) => [m, r4(mean(xs))])
        }
      };
    }).filter(f => f.stocks || f.cross.sessions);
  }
  return out;
}

function readStock(file) {
  const s = fs.readFileSync(file, "utf8");
  return JSON.parse(s.slice(s.indexOf("={") + 1, s.lastIndexOf("}") + 1));
}

function main() {
  const root = path.join(__dirname, "..", "web", "data");
  const dir = path.join(root, "stocks");
  if (!fs.existsSync(path.join(dir, "index.js"))) {
    console.error("build_market_backtest: no web/data/stocks/ (run pipeline/fetch_stocks.py)");
    process.exit(1);
  }
  const t0 = Date.now();
  const stocks = fs.readdirSync(dir).filter(f => f.endsWith(".js") && f !== "index.js")
    .map(f => readStock(path.join(dir, f)));
  const taiex = JSON.parse(fs.readFileSync(path.join(root, "taiex-daily.json"), "utf8"));
  const res = { generatedAt: new Date().toISOString().slice(0, 19), ...aggregate(stocks, taiex) };
  const file = path.join(root, "market-backtest.js");
  fs.writeFileSync(file, `window.MARKET_BACKTEST=${JSON.stringify(res)};\n`);
  console.log(`market backtest: ${res.stocks} stocks · ${res.span.join(" – ")} · ` +
    `${(fs.statSync(file).size / 1024).toFixed(0)} KB · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

if (require.main === module) main();
module.exports = { aggregate };
