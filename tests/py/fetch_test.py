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


if __name__ == "__main__":
    unittest.main()
