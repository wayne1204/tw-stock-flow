/**
 * Unit tests for the correction-detection algorithm.
 *
 * These run on hand-built series rather than the fetched data, so they pin the
 * *rules* independently of whatever the market happened to do. They need no
 * data file and no network.
 */
"use strict";

const { detectEpisodes } = require("../../web/js/detect.js");

// Build a series from closes. `extra` maps an index to chip fields.
const series = (closes, extra = {}) => closes.map((p, i) => ({
  date: `2021-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String(i % 28 + 1).padStart(2, "0")}`,
  open: p, high: p, low: p, close: p,
  turnoverYi: null, foreignNetYi: null, marginBalanceYi: null,
  ...(extra[i] || {})
}));

// Build a series with explicit highs/lows.
const ohlcSeries = bars => bars.map((b, i) => ({
  date: `2021-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String(i % 28 + 1).padStart(2, "0")}`,
  open: b[0], high: b[1], low: b[2], close: b[3],
  turnoverYi: null, foreignNetYi: null, marginBalanceYi: null
}));

module.exports = {
  name: "detect.js — correction detection rules",

  run(t) {
    // ── Degenerate input ───────────────────────────────────────────────────
    t.eq("empty series yields no episodes", detectEpisodes([], 0.07, "intraday").length, 0);
    t.eq("single row yields no episodes",
         detectEpisodes(series([100]), 0.07, "intraday").length, 0);
    t.eq("a series that only rises yields no episodes",
         detectEpisodes(series([100, 101, 102, 103, 104]), 0.07, "intraday").length, 0);
    t.eq("a decline that never reaches the threshold is ignored",
         detectEpisodes(series([100, 97, 94, 100]), 0.07, "close").length, 0);

    // ── Threshold boundary ─────────────────────────────────────────────────
    // -7.0% exactly must count (the rule is <= -threshold), -6.9% must not.
    t.eq("a drawdown exactly at the threshold counts",
         detectEpisodes(series([100, 93]), 0.07, "close").length, 1);
    t.eq("a drawdown just short of the threshold does not",
         detectEpisodes(series([100, 93.1]), 0.07, "close").length, 0);

    // ── Basic episode shape ────────────────────────────────────────────────
    {
      const rows = series([100, 105, 95, 90, 98, 106]);
      //            idx     0    1    2   3   4    5
      // peak 105 @1, trough 90 @3, reclaimed @5 (106 >= 105)
      const [e] = detectEpisodes(rows, 0.07, "close");
      t.eq("peak index", e.peakIdx, 1);
      t.eq("peak value", e.peakVal, 105);
      t.eq("trough index", e.troughIdx, 3);
      t.eq("trough value", e.troughVal, 90);
      t.near("drawdown %", e.drawdownPct, (90 - 105) / 105 * 100, 1e-9);
      t.eq("decline trading days = trough - peak", e.declineDays, 2);
      t.eq("recovery trading days = reclaim - trough", e.recoveryDays, 2);
      t.eq("status recovered", e.status, "recovered");
      t.eq("recover date recorded", e.recoverDate, rows[5].date);
    }

    // ── The rule that matters most ─────────────────────────────────────────
    // A rally inside a decline must NOT open a new episode. Only a new high
    // closes one out. This is what makes a long bear market count once.
    {
      const rows = series([100, 90, 96, 88, 94, 80, 101]);
      const eps = detectEpisodes(rows, 0.07, "close");
      t.eq("mid-decline rallies do not split the episode", eps.length, 1);
      t.eq("the episode keeps the deepest trough", eps[0].troughVal, 80);
      t.eq("trough index is the deepest, not the first", eps[0].troughIdx, 5);
    }

    // A genuine new high does close it, and a later decline is a new episode.
    {
      const rows = series([100, 90, 101, 92, 102]);
      const eps = detectEpisodes(rows, 0.07, "close");
      t.eq("a new high closes an episode and a later fall starts another", eps.length, 2);
      t.eq("first episode trough", eps[0].troughVal, 90);
      t.eq("second episode peak", eps[1].peakVal, 101);
      t.ok("episodes never overlap",
           eps.every((e, i) => i === 0 || e.peakIdx > eps[i - 1].troughIdx));
    }

    // ── Ongoing episodes ───────────────────────────────────────────────────
    {
      const [e] = detectEpisodes(series([100, 105, 90]), 0.07, "close");
      t.eq("unrecovered at end of series is ongoing", e.status, "ongoing");
      t.eq("ongoing has no recovery day count", e.recoveryDays, null);
      t.eq("ongoing has no recover index", e.recoverIdx, null);
      t.eq("ongoing has no recover date", e.recoverDate, null);
    }

    // ── intraday vs close basis ────────────────────────────────────────────
    {
      // Intraday low dips 8% but the close never falls more than 2%.
      const rows = ohlcSeries([
        [100, 100, 100, 100],
        [99,   99,  92,  98],
        [98,  101,  98, 101]
      ]);
      t.eq("intraday basis sees the wick", detectEpisodes(rows, 0.07, "intraday").length, 1);
      t.eq("close basis does not", detectEpisodes(rows, 0.07, "close").length, 0);
      t.eq("intraday trough uses the low", detectEpisodes(rows, 0.07, "intraday")[0].troughVal, 92);
    }

    // ── Chip metrics ───────────────────────────────────────────────────────
    {
      // Index -20%, margin 1000 -> 700 (-30%)  =>  ratio 1.5
      const rows = series([100, 80, 101], {
        0: { marginBalanceYi: 1000 },
        1: { marginBalanceYi: 700 },
        2: { marginBalanceYi: 700 }
      });
      const [e] = detectEpisodes(rows, 0.07, "close");
      t.near("margin change", e.marginChgYi, -300);
      t.near("margin change %", e.marginChgPct, -30);
      t.near("deleverage ratio = margin% / index%", e.killRatio, 1.5, 1e-9);
    }

    {
      // Missing chip values must stay null, never silently become 0.
      const [e] = detectEpisodes(series([100, 80, 101]), 0.07, "close");
      t.eq("absent turnover stays null", e.avgTurnoverYi, null);
      t.eq("absent foreign flow stays null", e.foreignSumYi, null);
      t.eq("absent margin stays null", e.marginChgYi, null);
      t.eq("deleverage ratio is null when margin is unknown", e.killRatio, null);
    }

    {
      // Margin gaps fall back to the nearest real reading, inward from each end.
      const rows = series([100, 100, 80, 101], {
        0: { marginBalanceYi: null },
        1: { marginBalanceYi: 1000 },
        2: { marginBalanceYi: 800 },
        3: { marginBalanceYi: 800 }
      });
      const [e] = detectEpisodes(rows, 0.07, "close");
      t.eq("margin start skips the leading gap", e.marginStartYi, 1000);
      t.eq("margin trough reads at the low", e.marginTroughYi, 800);
    }

    {
      // Foreign net sums only over peak..trough, skipping nulls.
      const rows = series([100, 95, 80, 101], {
        0: { foreignNetYi: -10 },
        1: { foreignNetYi: null },
        2: { foreignNetYi: -30 },
        3: { foreignNetYi: 999 }   // after the trough — must be excluded
      });
      const [e] = detectEpisodes(rows, 0.07, "close");
      t.near("foreign net sums peak..trough only, nulls skipped", e.foreignSumYi, -40);
    }

    {
      // Volume baseline is the 20 sessions *before* the peak.
      const pre = Array.from({ length: 20 }, () => 100);         // flat run-up
      const extra = {};
      pre.forEach((_, i) => { extra[i] = { turnoverYi: 100 }; });
      extra[20] = { turnoverYi: 200 };                            // peak day
      extra[21] = { turnoverYi: 200 };                            // trough day
      const rows = series([...pre, 100, 80, 101], extra);
      const [e] = detectEpisodes(rows, 0.07, "close");
      t.near("avg turnover over the decline", e.avgTurnoverYi, 200);
      t.near("turnover vs prior 20 sessions", e.turnoverChgPct, 100);
    }

    // ── Forward returns from the trough ────────────────────────────────────
    {
      // peak 100 @0, trough 80 @1, reclaim @2, then a long flat tail so the
      // 21/63/252-session windows have somewhere to land.
      const px = [100, 80, 101];
      for (let i = 0; i < 300; i++) px.push(120);      // flat at 120 thereafter
      const rows = series(px);
      const [e] = detectEpisodes(rows, 0.07, "close");

      t.eq("trough is where expected", e.troughIdx, 1);
      // Measured close-to-close FROM THE TROUGH DATE: 80 -> 120 = +50%
      t.near("+1M return is measured from the trough close", e.fwd1mPct, 50, 1e-9);
      t.near("+3M return", e.fwd3mPct, 50, 1e-9);
      t.near("+1Y return", e.fwd1yPct, 50, 1e-9);
    }

    {
      // Windows that run past the end of the series must be null, never a
      // partial-window number — "not enough data yet" is not "no move".
      const rows = series([100, 80, 101, 102, 103]);
      const [e] = detectEpisodes(rows, 0.07, "close");
      t.eq("+1M is null when the series is too short", e.fwd1mPct, null);
      t.eq("+3M is null when the series is too short", e.fwd3mPct, null);
      t.eq("+1Y is null when the series is too short", e.fwd1yPct, null);
    }

    {
      // Exactly at the boundary: index troughIdx + 21 must exist to report +1M.
      const mk = n => { const px = [100, 80]; for (let i = 0; i < n; i++) px.push(90); return series(px); };
      t.eq("+1M null at exactly one session short",
           detectEpisodes(mk(20), 0.07, "close")[0].fwd1mPct, null);
      t.near("+1M present the moment the 21st session exists",
             detectEpisodes(mk(21), 0.07, "close")[0].fwd1mPct, 12.5, 1e-9);
    }

    {
      // A forward return may be negative — the trough is a local low, not a floor.
      const px = [100, 80, 101];
      for (let i = 0; i < 30; i++) px.push(60);
      const [e] = detectEpisodes(series(px), 0.07, "close");
      t.ok("forward returns can be negative", e.fwd1mPct < 0, `${e.fwd1mPct.toFixed(1)}%`);
    }

    // ── A shared peak ──────────────────────────────────────────────────────
    {
      // Two crashes sharing one peak: 100 -> 80, bounce to 98 (never a new high),
      // then 98 -> 70, then finally a new high. Without a tolerance the bounce
      // does not close anything, so this is ONE episode.
      const rows = series([100, 80, 98, 70, 101]);

      const strict = detectEpisodes(rows, 0.07, "close");
      t.eq("strict: a shared peak yields one episode", strict.length, 1);
      t.eq("strict: it keeps the deepest trough", strict[0].troughVal, 70);
      t.eq("strict: closed by a new high", strict[0].endReason, "newhigh");

      // Omitting the options, or passing a non-object, must all mean "strict".
      const base = JSON.stringify(strict);
      for (const arg of [null, undefined, 0.2, "0.2"]) {
        const got = JSON.stringify(detectEpisodes(rows, 0.07, "close", arg));
        t.ok(`passing ${String(arg)} behaves as strict`, got === base,
             got === base ? "identical" : "DIFFERS from strict output");
      }
    }

    // ── Recovery tolerance ─────────────────────────────────────────────────
    {
      // 100 -> 80, bounce to 98 (2% short of the peak), then 98 -> 70, new high.
      const rows = series([100, 80, 98, 70, 101]);

      t.eq("tol 0: 2% short does not close the episode",
           detectEpisodes(rows, 0.07, "close", {tol: 0}).length, 1);
      t.eq("tol 1%: still short, still one episode",
           detectEpisodes(rows, 0.07, "close", {tol: 0.01}).length, 1);

      const t3 = detectEpisodes(rows, 0.07, "close", {tol: 0.03});
      t.eq("tol 3%: 2% short now counts as recovered -> two episodes", t3.length, 2);
      t.eq("tol 3%: first leg closed by tolerance", t3[0].endReason, "tolerance");
      t.eq("tol 3%: first leg troughs at 80", t3[0].troughVal, 80);
      t.eq("tol 3%: second leg re-pegs to the lower high", t3[1].peakVal, 98);
      t.eq("tol 3%: second leg closed by a genuine new high", t3[1].endReason, "newhigh");
    }

    {
      // A tolerance close lands BELOW the prior peak by construction — that is the
      // whole point, and it must never be reported as a new high.
      const rows = series([100, 80, 98, 70, 101]);
      const e = detectEpisodes(rows, 0.07, "close", {tol: 0.03})[0];
      t.ok("tolerance close is below the peak it closed against",
           rows[e.recoverIdx].close < e.peakVal,
           `${rows[e.recoverIdx].close} < ${e.peakVal}`);
      t.ok("tolerance close is within the tolerance band",
           rows[e.recoverIdx].close >= e.peakVal * 0.97);
    }

    {
      // Guard rails: a tolerance at or beyond the drawdown threshold would let an
      // episode close on the day it opened. Out-of-range values fall back to 0.
      const rows = series([100, 80, 98, 70, 101]);
      const strict = JSON.stringify(detectEpisodes(rows, 0.07, "close"));
      for (const bad of [-0.1, 0, 0.9, NaN, "0.03", null, undefined]) {
        t.ok(`tol ${String(bad)} falls back to strict`,
             JSON.stringify(detectEpisodes(rows, 0.07, "close", {tol: bad})) === strict,
             "identical to strict");
      }
    }

    // ── Threshold monotonicity on a fixed series ───────────────────────────
    {
      const rows = series([100, 96, 100, 91, 100, 84, 100]);
      const counts = [0.03, 0.07, 0.12, 0.20].map(
        th => detectEpisodes(rows, th, "close").length);
      t.ok("raising the threshold never finds more episodes",
           counts.every((n, i) => i === 0 || n <= counts[i - 1]),
           `3%/7%/12%/20% = ${counts.join(" / ")}`);
    }

    // ── Structural invariants ──────────────────────────────────────────────
    {
      // A pseudo-random but deterministic walk, to fuzz the invariants.
      let seed = 42;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      const px = [1000];
      for (let i = 1; i < 800; i++) px.push(Math.max(50, px[i - 1] * (1 + (rnd() - 0.5) * 0.06)));
      const rows = series(px);

      for (const th of [0.05, 0.07, 0.10, 0.15]) {
        const eps = detectEpisodes(rows, th, "close");
        const label = `${(th * 100).toFixed(0)}%`;
        t.ok(`[${label}] every drawdown meets the threshold`,
             eps.every(e => e.drawdownPct <= -th * 100 + 1e-9));
        t.ok(`[${label}] trough never precedes peak`,
             eps.every(e => e.troughIdx >= e.peakIdx));
        t.ok(`[${label}] episodes are ordered and disjoint`,
             eps.every((e, i) => i === 0 || e.peakIdx > eps[i - 1].troughIdx));
        t.ok(`[${label}] closed episodes genuinely reclaimed their peak`,
             eps.filter(e => e.status === "recovered")
                .every(e => rows[e.recoverIdx].close >= e.peakVal - 1e-9));
        t.ok(`[${label}] at most one ongoing episode, and it is last`,
             eps.filter(e => e.status === "ongoing").length <= 1 &&
             eps.every((e, i) => e.status !== "ongoing" || i === eps.length - 1));
        t.ok(`[${label}] day counts are non-negative`,
             eps.every(e => e.declineDays >= 0 &&
                            (e.recoveryDays === null || e.recoveryDays >= 0)));
      }
    }
  }
};
