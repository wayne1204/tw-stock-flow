/**
 * Browser-integration test for index.html (大盤今日): the day's tiles and the
 * shared market chart with its futures panel, booted in jsdom like
 * render.test.js does for drawdown.html.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { buildHtml } = require("./render.test.js");

const WEB = path.join(__dirname, "..", "..", "web");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function liveData() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(WEB, "data", "taiex-daily.js"), "utf8"), sandbox);
  return sandbox.window;
}
const asJs = (meta, data) =>
  `window.TAIEX_META=${JSON.stringify(meta)};\nwindow.TAIEX_DATA=${JSON.stringify(data)};\n`;

async function boot(dataJs) {
  const { JSDOM, VirtualConsole } = require("jsdom");
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push("jsdomError: " + (e.stack || e.message)));
  vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));
  vc.on("warn", (...a) => errors.push("console.warn: " + a.join(" ")));
  const dom = new JSDOM(buildHtml(dataJs, "index.html"), {
    runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    url: "http://localhost/index.html"
  });
  await sleep(1200);
  return { dom, doc: dom.window.document, window: dom.window, errors };
}

const tileText = (doc, label) => {
  const k = [...doc.querySelectorAll(".kpi")].find(x => x.querySelector(".k").textContent === label);
  return k ? { v: k.querySelector(".v").textContent.trim(), n: k.querySelector(".n").textContent.trim(),
               cls: k.querySelector(".v").className } : null;
};

module.exports = {
  name: "index.html (大盤今日) — tiles, chart & futures panel",

  needs() {
    try { require.resolve("jsdom"); require.resolve("echarts/dist/echarts.min.js"); }
    catch { return "jsdom/echarts not installed — run: npm install --save-dev jsdom echarts"; }
    return fs.existsSync(path.join(WEB, "data", "taiex-daily.js")) ? null
      : "web/data/taiex-daily.js not built";
  },

  async run(t) {
    const { TAIEX_META: META, TAIEX_DATA: D } = liveData();
    const last = D[D.length - 1];
    const fmt = (v, d) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

    // ── Live data ────────────────────────────────────────────────────────
    {
      const { dom, doc, window, errors } = await boot(asJs(META, D));
      try {
        t.ok("no uncaught errors or console errors/warnings", errors.length === 0,
          errors.slice(0, 3).join(" || ") || "clean");
        t.ok("app is revealed and the error banner hidden",
          !doc.getElementById("app").hidden && doc.getElementById("error").hidden);
        t.eq("大盤今日 tab is current",
          doc.querySelector('.tabs a[aria-current="page"]').getAttribute("href"), "index.html");

        const groups = ["t-index", "t-flow", "t-margin", "t-fut"].map(id => doc.querySelectorAll(`#${id} .kpi`).length);
        t.eq("tile groups: index 3, 法人 4, 融資 3, 期貨 2", groups, [3, 4, 3, 2]);
        t.ok("every tile has a value", [...doc.querySelectorAll(".kpi .v")].every(v => v.textContent.trim()));

        t.eq("加權指數 tile shows the latest close", tileText(doc, "加權指數").v, fmt(last.close, 2));
        const fx = tileText(doc, "外資");
        t.eq("外資 tile shows the latest net", fx.v, (last.foreignNetYi > 0 ? "+" : "") + fmt(last.foreignNetYi, 1) + " 億");
        t.ok("外資 tile is coloured by sign", fx.cls.includes(last.foreignNetYi >= 0 ? "pos" : "neg"), fx.cls);
        const futLast = [...D].reverse().find(r => r.foreignTxNetOI !== null && r.foreignTxNetOI !== undefined);
        t.ok("live data carries foreign futures net OI", !!futLast, futLast && futLast.date);
        t.eq("期貨 tile shows the latest foreign net OI",
          tileText(doc, "外資台指期淨未平倉").v, fmt(futLast.foreignTxNetOI, 0) + " 口");
        t.ok("meta line names the latest session", doc.getElementById("meta").textContent
          .startsWith(last.date.replace(/-/g, "/")), doc.getElementById("meta").textContent);

        const chart = window.echarts.getInstanceByDom(doc.getElementById("chart"));
        const opt = chart.getOption();
        t.eq("eight panels (seven market panels + futures)", opt.grid.length, 8);
        t.eq("eight series, no band hosts", opt.series.length, 8);
        t.ok("no correction bands on the daily chart",
          opt.series.every(s => !s.markArea || !(s.markArea.data || []).length));
        const fut = opt.series.find(s => s.name === "外資台指期淨未平倉");
        t.ok("futures panel plots the net OI on the last panel",
          fut && fut.xAxisIndex === 7 && fut.data[D.length - 1] === (last.foreignTxNetOI ?? "-"));
        t.ok("futures panel title is rendered",
          opt.title.some(x => x.text === "外資台指期淨未平倉（口）"));
        t.ok("sessions before TAIFEX's window are gaps, not zeros", fut.data[0] === "-");

        const dz = opt.dataZoom[0];
        const span = Date.parse(D[dz.endValue].date) - Date.parse(D[dz.startValue].date);
        t.ok("opens on about the last six months", dz.endValue === D.length - 1 &&
          span > 150 * 864e5 && span < 190 * 864e5, `${D[dz.startValue].date} → ${D[dz.endValue].date}`);

        const tip = opt.tooltip[0].formatter([{ dataIndex: D.length - 1 }]);
        t.ok("tooltip includes the futures position", tip.includes("外資台指期淨未平倉"));

        doc.querySelector("#seg-etf button[data-v='excl']").click();
        const bal = chart.getOption().series.find(s => s.name === "融資餘額");
        t.ok("排除 ETF switches the chart's balance series",
          bal.data[D.length - 1] === (last.marginBalanceExEtfYi ?? "-"));
        doc.querySelector("#seg-chart button[data-v='line']").click();
        t.eq("chart type toggles to a line", chart.getOption().series[0].type, "line");
        t.eq("…and keeps the six-month view", chart.getOption().dataZoom[0].startValue, dz.startValue);
        t.ok("no errors after interacting", errors.length === 0, errors.slice(0, 3).join(" || ") || "clean");
      } finally { dom.window.close(); }
    }

    // ── Lagging chip data is dated, not passed off as today's ────────────
    {
      const cut = D.map(r => ({ ...r }));
      const n = cut.length - 1;
      cut[n].marginRatio = null;
      cut[n].foreignTxNetOI = null;
      const { dom, doc, errors } = await boot(asJs(META, cut));
      try {
        const prevDate = cut[n - 1].date.slice(5).replace("-", "/");
        t.ok("維持率 tile names the earlier session it shows",
          tileText(doc, "融資維持率").n.includes(`資料日 ${prevDate}`), tileText(doc, "融資維持率").n);
        t.ok("期貨 tile names the earlier session it shows",
          tileText(doc, "外資台指期淨未平倉").n.includes(`資料日 ${prevDate}`));
        t.ok("加權指數 tile carries no lag note", !tileText(doc, "加權指數").n.includes("資料日"));
        t.ok("no errors with lagging fields", errors.length === 0, errors.slice(0, 3).join(" || ") || "clean");
      } finally { dom.window.close(); }
    }

    // ── No data: the banner, not an empty shell ──────────────────────────
    {
      const { dom, doc } = await boot(asJs({}, []));
      try {
        t.ok("no data: error banner shown and app kept hidden",
          !doc.getElementById("error").hidden && doc.getElementById("app").hidden);
      } finally { dom.window.close(); }
    }
  }
};
