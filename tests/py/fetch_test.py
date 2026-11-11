#!/usr/bin/env python3
"""
Unit tests for fetch_data.py (the TWSE data fetcher).

Every test in this file runs fully offline:

  * The four fetch_*_month/day functions are always called with
    rebuild_only=True, so they only ever read the on-disk cache under
    data/raw/ and never build a URL.
  * As a defensive backstop, setUp() monkeypatches fetch_data.SESSION.get to
    raise AssertionError. If any code path we did not anticipate tries to
    reach the network, the test fails loudly instead of hammering the real
    TWSE endpoints (which rate-limit aggressively).

Run with:  python3 tests/py/fetch_test.py
"""

import importlib.util
import os
import sys
import unittest
from datetime import date, timedelta
from unittest.mock import patch

# --------------------------------------------------------------------------
# Load the module under test (fetch_data.py is a plain script, not a
# package, and lives in pipeline/ at the project root).
# --------------------------------------------------------------------------

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PIPELINE_DIR = os.path.join(os.path.dirname(os.path.dirname(TESTS_DIR)), "pipeline")
MODULE_PATH = os.path.join(PIPELINE_DIR, "fetch_data.py")

if PIPELINE_DIR not in sys.path:
    sys.path.insert(0, PIPELINE_DIR)

_spec = importlib.util.spec_from_file_location("fetch_data", MODULE_PATH)
fetch_data = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fetch_data)


class NetworkAccessAttempted(BaseException):
    """
    Deliberately derived from BaseException, NOT Exception.

    fetch() wraps its request in `except Exception` to drive retry/backoff. An
    AssertionError raised here would be swallowed by that handler, retried three
    times (sleeping ~6s in the process) and turned into a quiet `None` — so the
    guard would stop the network call but never actually fail the test. Deriving
    from BaseException walks straight out through the retry loop instead.
    """


def _fail_on_network_call(*_args, **_kwargs):
    raise NetworkAccessAttempted(
        "SESSION.get was called - a test tried to hit the network. All "
        "fetch_*_month/day calls in tests must pass rebuild_only=True."
    )


class NetworkGuardedTestCase(unittest.TestCase):
    """Base class that makes any accidental HTTP call fail immediately."""

    def setUp(self):
        patcher = patch.object(fetch_data.SESSION, "get", side_effect=_fail_on_network_call)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_network_guard_is_effective(self):
        """The guard itself must fail loudly, not be absorbed by retry/backoff."""
        with self.assertRaises(NetworkAccessAttempted):
            # 199001 is not cached, so without rebuild_only this would go out to TWSE
            fetch_data.fetch_index_month("199001", rebuild_only=False)


# --------------------------------------------------------------------------
# parse_num
# --------------------------------------------------------------------------

class TestParseNum(NetworkGuardedTestCase):
    """parse_num must return a float for parseable input, and None (never 0)
    for anything it cannot parse."""

    def test_parses_plain_integer(self):
        self.assertEqual(fetch_data.parse_num("42"), 42.0)

    def test_parses_negative_number(self):
        self.assertEqual(fetch_data.parse_num("-274.83"), -274.83)

    def test_parses_thousands_separators(self):
        self.assertEqual(fetch_data.parse_num("1,234.5"), 1234.5)
        self.assertEqual(fetch_data.parse_num("507,011,173"), 507011173.0)

    def test_parses_parenthesised_negative(self):
        self.assertEqual(fetch_data.parse_num("(123.4)"), -123.4)

    def test_strips_full_width_space(self):
        # TWSE sometimes pads numeric fields with a full-width (U+3000) space.
        self.assertEqual(fetch_data.parse_num("1　234"), 1234.0)

    def test_zero_is_a_valid_value_not_confused_with_none(self):
        self.assertEqual(fetch_data.parse_num("0"), 0.0)
        self.assertEqual(fetch_data.parse_num(0), 0.0)

    def test_dash_placeholders_return_none(self):
        for placeholder in ("--", "---", "-"):
            self.assertIsNone(fetch_data.parse_num(placeholder), f"{placeholder!r} should be None")

    def test_letter_placeholders_return_none(self):
        for placeholder in ("X", "x", "N/A", "n/a"):
            self.assertIsNone(fetch_data.parse_num(placeholder), f"{placeholder!r} should be None")

    def test_empty_string_returns_none(self):
        self.assertIsNone(fetch_data.parse_num(""))

    def test_none_input_returns_none(self):
        self.assertIsNone(fetch_data.parse_num(None))

    def test_whitespace_only_returns_none(self):
        self.assertIsNone(fetch_data.parse_num("   "))
        self.assertIsNone(fetch_data.parse_num("　"))

    def test_unparseable_text_returns_none_not_zero(self):
        # This is the critical guarantee: garbage must never silently become 0,
        # which would corrupt downstream averages.
        result = fetch_data.parse_num("abc")
        self.assertIsNone(result)
        self.assertNotEqual(result, 0)


# --------------------------------------------------------------------------
# parse_twse_date
# --------------------------------------------------------------------------

class TestParseTwseDate(NetworkGuardedTestCase):

    def test_roc_calendar_slash_format(self):
        self.assertEqual(fetch_data.parse_twse_date("115/07/17"), "2026-07-17")

    def test_gregorian_slash_format(self):
        self.assertEqual(fetch_data.parse_twse_date("2026/07/17"), "2026-07-17")

    def test_compact_gregorian_format(self):
        self.assertEqual(fetch_data.parse_twse_date("20260717"), "2026-07-17")

    def test_single_digit_month_and_day(self):
        self.assertEqual(fetch_data.parse_twse_date("115/7/7"), "2026-07-07")

    def test_invalid_text_returns_none(self):
        self.assertIsNone(fetch_data.parse_twse_date("abc"))

    def test_invalid_month_and_day_returns_none(self):
        self.assertIsNone(fetch_data.parse_twse_date("115/13/45"))

    def test_none_input_returns_none(self):
        self.assertIsNone(fetch_data.parse_twse_date(None))

    def test_empty_string_returns_none(self):
        self.assertIsNone(fetch_data.parse_twse_date(""))

    def test_1911_boundary_rule_applies_roc_offset(self):
        # Any year below 1911 is treated as an ROC year and gets +1911, per
        # the function's documented rule (TWSE never serves pre-1911 data).
        self.assertEqual(fetch_data.parse_twse_date("1910/01/01"), "3821-01-01")
        # Year 1911 itself is on the Gregorian side of the boundary (not < 1911).
        self.assertEqual(fetch_data.parse_twse_date("1911/01/01"), "1911-01-01")


# --------------------------------------------------------------------------
# month_range
# --------------------------------------------------------------------------

class TestMonthRange(NetworkGuardedTestCase):

    def test_single_month_when_start_equals_end(self):
        self.assertEqual(fetch_data.month_range("2024-03", "2024-03"), ["202403"])

    def test_within_a_single_year(self):
        self.assertEqual(
            fetch_data.month_range("2024-01", "2024-04"),
            ["202401", "202402", "202403", "202404"],
        )

    def test_spans_a_year_boundary(self):
        self.assertEqual(
            fetch_data.month_range("2024-11", "2025-02"),
            ["202411", "202412", "202501", "202502"],
        )

    def test_spans_multiple_years(self):
        result = fetch_data.month_range("2023-11", "2025-02")
        self.assertEqual(result[0], "202311")
        self.assertEqual(result[-1], "202502")
        self.assertEqual(len(result), 16)
        # Every entry must be well-formed YYYYMM and strictly increasing.
        self.assertEqual(result, sorted(result))
        self.assertTrue(all(len(k) == 6 and k.isdigit() for k in result))


# --------------------------------------------------------------------------
# rows_of
# --------------------------------------------------------------------------

class TestRowsOf(NetworkGuardedTestCase):

    def test_flat_data_payload(self):
        payload = {"stat": "OK", "data": [["a", "1"], ["b", "2"]]}
        self.assertEqual(fetch_data.rows_of(payload), [["a", "1"], ["b", "2"]])

    def test_nested_tables_payload(self):
        payload = {"stat": "OK", "tables": [{"data": [["x", "1"]]}]}
        self.assertEqual(fetch_data.rows_of(payload), [["x", "1"]])

    def test_nested_tables_skips_empty_tables(self):
        # MI_MARGN sometimes returns a second, empty table alongside the real one.
        payload = {"stat": "OK", "tables": [{}, {"data": [["y", "2"]]}]}
        self.assertEqual(fetch_data.rows_of(payload), [["y", "2"]])

    def test_empty_marker_returns_empty_list(self):
        self.assertEqual(fetch_data.rows_of({"stat": "", "_empty": True}), [])

    def test_none_payload_returns_empty_list(self):
        self.assertEqual(fetch_data.rows_of(None), [])

    def test_empty_dict_returns_empty_list(self):
        self.assertEqual(fetch_data.rows_of({}), [])


# --------------------------------------------------------------------------
# is_stale
# --------------------------------------------------------------------------

class TestIsStale(NetworkGuardedTestCase):
    """Keys are built relative to date.today() so this suite does not rot."""

    def test_current_month_key_is_stale(self):
        today = date.today()
        key = f"{today.year:04d}{today.month:02d}"
        self.assertTrue(fetch_data.is_stale(key, {"stat": "OK", "data": []}))

    def test_past_month_key_is_not_stale(self):
        today = date.today()
        last_day_of_prev_month = date(today.year, today.month, 1) - timedelta(days=1)
        key = f"{last_day_of_prev_month.year:04d}{last_day_of_prev_month.month:02d}"
        self.assertFalse(fetch_data.is_stale(key, {"stat": "OK", "data": []}))

    def test_empty_marker_within_recheck_window_is_stale(self):
        today = date.today()
        recent_day = today - timedelta(days=fetch_data.EMPTY_RECHECK_DAYS)
        key = recent_day.strftime("%Y%m%d")
        self.assertTrue(fetch_data.is_stale(key, {"_empty": True}))

    def test_empty_marker_today_is_stale(self):
        key = date.today().strftime("%Y%m%d")
        self.assertTrue(fetch_data.is_stale(key, {"_empty": True}))

    def test_empty_marker_older_than_recheck_window_is_not_stale(self):
        today = date.today()
        old_day = today - timedelta(days=fetch_data.EMPTY_RECHECK_DAYS + 1)
        key = old_day.strftime("%Y%m%d")
        self.assertFalse(fetch_data.is_stale(key, {"_empty": True}))

    def test_non_empty_daily_payload_is_never_stale(self):
        # Even a same-day payload is not stale as long as it is not an _empty
        # marker - only monthly keys and _empty daily markers can be stale.
        key = date.today().strftime("%Y%m%d")
        payload = {"stat": "OK", "data": [["row"]]}
        self.assertFalse(fetch_data.is_stale(key, payload))


# --------------------------------------------------------------------------
# fetch_index_month / fetch_turnover_month
#
# Shape and row-count assertions run against a CLOSED month. Pointing them at
# the current month made them rot daily: the monthly cache legitimately gains a
# row after every session, so a hard-coded count passes on the day it is written
# and fails the next. Value spot-checks below stay pinned to their own dates,
# which never move.
# --------------------------------------------------------------------------

CLOSED_MONTH = "202606"          # June 2026: 21 sessions, will never change
CLOSED_MONTH_DAYS = 21

class TestFetchIndexMonth(NetworkGuardedTestCase):

    def test_parses_cached_month_into_iso_keyed_dict(self):
        result = fetch_data.fetch_index_month(CLOSED_MONTH, rebuild_only=True)
        self.assertIsInstance(result, dict)
        self.assertEqual(len(result), CLOSED_MONTH_DAYS)
        for k in result:
            # ISO date format, YYYY-MM-DD
            self.assertRegex(k, r"^\d{4}-\d{2}-\d{2}$")
        for row in result.values():
            self.assertEqual(set(row.keys()), {"open", "high", "low", "close"})

    def test_known_close_value(self):
        result = fetch_data.fetch_index_month("202607", rebuild_only=True)
        self.assertAlmostEqual(result["2026-07-17"]["close"], 42671.27)

    def test_missing_cache_returns_empty_dict_not_exception(self):
        result = fetch_data.fetch_index_month("199001", rebuild_only=True)
        self.assertEqual(result, {})


class TestFetchTurnoverMonth(NetworkGuardedTestCase):

    def test_parses_cached_month_into_iso_keyed_dict(self):
        result = fetch_data.fetch_turnover_month(CLOSED_MONTH, rebuild_only=True)
        self.assertIsInstance(result, dict)
        self.assertEqual(len(result), CLOSED_MONTH_DAYS)
        for k in result:
            self.assertRegex(k, r"^\d{4}-\d{2}-\d{2}$")
        for row in result.values():
            self.assertEqual(set(row.keys()), {"turnoverYi", "closeCheck"})

    def test_yuan_to_yi_conversion(self):
        # Raw turnover value for 2026-07-01 is 1,367,817,795,171 (NT dollars).
        # yuan -> yi (NT$100M) is a division by 1e8.
        result = fetch_data.fetch_turnover_month("202607", rebuild_only=True)
        self.assertAlmostEqual(result["2026-07-01"]["turnoverYi"], 13678.18)

    def test_close_check_cross_references_ohlc_close(self):
        result = fetch_data.fetch_turnover_month("202607", rebuild_only=True)
        self.assertAlmostEqual(result["2026-07-01"]["closeCheck"], 47018.99)

    def test_missing_cache_returns_empty_dict_not_exception(self):
        result = fetch_data.fetch_turnover_month("199001", rebuild_only=True)
        self.assertEqual(result, {})


# --------------------------------------------------------------------------
# desk_of / fetch_institutions_day  (real cache fixtures: data/raw/BFI82U/*.json)
# --------------------------------------------------------------------------

class TestDeskOf(unittest.TestCase):
    """Row-label classification. The overlap between the two tokens is the
    whole point: 外資自營商 is foreign money, not a domestic dealer desk."""

    def test_foreign_rows(self):
        self.assertEqual(fetch_data.desk_of("外資及陸資(不含外資自營商)"), "foreign")
        self.assertEqual(fetch_data.desk_of("外資自營商"), "foreign")

    def test_foreign_dealer_is_not_counted_as_dealer(self):
        # Contains BOTH 外資 and 自營商; must land in exactly one bucket.
        self.assertNotEqual(fetch_data.desk_of("外資自營商"), "dealer")

    def test_domestic_desks(self):
        self.assertEqual(fetch_data.desk_of("自營商(自行買賣)"), "dealer")
        self.assertEqual(fetch_data.desk_of("自營商(避險)"), "dealer")
        self.assertEqual(fetch_data.desk_of("投信"), "trust")

    def test_total_row_is_excluded(self):
        self.assertIsNone(fetch_data.desk_of("合計"))


class TestFetchInstitutionsDay(NetworkGuardedTestCase):

    def test_known_values_20260729(self):
        result = fetch_data.fetch_institutions_day("20260729", rebuild_only=True)
        self.assertIsInstance(result, dict)
        self.assertEqual(set(result), {"foreignNetYi", "trustNetYi", "dealerNetYi"})
        self.assertAlmostEqual(result["foreignNetYi"], -222.52)

    def test_known_foreign_net_value_20260717(self):
        result = fetch_data.fetch_institutions_day("20260717", rebuild_only=True)
        self.assertAlmostEqual(result["foreignNetYi"], -1883.15)

    def test_sums_all_rows_containing_foreign_token(self):
        # 2026-07-29 has two rows containing the 外資 token:
        #   外資及陸資(不含外資自營商) -22,251,858,551
        #   外資自營商                            0
        # The market convention sums them; total / 1e8 rounded to 2dp.
        result = fetch_data.fetch_institutions_day("20260729", rebuild_only=True)
        expected = round((-22_251_858_551 + 0) / 1e8, 2)
        self.assertAlmostEqual(result["foreignNetYi"], expected)

    def test_sums_both_dealer_desks(self):
        # 2026-07-30: 自營商(自行買賣) -504,368,492 + 自營商(避險) -14,722,165,301
        result = fetch_data.fetch_institutions_day("20260730", rebuild_only=True)
        expected = round((-504_368_492 + -14_722_165_301) / 1e8, 2)
        self.assertAlmostEqual(result["dealerNetYi"], expected)

    def test_trust_is_independent_of_foreign(self):
        # 2026-07-30 is the case that motivates the feature: foreign sold hard
        # while trusts bought. Opposite signs, so the two cannot be conflated.
        result = fetch_data.fetch_institutions_day("20260730", rebuild_only=True)
        self.assertLess(result["foreignNetYi"], 0)
        self.assertGreater(result["trustNetYi"], 0)

    def test_missing_cache_returns_none_not_exception(self):
        result = fetch_data.fetch_institutions_day("19900101", rebuild_only=True)
        self.assertIsNone(result)


# --------------------------------------------------------------------------
# fetch_margin_day  (real cache fixtures: data/raw/MI_MARGN/*.json)
# --------------------------------------------------------------------------

class TestFetchMarginDay(NetworkGuardedTestCase):

    def test_known_margin_balance_20260729(self):
        result = fetch_data.fetch_margin_day("20260729", rebuild_only=True)
        self.assertIsInstance(result, dict)
        self.assertEqual(set(result.keys()), {"marginBalanceYi"})
        self.assertAlmostEqual(result["marginBalanceYi"], 5070.11)

    def test_known_margin_balance_20260717(self):
        result = fetch_data.fetch_margin_day("20260717", rebuild_only=True)
        self.assertAlmostEqual(result["marginBalanceYi"], 5879.63)

    def test_thousand_to_yi_conversion(self):
        # Raw 今日餘額 for 20260729 is 507,011,173 (NT$ thousands, 仟元).
        # 仟元 -> 億元 is a division by 1e5.
        result = fetch_data.fetch_margin_day("20260729", rebuild_only=True)
        expected = round(507_011_173 / 1e5, 2)
        self.assertAlmostEqual(result["marginBalanceYi"], expected)
        self.assertEqual(expected, 5070.11)

    def test_short_balance_is_not_carried_into_the_output(self):
        # The raw response has a 融券 row; nothing downstream reads it, so the
        # parser must not smuggle it into the merged series.
        result = fetch_data.fetch_margin_day("20260717", rebuild_only=True)
        self.assertNotIn("shortBalanceUnits", result)

    def test_missing_cache_returns_none_not_exception(self):
        result = fetch_data.fetch_margin_day("19900101", rebuild_only=True)
        self.assertIsNone(result)


# --------------------------------------------------------------------------
# Market margin maintenance ratio  (real cache fixtures: data/raw/MI_MARGN_ALL,
# data/raw/MI_INDEX - the whole-market tables fetch_stocks.py caches)
# --------------------------------------------------------------------------

class TestMarginRatio(NetworkGuardedTestCase):

    def _market(self, days):
        bal = {d: fetch_data.fetch_margin_day(d.replace("-", ""), rebuild_only=True)["marginBalanceYi"]
               for d in days}
        return fetch_data.margin_market_by_day(days, bal, rebuild_only=True), bal

    def test_ratio_on_the_2024_08_05_crash_day(self):
        # Widely reported at about 148% the day the TAIEX fell 8.4%.
        mkt, bal = self._market(["2024-08-02", "2024-08-05"])
        ratio = fetch_data.margin_ratio(mkt["2024-08-05"]["collateralYi"], bal["2024-08-05"])
        self.assertGreater(ratio, 145)
        self.assertLess(ratio, 151)

    def test_ex_etf_fields_start_consistent_with_the_total(self):
        # Day one starts every stock at the market's own ratio, so excluding
        # ETFs cannot move it yet; the ETF loan is a small, positive slice.
        mkt, bal = self._market(["2022-01-03"])
        f = fetch_data.margin_fields(mkt["2022-01-03"], bal["2022-01-03"])
        self.assertAlmostEqual(f["marginRatioExEtf"], f["marginRatio"], places=1)
        self.assertGreater(f["marginBalanceExEtfYi"], bal["2022-01-03"] * 0.9)
        self.assertLess(f["marginBalanceExEtfYi"], bal["2022-01-03"])

    def test_days_before_the_series_start_are_absent(self):
        mkt, _ = self._market(["2021-12-30"])
        self.assertEqual(mkt, {})

    def test_missing_side_gives_none_not_zero(self):
        self.assertIsNone(fetch_data.margin_ratio(None, 3000))
        self.assertIsNone(fetch_data.margin_ratio(4500, None))
        self.assertIsNone(fetch_data.margin_ratio(4500, 0))
        self.assertEqual(fetch_data.margin_ratio(4500, 3000), 150.0)
        self.assertIsNone(fetch_data.margin_fields(None, 3000)["marginRatioExEtf"])


class TestMarginBook(unittest.TestCase):

    def test_new_borrowing_is_at_the_day_price_times_the_rate(self):
        b = fetch_data.MarginBook(0.6)
        b.step("X", 0, 10, 100.0)                    # 10 lots bought at 100
        self.assertAlmostEqual(b.loan["X"], 10 * 1000 * 100 * 0.6)
        self.assertAlmostEqual(b.ratio("X"), 166.67, places=2)   # at cost: 1 / 0.6
        b.step("X", 10, 10, 78.0)                    # price falls 22%
        self.assertAlmostEqual(b.ratio("X"), 130.0, places=2)

    def test_repayment_keeps_the_average_cost(self):
        b = fetch_data.MarginBook(0.6)
        b.step("X", 0, 10, 100.0)
        b.step("X", 10, 20, 200.0)                   # avg loan per lot now 90k
        b.step("X", 20, 10, 150.0)                   # half repaid
        self.assertAlmostEqual(b.loan["X"], 10 * 90_000)

    def test_a_guessed_start_is_withheld_for_the_warmup(self):
        b = fetch_data.MarginBook(0.6, warmup=3)
        for _ in range(3):
            b.step("X", 10, 10, 100.0)
            self.assertIsNone(b.ratio("X"))
        b.step("X", 10, 10, 100.0)
        self.assertIsNotNone(b.ratio("X"))

    def test_split_changes_lots_but_not_the_loan(self):
        b = fetch_data.MarginBook(0.6)
        b.step("X", 0, 10, 100.0)
        loan = b.loan["X"]
        b.step("X", 40, 40, 25.0)                    # 1:4 split: prev already 40
        self.assertAlmostEqual(b.loan["X"], loan)
        self.assertAlmostEqual(b.ratio("X"), 166.67, places=2)

    def test_closing_out_resets_to_exact(self):
        b = fetch_data.MarginBook(0.6, warmup=50)
        b.step("X", 10, 0, 100.0)
        b.step("X", 0, 5, 80.0)
        self.assertAlmostEqual(b.ratio("X"), 166.67, places=2)

    def test_etf_codes(self):
        self.assertTrue(fetch_data.is_etf("0050"))
        self.assertTrue(fetch_data.is_etf("00940"))
        self.assertFalse(fetch_data.is_etf("2330"))


# --------------------------------------------------------------------------
# TAIFEX futures open interest
# --------------------------------------------------------------------------

FUT_CSV = (
    "日期,商品名稱,身份別,多方交易口數,多方交易契約金額(千元),空方交易口數,空方交易契約金額(千元),"
    "多空交易口數淨額,多空交易契約金額淨額(千元),多方未平倉口數,多方未平倉契約金額(千元),"
    "空方未平倉口數,空方未平倉契約金額(千元),多空未平倉口數淨額,多空未平倉契約金額淨額(千元)\n"
    "2026/11/10,臺股期貨,自營商,6096,51578924,7092,60170152,-996,-8591228,4909,41892172,4824,41164131,85,728041\n"
    "2026/11/10,臺股期貨,投信,2986,25459249,20,170241,2966,25289008,101353,864463334,2834,24171753,98519,840291581\n"
    "2026/11/10,臺股期貨,外資及陸資,86285,727977694,88046,742662545,-1761,-14684851,9875,84238258,113348,966831234,-103473,-882592976\n"
    "2026/11/09,臺股期貨,外資,1,1,1,1,0,0,1,1,1,1,-99,0\n"
)


class TestFutures(NetworkGuardedTestCase):

    def setUp(self):
        super().setUp()
        p = patch.object(fetch_data.SESSION, "post", side_effect=_fail_on_network_call)
        p.start()
        self.addCleanup(p.stop)
        import tempfile
        self.tmp = tempfile.mkdtemp()
        p = patch.object(fetch_data, "RAW_DIR", self.tmp)
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(fetch_data.time, "sleep", lambda *_: None)
        p.start()
        self.addCleanup(p.stop)

    def test_parses_net_open_interest_per_desk(self):
        out = fetch_data.parse_fut_csv(FUT_CSV)
        self.assertEqual(out["2026-11-10"], {"dealer": 85, "trust": 98519, "foreign": -103473})

    def test_older_foreign_label_is_recognised(self):
        self.assertEqual(fetch_data.parse_fut_csv(FUT_CSV)["2026-11-09"], {"foreign": -99})

    def test_earliest_sits_inside_the_retention_window(self):
        self.assertEqual(fetch_data.taifex_earliest(date(2026, 11, 11)), date(2023, 11, 12))
        self.assertEqual(fetch_data.taifex_earliest(date(2028, 2, 29)), date(2025, 3, 1))

    def test_month_before_retention_issues_no_request(self):
        # The network guard would raise if this asked TAIFEX.
        self.assertEqual(fetch_data.fetch_futures_month("201701", today=date(2026, 11, 11)), {})

    def test_start_is_clamped_and_end_walks_back_over_unpublished_days(self):
        calls = []
        def fake(start, end):
            calls.append((start, end))
            return ("range", None) if end > date(2026, 11, 10) else ("ok", FUT_CSV)
        with patch.object(fetch_data, "_taifex_get", side_effect=fake):
            rows = fetch_data.fetch_futures_month("202611", today=date(2026, 11, 11))
        self.assertEqual(calls, [(date(2026, 11, 1), date(2026, 11, 11)),
                                 (date(2026, 11, 1), date(2026, 11, 10))])
        self.assertEqual(rows["2026-11-10"]["foreign"], -103473)
        with patch.object(fetch_data, "_taifex_get", side_effect=fake):
            fetch_data.fetch_futures_month("202311", today=date(2026, 11, 11))
        self.assertEqual(calls[-1][0], date(2023, 11, 12))

    def test_open_month_is_refetched_and_closed_month_is_not(self):
        with patch.object(fetch_data, "_taifex_get", return_value=("ok", FUT_CSV)) as g:
            fetch_data.fetch_futures_month("202611", today=date(2026, 11, 11))
            # Fetched during the month it covers: stale on the next run.
            fetch_data.fetch_futures_month("202611", today=date(2026, 11, 12))
            self.assertEqual(g.call_count, 2)
        # Rebuild mode reads the cache and never asks.
        self.assertIn("2026-11-10", fetch_data.fetch_futures_month("202611", rebuild_only=True))

    def test_unpublished_range_is_not_cached(self):
        with patch.object(fetch_data, "_taifex_get", return_value=("range", None)):
            self.assertEqual(fetch_data.fetch_futures_month("202611", today=date(2026, 11, 2)), {})
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "TAIFEX_FUT", "202611.json")))

    def test_no_sessions_is_cached_as_empty(self):
        with patch.object(fetch_data, "_taifex_get", return_value=("empty", None)):
            self.assertEqual(fetch_data.fetch_futures_month("202611", today=date(2026, 11, 1)), {})
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "TAIFEX_FUT", "202611.json")))


if __name__ == "__main__":
    unittest.main()
