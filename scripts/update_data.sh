#!/usr/bin/env bash
# Refresh the TAIEX dataset unattended. Written for cron, safe to run by hand.
#
# Usage:
#   scripts/update_data.sh                  Incremental fetch, append to fetch.log
#   scripts/update_data.sh --start 2026-01  Narrow the fetch window (see pipeline/fetch_data.py)
#   scripts/update_data.sh --bundle         Also rebuild dist/taiex-atlas-standalone.html
#   scripts/update_data.sh --commit         git-commit the data files if they changed
#   scripts/update_data.sh --deploy         Publish to Cloudflare Pages (see run.sh deploy)
#   scripts/update_data.sh --quiet          Log only; do not echo progress to stdout
#
# Environment:
#   PYTHON  interpreter to use (default: python3 on PATH, else /usr/bin/python3).
#           It needs `requests`; both pythons on this box have it.
#   LOG     log file (default: <repo>/fetch.log, rotated at 5 MB, one .1 kept).
#
# Cron only fires the script; every guard lives in here:
#   - flock, so a slow run can never overlap the next one
#   - absolute paths, so cron's near-empty PATH and $HOME-less env are harmless
#   - non-zero exit + a tail of the log on stderr, so cron mails you a real
#     error instead of failing silently
#
# The fetch is incremental (web/data/raw/ is a permanent response cache), so a
# normal weekday run is a handful of requests and finishes in seconds.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG="${LOG:-$ROOT/fetch.log}"
LOCK="$ROOT/.update_data.lock"
MAX_LOG_BYTES=$((5 * 1024 * 1024))

DO_BUNDLE=0
DO_COMMIT=0
DO_DEPLOY=0
QUIET=0
START_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) DO_BUNDLE=1; shift ;;
    --commit) DO_COMMIT=1; shift ;;
    --deploy) DO_DEPLOY=1; shift ;;
    --quiet)  QUIET=1; shift ;;
    --start)  START_ARGS=(--start "$2"); shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Resolve an interpreter without relying on cron's PATH.
PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" && -x .venv/bin/python ]]; then
  PYTHON="$PWD/.venv/bin/python"
fi
if [[ -z "$PYTHON" ]]; then
  PYTHON="$(command -v python3 || true)"
fi
if [[ -z "$PYTHON" && -x /usr/bin/python3 ]]; then
  PYTHON=/usr/bin/python3
fi
if [[ -z "$PYTHON" ]]; then
  echo "update_data.sh: no python3 found; set PYTHON=/path/to/python3" >&2
  exit 1
fi

# Rotate before writing so one runaway run cannot grow the log without bound.
if [[ -f "$LOG" ]] && (( $(stat -c %s "$LOG") > MAX_LOG_BYTES )); then
  mv -f "$LOG" "$LOG.1"
fi

say() {  # progress line: always logged, echoed unless --quiet
  printf '%s\n' "$*" >>"$LOG"
  (( QUIET )) || printf '%s\n' "$*"
}

fail() {  # cron mails whatever lands on stderr, so make it worth reading
  echo "update_data.sh FAILED: $*" >&2
  echo "--- last 30 lines of $LOG ---" >&2
  tail -n 30 "$LOG" >&2 || true
  exit 1
}

# Non-blocking lock: if yesterday's cold start is still running, skip this tick
# rather than queue a second fetcher against the same cache and output files.
exec 9>"$LOCK"
if ! flock -n 9; then
  say "[$(date '+%F %T')] another update_data.sh run holds the lock; skipping"
  exit 0
fi

say "[$(date '+%F %T')] update start (python: $PYTHON)"

if ! "$PYTHON" pipeline/fetch_data.py "${START_ARGS[@]}" >>"$LOG" 2>&1; then
  fail "fetch_data.py exited non-zero"
fi

# The watchlist is optional; a failure here is reported but does not block the
# market-level refresh and deploy below.
if [[ -s config/stocks.txt ]]; then
  if "$PYTHON" pipeline/fetch_stocks.py >>"$LOG" 2>&1; then
    say "  watchlist stocks refreshed"
  else
    say "  WARNING: fetch_stocks.py exited non-zero (see $LOG)"
    echo "update_data.sh: fetch_stocks.py failed; market data still updated" >&2
  fi
fi

if (( DO_BUNDLE )); then
  if ! "$PYTHON" pipeline/bundle.py >>"$LOG" 2>&1; then
    fail "bundle.py exited non-zero"
  fi
fi

# fetch_data.py writes the outputs even when a day is missing, so report what
# actually landed instead of assuming the run moved the series forward.
LATEST="$("$PYTHON" -c 'import json;d=json.load(open("web/data/taiex-daily.json"));print(d[-1]["date"], len(d))')" \
  || fail "could not read web/data/taiex-daily.json"
say "[$(date '+%F %T')] latest trading day ${LATEST% *} (${LATEST#* } rows)"

if (( DO_COMMIT )); then
  if git diff --quiet -- web/data/taiex-daily.json web/data/taiex-daily.js; then
    say "  data unchanged; nothing to commit"
  else
    git add web/data/taiex-daily.json web/data/taiex-daily.js
    git commit -q -m "chore(data): refresh TAIEX daily dataset through ${LATEST% *}" \
      >>"$LOG" 2>&1 || fail "git commit failed"
    say "  committed refreshed data through ${LATEST% *}"
  fi
fi

if (( DO_DEPLOY )); then
  if ! "$ROOT/run.sh" deploy >>"$LOG" 2>&1; then
    fail "run.sh deploy exited non-zero"
  fi
  say "  deployed to Cloudflare Pages"
fi

say "[$(date '+%F %T')] update done"
