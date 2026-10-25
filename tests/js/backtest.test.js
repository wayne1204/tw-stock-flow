/**
 * Unit tests for the single-stock factor backtest.
 *
 * Hand-built series with known answers, so the statistics and the no-look-ahead
 * entry rule are pinned independently of any fetched data.
 */
"use strict";

const { forwardReturns, spearman, summarize, factorSeries, run } = require("../../web/js/backtest.js");

// Sessions from explicit [open, close] pairs; dates are only labels here.
const bars = pairs => pairs.map(([o, c], i) => ({
  date: `2024-01-${String(i + 1).padStart(2, "0")}`, open: o, high: Math.max(o, c),
  low: Math.min(o, c), close: c, volume: 1000
}));

// 25 flat sessions with full chip fields; `patch(i)` overrides per session.
const chips = patch => Array.from({ length: 25 }, (_, i) => ({
  date: `2024-02-${String(i + 1).padStart(2, "0")}`, open: 100, high: 100, low: 100, close: 100,
  volume: 100, foreign: 10, trust: -5, dealer: 1, marginBalance: 1000 + 10 * i, mainForce: null,
  ...(patch ? patch(i) : {})
}));
// n sessions whose volume repeats every 20, so the prior-20 average is flat and
// the volume ratio rises with t % 20; the next session closes t % 20 % above
// its 100 open, so the 1-day forward return rises with it too.
const cyclic = n => Array.from({ length: n }, (_, i) => ({
  date: `d${String(i).padStart(4, "0")}`, open: 100, high: 130, low: 90,
  close: i ? 100 + (i - 1) % 20 : 100, volume: 100 + 5 * (i % 20),
  foreign: 10, trust: 10, dealer: 0, marginBalance: 1000, mainForce: null
}));
const pointsOf = (series, key) => series.find(f => f.key === key).points;

module.exports = {
  name: "backtest.js — factor event study",

  run(t) {
    // ── Forward returns: enter at t+1 open, exit at t+N close ─────────────
    {
      const rows = bars([[100, 100], [110, 120], [130, 132], [140, 150]]);
      const r = forwardReturns(rows, 2);
      // day 0: buy day 1 open 110, sell day 2 close 132 → +20%
      t.near("entry is the next session's open, exit the Nth close", r[0], 132 / 110 - 1, 1e-12);
      t.near("day 1 enters at day 2 open", r[1], 150 / 130 - 1, 1e-12);
      t.eq("no return once the window runs off the end", [r[2], r[3]], [null, null]);
    }
    {
      // Relative: minus the market's return over the same open→close window
      const rows = bars([[100, 100], [100, 110], [105, 120]]);
      const mkt = bars([[1000, 1000], [1000, 1050], [1060, 1100]]);
      const r = forwardReturns(rows, 2, mkt);
      t.near("relative return subtracts the market over the same sessions",
             r[0], (120 / 100 - 1) - (1100 / 1000 - 1), 1e-12);
      const gap = forwardReturns(rows, 2, mkt.filter((_, i) => i !== 2));
      t.eq("a session missing from the market series gives no relative return", gap[0], null);
    }

    // ── Spearman IC ────────────────────────────────────────────────────────
    t.near("a monotone relation has IC 1", spearman([1, 2, 3, 4], [10, 20, 25, 99]), 1, 1e-12);
    t.near("an inverse relation has IC -1", spearman([1, 2, 3, 4], [9, 7, 3, 1]), -1, 1e-12);
    // y ranks with a tie: [1, 2, 3.5, 5, 3.5] → 8 / √95 (worked by hand)
    t.near("tied values share their average rank", spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7]), 0.8207826816681233, 1e-12);
    t.eq("a constant series has no IC", spearman([1, 2, 3], [4, 4, 4]), null);

    // ── Quintiles, spread, hit rate ────────────────────────────────────────
    {
      const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const ys = [-1, -2, 0, 1, 2, 3, 1, 1, 5, -4].map(v => v / 100);
      const s = summarize(xs, ys, { horizon: 5 });
      t.eq("ten points make five quintiles of two", s.quintiles.map(q => q.n), [2, 2, 2, 2, 2]);
      t.eq("quintile means, lowest factor first (%)",
           s.quintiles.map(q => +(q.mean * 100).toFixed(10)), [-1.5, 0.5, 2.5, 1, 0.5]);
      t.near("spread = Q5 mean − Q1 mean", s.spread, 0.02, 1e-12);
      t.near("hit rate = share of Q5 returns above zero", s.hit, 0.5, 1e-12);
      t.eq("n counts the paired observations", s.n, 10);
    }
    t.eq("tied factor values stay in one quintile",
         summarize([1, 1, 1, 1, 2], [0, 0, 0, 0, 1], { horizon: 1 }).quintiles.map(q => q.n), [0, 0, 4, 0, 1]);

    // ── Factor definitions (L = 2, MA5) ─────────────────────────────────────
    {
      const rows = chips(i => ({
        volume: i === 24 ? 300 : 100,
        close: i === 24 ? 110 : 100,
        foreign: i === 23 ? null : 10
      }));
      const holders = [
        { date: "2024-02-01", holders: 900, big400Pct: 49 },   // before any later week: no prior
        { date: "2024-02-22", holders: 1000, big400Pct: 50 },
        { date: "2024-02-24", holders: 1100, big400Pct: 52 }
      ];
      const f = factorSeries(rows, holders, { lookback: 2, ma: 5 });
      t.eq("volume ratio = today ÷ prior 20-session average, from session 20 on",
           pointsOf(f, "volume").map(p => [p.i, p.x]), [[20, 1], [21, 1], [22, 1], [23, 1], [24, 3]]);
      t.eq("外資 = L-day net ÷ 20-day average volume; a null day blanks every window it is in",
           pointsOf(f, "foreign").map(p => [p.i, p.x]), [[20, 0.2], [21, 0.2], [22, 0.2]]);
      t.eq("投信 is defined like 外資", pointsOf(f, "trust").map(p => p.x), [-0.1, -0.1, -0.1, -0.1, -0.1]);
      t.near("融資 = L-day % change in margin balance", pointsOf(f, "margin")[0].x, 1200 / 1180 - 1, 1e-12);
      t.near("均線位置 = close ÷ MA − 1", pointsOf(f, "ma").slice(-1)[0].x, 110 / 102 - 1, 1e-12);
      t.eq("主力 with no data has no points", pointsOf(f, "mainForce"), []);
      t.eq("股東人數變化 = week-over-week %, on the session of the TDCC date",
           pointsOf(f, "holders").map(p => [p.i, +p.x.toFixed(12)]), [[21, 0.111111111111], [23, 0.1]]);
      t.eq("大戶持股比變化 is in percentage points", pointsOf(f, "big400").map(p => p.x), [1, 2]);
      t.eq("each factor prints its formula for the chosen L and MA",
           [f.find(x => x.key === "foreign").def, f.find(x => x.key === "ma").def],
           ["近 2 日買賣超 ÷ 前 20 日均量", "收盤 ÷ MA5 − 1"]);
      t.eq("weekly factors are flagged weekly",
           f.filter(x => x.weekly).map(x => x.key), ["holders", "big400"]);
    }

    // ── run(): pairing, eligibility, order ─────────────────────────────────
    {
      const res = run(cyclic(150), [], { horizon: 1, lookback: 5, ma: 20 });
      t.eq("a long enough stock is ok", res.status, "ok");
      const keys = res.factors.map(f => f.key);
      t.eq("the factor that leads the return ranks first", keys[0], "volume");
      t.near("its IC is 1", res.factors[0].ic, 1, 1e-12);
      t.eq("every factor value with a forward return is paired", res.factors[0].n, 129);
      t.ok("factors without data are left out", !keys.includes("mainForce") && !keys.includes("holders"),
           keys.join(","));
      t.eq("factors with no IC sort last", keys.slice(-3).sort(), ["foreign", "margin", "trust"]);
    }
    {
      // Six weekly rows → five changes: scored (they rank perfectly) but far too few to trust
      const rows = cyclic(150);
      const holders = [0, 1, 2, 3, 4, 5].map(k => ({ date: rows[100 + k * 5].date, holders: 1000 + k * k, big400Pct: 50 + k }));
      const res = run(rows, holders, { horizon: 5, lookback: 5, ma: 20 });
      const st = res.factors.map(f => `${f.key}:${f.status}`);
      t.eq("thin weekly factors are still listed, as insufficient",
           res.factors.filter(f => f.weekly).map(f => f.status), ["insufficient", "insufficient"]);
      t.ok("insufficient factors sort after every other one",
           st.slice(-2).every(x => x.endsWith(":insufficient")), st.join(" "));
    }
    t.eq("a stock with under 120 sessions is too short", run(cyclic(119), [], { horizon: 5, lookback: 5, ma: 20 }),
         { status: "short", days: 119, factors: [] });

    // ── Effective n: overlapping windows are not independent ───────────────
    const xs200 = Array.from({ length: 200 }, (_, i) => i), ys200 = xs200.map(i => Math.sin(i));
    const at = (h, weekly) => summarize(xs200, ys200, { horizon: h, weekly });
    t.eq("effective n = n ÷ horizon", at(20).effN, 10);
    t.eq("effN ≥ 30 is ok", at(5).status, "ok");
    t.eq("effN < 30 is thin (樣本少)", at(20).status, "thin");
    t.eq("effN < 10 is insufficient (樣本不足)", at(60).status, "insufficient");
    t.eq("weekly samples overlap by horizon ÷ 5 weeks", at(20, true).effN, 50);
    t.eq("a weekly sample shorter than its horizon is not overlapped", at(5, true).effN, 200);
  }
};
