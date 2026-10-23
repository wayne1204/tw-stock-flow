/**
 * Browser-integration test for stock.html.
 *
 * Boots the real page in jsdom with real ECharts (SVG renderer) against a
 * small synthetic stock, so it runs without data/stocks/ and pins down the
 * page's own behaviour: KPIs, the chart, broker tables and the period toggle.
 * Same canvas/layout stub idea as render.test.js.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const WEB = path.join(__dirname, "..", "..", "web");
const read = p => fs.readFileSync(path.join(WEB, p), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fixture() {
  const daily = [];
  const d0 = Date.UTC(2026, 6, 1);
  let px = 500;
  for (let i = 0; daily.length < 80; i++) {
    const dt = new Date(d0 + i * 864e5);
    if (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) continue;
    const o = px, c = px + ((i % 5) - 2) * 3;
    px = c;
    const n = daily.length;
    daily.push({
      date: dt.toISOString().slice(0, 10), open: o, high: Math.max(o, c) + 2,
      low: Math.min(o, c) - 2, close: c, volume: 1000 + n,
      foreign: n % 2 ? 300 : -200, trust: 50, dealer: n === 40 ? null : -10,
      marginBalance: 5000 + n, marginChange: n ? 1 : null,
      // Main force only covers the tail, as from the live source
      mainForce: n >= 35 ? (n % 3 ? 120 : -80) : null
    });
  }
  const fridays = daily.filter(r => new Date(r.date).getUTCDay() === 5);
  const holders = fridays.map((r, k) => ({
    date: r.date, holders: 100000 + k * 100, avgLots: 5, big400: 300 - k,
    big400Pct: 70 - k / 10, big1000: 150, big1000Pct: 60
  }));
  const side = s => Array.from({ length: 15 }, (_, k) =>
    ({ name: `${s}${k}`, buy: 100, sell: 10, net: 90 - k, pct: 0.5 }));
  const stock = {
    code: "9999", name: "測試股", generatedAt: "2026-10-18T08:00:00",
    start: daily[0].date, end: daily[daily.length - 1].date, daily, holders,
    // Windows exist only as of the latest session, and only 5 and 20 days
    brokers: { "5": { updated: daily[daily.length - 1].date, buy: side("B5"), sell: side("S5").slice(0, 3) } }
  };
  // Every session's own broker table, latest included, as fetch_stocks.py stores it (arrays)
  const arr = x => [x.name, x.buy, x.sell, x.net, x.pct];
  stock.brokerDaily = { [daily[60].date]: { buy: [["過去券商", 10, 1, 9, 0.1]], sell: [["賣方", 1, 5, 4, 0.1]],
                                            totalBuy: 9, totalSell: 4 },
                        [daily[daily.length - 1].date]: { buy: side("B").map(arr), sell: side("S").map(arr),
                                                          totalBuy: 1500, totalSell: 150 } };
  stock.tracked = true;
  // A whole-market stock off the watchlist: same series, no broker data
  const other = { ...stock, code: "8888", name: "另一檔", tracked: false, brokers: {}, brokerDaily: {},
                  daily: daily.map(r => ({ ...r, mainForce: null })),
                  // A 1:2 split before session 50: prices before it are halved on the chart
                  adjustments: [{ date: daily[50].date, kind: "分割", before: 600, ref: 300, ratio: 2 }] };
  return { stock, other, list: [{ code: "9999", name: "測試股", end: stock.end, tracked: true },
                                { code: "8888", name: "另一檔", end: stock.end, tracked: false }] };
}

function buildHtml({ stock, other, list }, apiStub = "") {
  let html = read("stock.html");
  const STUB = `<script>
    HTMLCanvasElement.prototype.getContext = function(){
      const noop = function(){ return this; };
      return new Proxy({ measureText: t => ({ width: String(t).length * 6.6 }),
        canvas:{width:300,height:150} }, { get:(o,k)=> k in o ? o[k] : noop });
    };
    var vis = function(el){ for (var n=el;n&&n.nodeType===1;n=n.parentElement) if(n.hidden) return false; return true; };
    var size = function(el){ return el.id==='chart' && vis(el) ? {w:1400,h:1200} : {w:0,h:0}; };
    ['clientWidth','offsetWidth'].forEach(k=>Object.defineProperty(HTMLElement.prototype,k,{get(){return size(this).w;}}));
    ['clientHeight','offsetHeight'].forEach(k=>Object.defineProperty(HTMLElement.prototype,k,{get(){return size(this).h;}}));
    HTMLElement.prototype.getBoundingClientRect = function(){ var s=size(this);
      return {width:s.w,height:s.h,top:0,left:0,right:s.w,bottom:s.h,x:0,y:0}; };
  </script>`;
  html = html.replace("<title>", STUB + apiStub + "<title>");
  html = html.replace(/<script src="https:\/\/cdn[^"]*"><\/script>/,
    `<script>${fs.readFileSync(require.resolve("echarts/dist/echarts.min.js"), "utf8")}</script>`);
  html = html.replace('<script src="data/stocks/index.js"></script>',
    `<script>window.STOCK_LIST=${JSON.stringify(list)};` +
    `window.STOCK_DATA={"${stock.code}":${JSON.stringify(stock)},"${other.code}":${JSON.stringify(other)}};</script>`);
  return html.replace("renderer:'canvas'", "renderer:'svg'");
}

module.exports = {
  name: "stock.html — render & interaction",

  needs() {
    try { require.resolve("jsdom"); require.resolve("echarts/dist/echarts.min.js"); }
    catch { return "jsdom/echarts not installed — run: npm install"; }
    return null;
  },

  async run(t) {
    const { JSDOM, VirtualConsole } = require("jsdom");
    const errors = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", e => errors.push(e.message));
    vc.on("error", (...a) => errors.push(a.join(" ")));
    vc.on("warn", (...a) => errors.push(a.join(" ")));

    const fx = fixture();
    const dom = new JSDOM(buildHtml(fx), { runScripts: "dangerously", pretendToBeVisual: true,
      virtualConsole: vc, url: "http://localhost/stock.html" });
    const { window } = dom, doc = window.document;
    try {
      await sleep(1200);
      t.ok("no uncaught errors or console noise", errors.length === 0, errors.slice(0, 3).join(" || ") || "clean");
      t.ok("error banner hidden", doc.getElementById("error").hidden);
      t.eq("title names the stock", doc.getElementById("title").textContent, "9999 測試股");
      t.eq("a plain visit leaves the URL alone", window.location.hash, "");
      t.eq("date box starts on the latest session", doc.getElementById("d-pick").value, fx.stock.end);

      const kpis = [...doc.querySelectorAll("#kpis .kpi")];
      t.eq("8 KPI cards", kpis.length, 8);
      const last = fx.stock.daily[fx.stock.daily.length - 1];
      const kv = k => [...doc.querySelectorAll("#kpis .kpi")].find(x => x.querySelector(".k").textContent.startsWith(k)).querySelector(".v").textContent;
      t.eq("foreign KPI is the last day's net", kv("外資"), (last.foreign > 0 ? "+" : "") + last.foreign.toLocaleString("en-US"));
      t.eq("margin KPI is the last balance", kv("融資餘額"), last.marginBalance.toLocaleString("en-US"));

      const chart = window.echarts.getInstanceByDom(doc.getElementById("chart"));
      const opt = chart.getOption();
      t.eq("8 stacked panels", opt.grid.length, 8);
      const series = name => opt.series.find(s => s.name === name);
      t.ok("candlestick present", series("日K") && series("日K").type === "candlestick");
      t.ok("missing dealer day is a gap, not 0", series("自營商").data[40] === "-");
      t.ok("main force before coverage is a gap", series("主力買賣超").data[0] === "-");
      const hold = series("股東人數").data.filter(v => v !== "-").length;
      t.eq("every in-range holder week is plotted", hold, fx.stock.holders.length);
      const dz = opt.dataZoom[0];
      t.eq("default range is 6M (or all when shorter)", [dz.start, dz.end], [0, 100]);

      t.eq("15 buy rows for 1 day", doc.querySelectorAll("#brokers .tbl:first-child tbody tr").length, 15);
      doc.querySelector('#seg-period button[data-v="5"]').click();
      t.eq("period toggle swaps tables", doc.querySelectorAll("#brokers .tbl:last-child tbody tr").length, 3);
      t.ok("no 60-day window", !doc.querySelector('#seg-period button[data-v="60"]'));
      doc.querySelector('#seg-period button[data-v="20"]').click();
      t.ok("period without data says so", /沒有分點資料/.test(doc.getElementById("br-sum").textContent));

      // ── Date box ──
      const pickDate = v => { const el = doc.getElementById("d-pick"); el.value = v;
        el.dispatchEvent(new window.Event("change")); };
      const d60 = fx.stock.daily[60];
      pickDate(d60.date);
      t.ok("KPIs follow the picked date", kv("收盤").includes(d60.close.toLocaleString("en-US")) &&
        kpis.length && doc.querySelector("#kpis .kpi .k").textContent.includes(d60.date.replace(/-/g, "/")),
        doc.querySelector("#kpis .kpi .k").textContent);
      doc.querySelector('#seg-period button[data-v="1"]').click();
      t.ok("1-day brokers come from that day's own table",
        doc.querySelector("#brokers tbody td").textContent === "過去券商");
      t.ok("5/20 disabled on a past date",
        doc.querySelector('#seg-period button[data-v="5"]').disabled);
      const sat = new Date(Date.parse(d60.date) + 864e5 * ((6 - new Date(d60.date).getUTCDay() + 7) % 7 || 7));
      pickDate(sat.toISOString().slice(0, 10));
      t.ok("a non-trading day snaps to the session before it",
        fx.stock.daily.some(r => r.date === doc.getElementById("d-pick").value) &&
        doc.getElementById("d-pick").value <= sat.toISOString().slice(0, 10), doc.getElementById("d-pick").value);
      doc.getElementById("d-latest").click();
      t.eq("最新 returns to the last session", doc.getElementById("d-pick").value, fx.stock.end);
      t.ok("5-day toggle enabled again", !doc.querySelector('#seg-period button[data-v="5"]').disabled);

      // ── Chart click and MA legend ──
      const legend = () => chart.getOption().legend[0];
      const ma5 = fx.stock.daily.slice(-5).reduce((a, r) => a + r.close, 0) / 5;
      t.eq("MA legend over the K panel", legend().data, ["MA5", "MA20", "MA60"]);
      t.eq("legend reads the selected session's MA", legend().formatter("MA5"),
        "MA5 " + ma5.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      const d30 = fx.stock.daily[30];
      const [px, py] = chart.convertToPixel({ gridIndex: 0 }, [d30.date, d30.close]);
      chart.getZr().trigger("click", { offsetX: px, offsetY: py });
      t.eq("clicking a K bar selects its date", doc.getElementById("d-pick").value, d30.date);
      t.eq("and the legend follows it", legend().formatter("MA60"), "MA60");   // < 60 sessions in
      doc.getElementById("d-latest").click();

      // ── 法人 toggles ──
      const instNames = () => chart.getOption().series.filter(x => x.xAxisIndex === 2 && x.data && x.data.length)
        .map(x => x.name);
      const tog = k => doc.querySelector(`#seg-inst button[data-v="${k}"]`).click();
      t.eq("all four on by default", instNames(), ["外資", "投信", "自營商", "三大法人合計"]);
      tog("trust"); tog("dealer"); tog("total");
      t.eq("only 外資 left: one red/green bar series", instNames(), ["外資買賣超"]);
      tog("foreign");
      t.eq("the last one cannot be switched off", instNames(), ["外資買賣超"]);
      tog("total"); tog("foreign");
      t.eq("合計 alone", instNames(), ["合計買賣超"]);

      // ── Theme ──
      const upColor = () => chart.getOption().series.find(x => x.type === "candlestick").itemStyle.color;
      const darkUp = upColor();
      t.eq("starts dark", doc.documentElement.dataset.theme, "dark");
      doc.getElementById("btn-theme").click();
      t.eq("toggle switches to light", doc.documentElement.dataset.theme, "light");
      t.eq("choice is remembered", window.localStorage.getItem("atlas-theme"), "light");
      // The palette swap itself is not asserted: jsdom does not resolve custom
      // properties set under :root[data-theme="light"]. Checked in Chromium
      // instead (candles #e66767 -> #d13c3c, body background light).
      doc.getElementById("btn-theme").click();
      t.eq("and back to dark", [doc.documentElement.dataset.theme, upColor()], ["dark", darkUp]);

      doc.querySelector('#seg-range button[data-v="21"]').click();
      await sleep(100);
      const z = chart.getOption().dataZoom[0];
      t.eq("1M range zooms to the last 21 sessions", [z.startValue, z.endValue], [59, 79]);

      // ── Stock search ──
      const q = doc.getElementById("q");
      const search = v => { q.value = v; q.dispatchEvent(new window.Event("change")); };
      t.eq("search box shows the stock", q.value, "9999 測試股");
      t.ok("search box has no suggestion dropdown", !q.hasAttribute("list") && !doc.querySelector("datalist"));
      t.ok("no API here: account UI, 自選 chips and ☆ stay hidden",
        doc.getElementById("account").hidden && doc.getElementById("chips").hidden &&
        doc.getElementById("btn-fav").hidden);
      t.ok("no API here: no left column, the page keeps its full width",
        doc.getElementById("side").hidden && !doc.getElementById("layout").classList.contains("with-side"));
      search("另一");
      await sleep(50);
      t.eq("a partial name finds the stock", doc.getElementById("title").textContent, "8888 另一檔");
      t.eq("an explicit pick goes into the URL", window.location.hash, "#8888");
      const k = chart.getOption().series.find(x => x.type === "candlestick");
      const vol = chart.getOption().series.find(x => x.name === "成交量").data;
      t.eq("a split rescales the sessions before it, not after",
        [k.data[10][1], vol[10].value, k.data[60][1], vol[60].value],
        [fx.stock.daily[10].close / 2, fx.stock.daily[10].volume * 2, fx.stock.daily[60].close, fx.stock.daily[60].volume]);
      t.ok("the split is marked on the K panel and named in the subtitle",
        k.markLine.data.length === 1 && /已還原 .* 分割（600\.00 → 參考價 300\.00）/.test(doc.getElementById("meta").textContent),
        doc.getElementById("meta").textContent);
      t.ok("stock without broker data says so",
        /沒有主力進出/.test(doc.getElementById("br-sum").textContent));
      search("不存在的股票");
      t.ok("no match says so and keeps the stock", /找不到/.test(doc.getElementById("q-msg").textContent) &&
        doc.getElementById("title").textContent === "8888 另一檔");
      search("9999");
      await sleep(50);
      t.eq("a code finds the stock", doc.getElementById("title").textContent, "9999 測試股");
    } finally {
      window.close();
    }

    await accountFlow(t, fx);
  }
};

/**
 * The page against a stubbed /api: what lib/account.mjs answers, recorded so
 * the requests themselves can be checked. jsdom has no fetch, so the stub is
 * the only one.
 */
async function accountFlow(t, fx) {
  const { JSDOM, VirtualConsole } = require("jsdom");
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(e.message));
  const API = `<script>
    window.__api = { signedIn: true, favs: ["8888"], calls: [] };
    window.fetch = async function(url, o) {
      o = o || {};
      const A = window.__api, path = String(url).split("api/").pop();
      A.calls.push({ path, method: o.method || "GET", body: o.body });
      const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
      if (path === "config") return res(200, { accounts: true, googleClientId: "cid" });
      if (path === "me") return A.signedIn ? res(200, { user: { name: "Ann", email: "a@x" }, favourites: A.favs })
                                           : res(401, { error: "not signed in" });
      if (path === "favourites") { A.favs = JSON.parse(o.body).codes; return res(200, { favourites: A.favs }); }
      if (path === "logout") { A.signedIn = false; return res(200, { ok: true }); }
      return res(404, {});
    };
  </script>`;
  const dom = new JSDOM(buildHtml(fx, API), { runScripts: "dangerously", pretendToBeVisual: true,
    virtualConsole: vc, url: "http://localhost/stock.html" });
  const { window } = dom, doc = window.document;
  const chipCodes = () => [...doc.querySelectorAll("#chips button")].map(b => b.dataset.code);
  try {
    await sleep(1200);
    t.ok("[account] no errors", errors.length === 0, errors.slice(0, 3).join(" || ") || "clean");
    t.ok("[account] signed in: name shown, sign-in button hidden",
      !doc.getElementById("account").hidden && doc.getElementById("acct-name").textContent === "Ann" &&
      doc.getElementById("gsi").hidden);
    t.ok("[account] account and 自選 sit in the left column",
      !doc.getElementById("side").hidden && doc.getElementById("layout").classList.contains("with-side") &&
      doc.getElementById("side").contains(doc.getElementById("account")) &&
      doc.getElementById("side").contains(doc.getElementById("chips")));
    t.eq("[account] chips are the user's own list, not stocks.txt", chipCodes(), ["8888"]);
    t.eq("[account] a list row shows code and name, with a count",
      [doc.querySelector('#chips button[data-code="8888"] .code').textContent +
       doc.querySelector('#chips button[data-code="8888"] .nm').textContent, doc.getElementById("fav-count").textContent],
      ["8888另一檔", "1"]);
    const fav = doc.getElementById("btn-fav");
    t.eq("[account] ☆ for a stock not in the list", [fav.hidden, fav.textContent], [false, "☆ 加入自選"]);
    fav.click();
    await sleep(50);
    const put = window.__api.calls.filter(c => c.path === "favourites").pop();
    t.eq("[account] ☆ saves the list with this stock added", put && JSON.parse(put.body), { codes: ["8888", "9999"] });
    t.eq("[account] button and chips follow", [fav.textContent, chipCodes()], ["★ 已自選", ["8888", "9999"]]);
    // Drag 9999 above 8888 with a mouse; jsdom has no layout, so the drop
    // target comes from a stubbed elementFromPoint.
    const ptr = (type, el, y) => {
      const e = new window.MouseEvent(type, { bubbles: true, clientX: 0, clientY: y, button: 0 });
      Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
      el.dispatchEvent(e);
    };
    const c8 = doc.querySelector('#chips button[data-code="8888"]');
    const c9 = doc.querySelector('#chips button[data-code="9999"]');
    doc.elementFromPoint = () => c8;
    ptr("pointerdown", c9, 40); ptr("pointermove", c9, -10); ptr("pointerup", c9, -10);
    c9.click();                                   // the click a drop produces
    await sleep(50);
    const order = window.__api.calls.filter(c => c.path === "favourites").pop();
    t.eq("[account] dragging a chip reorders and saves the list",
      [chipCodes(), JSON.parse(order.body)], [["9999", "8888"], { codes: ["9999", "8888"] }]);
    t.eq("[account] the drop does not open the dragged stock", doc.getElementById("title").textContent, "9999 測試股");
    doc.querySelector('#chips button[data-code="9999"] .rm').click();
    await sleep(50);
    t.eq("[account] × removes the stock without opening another",
      [chipCodes(), JSON.parse(window.__api.calls.filter(c => c.path === "favourites").pop().body),
       doc.getElementById("title").textContent], [["8888"], { codes: ["8888"] }, "9999 測試股"]);
    doc.getElementById("btn-fav").click();         // back to 8888, 9999 for the steps below
    await sleep(50);
    doc.querySelector('#chips button[data-code="8888"]').click();
    await sleep(50);
    t.eq("[account] a chip opens its stock", doc.getElementById("title").textContent, "8888 另一檔");
    fav.click();
    await sleep(50);
    t.eq("[account] ★ removes it again", chipCodes(), ["9999"]);
    doc.getElementById("btn-logout").click();
    await sleep(50);
    t.ok("[account] logout hides the list and asks to sign in",
      doc.getElementById("chips").hidden && doc.getElementById("acct-user").hidden && !doc.getElementById("gsi").hidden &&
      !doc.getElementById("fav-signin").hidden && !doc.getElementById("side").hidden);
    fav.click();
    t.ok("[account] ☆ while signed out asks to sign in first",
      /請先登入/.test(doc.getElementById("acct-msg").textContent));
  } finally {
    window.close();
  }
}
