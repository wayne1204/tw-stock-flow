/**
 * Minimal test harness. No framework — the project has no runtime
 * dependencies and the test suite shouldn't add one for the sake of it.
 *
 * A test file exports { name, needs?, run(t) }:
 *   name   label printed as the section header
 *   needs  optional () => string|null; return a reason to skip the whole file
 *   run    receives a context with ok / eq / near / throws / skip
 */
"use strict";

function makeContext() {
  const results = [];
  const push = (pass, name, detail) => results.push({ pass, name, detail });

  return {
    results,

    /** Assert a condition. `detail` is printed either way — it's the evidence. */
    ok(name, cond, detail) { push(!!cond, name, detail); return !!cond; },

    /** Deep-ish equality on primitives and JSON-able values. */
    eq(name, actual, expected) {
      const a = JSON.stringify(actual), b = JSON.stringify(expected);
      return push(a === b, name, a === b ? String(a) : `got ${a}, want ${b}`), a === b;
    },

    /** Floating-point comparison. */
    near(name, actual, expected, tol = 1e-6) {
      const pass = Math.abs(actual - expected) <= tol;
      push(pass, name, pass ? String(actual) : `got ${actual}, want ${expected} ±${tol}`);
      return pass;
    },

    /** Assert fn() throws. */
    throws(name, fn) {
      try { fn(); push(false, name, "did not throw"); return false; }
      catch { push(true, name); return true; }
    },

    skip(name, reason) { results.push({ skip: true, name, detail: reason }); }
  };
}

const C = {
  pass: "\x1b[32m", fail: "\x1b[31m", skip: "\x1b[33m",
  dim: "\x1b[2m", bold: "\x1b[1m", off: "\x1b[0m"
};
const paint = process.stdout.isTTY;
const c = (col, s) => paint ? col + s + C.off : s;

module.exports = { makeContext, C, c };
