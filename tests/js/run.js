#!/usr/bin/env node
/**
 * Test runner.
 *
 *   node tests/js/run.js         run everything
 *   node tests/js/run.js detect  run only suites whose filename matches "detect"
 *
 * Three kinds of suite are collected:
 *   *.test.js        JS modules exporting { name, needs?, run(t) }  (see helpers.js)
 *   verify.js        the data + acceptance-criteria report in scripts/
 *   tests/py/*.py    the Python unittest suites for the fetchers
 *
 * Suites that cannot run (missing data file, missing dev dependency) are SKIPPED
 * loudly rather than silently passing — a skipped guard is not a green guard.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { makeContext, C, c } = require("./helpers.js");

const TESTS_DIR = __dirname;
const ROOT = path.join(TESTS_DIR, "..", "..");
const PY_TESTS_DIR = path.join(TESTS_DIR, "..", "py");
const filter = process.argv[2] || "";

let totalPass = 0, totalFail = 0, totalSkip = 0;
const failures = [];

function report(suiteName, results) {
  const pass = results.filter(r => r.pass).length;
  const fail = results.filter(r => r.pass === false).length;
  const skip = results.filter(r => r.skip).length;
  totalPass += pass; totalFail += fail; totalSkip += skip;

  console.log(`\n${c(C.bold, suiteName)}`);
  for (const r of results) {
    if (r.skip) {
      console.log(`  ${c(C.skip, "SKIP")}  ${r.name}${r.detail ? c(C.dim, "  — " + r.detail) : ""}`);
    } else if (r.pass) {
      console.log(`  ${c(C.pass, "PASS")}  ${r.name}${r.detail ? c(C.dim, "  — " + r.detail) : ""}`);
    } else {
      console.log(`  ${c(C.fail, "FAIL")}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
      failures.push(`${suiteName} :: ${r.name}${r.detail ? "  — " + r.detail : ""}`);
    }
  }
}

/** Run a child process as a single suite; its exit code is the verdict. */
function runProcess(suiteName, cmd, args, opts = {}) {
  if (opts.missing) {
    return report(suiteName, [{ skip: true, name: suiteName, detail: opts.missing }]);
  }
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  if (r.error && r.error.code === "ENOENT") {
    return report(suiteName, [{ skip: true, name: suiteName, detail: `${cmd} not found` }]);
  }
  const out = ((r.stdout || "") + (r.stderr || "")).trimEnd();
  const ok = r.status === 0;

  console.log(`\n${c(C.bold, suiteName)}`);
  // Indent the child's own output so it reads as part of this report
  for (const line of out.split("\n")) console.log("  " + c(C.dim, line));
  console.log(`  ${ok ? c(C.pass, "PASS") : c(C.fail, "FAIL")}  ${suiteName} (exit ${r.status})`);

  ok ? totalPass++ : (totalFail++, failures.push(`${suiteName} exited ${r.status}`));
}

(async () => {
  console.log(c(C.bold, "TAIEX Drawdown Atlas — test suite"));

  // ── JS module suites ─────────────────────────────────────────────────────
  const files = fs.readdirSync(TESTS_DIR)
    .filter(f => f.endsWith(".test.js"))
    .filter(f => !filter || f.includes(filter))
    .sort();

  for (const f of files) {
    let mod;
    try {
      mod = require(path.join(TESTS_DIR, f));
    } catch (e) {
      report(f, [{ pass: false, name: `load ${f}`, detail: e.message }]);
      continue;
    }
    const name = mod.name || f;

    const reason = typeof mod.needs === "function" ? mod.needs() : null;
    if (reason) { report(name, [{ skip: true, name: "suite skipped", detail: reason }]); continue; }

    const t = makeContext();
    try {
      await mod.run(t);
    } catch (e) {
      t.ok("suite ran to completion", false, e && e.stack ? e.stack.split("\n")[0] : String(e));
    }
    report(name, t.results);
  }

  // ── Python fetcher suite ─────────────────────────────────────────────────
  if (!filter || "fetch".includes(filter) || filter.includes("fetch")) {
    const py = path.join(PY_TESTS_DIR, "fetch_test.py");
    const venvPy = path.join(ROOT, ".venv", "bin", "python");
    const python = fs.existsSync(venvPy) ? venvPy : "python3";
    runProcess("fetch_data.py — parsers & cache (python unittest)", python, [py],
      { missing: fs.existsSync(py) ? null : "tests/py/fetch_test.py not present" });
    runProcess("fetch_stocks.py — parsers (python unittest)", python,
      [path.join(PY_TESTS_DIR, "stock_fetch_test.py")]);
  }

  // ── Data + acceptance criteria ───────────────────────────────────────────
  if (!filter || "verify".includes(filter) || filter.includes("verify")) {
    const dataFile = path.join(ROOT, "web", "data", "taiex-daily.json");
    runProcess("verify.js — data integrity & acceptance criteria", "node", ["scripts/verify.js"],
      { missing: fs.existsSync(dataFile) ? null : "web/data/taiex-daily.json not built — run python3 pipeline/fetch_data.py" });
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(64));
  const parts = [
    c(C.pass, `${totalPass} passed`),
    totalFail ? c(C.fail, `${totalFail} failed`) : "0 failed",
    totalSkip ? c(C.skip, `${totalSkip} skipped`) : "0 skipped"
  ];
  console.log("  " + parts.join("  ·  "));
  if (failures.length) {
    console.log(`\n  ${c(C.fail, "Failures:")}`);
    for (const f of failures) console.log("    " + f);
  }
  if (totalSkip) {
    console.log(c(C.dim, "\n  Skipped suites are not passing suites — see the reasons above."));
  }
  console.log("");
  process.exit(totalFail ? 1 : 0);
})();
