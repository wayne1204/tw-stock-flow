#!/usr/bin/env node
/**
 * Verification harness — checks the fetched data and the detection algorithm
 * against the acceptance criteria and the reference table in the spec.
 *
 *   node scripts/verify.js
 *
 * Runs the exact detect.js used by the dashboard, so a pass here means the page
 * is showing the same numbers.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { detectEpisodes } = require("../web/js/detect.js");

const DATA = path.join(__dirname, "..", "web", "data", "taiex-daily.json");
if (!fs.existsSync(DATA)) {
  console.error("web/data/taiex-daily.json not found — run: python3 pipeline/fetch_data.py");
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(DATA, "utf8"));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const fmt = n => n === null || n === undefined ? "—"
  : n.toLocaleString("en-US", { maximumFractionDigits: 2 });

// ── Data integrity ─────────────────────────────────────────────────────────
console.log("\nData integrity");
const cov = k => rows.filter(r => r[k] !== null && r[k] !== undefined).length;
check("covers 2017-01-01 onward", rows[0].date <= "2017-01-05", rows[0].date);
check("at least 2,200 trading days", rows.length >= 2200, `${rows.length} days`);
check("OHLC complete", cov("close") === rows.length, `${cov("close")}/${rows.length}`);
check("turnover >= 99%", cov("turnoverYi") / rows.length >= 0.99,
      `${cov("turnoverYi")}/${rows.length}`);
check("foreign net >= 99%", cov("foreignNetYi") / rows.length >= 0.99,
      `${cov("foreignNetYi")}/${rows.length}`);
check("margin balance >= 99%", cov("marginBalanceYi") / rows.length >= 0.99,
      `${cov("marginBalanceYi")}/${rows.length}`);
check("dates strictly ascending, no dupes",
      rows.every((r, i) => i === 0 || r.date > rows[i - 1].date));
check("high >= low on every day", rows.every(r => r.high >= r.low));

// ── Known single-day records from the spec ─────────────────────────────────
console.log("\nKnown single-session records (sanity check)");
const byDate = Object.fromEntries(rows.map(r => [r.date, r]));
const prevOf = d => { const i = rows.findIndex(r => r.date === d); return i > 0 ? rows[i - 1] : null; };
const dayCheck = (d, close, pts) => {
  const r = byDate[d];
  if (!r) return check(`${d}`, false, "date missing from series");
  const p = prevOf(d);
  const delta = p ? r.close - p.close : null;
  const okClose = Math.abs(r.close - close) < 1.0;
  const okPts = pts === null || (delta !== null && Math.abs(delta - pts) < 2.0);
  check(`${d} close ${fmt(close)}`, okClose && okPts,
        `got close ${fmt(r.close)}, change ${fmt(delta)}`);
};
dayCheck("2024-08-05", 19830.88, -1807.21);
dayCheck("2025-04-07", 19232.35, -2065.87);
dayCheck("2025-04-10", 19000.03, +1608.27);
dayCheck("2025-12-31", 28963.60, null);
dayCheck("2026-07-17", 42671.27, -2953.71);

// ── Detection at the 7% default ────────────────────────────────────────────
console.log("\nCorrection detection @ 7%, intraday high/low");
const eps = detectEpisodes(rows, 0.07, "intraday");

console.log("\n   #  period                      peak        trough     draw    dn   rec   fgn      mgn%   ratio");
eps.forEach((e, i) => {
  console.log(
    `  ${String(i + 1).padStart(2)}  ${e.peakDate} -> ${e.troughDate}  ` +
    `${fmt(e.peakVal).padStart(9)}  ${fmt(e.troughVal).padStart(9)}  ` +
    `${e.drawdownPct.toFixed(1).padStart(6)}%  ${String(e.declineDays).padStart(3)}  ` +
    `${String(e.recoveryDays === null ? "ong" : e.recoveryDays).padStart(4)}  ` +
    `${fmt(e.foreignSumYi).padStart(7)}  ` +
    `${(e.marginChgPct === null ? "—" : e.marginChgPct.toFixed(1)).padStart(6)}  ` +
    `${(e.killRatio === null ? "—" : e.killRatio.toFixed(2)).padStart(5)}`);
});

console.log("");
// The spec's reference table starts in 2021, so compare like with like: only
// episodes whose peak falls in 2021 or later. Pre-2021 episodes (incl. the 2020
// COVID crash) are real, they are simply outside what that table enumerates.
// Lower bound only: the table is a fixed list of 8, but every new correction
// the market makes adds one, so an upper bound would fail on live data alone.
const epsFrom2021 = eps.filter(e => e.peakDate >= "2021-01-01");
const epsPre2021 = eps.filter(e => e.peakDate < "2021-01-01");
check("episode count from 2021 covers the reference table (>= 6 of 8)",
      epsFrom2021.length >= 6,
      `${epsFrom2021.length} episodes from 2021 (+${epsPre2021.length} in 2019-2020)`);

// The 2022 bear market must collapse into ONE episode, not four or five.
const bear22 = eps.filter(e => e.peakDate < "2023-01-01" && e.troughDate >= "2022-01-01");
check("2022 bear market counted once", bear22.length === 1,
      bear22.map(e => `${e.peakDate}->${e.troughDate} ${e.drawdownPct.toFixed(1)}%`).join(" | ")
      || "none found");
if (bear22.length === 1) {
  const b = bear22[0];
  check("  its drawdown is ~-32%", b.drawdownPct < -28 && b.drawdownPct > -36,
        `${b.drawdownPct.toFixed(1)}%`);
  check("  it took ~9-10 months to bottom", b.declineDays > 150 && b.declineDays < 230,
        `${b.declineDays} trading days`);
}

// Only the latest episode may be open, and an open one has no recovery yet.
// Whether it IS open depends on the market, so accept either state.
const last = eps[eps.length - 1];
check("only the latest episode can be ongoing",
      eps.slice(0, -1).every(e => e.status !== "ongoing"));
check("latest episode's status matches its recovery fields",
      last.status === "ongoing"
        ? last.recoveryDays === null && last.recoverDate === null
        : last.recoveryDays !== null && last.recoverDate !== null,
      `${last.peakDate} -> ${last.troughDate}, status ${last.status}`);

// Every closed episode must genuinely have reclaimed its peak.
check("closed episodes all reclaimed their peak",
      eps.filter(e => e.status === "recovered")
         .every(e => rows[e.recoverIdx].high >= e.peakVal - 1e-6));
check("all drawdowns meet the threshold",
      eps.every(e => e.drawdownPct <= -7 + 1e-9));
check("episodes do not overlap",
      eps.every((e, i) => i === 0 || e.peakIdx > eps[i - 1].troughIdx));

// ── Reference table cross-check ────────────────────────────────────────────
//
// The reference table lists events as a human reading the news would separate
// them. The spec's detection rule separates them only on a new high. Those two
// disagree in two specific places, and the rule wins — so the expected outcome
// is encoded per reference row rather than assuming one episode each.
//
//   own    - should surface as its own episode
//   deeper - our peak matches, but the episode ran past the reference trough
//   merged - absorbed into an earlier episode that never made a new high
//
// Reference rows are matched by which episode *contains the reference trough*,
// not by peak month: real peaks often land days before the month the event is
// remembered by (2021-05 actually peaks 2021-04-29).
console.log("\nAgainst the reference table (approximate levels, ±4% tolerance)");
const REF = [
  { ym: "2021-05", peak: 17709,    trough: 15159,    dd: -14.0, expect: "own" },
  { ym: "2021-07", peak: 18034,    trough: 16248,    dd: -10.0, expect: "own" },
  { ym: "2022-01", peak: 18619,    trough: 12629,    dd: -32.0, expect: "own" },
  { ym: "2023-08", peak: 17463,    trough: 15663,    dd: -10.0, expect: "merged",
    into: "2022-01", why: "2022 peak stood until 2024-02-15, so this dip never followed a new high" },
  { ym: "2024-07", peak: 24416.67, trough: 19662.74, dd: -19.5, expect: "deeper",
    why: "absorbs 2025-01; the 24,416 peak stood until 2025-08-18" },
  { ym: "2025-01", peak: 23900,    trough: 17306,    dd: -28.0, expect: "merged",
    into: "2024-07", why: "2025-01 high of 23,943 never cleared the 2024-07 peak" },
  { ym: "2026-02", peak: 35521,    trough: 31529,    dd: -11.0, expect: "own" },
  { ym: "2026-07", peak: 47425,    trough: 42450,    dd: -10.5, expect: "deeper",
    why: "ran below the 7/20 low before recovering" }
];

const near = (a, b) => Math.abs(a - b) / b <= 0.04;
const idxOfNearest = iso => {           // reference dates are month-level, so find the low near it
  let best = -1, bestGap = Infinity;
  rows.forEach((r, i) => {
    const gap = Math.abs(new Date(r.date) - new Date(iso));
    if (gap < bestGap) { bestGap = gap; best = i; }
  });
  return best;
};

REF.forEach(ref => {
  // Locate the episode whose window spans the reference trough level
  const host = eps.find(e =>
    e.peakDate.slice(0, 7) <= ref.ym &&
    (e.recoverDate === null ? "9999-99" : e.recoverDate.slice(0, 7)) >= ref.ym);

  if (!host) {
    return check(`${ref.ym}  ${ref.expect}`, false, "no episode spans that period");
  }

  if (ref.expect === "own") {
    check(`${ref.ym}  own      ref ${fmt(ref.peak)}→${fmt(ref.trough)} (${ref.dd}%)`,
          near(host.peakVal, ref.peak) && near(host.troughVal, ref.trough),
          `got ${fmt(host.peakVal)}→${fmt(host.troughVal)} (${host.drawdownPct.toFixed(1)}%)`);
  } else if (ref.expect === "deeper") {
    // Peak must match; the episode is allowed to have run deeper than the
    // reference trough, but must not have bottomed *above* it.
    check(`${ref.ym}  deeper   peak ${fmt(ref.peak)}, ran past ${fmt(ref.trough)}`,
          near(host.peakVal, ref.peak) && host.troughVal <= ref.trough * 1.04,
          `got ${fmt(host.peakVal)}→${fmt(host.troughVal)} — ${ref.why}`);
  } else if (ref.expect === "merged") {
    // Must NOT be its own episode, and the reference low must genuinely sit
    // inside the host episode's window.
    const ownEpisode = eps.some(e => e.peakDate.slice(0, 7) === ref.ym);
    const lowIdx = idxOfNearest(ref.ym + "-15");
    const inside = lowIdx >= host.peakIdx &&
                   lowIdx <= (host.recoverIdx === null ? rows.length - 1 : host.recoverIdx);
    check(`${ref.ym}  merged   into ${ref.into}`,
          !ownEpisode && inside,
          ownEpisode ? "surfaced as its own episode — the new-high rule was not applied"
                     : `absorbed by ${host.peakDate} — ${ref.why}`);
  }
});

// Every reference event must at least be *covered* by some episode's window,
// merged or not — nothing may fall through the cracks entirely.
check("all 8 reference events fall inside a detected episode",
      REF.every(ref => eps.some(e =>
        e.peakDate.slice(0, 7) <= ref.ym &&
        (e.recoverDate === null ? "9999-99" : e.recoverDate.slice(0, 7)) >= ref.ym)));

// "Intact" means the January-2022 peak still owns a single ~-32% episode all the
// way down to October. Counting every episode that merely touches 2022 would be
// wrong: the December-2022 dip is a genuinely separate correction, not a split.
const bearIntact = eps2 => {
  const m = eps2.filter(e => e.peakDate.startsWith("2022-01"));
  return m.length === 1 && m[0].drawdownPct <= -28 && m[0].troughDate >= "2022-10-01";
};

// ── Recovery tolerance ─────────────────────────────────────────────────────
// Treating "within tol of the prior peak" as reclaimed is how two crashes that
// share a peak get separated, and it is what the UI defaults to (3%). The
// running peak ratchets DOWN to each tolerant close, so the effect compounds
// along the series.
console.log("\nRecovery tolerance (within N% of the peak counts as reclaimed)");
for (const T of [0, 0.01, 0.02, 0.03, 0.05]) {
  const e2 = detectEpisodes(rows, 0.07, "intraday", { tol: T });
  console.log(`  ${(T * 100).toFixed(0)}%`.padEnd(6) +
    `${String(e2.length).padStart(2)} episodes` +
    `   2022 intact: ${bearIntact(e2) ? "yes" : "NO"}` +
    `   closed by a real new high: ${e2.filter(x => x.endReason === "newhigh").length}`);
}

const tol3 = detectEpisodes(rows, 0.07, "intraday", { tol: 0.03 });
check("3% tolerance keeps the 2022 bear market as one episode", bearIntact(tol3));
check("3% tolerance separates 2024-07 from 2025-01",
      tol3.some(e => e.peakDate.startsWith("2024-07") && e.drawdownPct > -22) &&
      tol3.some(e => e.peakDate.startsWith("2025-01") && e.drawdownPct < -25),
      tol3.filter(e => e.peakDate >= "2024-07" && e.peakDate < "2025-05")
          .map(e => `${e.peakDate}→${e.troughDate} ${e.drawdownPct.toFixed(1)}%`).join(" | "));
check("5% tolerance starts breaking the 2022 bear market",
      !bearIntact(detectEpisodes(rows, 0.07, "intraday", { tol: 0.05 })));
check("tolerance closes never exceeded the peak they closed against",
      tol3.filter(e => e.endReason === "tolerance")
          .every(e => rows[e.recoverIdx].high < e.peakVal));
check("tolerance closes all landed inside the 3% band",
      tol3.filter(e => e.endReason === "tolerance")
          .every(e => rows[e.recoverIdx].high >= e.peakVal * 0.97 - 1e-9));
check("tol=0 is byte-identical to passing nothing",
      JSON.stringify(detectEpisodes(rows, 0.07, "intraday", { tol: 0 })) ===
      JSON.stringify(detectEpisodes(rows, 0.07, "intraday")));

check("every episode reports how it ended",
      tol3.every(e => ["newhigh", "tolerance", "ongoing"].includes(e.endReason)));

// ── Threshold / mode sweep ─────────────────────────────────────────────────
console.log("\nThreshold & price-basis sweep (counts should fall as threshold rises)");
for (const mode of ["intraday", "close"]) {
  const counts = [0.05, 0.07, 0.10, 0.15].map(t => detectEpisodes(rows, t, mode).length);
  const monotone = counts.every((c, i) => i === 0 || c <= counts[i - 1]);
  check(`${mode.padEnd(8)} 5%/7%/10%/15% = ${counts.join(" / ")}`, monotone);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
