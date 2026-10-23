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
const BUNDLE = path.join(ROOT, "dist", "taiex-atlas-standalone.html");

// Everything bundle.py inlines. detect.js and the data file are pulled in via
// index.html's <script src>, so a change to either also invalidates the build.
const SOURCES = ["index.html", path.join("js", "detect.js"), path.join("data", "taiex-daily.js")];

const mtime = p => fs.statSync(p).mtimeMs;

module.exports = {
  name: "bundle — dist/ is current with its sources",

  needs: () => fs.existsSync(BUNDLE)
    ? null
    : "dist/taiex-atlas-standalone.html not built — run `python3 pipeline/bundle.py`",

  run(t) {
    const built = mtime(BUNDLE);

    for (const rel of SOURCES) {
      const src = path.join(WEB, rel);
      if (!fs.existsSync(src)) {
        t.ok(`${rel} exists`, false, "referenced by the bundle but missing");
        continue;
      }
      const age = (mtime(src) - built) / 1000;
      t.ok(`${rel} is not newer than the bundle`, age <= 0,
        age <= 0 ? `${Math.round(-age)}s older`
                 : `${Math.round(age)}s NEWER — run \`python3 pipeline/bundle.py\``);
    }

    // A bundle that failed to inline something is worse than a stale one: it
    // would try to reach the network from a file:// page and render nothing.
    const html = fs.readFileSync(BUNDLE, "utf8");
    const external = html.match(/<script src="[^"]+"/g) || [];
    t.ok("bundle has no external <script src>", external.length === 0,
      external.join(", ") || "fully self-contained");
  }
};
