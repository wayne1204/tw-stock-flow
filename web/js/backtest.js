/**
 * Single-stock factor event study for stock.html.
 *
 * Shared by the page (loaded via <script src>, so it works over file://) and by
 * the Node test suite. Describes the past only: how each chip factor lined up
 * with the stock's forward return, never a reading for today.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.StockBacktest = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const has = v => v !== null && v !== undefined && !Number.isNaN(v);

  /**
   * Forward return for each session. Chip data for day t is published after
   * the close, so the first price anyone could trade on it is day t+1's open;
   * the position is closed at day t+N's close. With `market` (TAIEX rows),
   * the index's return over the same two sessions is subtracted.
   */
  function forwardReturns(rows, N, market) {
    const byDate = market ? new Map(market.map(r => [r.date, r])) : null;
    const ret = (a, b) => a && b && has(a.open) && has(b.close) && a.open > 0 ? b.close / a.open - 1 : null;
    return rows.map((_, i) => {
      const a = rows[i + 1], b = rows[i + N];
      const own = ret(a, b);
      if (!byDate || own === null) return own;
      const m = ret(byDate.get(a.date), byDate.get(b.date));
      return m === null ? null : own - m;
    });
  }

  // Ranks from 1, ties sharing their average rank
  function ranks(xs) {
    const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
    const out = new Array(xs.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j++;
      for (let k = i; k <= j; k++) out[idx[k]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return out;
  }

  /** Spearman rank correlation of paired samples; null when either side is constant. */
  function spearman(xs, ys) {
    const rx = ranks(xs), ry = ranks(ys), n = xs.length;
    const m = (n + 1) / 2;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = rx[i] - m, dy = ry[i] - m;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }

  const THIN = 30, INSUFFICIENT = 10;

  /**
   * Statistics for one factor's paired (factor, forward return) samples.
   * Quintile cut points come from the full sample: this describes the past,
   * it does not simulate trading it. Consecutive N-day windows share N−1
   * days, so the effective sample is n ÷ N (n ÷ N/5 for weekly samples);
   * the status flags read off that, not off n.
   *
   * @param opts  { horizon, weekly }
   */
  function summarize(xs, ys, opts) {
    const n = xs.length;
    const overlap = Math.max(1, opts.weekly ? opts.horizon / 5 : opts.horizon);
    const effN = n / overlap;
    const r = ranks(xs);
    const qs = Array.from({ length: 5 }, () => ({ sum: 0, n: 0, up: 0 }));
    for (let i = 0; i < n; i++) {
      // By average rank, so tied factor values land in the same quintile
      const q = qs[Math.min(4, Math.floor((r[i] - 0.5) * 5 / n))];
      q.sum += ys[i]; q.n++; if (ys[i] > 0) q.up++;
    }
    const quintiles = qs.map(q => ({ n: q.n, mean: q.n ? q.sum / q.n : null }));
    const lo = quintiles[0], hi = quintiles[4];
    return {
      n, effN, ic: n > 2 ? spearman(xs, ys) : null, quintiles,
      spread: has(lo.mean) && has(hi.mean) ? hi.mean - lo.mean : null,
      hit: qs[4].n ? qs[4].up / qs[4].n : null,
      status: effN < INSUFFICIENT ? "insufficient" : effN < THIN ? "thin" : "ok"
    };
  }

  const WARMUP = 20;   // sessions of history behind every daily factor value

  // `def` is the formula as the panel prints it, for the chosen L and MA
  const flowDef = o => `近 ${o.lookback} 日買賣超 ÷ 前 20 日均量`;
  const FACTORS = [
    { key: "foreign", label: "外資", def: flowDef },
    { key: "trust", label: "投信", def: flowDef },
    { key: "volume", label: "量能變化", def: () => "當日成交量 ÷ 前 20 日均量" },
    { key: "ma", label: "均線位置", def: o => `收盤 ÷ MA${o.ma} − 1` },
    { key: "margin", label: "融資", def: o => `融資餘額近 ${o.lookback} 日增減 %` },
    { key: "mainForce", label: "主力", def: o => `近 ${o.lookback} 日主力買賣超 ÷ 前 20 日均量` },
    // TDCC dates a week by its last business day and publishes it that
    // evening, so the next session's open is the first tradable price here too
    { key: "holders", label: "股東人數變化", weekly: true, def: () => "集保總股東人數週增減 %" },
    { key: "big400", label: "大戶持股比變化", weekly: true, def: () => "> 400 張大戶持股比週增減（百分點）" }
  ];

  /**
   * Every factor as points {i, x}, i being the session the value is known at
   * (after its close). A window with any missing input yields no point rather
   * than a partial sum.
   *
   * @param rows     split-adjusted daily rows (stock.html's restore())
   * @param holders  weekly TDCC rows
   * @param opts     { lookback: L, ma: 5 | 20 | 60 }
   */
  function factorSeries(rows, holders, opts) {
    const L = opts.lookback, M = opts.ma;
    const win = (i, n, k) => {
      if (i - n + 1 < 0) return null;
      const xs = [];
      for (let j = i - n + 1; j <= i; j++) {
        if (!has(rows[j][k])) return null;
        xs.push(rows[j][k]);
      }
      return xs;
    };
    const sum = xs => xs && xs.reduce((a, b) => a + b, 0);
    // Volume baseline: the 20 sessions before today, so today's own spike
    // does not dilute it
    const baseVol = i => {
      const xs = win(i - 1, WARMUP, "volume");
      const v = xs && sum(xs) / WARMUP;
      return v > 0 ? v : null;
    };
    const flow = k => i => {
      const s = sum(win(i, L, k)), v = baseVol(i);
      return has(s) && v ? s / v : null;
    };
    const daily = {
      foreign: flow("foreign"),
      trust: flow("trust"),
      mainForce: flow("mainForce"),
      volume: i => { const v = baseVol(i); return v && has(rows[i].volume) ? rows[i].volume / v : null; },
      ma: i => { const xs = win(i, M, "close"); return xs ? rows[i].close / (sum(xs) / M) - 1 : null; },
      margin: i => {
        const a = rows[i - L] && rows[i - L].marginBalance, b = rows[i].marginBalance;
        return has(a) && has(b) && a > 0 ? b / a - 1 : null;
      }
    };

    // A TDCC week lands on the last session on or before its data date
    const weekly = { holders: [], big400: [] };
    let j = 0, prev = null;
    for (const h of holders || []) {
      if (!rows.length || h.date < rows[0].date || h.date > rows[rows.length - 1].date) continue;
      while (j + 1 < rows.length && rows[j + 1].date <= h.date) j++;
      if (prev) {
        if (has(h.holders) && has(prev.holders) && prev.holders > 0)
          weekly.holders.push({ i: j, x: h.holders / prev.holders - 1 });
        if (has(h.big400Pct) && has(prev.big400Pct))
          weekly.big400.push({ i: j, x: h.big400Pct - prev.big400Pct });
      }
      prev = h;
    }

    return FACTORS.map(f => {
      let points = weekly[f.key];
      if (!points) {
        points = [];
        for (let i = WARMUP; i < rows.length; i++) {
          const x = daily[f.key](i);
          if (has(x)) points.push({ i, x });
        }
      }
      return { key: f.key, label: f.label, def: f.def(opts), weekly: !!f.weekly, points };
    });
  }

  const MIN_DAYS = 120;

  /**
   * The whole panel: every factor that has data, paired with its forward
   * return and summarized, strongest |IC| first. Insufficient factors and
   * factors without an IC sort last.
   *
   * @param opts  { horizon, lookback, ma, market? }  market = TAIEX rows for
   *              returns relative to the index
   */
  function run(rows, holders, opts) {
    if (rows.length < MIN_DAYS) return { status: "short", days: rows.length, factors: [] };
    const fwd = forwardReturns(rows, opts.horizon, opts.market);
    const factors = [];
    for (const f of factorSeries(rows, holders, opts)) {
      if (!f.points.length) continue;
      const xs = [], ys = [];
      for (const p of f.points) if (has(fwd[p.i])) { xs.push(p.x); ys.push(fwd[p.i]); }
      factors.push({ key: f.key, label: f.label, def: f.def, weekly: f.weekly,
                     ...summarize(xs, ys, { horizon: opts.horizon, weekly: f.weekly }) });
    }
    const tier = f => f.status === "insufficient" ? 2 : has(f.ic) ? 0 : 1;
    factors.sort((a, b) => tier(a) - tier(b) || Math.abs(b.ic || 0) - Math.abs(a.ic || 0));
    return { status: "ok", days: rows.length, factors };
  }

  return { forwardReturns, spearman, summarize, factorSeries, run };
});
