/**
 * The standalone build must not silently drift from its sources.
 *
 * dist/ is gitignored, so the bundle is a local artifact that nobody is forced
 * to rebuild — which is exactly how it goes stale. Editing index.html and
 * handing someone dist/taiex-atlas-standalone.html then ships them the previous
 * version of the page with no warning anywhere.
 *
 * No bundle at all is fine (SKIP). A bundle older than what it inlines is not.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const WEB = path.join(ROOT, "web");
const DIST = path.join(ROOT, "dist");
// Each bundle and everything bundle.py inlines into it: the page plus every
// local <script src> it loads, so a change to any of them invalidates the build.
const BUNDLES = [["taiex-today-standalone.html", "index.html"],
                 ["taiex-atlas-standalone.html", "drawdown.html"]];
const sourcesOf = page => [page, ...[...fs.readFileSync(path.join(WEB, page), "utf8")
  .matchAll(/<script src="((?!https?:)[^"]+)"/g)].map(m => m[1])];

const mtime = p => fs.statSync(p).mtimeMs;

module.exports = {
  name: "bundle — dist/ is current with its sources",

  needs: () => BUNDLES.some(([out]) => fs.existsSync(path.join(DIST, out)))
    ? null
    : "dist/ bundles not built — run `python3 pipeline/bundle.py`",

  run(t) {
    for (const [out, page] of BUNDLES) {
      const bundle = path.join(DIST, out);
      if (!fs.existsSync(bundle)) {
        t.ok(`${out} is built`, false, "run `python3 pipeline/bundle.py`");
        continue;
      }
      const built = mtime(bundle);
      for (const rel of sourcesOf(page)) {
        const src = path.join(WEB, rel);
        if (!fs.existsSync(src)) {
          t.ok(`${rel} exists`, false, `referenced by ${page} but missing`);
          continue;
        }
        const age = (mtime(src) - built) / 1000;
        t.ok(`${out}: ${rel} is not newer than the bundle`, age <= 0,
          age <= 0 ? `${Math.round(-age)}s older`
                   : `${Math.round(age)}s NEWER — run \`python3 pipeline/bundle.py\``);
      }

      // A bundle that failed to inline something is worse than a stale one: it
      // would try to reach the network from a file:// page and render nothing.
      const html = fs.readFileSync(bundle, "utf8");
      const external = html.match(/<script src="[^"]+"/g) || [];
      t.ok(`${out} has no external <script src>`, external.length === 0,
        external.join(", ") || "fully self-contained");
    }
  }
};
