/**
 * Peak-to-trough correction detection for the TAIEX daily series.
 *
 * Shared by index.html (loaded via <script src>, so it works over file://) and
 * by verify.js under Node, so the browser and the verification run can never
 * drift apart.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TaiexDetect = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const mean = a => {
    const v = a.filter(x => x !== null && x !== undefined);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };

  // Walk in `dir` for the closest non-null value; chip series have occasional holes
  const nearest = (arr, i, dir) => {
    for (let k = i; k >= 0 && k < arr.length; k += dir) {
      if (arr[k] !== null && arr[k] !== undefined) return arr[k];
    }
    return null;
  };

  /**
   * @param rows        merged daily series from data/taiex-daily.json
   * @param threshold   e.g. 0.07 for a 7% correction
   * @param mode        'intraday' (high/low) or 'close'
   * @param opts        optional { tol }: the recovery tolerance, e.g. 0.03
   * @returns array of episode objects
   *
   * A rally *inside* an ongoing decline does not open a new episode. Only
   * reclaiming the prior peak closes one out, so the whole 2022 bear market is
   * counted once rather than as four or five corrections. Every episode reports
   * how it ended via `endReason`.
   */
  function detectEpisodes(rows, threshold, mode, opts) {
    const tolIn = opts && typeof opts === "object" ? opts.tol : 0;
    // Recovery tolerance: how close to the prior peak counts as reclaiming it.
    // Clamped to [0, 0.5) — a tolerance at or above the drawdown threshold would
    // let an episode close on the very day it opened.
    const tol = (typeof tolIn === "number" && tolIn > 0 && tolIn < 0.5) ? tolIn : 0;
    const N = rows.length;
    const dates = rows.map(r => r.date);
    const rawTurn = rows.map(r => r.turnoverYi);
    const rawMgn = rows.map(r => r.marginBalanceYi);

    const HI = i => (mode === "intraday" ? rows[i].high : rows[i].close);
    const LO = i => (mode === "intraday" ? rows[i].low : rows[i].close);

    function build(pi, pv, ti, tv, ri, endReason) {
      const ddPct = ((tv - pv) / pv) * 100;

      // Average daily turnover during the decline vs the 20 sessions before the peak
      const avgTurn = mean(rawTurn.slice(pi, ti + 1));
      const preTurn = mean(rawTurn.slice(Math.max(0, pi - 20), pi));
      const turnChg = avgTurn !== null && preTurn ? (avgTurn / preTurn - 1) * 100 : null;

      // Foreign net summed across the decline window
      let fSum = null;
      for (let k = pi; k <= ti; k++) {
        const v = rows[k].foreignNetYi;
        if (v !== null && v !== undefined) fSum = (fSum || 0) + v;
      }

      // Margin balance: peak -> trough
      const mStart = nearest(rawMgn, pi, +1);
      const mTrough = nearest(rawMgn, ti, -1);
      const mChg = mStart !== null && mTrough !== null ? mTrough - mStart : null;
      const mChgPct = mChg !== null && mStart ? (mChg / mStart) * 100 : null;

      // Deleverage ratio = margin decline % / index decline % (both negative -> positive)
      const kill = mChgPct !== null && ddPct < 0 ? mChgPct / ddPct : null;

      // Forward return from the trough, in trading days (~21 / 63 / 252 sessions).
      // Measured CLOSE-to-CLOSE from the trough date, not from the intraday low:
      // nobody transacts at the low tick, and using it would inflate every figure
      // and make the intraday and close bases incomparable. Returns null when the
      // series does not yet extend far enough, never a partial-window number.
      const fwd = n => {
        const j = ti + n;
        if (j >= rows.length) return null;
        const base = rows[ti].close, tgt = rows[j].close;
        if (base === null || base === undefined || tgt === null || tgt === undefined) return null;
        return (tgt - base) / base * 100;
      };

      return {
        peakDate: dates[pi], peakVal: pv, peakIdx: pi,
        troughDate: dates[ti], troughVal: tv, troughIdx: ti,
        recoverIdx: ri, recoverDate: ri === null ? null : dates[ri],
        status: ri === null ? "ongoing" : "recovered",
        // "newhigh"   - cleared the prior peak outright (a true recovery)
        // "tolerance" - came within the recovery tolerance of the peak
        // "ongoing" - never closed
        endReason: endReason || (ri === null ? "ongoing" : "newhigh"),
        drawdownPct: ddPct,
        declineDays: ti - pi,
        recoveryDays: ri === null ? null : ri - ti,
        avgTurnoverYi: avgTurn, turnoverChgPct: turnChg,
        foreignSumYi: fSum,
        marginStartYi: mStart, marginTroughYi: mTrough,
        marginChgYi: mChg, marginChgPct: mChgPct,
        killRatio: kill,
        fwd1mPct: fwd(21), fwd3mPct: fwd(63), fwd1yPct: fwd(252)
      };
    }

    const out = [];
    let peakIdx = -1, peakVal = -Infinity;
    let inCorr = false, trIdx = -1, trVal = Infinity;

    for (let i = 0; i < N; i++) {
      const h = HI(i), l = LO(i);
      if (h === null || l === null || h === undefined || l === undefined) continue;
      if (peakIdx < 0) { peakIdx = i; peakVal = h; }

      if (!inCorr) {
        if (h >= peakVal) { peakVal = h; peakIdx = i; }
        if ((l - peakVal) / peakVal <= -threshold) { inCorr = true; trVal = l; trIdx = i; }
      } else {
        if (l < trVal) { trVal = l; trIdx = i; }
        // Recovery is measured against the peak, optionally with a tolerance:
        // getting within `tol` of the prior high counts as reclaiming it. This is
        // what separates two crashes that share a peak — 2025-01 rebounded to
        // within 1.94% of the 2024-07 high, which a 3% tolerance accepts.
        if (h >= peakVal * (1 - tol)) {
          out.push(build(peakIdx, peakVal, trIdx, trVal, i,
                         h >= peakVal ? "newhigh" : "tolerance"));
          inCorr = false;
          // The running peak resets to today's high. On a tolerance exit that is
          // just BELOW the old peak, so the next decline is measured from it
          // instead of being swallowed by the original episode.
          peakVal = h; peakIdx = i;
        }
      }
    }
    // Ran off the end of the series still under water
    if (inCorr) out.push(build(peakIdx, peakVal, trIdx, trVal, null, "ongoing"));
    return out;
  }

  return { detectEpisodes };
});
