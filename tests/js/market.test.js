/**
 * The whole-market backtest: pipeline/build_market_backtest.js's aggregate()
 * over synthetic stocks, then backtest.html booted in jsdom on its output.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { aggregate } = require("../../pipeline/build_market_backtest.js");

const WEB = path.join(__dirname, "..", "..", "web");
const read = p => fs.readFileSync(path.join(WEB, p), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Weekday dates from 2024-01-01
function sessions(n) {
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const d = new Date(Date.UTC(2024, 0, 1) + i * 864e5);
    if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
// Stock k: volume cycles every 20 sessions, shifted by k, and every session
// opens at 100 and closes 5 sessions later's cycle position above it, so on
// any day the stocks with the larger volume ratio return more over 5 days.
function stock(code, n, k) {
  return { code, name: code, holders: [], daily: sessions(n).map((date, i) => ({
    date, open: 100, high: 130, low: 90, close: 100 + ((i - 5 + k) % 20 + 20) % 20,
    volume: 100 + 5 * ((i + k) % 20), foreign: (i * 7 + k) % 11 - 5, trust: 1,
    marginBalance: 1000 + ((i * 3 + k) % 13), mainForce: null })) };
}
const STOCKS = [...Array.from({ length: 40 }, (_, k) => stock(String(1000 + k), 150, k)),
                stock("0050", 150, 3),    // an ETF: left out
                stock("9998", 100, 5)];   // under 120 sessions: left out
const FLAT = sessions(150).map(date => ({ date, open: 1000, close: 1000 }));

function buildHtml(data) {
  let html = read("backtest.html");
  const STUB = `<script>
    HTMLCanvasElement.prototype.getContext = function(){
      const noop = function(){ return this; };
      return new Proxy({ measureText: t => ({ width: String(t).length * 6.6 }),
        canvas:{width:300,height:150} }, { get:(o,k)=> k in o ? o[k] : noop });
    };
    ['clientWidth','offsetWidth'].forEach(k=>Object.defineProperty(HTMLElement.prototype,k,{get(){return 1200;}}));
    ['clientHeight','offsetHeight'].forEach(k=>Object.defineProperty(HTMLElement.prototype,k,{get(){return 400;}}));
  </script>`;
  html = html.replace("<title>", STUB + "<title>");
  html = html.replace(/<script src="https:\/\/cdn[^"]*"><\/script>/,
    `<script>${fs.readFileSync(require.resolve("echarts/dist/echarts.min.js"), "utf8")}</script>`);
  html = html.replace('<script src="data/market-backtest.js"></script>',
    data ? `<script>window.MARKET_BACKTEST=${JSON.stringify(data)};</script>` : "");
  return html.replace("renderer:'canvas'", "renderer:'svg'");
}

module.exports = {
  name: "market backtest — aggregate & backtest.html",

  needs() {
    try { require.resolve("jsdom"); require.resolve("echarts/dist/echarts.min.js"); }
    catch { return "jsdom/echarts not installed — run: npm install"; }
    return null;
  },

  async run(t) {
    const res = aggregate(STOCKS, FLAT);
    const raw5 = res.views["raw-5"];
    const vol = raw5.find(f => f.key === "volume");
    t.eq("ETFs and stocks under 120 sessions are left out", res.stocks, 40);
    t.eq("three horizons, raw and relative", Object.keys(res.views),
      ["raw-5", "raw-20", "raw-60", "rel-5", "rel-20", "rel-60"]);
    t.eq("factors keep the fixed order; those without data (or never varying, 投信) are left out",
      raw5.map(f => f.key), ["ma", "volume", "foreign", "margin"]);
    t.ok("per-stock IC box runs low to high", vol.box.every((v, i) => !i || v >= vol.box[i - 1]), vol.box.join(" "));
    t.ok("the cross-section sees the volume lead (IC well above 0)",
      vol.cross.sessions > 100 && vol.cross.meanIC > 0.9, `${vol.cross.sessions} sessions, IC ${vol.cross.meanIC}`);
    t.eq("cross-sectional IC is averaged by month", vol.cross.months.map(m => m[0]),
      ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05", "2024-06", "2024-07"]);
    t.ok("against a flat index, relative equals raw", JSON.stringify(res.views["rel-5"]) === JSON.stringify(raw5));

    const { JSDOM, VirtualConsole } = require("jsdom");
    const errors = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", e => errors.push(e.message));
    vc.on("error", (...a) => errors.push(a.join(" ")));
    const data = { generatedAt: "2026-10-25T20:00:00", ...res };
    let dom = new JSDOM(buildHtml(data), { runScripts: "dangerously", pretendToBeVisual: true,
      virtualConsole: vc, url: "http://localhost/backtest.html" });
    let { window } = dom, doc = window.document;
    const cell = (key, col) => doc.querySelector(`#t-sum tr[data-key="${key}"] td[data-col="${col}"]`).textContent;
    try {
      await sleep(300);
      t.ok("page renders without errors", errors.length === 0 && doc.getElementById("error").hidden,
        errors.slice(0, 3).join(" || ") || "clean");
      t.ok("its tab is the current one",
        doc.querySelector('.tabs a[aria-current="page"]').getAttribute("href") === "backtest.html");
      t.ok("meta names the universe and span", /40 檔/.test(doc.getElementById("meta").textContent) &&
        /2024\/01\/01/.test(doc.getElementById("meta").textContent), doc.getElementById("meta").textContent);
      t.eq("table rows follow the fixed order",
        [...doc.querySelectorAll("#t-sum tbody tr")].map(r => r.dataset.key), ["ma", "volume", "foreign", "margin"]);
      const ic = window.echarts.getInstanceByDom(doc.getElementById("c-ic")).getOption();
      t.eq("IC chart: one box per factor, same order", ic.yAxis[0].data, ["均線位置", "量能變化", "外資", "融資"]);
      const q = window.echarts.getInstanceByDom(doc.getElementById("c-q")).getOption();
      t.eq("quintile chart: one small chart per factor", q.series.length, 4);
      t.ok("cross-section heatmap is drawn",
        window.echarts.getInstanceByDom(doc.getElementById("c-xs")).getOption().series[0].data.length > 0);
      t.eq("defaults to 20 days, raw", doc.getElementById("t-hint").textContent, "往後 20 日 · 原始報酬");

      doc.querySelector('#seg-h button[data-v="5"]').click();
      t.eq("horizon toggle switches the view", cell("volume", "xs"),
        (vol.cross.meanIC > 0 ? "+" : "") + vol.cross.meanIC.toFixed(3));
      doc.querySelector('#seg-rel button[data-v="rel"]').click();
      t.ok("relative toggle says so", /相對加權指數/.test(doc.getElementById("t-hint").textContent) &&
        /扣除同期加權指數/.test(doc.getElementById("note").textContent));
      t.ok("no-advice footer", /不構成投資建議/.test(doc.querySelector("footer").textContent));
      t.ok("still no errors after toggling", errors.length === 0, errors.slice(0, 3).join(" || ") || "clean");
    } finally {
      window.close();
    }

    dom = new JSDOM(buildHtml(null), { runScripts: "dangerously", pretendToBeVisual: true,
      virtualConsole: vc, url: "http://localhost/backtest.html" });
    ({ window } = dom); doc = window.document;
    try {
      await sleep(100);
      t.ok("without data the page says how to build it",
        !doc.getElementById("error").hidden && /build_market_backtest/.test(doc.getElementById("error").textContent) &&
        doc.getElementById("app").hidden);
    } finally {
      window.close();
    }
  }
};
