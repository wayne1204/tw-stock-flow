#!/usr/bin/env bash
# Run the TAIEX Drawdown Atlas dashboard locally, or publish it.
#
# Usage:
#   ./run.sh              Fetch latest data, then serve at http://localhost:3001
#   ./run.sh --no-fetch   Skip fetching, serve existing web/data/taiex-daily.json as-is
#   ./run.sh --port 9000  Serve on a custom port
#   ./run.sh deploy                   Publish to Cloudflare Pages (production)
#   ./run.sh deploy --branch preview  Publish a preview with its own *.pages.dev URL
#
# Data is cached in web/data/raw/, so a first-time fetch takes ~110 minutes but
# subsequent runs only fetch new trading days (usually seconds).
#
# Deploy environment:
#   CF_PAGES_PROJECT  Pages project name (default: tw-stock-drawdown)
#   WRANGLER          wrangler binary (default: on PATH, else the newest nvm one)
#   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
#                     Read from ./.env (gitignored) when present; not needed
#                     where `wrangler login` has been run.
#
# Deploy uploads only the files in web/ the pages load (plus stock.html and
# data/stocks/*.js once pipeline/fetch_stocks.py has run), staged into a temp dir.
# wrangler also compiles ./functions (the account API, see README) from the
# repo root, where this script runs; its D1 binding and GOOGLE_CLIENT_ID are
# set once in the Pages project settings.
# web/data/raw/, fetch.log, tests and notes never leave this machine. The project
# is created on first deploy. Safe to call from cron via scripts/update_data.sh --deploy.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

deploy() {
  # Credentials live in a gitignored .env so cron can deploy without a login.
  if [[ -f .env ]]; then set -a; source .env; set +a; fi
  local project="${CF_PAGES_PROJECT:-tw-stock-drawdown}" branch=main
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --branch) branch="$2"; shift 2 ;;
      *) echo "Unknown deploy argument: $1" >&2; exit 1 ;;
    esac
  done

  # Cron's PATH has no nvm, and wrangler's shebang needs `node` beside it.
  local wrangler="${WRANGLER:-$(command -v wrangler || true)}"
  if [[ -z "$wrangler" ]]; then
    wrangler="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/wrangler 2>/dev/null | sort -V | tail -n 1 || true)"
  fi
  if [[ -z "$wrangler" || ! -x "$wrangler" ]]; then
    echo "run.sh deploy: wrangler not found; npm i -g wrangler or set WRANGLER=/path" >&2
    exit 1
  fi
  export PATH="$(dirname "$wrangler"):$PATH"

  # Paths are relative to web/, the site root.
  local files=(index.html stock.html js/detect.js data/taiex-daily.js) f
  for f in "${files[@]}"; do
    [[ -s "web/$f" ]] || { echo "run.sh deploy: missing web/$f (run python3 pipeline/fetch_data.py)" >&2; exit 1; }
  done

  # stock.html always ships: index.html links to it, and Pages answers a
  # missing path with index.html, so leaving it out makes the tab silently
  # reload the market page. Without data it shows its own "run
  # fetch_stocks.py" notice instead.
  if [[ -s web/data/stocks/index.js ]]; then
    files+=($(cd web && echo data/stocks/*.js))
  else
    echo "run.sh deploy: WARNING no web/data/stocks/ (run python3 pipeline/fetch_stocks.py); stock.html ships without data" >&2
  fi

  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  for f in "${files[@]}"; do
    mkdir -p "$STAGE/$(dirname "$f")"
    cp "web/$f" "$STAGE/$f"
  done

  # First deploy: create the project. "Already exists" is the normal case after.
  # --force keeps it a classic Pages project; wrangler 4.148+ otherwise hands
  # creation to Workers, which fails without a Worker config.
  if ! "$wrangler" pages project list 2>/dev/null | grep -qw "$project"; then
    "$wrangler" pages project create "$project" --production-branch main --force
  fi

  local data_end
  data_end="$(sed -n 's/.*"end": "\([0-9-]*\)".*/\1/p' web/data/taiex-daily.js | head -n 1)"
  "$wrangler" pages deploy "$STAGE" \
    --project-name "$project" \
    --branch "$branch" \
    --commit-hash "$(git rev-parse HEAD)" \
    --commit-message "data through $data_end" \
    --commit-dirty=true
}

if [[ "${1:-}" == "deploy" ]]; then
  shift
  deploy "$@"
  exit 0
fi

PORT=3001
DO_FETCH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-fetch) DO_FETCH=0; shift ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

PY=python3
[[ -x .venv/bin/python ]] && PY=.venv/bin/python

if [[ "$DO_FETCH" -eq 1 ]]; then
  echo "Fetching TAIEX data (incremental; cached responses are reused)..."
  "$PY" pipeline/fetch_data.py
  if [[ -s config/stocks.txt ]]; then
    echo "Fetching stock data (whole market + watchlist brokers)..."
    "$PY" pipeline/fetch_stocks.py
  fi
fi

echo "Serving dashboard at http://localhost:${PORT}"
exec python3 -m http.server "$PORT" --directory web
