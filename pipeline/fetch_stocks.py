#!/usr/bin/env python3
"""
Single-stock monitor - data fetcher

Builds a daily series for EVERY listed (TWSE) and OTC (TPEx) stock and ETF
(about 2,200), plus richer broker data for the stocks on the watchlist
(stocks.txt):

  Every stock                  TWSE (上市)          TPEx (上櫃)       per
  1. Daily OHLC + volume       MI_INDEX             afterTrading/otc  day, whole market
  2. Institutional net         T86                  insti/dailyTrade  day, whole market
  3. Margin balance / change   MI_MARGN ALL         margin/balance    day, whole market
  4. Shareholder distribution  norway.twsthr.info (both markets)      stock, weekly

  Tracked stocks only (one request per stock per session - too many for all)
  5. Main-force net + brokers  fubon-ebrokerdj (DJ)     (daily tables, 5/20-day windows)

Tracked = config/stocks.txt (the watchlist) + config/top200.txt (the top 200 stocks by
trading value, written by --refresh-top) + --stocks. Day tables are fetched for
the last --broker-months (default 12); older days are served from the cache only.

The whole-market queries cost six requests a day (three per exchange) however
many stocks are built; they are cached slimmed down to the columns read back. The trading
calendar comes from the TAIEX months fetch_data.py already caches. Shareholder
pages are refreshed once a week (TDCC publishes weekly), so a normal nightly
run is six exchange requests plus the watchlist's broker pages; the first run
after each Saturday also walks every stock's shareholder page (~75 min).

Outputs:
  web/data/stocks/<code>.js  one stock, as window.STOCK_DATA[code] (works over file://)
  web/data/stocks/index.js   window.STOCK_LIST: every built stock, watchlist first

Usage:
  python3 pipeline/fetch_stocks.py                     # whole market + watchlist extras
  python3 pipeline/fetch_stocks.py --watchlist-only    # just config/stocks.txt (fast)
  python3 pipeline/fetch_stocks.py --stocks 2327,2330  # just these, with broker data
  python3 pipeline/fetch_stocks.py --months 36         # deeper history (default 24)
  python3 pipeline/fetch_stocks.py --refresh-top       # re-rank config/top200.txt, then fetch
  python3 pipeline/fetch_stocks.py --rebuild           # no requests; cache only

Note: Chinese string literals below are matched against response payloads
(column headers, page labels). They are data and must not be translated.
"""

import argparse
import calendar as calendar_mod
import html
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta

import fetch_data as fd

ROOT = fd.ROOT
OUT_DIR = os.path.join(fd.DATA_DIR, "stocks")
WATCHLIST = os.path.join(ROOT, "config", "stocks.txt")
TOPLIST = os.path.join(ROOT, "config", "top200.txt")
DEFAULT_MONTHS = 24
DEFAULT_BROKER_MONTHS = 12
TOP_N, TOP_SESSIONS = 200, 60
LOCK = os.path.join(fd.DATA_DIR, ".fetch_stocks.lock")

# DJ broker pages are paced on their own: 0.8 s between requests, doubled (up
# to DJ_SLEEP_MAX) whenever a request fails, so a site that starts pushing back
# is met with a slower crawl rather than a burst of retries. Every DJ_RECOVER
# clean requests in a row halve it again, so a passing hiccup does not slow
# the rest of a long backfill.
DJ_SLEEP, DJ_SLEEP_MAX, DJ_RECOVER = 0.8, 3.2, 200
_dj = {"sleep": DJ_SLEEP, "ok": 0}

HOLDERS_URL = "https://norway.twsthr.info/StockHolders.aspx?stock={code}"
DJ_BASE = "https://fubon-ebrokerdj.fbs.com.tw"
# zco_<code>_N.djhtm is a window as of the latest session, N from the page's own
# <select name="D">: 2 = 5 days, 4 = 20. Only these are fetched: the one-day
# page repeats the day table below, and 主力 is each day table's own totals.
DJ_BROKER_PERIODS = {"5": "_2", "20": "_4"}
DJ_BROKER_URL = DJ_BASE + "/z/zc/zco/zco_{code}{suffix}.djhtm"
# Custom range (e = from, f = to, unpadded Y-M-D): one session's broker table
# for any past day. Past days never change, so these are cached for good.
DJ_BROKER_DAY_URL = DJ_BASE + "/z/zc/zco/zco.djhtm?a={code}&e={d}&f={d}"

LOTS = 1000  # shares per lot (張)

# Ordinary stocks (4 digits) and ETFs (00xx, 00xxx, 00xxxR ...). Excludes
# preferred shares (2881A), TDRs (91xxxx), ETNs (020xxx) and REIT certificates
# (01xxxT), which have no shareholder or institutional coverage worth a page.
UNIVERSE_RE = re.compile(r"\d{4}|00\d{2,4}[A-Z]?")

TPEX_BASE = "https://www.tpex.org.tw/www/zh-tw"


# --------------------------------------------------------------------------
# Watchlist
# --------------------------------------------------------------------------

def read_watchlist(path=WATCHLIST):
    """Stock codes from stocks.txt: one per line, `#` starts a comment."""
    if not os.path.exists(path):
        return []
    codes = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            code = line.split("#", 1)[0].strip()
            if code and code not in codes:
                codes.append(code)
    return codes


def rank_top(market, calendar, names, n=TOP_N, sessions=TOP_SESSIONS):
    """
    The n most-traded stocks (ETFs and other 00xx funds excluded), by average
    daily trading value (close x volume) over the last `sessions` sessions.
    """
    recent = [d for d in calendar if market[d][0]][-sessions:]
    total, seen = {}, {}
    for d in recent:
        for code, q in market[d][0].items():
            if not re.fullmatch(r"[1-9]\d{3}", code):
                continue
            close, lots = q[3], q[4]
            if close is None or lots is None:
                continue
            total[code] = total.get(code, 0) + close * lots * LOTS
            seen[code] = seen.get(code, 0) + 1
    # A code must trade on at least half the sessions: one huge day is not "most traded".
    avg = {c: total[c] / seen[c] for c in total if seen[c] * 2 >= len(recent)}
    return [(c, names.get(c), avg[c]) for c in sorted(avg, key=avg.get, reverse=True)[:n]]


def write_toplist(top, asof, path=TOPLIST):
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"# Top {len(top)} stocks by average daily trading value, last "
                f"{TOP_SESSIONS} sessions to {asof}.\n"
                "# Written by `fetch_stocks.py --refresh-top`; these get broker data too.\n")
        for code, name, v in top:
            f.write(f"{code}  # {(name or '').strip()} {v / 1e8:,.0f} 億/日\n")


# --------------------------------------------------------------------------
# TWSE: whole-market daily tables, slimmed before caching
# --------------------------------------------------------------------------

def _slim_result(rows, **extra):
    """
    A whole-market table with no rows is "no data", not a final answer: TPEx
    replies stat "ok" with an empty table for a day it has not published yet.
    Marking it _empty lets fetch() cache it as such and ask again (is_stale).
    """
    if not rows:
        return {"stat": "OK", "_empty": True}
    return {"stat": "OK", "rows": rows, **extra}


def _col(fields, test):
    for i, name in enumerate(fields):
        if test(str(name)):
            return i
    return None


def slim_t86(payload):
    """
    T86 -> {"rows": {code: [foreign, trust, dealer]}} in shares.

    Columns are located by header name, not position: TWSE inserted the
    外資自營商 columns in late 2017, shifting everything after them. Foreign
    is 外陸資 + 外資自營商, matching the market-level series in fetch_data.py.
    """
    fields = payload.get("fields") or []
    fgn = _col(fields, lambda f: f.startswith("外陸資買賣超") or f.startswith("外資買賣超"))
    fgn_dealer = _col(fields, lambda f: f.startswith("外資自營商買賣超"))
    trust = _col(fields, lambda f: f.startswith("投信買賣超"))
    dealer = _col(fields, lambda f: f.startswith("自營商買賣超") and "(" not in f)
    rows = {}
    for r in payload.get("data") or []:
        code = str(r[0]).strip()

        def num(i):
            return fd.parse_num(r[i]) if i is not None and i < len(r) else None

        f = num(fgn)
        fdlr = num(fgn_dealer)
        if f is not None and fdlr is not None:
            f += fdlr
        rows[code] = [f, num(trust), num(dealer)]
    return _slim_result(rows)


def slim_margin(payload):
    """MI_MARGN (selectType=ALL) -> {"rows": {code: [prev_balance, balance]}} in lots."""
    rows = {}
    for t in payload.get("tables") or []:
        fields = t.get("fields") or []
        if not fields or str(fields[0]).strip() != "代號":
            continue
        # 融資 comes first: 買進 賣出 現金償還 前日餘額 今日餘額 ...
        prev_i = _col(fields, lambda f: f == "前日餘額")
        bal_i = _col(fields, lambda f: f == "今日餘額")
        for r in t.get("data") or []:
            if prev_i is None or bal_i is None or len(r) <= bal_i:
                continue
            rows[str(r[0]).strip()] = [fd.parse_num(r[prev_i]), fd.parse_num(r[bal_i])]
    return _slim_result(rows)


def fetch_t86_day(ymd, rebuild_only=False):
    p = fd.fetch("T86", "fund/T86",
                 {"date": ymd, "selectType": "ALLBUT0999", "response": "json"},
                 ymd, rebuild_only, slim=slim_t86)
    return (p or {}).get("rows") or {}


def fetch_margin_all_day(ymd, rebuild_only=False):
    p = fd.fetch("MI_MARGN_ALL", "marginTrading/MI_MARGN",
                 {"date": ymd, "selectType": "ALL", "response": "json"},
                 ymd, rebuild_only, slim=slim_margin)
    return (p or {}).get("rows") or {}


def slim_quotes(payload):
    """
    MI_INDEX (type=ALLBUT0999) -> {"rows": {code: [open, high, low, close, lots]},
    "names": {code: name}}. The quote table is found by its header, among the
    index and statistics tables that share the payload.
    """
    rows, names = {}, {}
    for t in payload.get("tables") or []:
        fields = [str(f) for f in t.get("fields") or []]
        if "證券代號" not in fields or "收盤價" not in fields:
            continue
        ix = {k: fields.index(k) for k in ("證券代號", "證券名稱", "成交股數",
                                            "開盤價", "最高價", "最低價", "收盤價")
              if k in fields}
        for r in t.get("data") or []:
            code = str(r[ix["證券代號"]]).strip()
            num = lambda k: fd.parse_num(r[ix[k]]) if k in ix else None  # noqa: E731
            shares = num("成交股數")
            rows[code] = [num("開盤價"), num("最高價"), num("最低價"), num("收盤價"),
                          round(shares / LOTS) if shares is not None else None]
            if "證券名稱" in ix:
                names[code] = str(r[ix["證券名稱"]]).strip()
    return _slim_result(rows, names=names)


def fetch_quotes_day(ymd, rebuild_only=False):
    p = fd.fetch("MI_INDEX", "afterTrading/MI_INDEX",
                 {"date": ymd, "type": "ALLBUT0999", "response": "json"},
                 ymd, rebuild_only, slim=slim_quotes)
    return (p or {}).get("rows") or {}, (p or {}).get("names") or {}


# --------------------------------------------------------------------------
# Price-scale events: a par-value change (split) or capital reduction halts a
# stock and resumes it at a reference price that is not the last close. The
# page rescales the sessions before each one by close / reference, so the K
# chart has no cliff. TWSE lists both by resumption date; a month per request.
# --------------------------------------------------------------------------

ADJUST_SOURCES = {"TWTB8U": ("change/TWTB8U", "面額變更"),
                  "TWTAUU": ("reducation/TWTAUU", "減資")}


def slim_adjust(payload):
    fields = [str(f).strip() for f in payload.get("fields") or []]
    ix = {k: _col(fields, lambda f, k=k: f.startswith(k))
          for k in ("恢復買賣日期", "股票代號", "停止買賣前收盤價格", "恢復買賣參考價")}
    events = []
    if None in ix.values():
        return _slim_result(events)
    for r in payload.get("data") or []:
        y, m, d = str(r[ix["恢復買賣日期"]]).strip().split("/")
        before, ref = fd.parse_num(r[ix["停止買賣前收盤價格"]]), fd.parse_num(r[ix["恢復買賣參考價"]])
        if before and ref:
            events.append([str(r[ix["股票代號"]]).strip(), f"{int(y) + 1911:04d}-{m}-{d}",
                           before, ref])
    return _slim_result(events)


def fetch_adjustments(months, rebuild_only=False):
    """{code: [{date, kind, before, ref, ratio}]} over `months` (YYYYMM)."""
    out = {}
    for src, (path, kind) in ADJUST_SOURCES.items():
        for ym in months:
            y, m = int(ym[:4]), int(ym[4:])
            last = calendar_mod.monthrange(y, m)[1]
            p = fd.fetch(src, path, {"startDate": f"{y:04d}{m:02d}01",
                                     "endDate": f"{y:04d}{m:02d}{last:02d}", "response": "json"},
                         f"{y:04d}{m:02d}", rebuild_only, slim=slim_adjust)
            for code, d, before, ref in (p or {}).get("rows") or []:
                out.setdefault(code, []).append({"date": d, "kind": kind, "before": before,
                                                 "ref": ref, "ratio": round(before / ref, 6)})
    for ev in out.values():
        ev.sort(key=lambda e: e["date"])
    return out


def slim_reference(payload):
    """MI_INDEX -> {"rows": {code: reference price}}: close minus the signed 漲跌價差."""
    refs = {}
    for t in payload.get("tables") or []:
        fields = [str(f) for f in t.get("fields") or []]
        if not {"證券代號", "收盤價", "漲跌(+/-)", "漲跌價差"} <= set(fields):
            continue
        ix = {k: fields.index(k) for k in ("證券代號", "收盤價", "漲跌(+/-)", "漲跌價差")}
        for r in t.get("data") or []:
            close, diff = fd.parse_num(r[ix["收盤價"]]), fd.parse_num(r[ix["漲跌價差"]])
            sign = str(r[ix["漲跌(+/-)"]])
            sign = -1 if "-" in sign else 1 if "+" in sign else 0 if diff == 0 else None
            if close is not None and diff is not None and sign is not None:
                refs[str(r[ix["證券代號"]]).strip()] = round(close - sign * diff, 4)
    return _slim_result(refs)


def fetch_reference_day(ymd, rebuild_only=False):
    """Each TWSE code's reference price that day: asked only on suspected split days."""
    p = fd.fetch("MI_INDEX_REF", "afterTrading/MI_INDEX",
                 {"date": ymd, "type": "ALLBUT0999", "response": "json"},
                 ymd, rebuild_only, slim=slim_reference)
    return (p or {}).get("rows") or {}


def infer_splits(daily, calendar, known=(), reference=None):
    """
    Splits the tables above miss (ETFs; anything on TPEx): trading halts for
    two or more sessions and resumes near 1/N of the last close (N:1 for a
    reverse split), well beyond the ±10% a session can move. `reference(date)`
    gives that day's reference price where the exchange publishes it, and the
    ratio is exact; otherwise N is the whole number the gap rounds to (the
    opening auction is within the limit of the reference, so off by one at
    worst). Events already in `known` (dates) are left alone.
    """
    pos = {d: i for i, d in enumerate(calendar)}
    out = []
    for a, b in zip(daily, daily[1:]):
        if b["date"] in known or pos[b["date"]] - pos[a["date"]] < 3:
            continue
        if not a["close"] or not b["open"]:
            continue
        r = a["close"] / b["open"]
        ratio = round(r) if r >= 1.5 else 1 / round(1 / r) if r <= 1 / 1.5 else None
        if not ratio or abs(r / ratio - 1) >= 0.1:
            continue
        ref = reference(b["date"]) if reference else None
        exact = bool(ref)
        ref = ref or round(a["close"] / ratio, 2)
        out.append({"date": b["date"], "kind": "分割" if ratio > 1 else "反分割",
                    "before": a["close"], "ref": ref, "ratio": round(a["close"] / ref, 6),
                    "inferred": True, **({} if exact else {"estimated": True})})
    return out


# --------------------------------------------------------------------------
# TPEx (上櫃): the same three whole-market tables, slimmed to the same shapes
# --------------------------------------------------------------------------

def _tpex_date(ymd):
    return f"{ymd[:4]}/{ymd[4:6]}/{ymd[6:]}"


def _tpex_table(payload):
    for t in payload.get("tables") or []:
        if t.get("data"):
            return [str(f).strip() for f in t.get("fields") or []], t["data"]
    return [], []


def slim_tpex_quotes(payload):
    """afterTrading/otc (regular session, fixed-price trades excluded, like MI_INDEX)."""
    fields, data = _tpex_table(payload)
    ix = {k: _col(fields, lambda f, k=k: f.startswith(k))
          for k in ("代號", "名稱", "開盤", "最高", "最低", "收盤", "成交股數")}
    rows, names = {}, {}
    if None in ix.values():
        return _slim_result(rows)
    for r in data:
        code = str(r[ix["代號"]]).strip()
        shares = fd.parse_num(r[ix["成交股數"]])
        rows[code] = [fd.parse_num(r[ix[k]]) for k in ("開盤", "最高", "最低", "收盤")] + [
            round(shares / LOTS) if shares is not None else None]
        names[code] = str(r[ix["名稱"]]).strip()
    return _slim_result(rows, names=names)


# insti/dailyTrade repeats 買進/賣出/買賣超股數 under group headers the JSON
# does not carry, so its net columns are taken by position. The layout:
#   2-4 外資及陸資(不含外資自營商)  5-7 外資自營商  8-10 外資及陸資合計
#   11-13 投信  14-16 自營商(自行買賣)  17-19 自營商(避險)  20-22 自營商合計
#   23 三大法人買賣超股數合計
# and is checked by arithmetic on every row: the three nets must add up to
# column 23, or the row is skipped.
TPEX_INST_COLS = {"foreign": 10, "trust": 13, "dealer": 22, "total": 23}


def slim_tpex_inst(payload):
    fields, data = _tpex_table(payload)
    rows = {}
    if len(fields) != 24 or not fields[23].startswith("三大法人"):
        return _slim_result(rows)
    for r in data:
        v = {k: fd.parse_num(r[i]) for k, i in TPEX_INST_COLS.items()}
        parts = [v["foreign"], v["trust"], v["dealer"]]
        if None not in parts and v["total"] is not None and abs(sum(parts) - v["total"]) > 1:
            continue
        rows[str(r[0]).strip()] = parts
    return _slim_result(rows)


def slim_tpex_margin(payload):
    """margin/balance -> {code: [prev_balance, balance]} in lots, like slim_margin."""
    fields, data = _tpex_table(payload)
    prev_i = _col(fields, lambda f: f.startswith("前資餘額"))
    bal_i = _col(fields, lambda f: f == "資餘額")
    rows = {}
    if prev_i is not None and bal_i is not None:
        for r in data:
            rows[str(r[0]).strip()] = [fd.parse_num(r[prev_i]), fd.parse_num(r[bal_i])]
    return _slim_result(rows)


# TPEx drops connections from some networks outright. Once this many days in
# a row fail, stop asking for the rest of the run instead of retrying every day.
TPEX_GIVE_UP_DAYS = 3
TPEX_HEADERS = {"Referer": "https://www.tpex.org.tw/zh-tw/index.html"}
_tpex = {"failed_days": 0, "offline": False}


def fetch_tpex_day(ymd, rebuild_only=False):
    """-> (quotes, names, inst, margin) for one session, shaped like the TWSE ones."""
    d = _tpex_date(ymd)
    cache_only = rebuild_only or _tpex["offline"]
    get = lambda name, path, params, slim: fd.fetch(  # noqa: E731
        name, path, {**params, "date": d, "response": "json"}, ymd, cache_only,
        slim=slim, base=TPEX_BASE, headers=TPEX_HEADERS)
    q = get("TPEX_QUOTES", "afterTrading/otc", {"type": "EW"}, slim_tpex_quotes)
    i = get("TPEX_INST", "insti/dailyTrade", {"type": "Daily", "sect": "AL"}, slim_tpex_inst)
    m = get("TPEX_MARGIN", "margin/balance", {}, slim_tpex_margin)
    if not cache_only:
        # fd.fetch answers None only when every attempt failed and nothing is cached
        _tpex["failed_days"] = _tpex["failed_days"] + 1 if q is i is m is None else 0
        if _tpex["failed_days"] >= TPEX_GIVE_UP_DAYS:
            _tpex["offline"] = True
            print(f"  !! TPEx unreachable for {TPEX_GIVE_UP_DAYS} days in a row; using "
                  "cached TPEx data only for the rest of this run", file=sys.stderr)
    q, i, m = q or {}, i or {}, m or {}
    return q.get("rows") or {}, q.get("names") or {}, i.get("rows") or {}, m.get("rows") or {}


# --------------------------------------------------------------------------
# Third-party pages (shareholders, main force)
# --------------------------------------------------------------------------

def fetch_page(source, key, url, encoding, rebuild_only=False, permanent=False,
               fresh_since=None):
    """
    GET a third-party page, cached for the day it was fetched on. These pages
    always show "latest", so there is no closed period to cache forever; one
    fetch per day per page is all a daily job needs. Returns text or None.
    A failed fetch falls back to the last copy on disk.

    `permanent` marks a page about a closed period (a past session): any
    cached copy is final. The caller drops a copy that turns out not to cover
    the period asked for (see fetch_broker_day). `fresh_since` (ISO date)
    accepts any copy fetched on or after it, for pages that change weekly.
    """
    cp = fd._cache_path(source, key)
    cached = None
    if os.path.exists(cp):
        with open(cp, "r", encoding="utf-8") as f:
            cached = json.load(f)
        if (rebuild_only or permanent
                or (cached.get("_fetchedOn") or "") >= (fresh_since or date.today().isoformat())):
            fd._stats["cache_hits"] += 1
            return cached.get("body")
    if rebuild_only:
        return None

    delay, last_err = 2.0, None
    for attempt in range(fd.MAX_RETRIES):
        try:
            fd._stats["requests"] += 1
            r = fd.SESSION.get(url, timeout=30, headers={"Referer": url})
            r.raise_for_status()
            body = r.content.decode(encoding, errors="replace")
            with open(cp, "w", encoding="utf-8") as f:
                json.dump({"_fetchedOn": date.today().isoformat(), "url": url,
                           "body": body}, f, ensure_ascii=False)
            if source.startswith("DJ_"):
                _dj["ok"] += 1
                if _dj["ok"] >= DJ_RECOVER and _dj["sleep"] > DJ_SLEEP:
                    _dj["sleep"], _dj["ok"] = max(_dj["sleep"] / 2, DJ_SLEEP), 0
                    print(f"  .. DJ pacing back to {_dj['sleep']:.1f}s",
                          file=sys.stderr, flush=True)
            time.sleep(_dj["sleep"] if source.startswith("DJ_") else fd.SLEEP_BASE)
            return body
        except Exception as e:  # noqa: BLE001 - same retry policy as fetch()
            last_err = e
            fd._stats["retries"] += 1
            if source.startswith("DJ_"):
                _dj["ok"] = 0
            if source.startswith("DJ_") and _dj["sleep"] < DJ_SLEEP_MAX:
                _dj["sleep"] = min(_dj["sleep"] * 2, DJ_SLEEP_MAX)
                print(f"  .. {source} {key}: {e}; DJ pacing now {_dj['sleep']:.1f}s",
                      file=sys.stderr, flush=True)
            if attempt < fd.MAX_RETRIES - 1:
                time.sleep(delay)
                delay *= 2
    print(f"  !! {source} {key} failed: {last_err}", file=sys.stderr)
    return cached.get("body") if cached else None


def _cell_text(s):
    s = re.sub(r"<br\s*/?>|</br>", "", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return html.unescape(s).replace("\xa0", " ").strip()


def html_rows(body):
    """Every <tr> as a list of cell texts. Tolerates the `<tr/>` both sites emit."""
    out = []
    for seg in re.split(r"<tr\b[^>]*>", body, flags=re.I)[1:]:
        cells = re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", seg, flags=re.I | re.S)
        if cells:
            out.append([_cell_text(c) for c in cells])
    return out


# Header text (whitespace removed) -> output key
HOLDER_COLS = {
    "資料日期": "date",
    "總股東人數": "holders",
    "平均張數/人": "avgLots",
    ">400張大股東持有百分比": "big400Pct",
    ">400張大股東人數": "big400",
    ">1000張人數": "big1000",
    ">1000張大股東持有百分比": "big1000Pct",
}


def parse_holders(body):
    """
    twsthr StockHolders page -> weekly rows, oldest first:
    {date, holders, avgLots, big400, big400Pct, big1000, big1000Pct}.

    A row with a handful of holders is the depository's placeholder in the
    week of a share split or capital reduction (2327 shows 1 holder owning
    100%); it is dropped rather than plotted as a cliff.
    """
    if not body:
        return []
    m = re.search(r"id='Details'.*?</table>", body, flags=re.S)
    rows = html_rows(m.group(0) if m else body)
    idx = None
    out = []
    for cells in rows:
        keys = [re.sub(r"\s+", "", c) for c in cells]
        if "資料日期" in keys:
            idx = {HOLDER_COLS[k]: i for i, k in enumerate(keys) if k in HOLDER_COLS}
            continue
        if idx is None or "date" not in idx or len(cells) <= max(idx.values()):
            continue
        raw = re.sub(r"\D", "", cells[idx["date"]])
        if not re.fullmatch(r"\d{8}", raw):
            continue
        rec = {"date": fd.parse_twse_date(raw)}
        for k, i in idx.items():
            if k != "date":
                rec[k] = fd.parse_num(cells[i])
        if rec.get("holders") is None or rec["holders"] < 100:
            continue
        out.append(rec)
    return sorted(out, key=lambda r: r["date"])


def parse_brokers(body):
    """
    zco page -> {"updated", "buy": [...], "sell": [...]}, top brokers each side.
    Each entry: {name, buy, sell, net, pct}; lots, pct is % of the period's volume.
    """
    if not body:
        return None
    buy, sell = [], []
    for cells in html_rows(body):
        if len(cells) != 10 or not cells[1].replace(",", "").isdigit():
            continue
        for side, c in ((buy, cells[0:5]), (sell, cells[5:10])):
            if c[0]:
                side.append({"name": c[0], "buy": fd.parse_num(c[1]),
                             "sell": fd.parse_num(c[2]), "net": fd.parse_num(c[3]),
                             "pct": fd.parse_num(c[4].rstrip("%"))})
    m = re.search(r"最後更新日：(\d{4}/\d{1,2}/\d{1,2})", body)
    if not buy and not sell:
        return None
    # The page's own totals (合計買超張數 / 合計賣超張數); their difference is
    # the day's main-force net. DJ's own 主力 series matches it to within 1 張
    # (rounding), so the series page is not fetched.
    text = _cell_text(body)
    tot = {k: re.search(k + r"\s*([\d,]+)", text) for k in ("合計買超張數", "合計賣超張數")}
    return {"updated": fd.parse_twse_date(m.group(1)) if m else None,
            "buy": buy, "sell": sell,
            "totalBuy": fd.parse_num(tot["合計買超張數"].group(1)) if tot["合計買超張數"] else None,
            "totalSell": fd.parse_num(tot["合計賣超張數"].group(1)) if tot["合計賣超張數"] else None}


def fetch_broker_day(code, d, rebuild_only=False):
    """
    One session's broker table, or None. DJ answers a day it has not published
    yet with an empty table or another day's; neither is kept, so the next run
    asks again.
    """
    y, m, dd = (int(x) for x in d.split("-"))
    key = f"{code}_{d.replace('-', '')}"
    b = parse_brokers(fetch_page("DJ_ZCO_DAY", key,
                                 DJ_BROKER_DAY_URL.format(code=code, d=f"{y}-{m}-{dd}"),
                                 "cp950", rebuild_only, permanent=True))
    if b is None or b["updated"] != d:
        cp = fd._cache_path("DJ_ZCO_DAY", key)
        if os.path.exists(cp):
            os.remove(cp)
        return None
    return b


def compact_brokers(b):
    """Per-day tables ride along for every session: rows as arrays, not objects."""
    row = lambda x: [x["name"], x["buy"], x["sell"], x["net"], x["pct"]]  # noqa: E731
    return {"buy": [row(x) for x in b["buy"]], "sell": [row(x) for x in b["sell"]],
            "totalBuy": b.get("totalBuy"), "totalSell": b.get("totalSell")}


# --------------------------------------------------------------------------
# Build one stock
# --------------------------------------------------------------------------

JS_PREFIX = re.compile(r'^\(window\.STOCK_DATA=window\.STOCK_DATA\|\|\{\}\)\["[^"]*"\]=')


def load_previous(code):
    """The last output for `code` (its .js file), or {}."""
    try:
        with open(os.path.join(OUT_DIR, f"{code}.js"), "r", encoding="utf-8") as f:
            text = f.read().strip()
        prev = json.loads(JS_PREFIX.sub("", text).rstrip(";"))
        return prev if isinstance(prev, dict) else {}
    except (OSError, ValueError):
        return {}


def holders_fresh_since(today=None):
    """TDCC data is weekly; a shareholder page fetched since the last Saturday is current."""
    today = today or date.today()
    return (today - timedelta(days=(today.weekday() - 5) % 7)).isoformat()


def build_stock(code, name, days, market, tracked, rebuild_only=False, exchange="TWSE",
                broker_from=None, adjustments=None, reference=None):
    """
    market: {date: (quotes, t86_rows, margin_rows)} shared across stocks.
    `tracked` adds the per-stock broker data (main force, broker tables).
    `broker_from` (ISO date): day tables before it come from the cache only.
    `adjustments`: this code's split / capital-reduction events (fetch_adjustments).
    `reference(date, code)`: that day's reference price, or None (infer_splits).
    Returns None for a code with no quotes in range.
    """
    calendar, days = days, [d for d in days if code in market[d][0]]
    if not days:
        return None
    prev = load_previous(code)
    lots = lambda v: round(v / LOTS) if v is not None else None  # noqa: E731

    main, broker_daily, brokers = {}, {}, {}
    if tracked:
        main = {r["date"]: r.get("mainForce") for r in prev.get("daily") or []
                if r.get("mainForce") is not None}
        # Per-day broker tables, newest first so an interrupted backfill still
        # leaves the most recent sessions. The first run walks the broker window
        # (one request a day); after that only new days are asked. Days before
        # the window are used if cached and never fetched.
        for i, d in enumerate(reversed(days), 1):
            b = fetch_broker_day(code, d, rebuild_only or (broker_from is not None
                                                           and d < broker_from))
            if b is not None:
                broker_daily[d] = compact_brokers(b)
                if b["totalBuy"] is not None and b["totalSell"] is not None:
                    main[d] = b["totalBuy"] - b["totalSell"]
            if i % 50 == 0:
                print(f"    {code} broker tables {i}/{len(days)}", flush=True)
        for label, suffix in DJ_BROKER_PERIODS.items():
            b = parse_brokers(fetch_page("DJ_ZCO", f"{code}{suffix or '_1'}",
                                         DJ_BROKER_URL.format(code=code, suffix=suffix),
                                         "cp950", rebuild_only))
            if b is None:
                b = (prev.get("brokers") or {}).get(label)
            if b is not None:
                brokers[label] = b

    daily = []
    for d in days:
        quotes, inst, mg = market[d]
        o, h, lo, c, vol = quotes[code]
        f, t, dl = inst.get(code) or [None, None, None]
        prev_bal, bal = mg.get(code) or [None, None]
        daily.append({
            "date": d, "open": o, "high": h, "low": lo, "close": c, "volume": vol,
            "foreign": lots(f), "trust": lots(t), "dealer": lots(dl),
            "marginBalance": bal,
            "marginChange": bal - prev_bal if bal is not None and prev_bal is not None else None,
            "mainForce": main.get(d),
        })

    holders = parse_holders(
        fetch_page("TWSTHR", code, HOLDERS_URL.format(code=code), "utf-8", rebuild_only,
                   fresh_since=holders_fresh_since()))
    if not holders:
        holders = prev.get("holders") or []

    return {
        "code": code, "name": name or prev.get("name") or code, "tracked": tracked,
        "exchange": exchange,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "start": days[0], "end": days[-1],
        "daily": daily, "holders": holders, "brokers": brokers,
        "brokerDaily": broker_daily,
        "adjustments": adjust_events(daily, calendar, adjustments,
                                     reference and (lambda d: reference(d, code))),
    }


def adjust_events(daily, calendar, listed, reference=None):
    """Listed events with sessions on both sides, plus inferred splits."""
    first, last = daily[0]["date"], daily[-1]["date"]
    ev = [e for e in listed or [] if first < e["date"] <= last]
    ev += infer_splits(daily, calendar, {e["date"] for e in ev}, reference)
    return sorted(ev, key=lambda e: e["date"])


def write_stock(s):
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, f"{s['code']}.js"), "w", encoding="utf-8") as f:
        f.write("(window.STOCK_DATA=window.STOCK_DATA||{})[" + json.dumps(s["code"]) + "]="
                + json.dumps(s, ensure_ascii=False, separators=(",", ":")) + ";\n")


def write_index(watchlist, tracked=None):
    """
    The page's stock picker: every stock with an output file, watchlist first
    (in list order, the first being the page's default), then by code.
    """
    tracked = set(watchlist) if tracked is None else set(tracked)
    built = sorted(f[:-3] for f in os.listdir(OUT_DIR)
                   if f.endswith(".js") and f != "index.js")
    order = [c for c in watchlist if c in built] + [c for c in built if c not in watchlist]
    entries = []
    for code in order:
        s = load_previous(code)
        if s:
            entries.append({"code": code, "name": s.get("name"), "end": s.get("end"),
                            "tracked": code in tracked,
                            "exchange": s.get("exchange", "TWSE")})
    with open(os.path.join(OUT_DIR, "index.js"), "w", encoding="utf-8") as f:
        f.write("window.STOCK_LIST=" + json.dumps(entries, ensure_ascii=False,
                                                  separators=(",", ":")) + ";\n")
    return entries


def main():
    ap = argparse.ArgumentParser(description="Fetch single-stock data for stock.html")
    ap.add_argument("--stocks", help="comma-separated codes to build (with broker data)")
    ap.add_argument("--watchlist-only", action="store_true",
                    help="build only the stocks in stocks.txt")
    ap.add_argument("--months", type=int, default=DEFAULT_MONTHS,
                    help=f"months of history (default {DEFAULT_MONTHS})")
    ap.add_argument("--rebuild", action="store_true",
                    help="issue no requests; rebuild outputs from the cache only")
    ap.add_argument("--broker-months", type=int, default=DEFAULT_BROKER_MONTHS,
                    help=f"months of broker day tables to fetch (default {DEFAULT_BROKER_MONTHS})")
    ap.add_argument("--refresh-top", action="store_true",
                    help=f"re-rank {os.path.basename(TOPLIST)} from the market data first")
    args = ap.parse_args()

    # One fetcher at a time: a long backfill and the nightly cron must not walk
    # the same cache and outputs together. A run that finds the lock taken skips.
    import fcntl
    os.makedirs(fd.DATA_DIR, exist_ok=True)
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another fetch_stocks.py run holds the lock; skipping")
        return

    watchlist = read_watchlist()
    explicit = [c.strip() for c in args.stocks.split(",") if c.strip()] if args.stocks else []
    for c in watchlist + explicit:
        if not re.fullmatch(r"[0-9A-Z]{4,6}", c):
            raise SystemExit(f"ERROR: {c!r} is not a stock code")

    today = date.today()
    end = f"{today.year:04d}-{today.month:02d}"
    y, m = today.year, today.month - (args.months - 1)
    while m < 1:
        y, m = y - 1, m + 12
    months = fd.month_range(f"{y:04d}-{m:02d}", end)
    t0 = time.time()
    print(f"[{'REBUILD' if args.rebuild else 'FETCH'}] {months[0]} -> {months[-1]}")

    # The TAIEX months (shared with fetch_data.py's cache) define the calendar.
    calendar = set()
    for ym in months:
        calendar.update(fd.fetch_index_month(ym, args.rebuild))
    calendar = sorted(calendar)
    if not calendar:
        raise SystemExit("ERROR: no trading days retrieved; aborting.")
    print(f"  {len(calendar)} trading days; quotes + institutional + margin from "
          "TWSE and TPEx, six whole-market queries per day")

    # Both exchanges share the trading calendar, and a code is listed on only
    # one of them, so their tables merge into one dict per day.
    market, names, otc = {}, {}, set()
    for i, d in enumerate(calendar, 1):
        ymd = d.replace("-", "")
        quotes, nm = fetch_quotes_day(ymd, args.rebuild)
        tq, tnm, tinst, tmg = fetch_tpex_day(ymd, args.rebuild)
        names.update(nm)                     # later days win: current names
        names.update(tnm)
        otc.update(tq)
        market[d] = ({**quotes, **tq},
                     {**fetch_t86_day(ymd, args.rebuild), **tinst},
                     {**fetch_margin_all_day(ymd, args.rebuild), **tmg})
        if i % 25 == 0 or i == len(calendar):
            print(f"  {d}  {i}/{len(calendar)}  {(time.time() - t0) / 60:.1f} min", flush=True)

    adjustments = fetch_adjustments(months, args.rebuild)
    print(f"  {sum(map(len, adjustments.values()))} TWSE split / capital-reduction event(s); "
          "other splits are inferred from the price gap")

    if args.refresh_top:
        top = rank_top(market, calendar, names)
        write_toplist(top, calendar[-1])
        print(f"  wrote {os.path.basename(TOPLIST)}: {len(top)} stocks, "
              f"{top[-1][2] / 1e8:,.1f} 億/日 and up")
    toplist = read_watchlist(TOPLIST)
    tracked = set(watchlist) | set(toplist) | set(explicit)
    # Same day of month, broker_months back; compared as a string, so a day
    # that month lacks (e.g. 02-31) still sorts correctly.
    y2, m2 = today.year, today.month - args.broker_months
    while m2 < 1:
        y2, m2 = y2 - 1, m2 + 12
    broker_from = f"{y2:04d}-{m2:02d}-{today.day:02d}"

    # Today's listing decides the universe; a delisted code drops out of it.
    latest = next((market[d][0] for d in reversed(calendar) if market[d][0]), {})
    if explicit:
        codes = explicit
    elif args.watchlist_only:
        codes = watchlist
    else:
        codes = list(dict.fromkeys(
            watchlist + toplist + sorted(c for c in latest if UNIVERSE_RE.fullmatch(c))))
    if not codes:
        raise SystemExit("ERROR: no stocks to build. Add codes to stocks.txt.")
    print(f"  building {len(codes)} stock(s), {len(tracked & set(codes))} with broker data "
          f"(day tables fetched from {broker_from})")

    # TPEx reference prices are not wired in; its splits stay estimates.
    def reference(d, code):
        return None if code in otc else fetch_reference_day(d.replace("-", ""), args.rebuild).get(code)

    built = failed = 0
    for i, code in enumerate(codes, 1):
        try:
            s = build_stock(code, names.get(code), calendar, market, code in tracked,
                            args.rebuild, exchange="TPEx" if code in otc else "TWSE",
                            broker_from=broker_from, adjustments=adjustments.get(code),
                            reference=reference)
        except Exception as e:  # noqa: BLE001 - one bad page must not sink the run
            failed += 1
            print(f"  !! {code} failed: {e}", file=sys.stderr)
            continue
        if s is None:
            if code in tracked:
                print(f"  !! {code}: no TWSE or TPEx quotes in range", file=sys.stderr)
            continue
        write_stock(s)
        built += 1
        if s["tracked"]:
            d = s["daily"]
            cov = lambda k: sum(1 for r in d if r[k] is not None)  # noqa: E731
            print(f"  {code} {s['name']}: {len(d)} days ({s['start']} -> {s['end']}) · "
                  f"法人 {cov('foreign')} · 融資 {cov('marginBalance')} · "
                  f"主力 {cov('mainForce')} · 股東週 {len(s['holders'])} · "
                  f"分點 {','.join(s['brokers']) or '-'} · 分點日 {len(s['brokerDaily'])}")
        if i % 100 == 0:
            print(f"  {i}/{len(codes)} stocks  {(time.time() - t0) / 60:.1f} min", flush=True)

    entries = write_index(watchlist, tracked)
    st = fd._stats
    print(f"  built {built}, failed {failed} · index: {len(entries)} stock(s) · "
          f"{st['requests']} requests / {st['cache_hits']} cache hits / "
          f"{st['retries']} retries · {(time.time() - t0) / 60:.1f} min")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
