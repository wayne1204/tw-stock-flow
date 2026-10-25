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
    t.ok("run.sh stamps both staged pages",
      run.includes('s|<!--DEPLOYED-->|$stamp|" "$STAGE/index.html" "$STAGE/stock.html"'));
  }
};
