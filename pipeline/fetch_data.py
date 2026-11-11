#!/usr/bin/env python3
"""
TW Stock Flow - TAIEX data fetcher

Pulls the TWSE (and one TAIFEX) public datasets below and merges them into a
single daily series:

  1. TAIEX daily OHLC        MI_5MINS_HIST   (monthly query)
  2. Market turnover         FMTQIK          (monthly query)
  3. Institutional trading   BFI82U          (single-day query)
  4. Margin & short stats    MI_MARGN        (single-day query)
  5. Margin maintenance ratio MI_MARGN ALL + MI_INDEX (single-day, whole market,
                              from 2022; shared with fetch_stocks.py's cache)
  6. Futures net OI          TAIFEX 區分各期貨契約 (monthly CSV, 臺股期貨 foreign
                              net open interest; TAIFEX serves only ~3 years)

Outputs:
  web/data/taiex-daily.json          merged daily series
  web/data/taiex-daily.js            same payload as window.TAIEX_DATA, so index.html
                                     works when opened directly over file://
  web/data/raw/<endpoint>/*.json     raw response cache (re-runs skip these entirely)

Usage:
  python3 pipeline/fetch_data.py                  # full run (~150 min first time; almost
                                                  #   all of it is rate-limit sleeping)
  python3 pipeline/fetch_data.py --start 2024-01  # backfill a narrower window
  python3 pipeline/fetch_data.py --rebuild        # no requests at all; rebuild outputs
                                                  #   from the existing cache

Note: the Chinese string literals below are matched against TWSE response
payloads (row labels such as the foreign-investor and margin rows). They are
data, not user-facing text, and must not be translated.
"""

import argparse
import json
import os
import random
import re
import sys
import time
from datetime import date, datetime, timedelta

import requests

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

BASE = "https://www.twse.com.tw/rwd/zh"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "web", "data")
RAW_DIR = os.path.join(DATA_DIR, "raw")

DEFAULT_START = "2017-01"

# TWSE throttles at roughly 3 requests per 5 seconds. Do not lower these to make
# the run faster - you will start getting 429s and HTML maintenance pages.
SLEEP_BASE = 1.6
SLEEP_JITTER = 0.4
MAX_RETRIES = 3

# How far back to re-ask days cached as "no data". Covers a fetch that ran before
# TWSE published, plus a long weekend/holiday either side of it.
EMPTY_RECHECK_DAYS = 5

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Referer": "https://www.twse.com.tw/zh/index.html",
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)

_stats = {"requests": 0, "cache_hits": 0, "retries": 0, "refreshed": 0}


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------

def parse_num(raw):
    """Clean a TWSE numeric field. Returns None (never 0) when unparseable."""
    if raw is None:
        return None
    s = str(raw).strip().replace(",", "").replace("　", "")
    if s in ("", "--", "---", "-", "X", "x", "N/A", "n/a"):
        return None
    # A few fields wrap negatives in parentheses
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def parse_twse_date(raw):
    """
    TWSE dates come back either as ROC calendar `115/07/17` or Gregorian
    `2026/07/17` / `20260717`. Detect rather than hardcode; always return ISO.
    """
    if raw is None:
        return None
    s = str(raw).strip()
    m = re.match(r"^(\d{2,4})[/\-](\d{1,2})[/\-](\d{1,2})$", s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = re.match(r"^(\d{4})(\d{2})(\d{2})$", s)
        if m:
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        else:
            return None
    # TWSE never serves data before 1911, so any year below that is ROC calendar
    if y < 1911:
        y += 1911
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return None


def _cache_path(endpoint, key):
    d = os.path.join(RAW_DIR, endpoint)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{key}.json")


def is_stale(key, payload):
    """
    A cache entry is final only once the period it covers is closed. Two cases
    are not:

      * a monthly response (key `YYYYMM`) fetched while that month was still
        open - it grows a row after every session, so a copy fetched partway
        through the month is short some days. This is not just "key equals
        the current month": a run late on the month's last trading day (or
        one that simply never re-ran before the calendar rolled over) leaves
        behind a cache stamped with that month's key but fetched before the
        month actually finished, and it would otherwise be trusted as final
        forever. `_fetchedOn` (set when the entry is written) pins that down
        precisely: stale iff it was fetched during the same month it covers;
      * an `_empty` marker on a recent day (key `YYYYMMDD`) - TWSE publishes the
        daily chip data a few hours after the close, so a run that lands before
        publication would otherwise freeze "no data" in place permanently.

    Anything older than that never changes again, so it stays a hard cache hit.
    """
    today = date.today()
    if re.fullmatch(r"\d{6}", key):
        fetched_on = payload.get("_fetchedOn")
        if fetched_on is None:
            # Pre-existing cache from before _fetchedOn was tracked - fall back
            # to the old, coarser check rather than assume it needs a refetch.
            return key == f"{today.year:04d}{today.month:02d}"
        return fetched_on[:4] + fetched_on[5:7] == key
    if re.fullmatch(r"\d{8}", key) and payload.get("_empty"):
        d = parse_twse_date(key)
        if d is None:
            return False
        return (today - date.fromisoformat(d)).days <= EMPTY_RECHECK_DAYS
    return False


def fetch(endpoint, path, params, key, rebuild_only=False, slim=None, base=BASE, headers=None):
    """
    Cached GET with exponential backoff. Returns a dict, or None when that
    day/month has no data. A cache hit issues no request at all - this is what
    makes the second run finish in seconds.

    `slim`, when given, maps an OK payload to the (smaller) dict that is cached
    and returned instead - for whole-market responses where only a few columns
    are ever read back. A slim result marked `_empty` is cached as "no data",
    so a recent day is asked again (see is_stale).

    `base` points the same cache and retry logic at another host (TPEx).
    """
    cp = _cache_path(endpoint, key)
    today = date.today()
    cached = None
    if os.path.exists(cp):
        try:
            with open(cp, "r", encoding="utf-8") as f:
                cached = json.load(f)
        except json.JSONDecodeError:
            os.remove(cp)  # corrupt cache entry - refetch it
        else:
            # In rebuild mode there are no requests to fall back on, so a stale
            # entry is still the best available answer.
            if rebuild_only or not is_stale(key, cached):
                _stats["cache_hits"] += 1
                return cached
            _stats["refreshed"] += 1

    if rebuild_only:
        return None

    url = f"{base}/{path}"
    delay = 2.0
    last_err = None

    for attempt in range(MAX_RETRIES):
        try:
            _stats["requests"] += 1
            r = SESSION.get(url, params=params, timeout=30, headers=headers)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()

            body = r.text.lstrip()
            if body.startswith("<"):
                # When throttled, TWSE serves an HTML maintenance page, not JSON
                raise ValueError("got HTML instead of JSON (rate limited or under maintenance)")

            payload = r.json()
            stat = payload.get("stat", "")
            if str(stat).upper() != "OK":      # TPEx answers "ok"
                # Non-trading day / no data - normal. Cache an empty marker so we
                # never ask again.
                payload = {"stat": stat, "_empty": True}
            elif slim is not None:
                payload = slim(payload)
            if re.fullmatch(r"\d{6}", key):
                payload["_fetchedOn"] = today.isoformat()
            with open(cp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            time.sleep(SLEEP_BASE + random.uniform(0, SLEEP_JITTER))
            return payload

        except Exception as e:  # noqa: BLE001 - retry layer swallows everything
            last_err = e
            _stats["retries"] += 1
            if attempt < MAX_RETRIES - 1:
                time.sleep(delay)
                delay *= 2

    print(f"  !! {endpoint} {key} failed after {MAX_RETRIES} attempts: {last_err}",
          file=sys.stderr)
    # A failed refresh must not lose data we already hold - keep the stale copy
    # rather than dropping the whole period out of the merged series.
    return cached


def merge_with_existing(path, fetched):
    """
    Union this run's rows with the previous output, keyed by date.

    Returns (merged_rows_sorted_by_date, days_carried_over). A row from `fetched`
    always beats a stored row for the same date - a refetch is by definition
    newer. Anything unreadable is treated as absent: a corrupt or hand-edited
    output file must not be able to inject rows into a clean fetch.

    To genuinely shrink the series, delete web/data/taiex-daily.json and refetch.
    """
    if not os.path.exists(path):
        return list(fetched), 0
    try:
        with open(path, "r", encoding="utf-8") as f:
            prior = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"  existing output unreadable ({e}); writing only this run's range",
              file=sys.stderr)
        return list(fetched), 0
    if not isinstance(prior, list):
        return list(fetched), 0

    by_date = {r["date"]: r for r in prior
               if isinstance(r, dict) and isinstance(r.get("date"), str)}
    carried = sum(1 for d in by_date if d not in {r["date"] for r in fetched})
    by_date.update({r["date"]: r for r in fetched})
    return [by_date[d] for d in sorted(by_date)], carried


def month_range(start_ym, end_ym):
    y, m = int(start_ym[:4]), int(start_ym[5:7])
    ey, em = int(end_ym[:4]), int(end_ym[5:7])
    out = []
    while (y, m) <= (ey, em):
        out.append(f"{y:04d}{m:02d}")
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return out


def rows_of(payload):
    """MI_MARGN nests rows under tables[]; the others use a flat data[]."""
    if not payload or payload.get("_empty"):
        return []
    if "data" in payload and isinstance(payload["data"], list):
        return payload["data"]
    for t in payload.get("tables", []) or []:
        if isinstance(t.get("data"), list) and t["data"]:
            return t["data"]
    return []


# --------------------------------------------------------------------------
# Per-endpoint parsing
# --------------------------------------------------------------------------

def fetch_index_month(ym, rebuild_only=False):
    """TAIEX daily OHLC. Columns: date, open, high, low, close."""
    p = fetch("MI_5MINS_HIST", "TAIEX/MI_5MINS_HIST",
              {"date": f"{ym}01", "response": "json"}, ym, rebuild_only)
    out = {}
    for row in rows_of(p):
        if len(row) < 5:
            continue
        d = parse_twse_date(row[0])
        if not d:
            continue
        out[d] = {
            "open": parse_num(row[1]),
            "high": parse_num(row[2]),
            "low": parse_num(row[3]),
            "close": parse_num(row[4]),
        }
    return out


def fetch_turnover_month(ym, rebuild_only=False):
    """Market turnover. Columns: date, shares, value, trades, TAIEX close, change."""
    p = fetch("FMTQIK", "afterTrading/FMTQIK",
              {"date": f"{ym}01", "response": "json"}, ym, rebuild_only)
    out = {}
    for row in rows_of(p):
        if len(row) < 5:
            continue
        d = parse_twse_date(row[0])
        if not d:
            continue
        amount = parse_num(row[2])          # turnover value, in NT dollars
        out[d] = {
            "turnoverYi": round(amount / 1e8, 2) if amount is not None else None,
            "closeCheck": parse_num(row[4]),  # cross-check against the OHLC close
        }
    return out


def desk_of(name):
    """
    Which of the three institutional desks a BFI82U row belongs to, or None for
    rows we do not aggregate (the 合計 total line).

    Order matters. TWSE ships five rows:

        自營商(自行買賣)  自營商(避險)  投信
        外資及陸資(不含外資自營商)      外資自營商      合計

    "外資自營商" contains BOTH tokens, and it is foreign money - so the foreign
    test has to run first, or the foreign dealer desk would be double-counted
    into the domestic dealer bucket. Each side's two rows are summed, which is
    the market convention for quoting either figure.
    """
    if "外資" in name:
        return "foreign"
    if "投信" in name:
        return "trust"
    if "自營商" in name:
        return "dealer"
    return None


def fetch_institutions_day(ymd, rebuild_only=False):
    """
    Institutional trading. Columns: desk, buy, sell, net (all in NT dollars).

    Returns net flow per desk in NT$100M, e.g.
    {"foreignNetYi": -483.12, "trustNetYi": 139.97, "dealerNetYi": -152.27}.
    A desk absent from the response is absent from the dict rather than 0 -
    "no row" and "flat on the day" are different facts.

    (The spec said the foreign split began in 2022; it is in fact present at
    least as far back as 2019-01, verified against the raw response.)
    """
    p = fetch("BFI82U", "fund/BFI82U",
              {"dayDate": ymd, "type": "day", "response": "json"}, ymd, rebuild_only)
    rows = rows_of(p)
    if not rows:
        return None
    totals = {}
    for row in rows:
        if len(row) < 4:
            continue
        desk = desk_of(str(row[0]))
        if desk is None:
            continue
        v = parse_num(row[3])
        if v is None:
            continue
        totals[desk] = totals.get(desk, 0) + v
    if not totals:
        return None
    return {f"{d}NetYi": round(v / 1e8, 2)      # NT dollars -> NT$100M
            for d, v in totals.items()}


def fetch_margin_day(ymd, rebuild_only=False):
    """
    Margin & short statistics (selectType=MS).
    Columns: item, buy, sell, cash redemption, prev balance, today's balance.
    We need today's margin balance in NT$ thousands.

    The short balance on the same row set is deliberately not carried into the
    merged output: nothing consumes it. The raw responses are cached under
    data/raw/MI_MARGN/, so adding it back is a two-line change plus --rebuild.
    """
    p = fetch("MI_MARGN", "marginTrading/MI_MARGN",
              {"date": ymd, "selectType": "MS", "response": "json"}, ymd, rebuild_only)
    rows = rows_of(p)
    if not rows:
        return None
    for row in rows:
        if len(row) < 6:
            continue
        if "融資金額" not in str(row[0]):      # margin balance, NT$ thousands
            continue
        today_bal = parse_num(row[5])
        if today_bal is not None:
            return {"marginBalanceYi": round(today_bal / 1e5, 2)}   # 仟元 -> 億元
    return None


# --------------------------------------------------------------------------
# TAIFEX: institutional open interest in TAIEX futures (臺股期貨, TX)
# --------------------------------------------------------------------------
#
# Not a TWSE endpoint: the futures exchange serves 三大法人「區分各期貨契約」 as a
# CSV download over a POSTed date range. Two quirks shape the code below:
#
#   * it keeps only the last ~3 years - a range starting earlier is refused
#     outright (日期時間錯誤 DateTime error) rather than clipped, so the start is
#     clamped to the retention window and older months are never asked for;
#   * a range ending after the newest published session is refused the same
#     way, so the end steps back a day at a time until it lands on one.
#
# A range with no sessions in it answers 查無資料. Both refusals come back as a
# small HTML page, not a CSV.

TAIFEX_URL = "https://www.taifex.com.tw/cht/3/futContractsDateDown"
TAIFEX_RETENTION_YEARS = 3
TAIFEX_ENDPOINT = "TAIFEX_FUT"
# 身份別 labels. Older files say 外資 rather than 外資及陸資.
FUT_DESKS = (("外資", "foreign"), ("投信", "trust"), ("自營商", "dealer"))
FUT_NET_OI_COL = 13          # 多空未平倉口數淨額


def taifex_earliest(today):
    """First day the download still serves (a day inside the window, to be safe)."""
    y = today.year - TAIFEX_RETENTION_YEARS
    try:
        d = today.replace(year=y)
    except ValueError:                 # 29 Feb with no leap day three years back
        d = today.replace(year=y, day=28)
    return d + timedelta(days=1)


def parse_fut_csv(text):
    """
    The 區分各期貨契約 CSV -> {iso_date: {"foreign": lots, "trust": .., "dealer": ..}}.

    Values are net open interest (long minus short) in contracts. A desk with
    no row that day is absent, never 0.
    """
    out = {}
    for line in text.splitlines()[1:]:
        cols = [c.strip() for c in line.split(",")]
        if len(cols) <= FUT_NET_OI_COL:
            continue
        d = parse_twse_date(cols[0])
        desk = next((k for label, k in FUT_DESKS if label in cols[2]), None)
        v = parse_num(cols[FUT_NET_OI_COL])
        if d is None or desk is None or v is None:
            continue
        out.setdefault(d, {})[desk] = int(v)
    return out


def _taifex_get(start, end):
    """
    One POST. Returns ("ok", csv_text), ("empty", None) for 查無資料, or
    ("range", None) when TAIFEX rejects the dates. Raises on anything else.
    """
    _stats["requests"] += 1
    r = SESSION.post(TAIFEX_URL, timeout=30, headers={
        "Referer": "https://www.taifex.com.tw/cht/3/futContractsDate",
        "Accept": "text/csv,text/html;q=0.9,*/*;q=0.8",
    }, data={
        "queryStartDate": start.strftime("%Y/%m/%d"),
        "queryEndDate": end.strftime("%Y/%m/%d"),
        "commodityId": "TXF",
    })
    if r.status_code == 429 or r.status_code >= 500:
        raise requests.HTTPError(f"HTTP {r.status_code}")
    r.raise_for_status()
    text = r.content.decode("cp950", errors="replace")
    time.sleep(SLEEP_BASE + random.uniform(0, SLEEP_JITTER))
    if not text.lstrip().startswith("<"):
        return "ok", text
    if "查無資料" in text:
        return "empty", None
    if "DateTime error" in text:
        return "range", None
    raise ValueError("unexpected HTML from TAIFEX (maintenance page?)")


def fetch_futures_month(ym, rebuild_only=False, today=None):
    """
    Institutional net open interest in 臺股期貨 for one month, keyed by ISO date.

    Cached under data/raw/TAIFEX_FUT/<YYYYMM>.json with the same staleness rule
    as the TWSE monthly queries (see is_stale). Months entirely before the
    retention window return {} without a request.
    """
    today = today or date.today()
    cp = _cache_path(TAIFEX_ENDPOINT, ym)
    cached = None
    if os.path.exists(cp):
        try:
            with open(cp, "r", encoding="utf-8") as f:
                cached = json.load(f)
        except json.JSONDecodeError:
            os.remove(cp)
        else:
            if rebuild_only or not is_stale(ym, cached):
                _stats["cache_hits"] += 1
                return cached.get("rows", {})
            _stats["refreshed"] += 1
    if rebuild_only:
        return {}

    first = date(int(ym[:4]), int(ym[4:]), 1)
    last = (first.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    start, end = max(first, taifex_earliest(today)), min(last, today)
    if start > end:
        return {}

    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            # Walk the end back over unpublished days: today before ~15:00,
            # plus a weekend or holiday behind it.
            e = end
            status, text = _taifex_get(start, e)
            while status == "range" and e > start and (end - e).days < 7:
                e -= timedelta(days=1)
                status, text = _taifex_get(start, e)
            if status == "range":
                # Nothing published in this range yet; do not cache a guess.
                return cached.get("rows", {}) if cached else {}
            payload = ({"stat": "OK", "rows": parse_fut_csv(text)} if status == "ok"
                       else {"stat": "查無資料", "_empty": True, "rows": {}})
            payload["_fetchedOn"] = today.isoformat()
            with open(cp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            return payload["rows"]
        except Exception as err:  # noqa: BLE001 - same retry policy as fetch()
            last_err = err
            _stats["retries"] += 1
            if attempt < MAX_RETRIES - 1:
                time.sleep(2.0 * 2 ** attempt)
    print(f"  !! {TAIFEX_ENDPOINT} {ym} failed after {MAX_RETRIES} attempts: {last_err}",
          file=sys.stderr)
    return cached.get("rows", {}) if cached else {}


# The maintenance ratio needs every listed stock's margin lots and close, one
# whole-market request each per day. fetch_stocks.py already caches both from
# its default history start, so the series begins there rather than paying
# ~2,500 extra requests to reach back to 2017.
MARGIN_RATIO_START = "2022-01-01"


# Share of the purchase price a margin buyer borrows (融資成數).
FINANCING_RATE = {"TWSE": 0.6, "TPEx": 0.5}

# Sessions before a per-stock ratio is trusted when its loan had to be guessed:
# enough for most of the opening balance to have turned over.
MARGIN_WARMUP = 60

SHARES_PER_LOT = 1000


def is_etf(code):
    """TWSE/TPEx ETF codes (stock, bond, leveraged, active) all start with 00."""
    return code.startswith("00")


class MarginBook:
    """
    Estimated outstanding margin loan per stock, in NT dollars.

    TWSE publishes the loan amount (融資金額) only as a market total; per stock
    there are just lots. The loan is rebuilt from the daily balance change: a
    rise is new borrowing at that day's close x the financing rate, a fall
    repays the same share of the loan (positions close at their average cost).
    Summed over every listed stock this tracks the published total within a
    few percent, and its ETF slice agrees with what WantGoo shows.

    A stock first seen already holding margin has an unknown cost; its loan
    starts at `init_ratio` (market value / loan) and its ratio is withheld for
    `warmup` sessions, until most of that guess has been repaid. A stock first
    seen with no margin, or whose margin went to zero, is exact.
    """

    def __init__(self, rate, init_ratio=None, warmup=MARGIN_WARMUP):
        self.rate = rate
        self.init_ratio = init_ratio or 1 / rate      # default: bought at today's price
        self.warmup = warmup
        self.loan, self.lots, self.close, self.guessed = {}, {}, {}, {}

    def step(self, code, prev, bal, close):
        """One session's margin balance (lots before and after) for `code`."""
        if close is not None:
            self.close[code] = close
        px = self.close.get(code)
        if prev is None or bal is None:
            return
        if code not in self.loan:
            if prev > 0 and px is None:
                return                               # no price yet to value it
            self.loan[code] = prev * SHARES_PER_LOT * px / self.init_ratio if prev > 0 else 0.0
            # +1: this session is counted down below like every later one
            self.guessed[code] = self.warmup + 1 if prev > 0 and self.warmup else 0
        loan = self.loan[code]
        if bal > prev and px is not None:
            loan += (bal - prev) * SHARES_PER_LOT * px * self.rate
        elif bal < prev:
            loan = loan * bal / prev if prev > 0 else 0.0
        if bal == 0:
            loan, self.guessed[code] = 0.0, 0
        elif self.guessed[code]:
            self.guessed[code] -= 1
        self.loan[code], self.lots[code] = loan, bal

    def value(self, code):
        """Market value of the margin position, NT dollars."""
        px = self.close.get(code)
        return self.lots.get(code, 0) * SHARES_PER_LOT * px if px is not None else 0.0

    def ratio(self, code):
        """Maintenance ratio in percent, or None (no margin, or still warming up)."""
        loan = self.loan.get(code)
        if not loan or self.guessed.get(code) or not self.lots.get(code):
            return None
        return round(self.value(code) / loan * 100, 2)


def margin_market_by_day(trading_days, balances, rebuild_only=False):
    """
    Per day: {"collateralYi", "etfCollateralYi", "etfLoanYi"} for TWSE-listed
    margin, NT$100M. Collateral is sum(lots x 1000 x close); divided by the
    published balance (融資金額) it is the market maintenance ratio
    (大盤融資維持率) as brokers and the press quote it.

    The ETF loan is a MarginBook estimate, started at the market's own ratio on
    the first day, so the ex-ETF split needs no warm-up. A stock with no trade
    is valued at its last close. Days before MARGIN_RATIO_START, or whose
    whole-market tables are missing, are absent.
    """
    # fetch_stocks imports this module as `fetch_data`. Run as a script we are
    # `__main__`, so register under that name too, or the import would build a
    # second copy with its own session and counters.
    if __name__ in sys.modules:
        sys.modules.setdefault("fetch_data", sys.modules[__name__])
    import fetch_stocks as fs

    out, book = {}, None
    for d in trading_days:
        if d < MARGIN_RATIO_START:
            continue
        ymd = d.replace("-", "")
        quotes, _ = fs.fetch_quotes_day(ymd, rebuild_only)
        lots = fs.fetch_margin_all_day(ymd, rebuild_only)
        if book is None:
            book = MarginBook(FINANCING_RATE["TWSE"], warmup=0)
        for code, q in quotes.items():
            if q[3] is not None:
                book.close[code] = q[3]
        if not quotes or not lots:
            continue
        if not book.loan:
            # First usable day: start every stock at the market's ratio, so the
            # estimated loans add up to the published balance.
            mv = sum(bal * SHARES_PER_LOT * book.close[c]
                     for c, (_, bal) in lots.items() if bal and c in book.close)
            if not mv or not balances.get(d):
                continue
            book.init_ratio = mv / (balances[d] * 1e8)
        for code, (prev, bal) in lots.items():
            book.step(code, prev, bal, None)
        coll = etf_coll = etf_loan = 0.0
        for code in lots:
            v = book.value(code)
            coll += v
            if is_etf(code):
                etf_coll += v
                etf_loan += book.loan.get(code, 0.0)
        if coll > 0:
            out[d] = {"collateralYi": coll / 1e8, "etfCollateralYi": etf_coll / 1e8,
                      "etfLoanYi": etf_loan / 1e8}
    return out


def margin_fields(mkt, balance_yi):
    """
    The market ratio, plus the ex-ETF balance and ratio (published balance less
    the estimated ETF loan). All None where the day has no whole-market data.
    """
    if not mkt or not balance_yi:
        return {"marginRatio": None, "marginBalanceExEtfYi": None, "marginRatioExEtf": None}
    ex_bal = balance_yi - mkt["etfLoanYi"]
    return {
        "marginRatio": margin_ratio(mkt["collateralYi"], balance_yi),
        "marginBalanceExEtfYi": round(ex_bal, 2),
        "marginRatioExEtf": margin_ratio(mkt["collateralYi"] - mkt["etfCollateralYi"], ex_bal),
    }


def margin_ratio(collateral_yi, balance_yi):
    """Maintenance ratio in percent, or None when either side is missing."""
    if collateral_yi is None or not balance_yi:
        return None
    return round(collateral_yi / balance_yi * 100, 2)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Fetch TWSE data and build web/data/taiex-daily.json")
    ap.add_argument("--start", default=DEFAULT_START,
                    help="start month YYYY-MM (default 2017-01)")
    ap.add_argument("--end", default=None, help="end month YYYY-MM (default: today)")
    ap.add_argument("--rebuild", action="store_true",
                    help="issue no requests; rebuild outputs from the cache only")
    args = ap.parse_args()

    today = date.today()
    end_ym = args.end or f"{today.year:04d}-{today.month:02d}"
    months = month_range(args.start, end_ym)

    os.makedirs(DATA_DIR, exist_ok=True)
    t0 = time.time()

    mode = "REBUILD (no requests)" if args.rebuild else "FETCH"
    print(f"[{mode}] range {args.start} -> {end_ym} ({len(months)} months)")

    # --- Stage 1: monthly queries (OHLC + turnover) --------------------------
    print("\n[1/3] TAIEX daily OHLC + market turnover (monthly queries)")
    index_data, turnover_data = {}, {}
    for i, ym in enumerate(months, 1):
        index_data.update(fetch_index_month(ym, args.rebuild))
        turnover_data.update(fetch_turnover_month(ym, args.rebuild))
        print(f"  {ym}  {len(index_data)} trading days so far   ({i}/{len(months)})",
              flush=True)

    if not index_data:
        raise SystemExit(
            "ERROR: no TAIEX OHLC data retrieved. Check connectivity, or whether "
            "the endpoint changed shape. Aborting rather than emitting partial data.")

    # The OHLC series defines the trading calendar; everything else left-joins onto it
    trading_days = sorted(index_data.keys())
    print(f"  -> {len(trading_days)} trading days "
          f"({trading_days[0]} to {trading_days[-1]})")

    # --- Stage 2: daily queries (foreign flow + margin) ----------------------
    # TWSE offers these two only as single-day queries - there is no monthly
    # rollup and the OpenAPI resources carry no date parameter - so we walk the
    # trading calendar one day at a time.
    todo = len(trading_days) * 2
    if not args.rebuild:
        eta = todo * (SLEEP_BASE + SLEEP_JITTER / 2) / 60
        print(f"\n[2/3] Foreign net + margin balance (daily queries, {todo} requests, "
              f"~{eta:.0f} min when uncached)")
    else:
        print("\n[2/3] Foreign net + margin balance (daily queries, rebuild mode)")

    flows, margin = {}, {}
    for i, d in enumerate(trading_days, 1):
        ymd = d.replace("-", "")
        f = fetch_institutions_day(ymd, args.rebuild)
        if f is not None:
            flows[d] = f
        m = fetch_margin_day(ymd, args.rebuild)
        if m is not None:
            margin[d] = m
        if i % 25 == 0 or i == len(trading_days):
            pct = i / len(trading_days) * 100
            el = (time.time() - t0) / 60
            print(f"  {d}  {i}/{len(trading_days)} ({pct:.0f}%)  "
                  f"flows {len(flows)} / margin {len(margin)}  {el:.1f} min elapsed",
                  flush=True)

    # The whole-market tables are usually cache hits: fetch_stocks.py reads the
    # same ones. Only a day it has not seen yet costs two requests here.
    print("\n      Margin maintenance ratio (whole-market tables from "
          f"{MARGIN_RATIO_START[:7]})", flush=True)
    mkt = margin_market_by_day(
        trading_days, {d: m.get("marginBalanceYi") for d, m in margin.items()}, args.rebuild)

    # TAIFEX keeps ~3 years, so only the months inside that window are asked;
    # older ones are skipped without a request and stay null in the output.
    print("\n      Foreign net open interest in TAIEX futures (TAIFEX, monthly, "
          f"from {taifex_earliest(today).isoformat()[:7]})", flush=True)
    futures = {}
    for ym in months:
        futures.update(fetch_futures_month(ym, args.rebuild, today))
    print(f"  -> {len(futures)} sessions with futures positioning", flush=True)

    # --- Stage 3: merge and write -------------------------------------------
    print("\n[3/3] Merging")
    fetched = []
    mismatch = 0
    for d in trading_days:
        k = index_data[d]
        t = turnover_data.get(d, {})
        m = margin.get(d, {})

        # Cross-check: the close reported by FMTQIK should match the OHLC close
        cc = t.get("closeCheck")
        if cc is not None and k["close"] is not None and abs(cc - k["close"]) > 0.5:
            mismatch += 1

        fetched.append({
            "date": d,
            "open": k["open"], "high": k["high"], "low": k["low"], "close": k["close"],
            "turnoverYi": t.get("turnoverYi"),
            **{k: flows.get(d, {}).get(k)
               for k in ("foreignNetYi", "trustNetYi", "dealerNetYi")},
            "marginBalanceYi": m.get("marginBalanceYi"),
            **margin_fields(mkt.get(d), m.get("marginBalanceYi")),
            "foreignTxNetOI": futures.get(d, {}).get("foreign"),
        })

    # Fold this run's range into whatever the previous run wrote. --start names
    # the range to FETCH, not the range to keep: without this, topping up the
    # current month with `--start 2026-07` would replace a seven-year series
    # with twenty days. Freshly fetched days win on collision.
    out_json = os.path.join(DATA_DIR, "taiex-daily.json")
    merged, carried = merge_with_existing(out_json, fetched)
    if carried:
        print(f"  carried over {carried} day(s) from the existing output "
              f"outside {args.start} -> {end_ym}")

    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, separators=(",", ":"))

    # Emit the same payload as a JS file so index.html works over file:// -
    # fetch() is blocked by CORS there, but a <script src> is not.
    meta = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "start": merged[0]["date"],
        "end": merged[-1]["date"],
        "tradingDays": len(merged),
        "coverage": {
            "turnover": sum(1 for r in merged if r["turnoverYi"] is not None),
            "foreign": sum(1 for r in merged if r["foreignNetYi"] is not None),
            "trust": sum(1 for r in merged if r["trustNetYi"] is not None),
            "dealer": sum(1 for r in merged if r["dealerNetYi"] is not None),
            "margin": sum(1 for r in merged if r["marginBalanceYi"] is not None),
            "marginRatio": sum(1 for r in merged if r.get("marginRatio") is not None),
            "futures": sum(1 for r in merged if r.get("foreignTxNetOI") is not None),
        },
    }
    out_js = os.path.join(DATA_DIR, "taiex-daily.js")
    with open(out_js, "w", encoding="utf-8") as f:
        f.write("window.TAIEX_META=" + json.dumps(meta, ensure_ascii=False) + ";\n")
        f.write("window.TAIEX_DATA=" + json.dumps(merged, ensure_ascii=False,
                                                  separators=(",", ":")) + ";\n")

    el = time.time() - t0
    c = meta["coverage"]
    n = len(merged)
    print(f"""
--------------------------------------------------
  Trading days     {n}  ({meta['start']} to {meta['end']})
  Turnover         {c['turnover']}  ({c['turnover']/n*100:.1f}%)
  Foreign net      {c['foreign']}  ({c['foreign']/n*100:.1f}%)
  Margin balance   {c['margin']}  ({c['margin']/n*100:.1f}%)
  Margin ratio     {c['marginRatio']}  (from {MARGIN_RATIO_START})
  Futures net OI   {c['futures']}  (TAIFEX keeps ~{TAIFEX_RETENTION_YEARS} years)
  Close cross-check {n - mismatch}/{n} match
  {_stats['requests']} requests / {_stats['cache_hits']} cache hits / {_stats['refreshed']} stale refreshed / {_stats['retries']} retries
  Elapsed {el/60:.1f} min
  -> {out_json}
  -> {out_js}
--------------------------------------------------""")

    if c["foreign"] < n * 0.9 or c["margin"] < n * 0.9:
        print("WARNING: chip-data coverage below 90%. Re-run to fill the gaps "
              "(cached days will not be refetched).", file=sys.stderr)


if __name__ == "__main__":
    main()
