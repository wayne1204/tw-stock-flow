/**
 * The deploy-time footer stamp.
 *
 * run.sh deploy replaces <!--DEPLOYED--> in the staged copy of each page with
 * the deploy time and commit. The marker has to exist exactly once per page,
 * or the stamp silently goes missing (or is written twice).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");
const count = (s, needle) => s.split(needle).length - 1;

module.exports = {
  name: "deploy — footer carries the deploy-time marker",

  run(t) {
    for (const page of ["index.html", "stock.html"]) {
      const html = read(path.join("web", page));
      t.eq(`${page} has one <!--DEPLOYED--> marker`, count(html, "<!--DEPLOYED-->"), 1);
      t.ok(`${page} marker sits in the footer`,
        /<footer>[\s\S]*<!--DEPLOYED-->[\s\S]*<\/footer>/.test(html));
      t.ok(`${page} hides the empty stamp`, html.includes(".deployed:empty{display:none}"));
    }
    const run = read("run.sh");
    // Every local script a page loads must ship, or the deployed page breaks
    // while file:// and ./run.sh keep working. data/stocks/ is added by glob.
    const listed = (run.match(/local files=\(([^)]*)\)/) || [, ""])[1].split(/\s+/);
    for (const page of ["index.html", "stock.html"]) {
      const srcs = [...read(path.join("web", page)).matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
        .filter(src => !/^https?:/.test(src) && !src.startsWith("data/stocks/"));
      const missing = srcs.filter(src => !listed.includes(src));
      t.ok(`run.sh deploys every local script ${page} loads`, missing.length === 0,
        missing.length ? `missing: ${missing.join(", ")}` : srcs.join(", "));
    }
    t.ok("run.sh deploys the TAIEX data stock.html loads lazily", listed.includes("data/taiex-daily.js"));
    t.ok("run.sh stamps both staged pages",
      run.includes('s|<!--DEPLOYED-->|$stamp|" "$STAGE/index.html" "$STAGE/stock.html"'));
  }
};
