#!/usr/bin/env python3
"""
Unit tests for fetch_stocks.py parsers. Fully offline: every input is a small
inline excerpt shaped like the real response, and SESSION.get is patched to
fail loudly if anything tries the network.

Run with:  python3 tests/py/stock_fetch_test.py
"""

import os
import sys
import unittest
from unittest.mock import patch

PIPELINE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "pipeline")
sys.path.insert(0, PIPELINE_DIR)

import fetch_data  # noqa: E402
import fetch_stocks as fs  # noqa: E402


class NetworkAccessAttempted(BaseException):
    """BaseException so fetch()'s `except Exception` retry loop cannot swallow it."""


def _no_network(*_a, **_k):
    raise NetworkAccessAttempted("a test tried to hit the network")


class Base(unittest.TestCase):
    def setUp(self):
        p = patch.object(fetch_data.SESSION, "get", side_effect=_no_network)
        p.start()
        self.addCleanup(p.stop)


class TestT86(Base):
    FIELDS = ["證券代號", "證券名稱", "外陸資買進股數(不含外資自營商)", "外陸資賣出股數(不含外資自營商)",
              "外陸資買賣超股數(不含外資自營商)", "外資自營商買進股數", "外資自營商賣出股數",
              "外資自營商買賣超股數", "投信買進股數", "投信賣出股數", "投信買賣超股數",
              "自營商買賣超股數", "自營商買進股數(自行買賣)", "自營商賣出股數(自行買賣)",
              "自營商買賣超股數(自行買賣)", "自營商買進股數(避險)", "自營商賣出股數(避險)",
              "自營商買賣超股數(避險)", "三大法人買賣超股數"]
    ROW = ["2327", "國巨*  ", "10,486,351", "14,203,233", "-3,716,882", "0", "0", "1,000",
           "1,348,593", "197,000", "1,151,593", "-1,544,564", "44,295", "1,150,392",
           "-1,106,097", "226,004", "664,471", "-438,467", "-4,109,853"]

    def test_columns_by_name(self):
        rows = fs.slim_t86({"fields": self.FIELDS, "data": [self.ROW]})["rows"]
        # foreign = 外陸資 + 外資自營商; dealer = the total column, not a sub-desk
        self.assertEqual(rows["2327"], [-3715882, 1151593, -1544564])

    def test_dirty_value_is_none_not_zero(self):
        row = list(self.ROW)
        row[10] = "--"
        self.assertIsNone(fs.slim_t86({"fields": self.FIELDS, "data": [row]})["rows"]["2327"][1])


class TestMargin(Base):
    def test_margin_rows(self):
        payload = {"tables": [
            {"fields": ["項目", "買進", "賣出", "現金(券)償還", "前日餘額", "今日餘額"],
             "data": [["融資(交易單位)", "1", "2", "3", "4", "5"]]},
            {"fields": ["代號", "名稱", "買進", "賣出", "現金償還", "前日餘額", "今日餘額",
                        "次一營業日限額", "買進", "賣出", "現券償還", "前日餘額", "今日餘額"],
             "data": [["2327", "國巨*", "1,142", "1,257", "11", "51,866", "51,740",
                       "514,682", "57", "26", "0", "391", "360"]]},
        ]}
        # The first 前日餘額/今日餘額 pair is 融資, not 融券
        self.assertEqual(fs.slim_margin(payload)["rows"], {"2327": [51866, 51740]})


class TestQuotes(Base):
    def test_quote_table_found_by_header(self):
        payload = {"tables": [
            {"fields": ["指數", "收盤指數"], "data": [["發行量加權股價指數", "40,000"]]},
            {"fields": ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價",
                        "最高價", "最低價", "收盤價", "漲跌(+/-)"],
             "data": [["2330", "台積電", "43,046,982", "1", "1", "2,430.00", "2,445.00",
                       "2,420.00", "2,420.00", "<p>-</p>"],
                      ["9999", "停牌股", "0", "0", "0", "--", "--", "--", "--", ""]]},
        ]}
        out = fs.slim_quotes(payload)
        self.assertEqual(out["rows"]["2330"], [2430, 2445, 2420, 2420, 43047])
        self.assertEqual(out["names"]["2330"], "台積電")
        # No trade: prices are gaps, not zeros
        self.assertEqual(out["rows"]["9999"][:4], [None, None, None, None])

    def test_universe(self):
        ok = ["2330", "0050", "00878", "00632R"]
        no = ["2881A", "01001T", "020000", "910322", "1101B"]
        self.assertTrue(all(fs.UNIVERSE_RE.fullmatch(c) for c in ok))
        self.assertFalse(any(fs.UNIVERSE_RE.fullmatch(c) for c in no))


class TestTpex(Base):
    def test_quotes(self):
        payload = {"stat": "ok", "tables": [{"fields": [
            "代號", "名稱", "收盤 ", "漲跌", "開盤 ", "最高 ", "最低", "成交股數  ", " 成交金額(元)"],
            "data": [["6488", "環球晶", "902.00", "-21.00", "936.00", "936.00", "890.00",
                      "14,831,000", "1"]]}]}
        out = fs.slim_tpex_quotes(payload)
        self.assertEqual(out["rows"]["6488"], [936, 936, 890, 902, 14831])
        self.assertEqual(out["names"]["6488"], "環球晶")

    def test_inst_by_position_with_sum_check(self):
        fields = ["代號", "名稱"] + ["買進股數", "賣出股數", "買賣超股數"] * 7 + ["三大法人買賣超股數合計"]
        good = ["6488", "環球晶", "3,922,489", "8,379,161", "-4,456,672", "0", "0", "0",
                "3,922,489", "8,379,161", "-4,456,672", "246,714", "25,000", "221,714",
                "85,700", "182,440", "-96,740", "928,297", "978,990", "-50,693",
                "1,013,997", "1,161,430", "-147,433", "-4,382,391"]
        bad = list(good)
        bad[0], bad[23] = "9999", "1"          # nets no longer add up: layout changed
        out = fs.slim_tpex_inst({"tables": [{"fields": fields, "data": [good, bad]}]})
        self.assertEqual(out["rows"], {"6488": [-4456672, 221714, -147433]})

    def test_inst_unknown_layout_is_no_data(self):
        out = fs.slim_tpex_inst({"tables": [{"fields": ["代號", "名稱", "x"], "data": [["1", "a", "2"]]}]})
        self.assertTrue(out.get("_empty"))

    def test_margin(self):
        payload = {"tables": [{"fields": ["代號", "名稱", "前資餘額(張)", "資買", "資賣", "現償",
                                          "資餘額", "資屬證金"],
                               "data": [["6488", "環球晶", "13,977", "1,009", "1,014", "3", "13,969", "221"]]}]}
        self.assertEqual(fs.slim_tpex_margin(payload)["rows"], {"6488": [13977, 13969]})

    def test_unpublished_day_is_empty_not_final(self):
        # TPEx answers stat "ok" with an empty table before it publishes a day
        self.assertTrue(fs.slim_tpex_quotes({"stat": "ok", "tables": [{"fields": [], "data": []}]})["_empty"])
        self.assertEqual(fs._tpex_date("20261016"), "2026/10/16")


class TestHoldersFreshness(Base):
    def test_weekly_after_saturday(self):
        from datetime import date
        f = lambda d: fs.holders_fresh_since(date.fromisoformat(d))  # noqa: E731
        self.assertEqual(f("2026-10-17"), "2026-10-17")   # Saturday itself
        self.assertEqual(f("2026-10-19"), "2026-10-17")   # Monday
        self.assertEqual(f("2026-10-23"), "2026-10-17")   # Friday
        self.assertEqual(f("2026-10-24"), "2026-10-24")


class TestHolders(Base):
    HEAD = ("<table id='Details'><tr class='lDS'><td>&nbsp;</td><td>&nbsp;</td><td>資料日期</td>"
            "<td>集保</br>總張數</td><td>總股東<br/>人數</td><td>平均</br>張數/人</td>"
            "<td>>400張</br>大股東<br/>持有張數</td><td>>400張</br>大股東<br/>持有百分比</td>"
            "<td>>400張</br>大股東<br/>人數</td><td>400</br>~600張</br>人數</td>"
            "<td>600</br>~800張</br>人數</td><td>800</br>~1000張</br>人數</td>"
            "<td>>1000張</br>人數</td><td>>1000張</br>大股東<br/>持有百分比</td><td>收盤價</td>"
            "<td>&nbsp;</td></tr>")

    @staticmethod
    def row(d, holders):
        cells = ["&nbsp;", "<div>&nbsp;</div>", f"{d}&nbsp;", "2,058,731&nbsp;", holders, "3.32",
                 "1,373,079", "66.70", "358", "87", "47", "28", "196", "61.74", "567.00", "&nbsp;"]
        return "<tr class='lDS'>" + "".join(f"<td>{c}</td>" for c in cells) + "<tr/>"

    def test_parse_sorted_and_split_week_dropped(self):
        body = (self.HEAD + self.row("20261016", "619,908") + self.row("20250822", "1")
                + self.row("20261008", "585,575") + "</table>")
        out = fs.parse_holders(body)
        self.assertEqual([r["date"] for r in out], ["2026-10-08", "2026-10-16"])
        self.assertEqual(out[-1], {"date": "2026-10-16", "holders": 619908, "avgLots": 3.32,
                                   "big400Pct": 66.70, "big400": 358, "big1000": 196,
                                   "big1000Pct": 61.74})


class TestAdjustments(Base):
    """Splits and capital reductions: listed by TWSE, or inferred from a halt and a gap."""

    def test_listed_event(self):
        p = {"stat": "OK", "fields": ["恢復買賣日期", "股票代號", "名稱", "停止買賣前收盤價格",
                                      "恢復買賣參考價", "漲停價格"],
             "data": [["114/08/25", "2327", "國巨", "546.00", "136.50", "150.00"]]}
        self.assertEqual(fs.slim_adjust(p)["rows"], [["2327", "2025-08-25", 546.0, 136.5]])

    def test_reference_price_from_change(self):
        p = {"tables": [{"fields": ["證券代號", "收盤價", "漲跌(+/-)", "漲跌價差"],
                         "data": [["0050", "47.57", "<p style= color:red>+</p>", "0.41"],
                                  ["2330", "1,000.00", "<p style= color:green>-</p>", "5.00"],
                                  ["1101", "30.00", "<p> </p>", "0.00"],
                                  ["9999", "--", "X", "0.00"]]}]}
        self.assertEqual(fs.slim_reference(p)["rows"], {"0050": 47.16, "2330": 1005.0, "1101": 30.0})

    cal = ["2025-06-09", "2025-06-10", "2025-06-11", "2025-06-12", "2025-06-13", "2025-06-16",
           "2025-06-17", "2025-06-18"]

    def rows(self, *pairs):
        return [{"date": d, "open": o, "close": c} for d, o, c in pairs]

    def test_inferred_split_uses_the_reference_price(self):
        d = self.rows(("2025-06-10", 188, 188.65), ("2025-06-18", 47.5, 47.57))
        ev = fs.infer_splits(d, self.cal, reference=lambda day: 47.16)
        self.assertEqual([(e["date"], e["kind"], round(e["ratio"], 3), "estimated" in e) for e in ev],
                         [("2025-06-18", "分割", 4.0, False)])

    def test_without_a_reference_the_ratio_is_estimated(self):
        d = self.rows(("2025-06-10", 6, 6.82), ("2025-06-18", 27.3, 27.4))
        ev = fs.infer_splits(d, self.cal)
        self.assertEqual([(e["kind"], e["ratio"], e["estimated"]) for e in ev], [("反分割", 0.25, True)])

    def test_no_halt_or_no_round_ratio_is_not_a_split(self):
        # A limit-down day with no halt, and a halt that resumes at an odd ratio
        self.assertEqual(fs.infer_splits(self.rows(("2025-06-17", 100, 100), ("2025-06-18", 50, 50)),
                                         self.cal), [])
        self.assertEqual(fs.infer_splits(self.rows(("2025-06-10", 100, 100), ("2025-06-18", 40, 40)),
                                         self.cal), [])

    def test_listed_events_win_and_need_sessions_on_both_sides(self):
        d = self.rows(("2025-06-10", 546, 546), ("2025-06-18", 140, 140))
        listed = [{"date": "2025-06-18", "kind": "面額變更", "before": 546, "ref": 136.5, "ratio": 4.0},
                  {"date": "2025-06-09", "kind": "減資", "before": 1, "ref": 2, "ratio": 0.5}]
        self.assertEqual(fs.adjust_events(d, self.cal, listed), listed[:1])


class TestBrokers(Base):
    def test_parse(self):
        body = ("<div class=\"t11\">單位：張　最後更新日：2026/10/16</div>"
                "<TR><TD class=\"t2\">買超券商</TD><TD>買進</TD><TD>賣出</TD><TD>買超</TD><TD>佔成交比重</TD>"
                "<TD>賣超券商</TD><TD>買進</TD><TD>賣出</TD><TD>賣超</TD><TD>佔成交比重</TD></TR>"
                "<TR><TD class=\"t4t1\" nowrap><a href=\"x\">新加坡商瑞銀</a></TD><TD>2,129</TD>"
                "<TD>855</TD><TD>1,274</TD><TD>3.51%</TD><TD><a href=\"y\">美林</a></TD>"
                "<TD>566</TD><TD>3,235</TD><TD>2,669</TD><TD>7.36%</TD></tr>")
        b = fs.parse_brokers(body)
        self.assertEqual(b["updated"], "2026-10-16")
        self.assertEqual(b["buy"], [{"name": "新加坡商瑞銀", "buy": 2129, "sell": 855,
                                     "net": 1274, "pct": 3.51}])
        self.assertEqual(b["sell"][0]["name"], "美林")

    def test_page_totals(self):
        body = ("<div>最後更新日：2026/10/08</div><TR><TD><a>x</a></TD><TD>1</TD><TD>0</TD><TD>1</TD>"
                "<TD>1%</TD><TD><a>y</a></TD><TD>0</TD><TD>1</TD><TD>1</TD><TD>1%</TD></TR>"
                "<tr><td>合計買超張數</td><td>3,804</td><td>合計賣超張數</td><td>13,043</td></tr>")
        b = fs.parse_brokers(body)
        self.assertEqual((b["totalBuy"], b["totalSell"]), (3804, 13043))

    def test_empty_page(self):
        self.assertIsNone(fs.parse_brokers("<html>無資料</html>"))


class TestTrackedPages(Base):
    """A tracked stock asks for each session's table and the 5/20-day windows only."""

    @staticmethod
    def page(d, tb, ts):
        y, m, dd = d.split("-")
        return (f"<div>最後更新日：{y}/{int(m)}/{int(dd)}</div><TR><TD><a>x</a></TD><TD>9</TD>"
                "<TD>0</TD><TD>9</TD><TD>1%</TD><TD><a>y</a></TD><TD>0</TD><TD>4</TD><TD>4</TD>"
                f"<TD>1%</TD></TR><tr><td>合計買超張數</td><td>{tb}</td>"
                f"<td>合計賣超張數</td><td>{ts}</td></tr>")

    def test_pages_and_main_force(self):
        days = ["2026-10-15", "2026-10-16"]
        quotes = {"2327": [1, 2, 1, 2, 1000]}
        market = {d: (quotes, {}, {}) for d in days}
        seen = []

        def fake_fetch_page(source, key, url, encoding, rebuild_only=False, permanent=False,
                            fresh_since=None):
            seen.append(source if source != "DJ_ZCO" else f"DJ_ZCO{key[4:]}")
            if source == "DJ_ZCO_DAY":
                d = key.split("_")[1]
                d = f"{d[:4]}-{d[4:6]}-{d[6:]}"
                return self.page(d, 300 if d == days[0] else 50, 100)
            if source == "DJ_ZCO":
                return self.page(days[-1], 1, 1)
            return None

        with patch.object(fs, "fetch_page", side_effect=fake_fetch_page), \
             patch.object(fs, "load_previous", return_value={}):
            s = fs.build_stock("2327", "國巨", days, market, tracked=True)

        self.assertEqual(sorted(seen), ["DJ_ZCO_2", "DJ_ZCO_4", "DJ_ZCO_DAY", "DJ_ZCO_DAY",
                                        "TWSTHR"])
        self.assertEqual(sorted(s["brokers"]), ["20", "5"])
        self.assertEqual([r["mainForce"] for r in s["daily"]], [200, -50])
        self.assertEqual(sorted(s["brokerDaily"]), days)

    def test_days_before_broker_window_are_cache_only(self):
        days = ["2025-10-20", "2026-10-16"]
        market = {d: ({"2327": [1, 2, 1, 2, 1000]}, {}, {}) for d in days}
        calls = []

        def fake_fetch_page(source, key, url, encoding, rebuild_only=False, permanent=False,
                            fresh_since=None):
            calls.append((source, key, rebuild_only))
            return None

        with patch.object(fs, "fetch_page", side_effect=fake_fetch_page), \
             patch.object(fs, "load_previous", return_value={}):
            fs.build_stock("2327", "國巨", days, market, tracked=True, broker_from="2025-10-22")
        day_calls = {k: ro for src, k, ro in calls if src == "DJ_ZCO_DAY"}
        self.assertEqual(day_calls, {"2327_20251020": True, "2327_20261016": False})


class TestDjPacing(Base):
    """A failure doubles the DJ delay; a run of clean requests halves it again."""

    def test_backs_off_then_recovers(self):
        import tempfile
        from unittest.mock import MagicMock
        ok = MagicMock(content=b"x")
        replies = [OSError("timeout"), ok] + [ok] * fs.DJ_RECOVER

        def fake_get(*_a, **_k):
            r = replies.pop(0)
            if isinstance(r, Exception):
                raise r
            return r

        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(fetch_data.SESSION, "get", side_effect=fake_get), \
             patch.object(fetch_data, "_cache_path",
                          side_effect=lambda s, k: os.path.join(tmp, f"{s}_{k}.json")), \
             patch.object(fs, "_dj", {"sleep": fs.DJ_SLEEP, "ok": 0}), \
             patch.object(fs.time, "sleep"), patch("sys.stderr"):
            fs.fetch_page("DJ_ZCO_DAY", "k0", "u", "big5")
            self.assertEqual(fs._dj["sleep"], fs.DJ_SLEEP * 2)
            for i in range(1, fs.DJ_RECOVER):
                fs.fetch_page("DJ_ZCO_DAY", f"k{i}", "u", "big5")
            self.assertEqual(fs._dj["sleep"], fs.DJ_SLEEP)


class TestTopList(Base):
    def test_ranks_by_trading_value_and_skips_funds(self):
        days = ["2026-10-15", "2026-10-16"]
        q = {"2330": [1, 1, 1, 1000, 50], "2327": [1, 1, 1, 500, 300],
             "0050": [1, 1, 1, 200, 9999], "1101": [1, 1, 1, 40, 10]}
        market = {d: (q, {}, {}) for d in days}
        top = fs.rank_top(market, days, {"2327": "國巨"}, n=2)
        self.assertEqual([c for c, _, _ in top], ["2327", "2330"])   # 0050 is a fund
        self.assertEqual(top[0][1], "國巨")
        self.assertEqual(top[0][2], 500 * 300 * fs.LOTS)

    def test_needs_half_the_sessions(self):
        days = ["2026-10-14", "2026-10-15", "2026-10-16"]
        market = {d: ({"2330": [1, 1, 1, 10, 10]}, {}, {}) for d in days}
        market["2026-10-16"][0]["9999"] = [1, 1, 1, 1e6, 1e6]       # one huge day only
        self.assertEqual([c for c, _, _ in fs.rank_top(market, days, {})], ["2330"])


class TestWatchlist(Base):
    def test_comments_and_dupes(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
            f.write("# list\n2327  # 國巨\n\n2330\n2327\n")
        self.addCleanup(os.remove, f.name)
        self.assertEqual(fs.read_watchlist(f.name), ["2327", "2330"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
