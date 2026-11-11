# Changelog

Each release is a git tag. Dates are the day of the release's last change.

## v1.5.0 — 2026-11-11: 大盤今日 home page

- Add a 大盤今日 home page with the latest session and a half-year K + chip chart; 修正波段 moves to `drawdown.html`
- Fetch 外資台指期淨未平倉 from TAIFEX (about 3 years kept)
- Add `update_data.sh --margin-only` to patch in the evening's margin without a full rebuild

## v1.4.0 — 2026-11-04: Backtests and margin maintenance ratios

**Breaking.** `fetch_stocks.py` drops `--months` for `--start YYYY-MM`, anchoring history at 2022-01

- Add a factor backtest panel to the stock page and a whole-market 全市場回測 page (IC, quintile returns)
- Add the market margin maintenance ratio (融資維持率), with an 含/排除 ETF toggle
- Estimate each stock's maintenance ratio from its daily margin balance changes
- Add a 240-day moving average to the stock K chart

## v1.3.1 — 2026-10-25

- Track the top 200 stocks by trading value for broker data
- Split the repo into `web/`, `pipeline/`, `config/`, `scripts/` and `tests/`, rename it TW Stock Flow, and use its `.venv`
- Stamp the deploy time and commit into both page footers

## v1.3.0 — 2026-10-23: Broker tracking and K-chart navigation

- Track the top 100 stocks with a year of broker history
- Pick dates from the stock K chart, add an MA legend, and drag or × to reorder and remove 自選 stocks
- Keep the K chart continuous across splits and capital reductions
- Show 修正波段明細 as compact cards on phones

## v1.2.2 — 2026-10-22

- Add TPEx (上櫃) stocks, and stop retrying TPEx for the whole run once it drops connections
- Add Google sign-in with a per-user 自選 list in a left column
- Default the stock page to 24 months and the index chart to the latest year, and always ship `stock.html`

## v1.2.1 — 2026-10-18

- Cover every TWSE-listed stock, with a search box
- Make the 大盤 / 個股 switch a prominent tab bar
- Keep per-stock data out of git

## v1.2.0 — 2026-10-18: Single-stock chip page

- Add the single-stock chip monitor page: K chart, 法人 per desk, margin, 主力 and broker tables
- Add a light/dark theme toggle to both pages

## v1.1.0 — 2026-10-18: Margin flow panels

- Add 融資增減 panels, a 三大法人 合計 option and a start-day picker to the flow charts
- Keep an episode's price, volume, flows and margin on one screen, and select it by clicking its overlay path
- Default the index chart to K 線 and 收復認定 to 嚴格; drop the 波段切分 rebound rule

## v1.0.0 — 2026-10-17: Live on Cloudflare Pages

- Deploy the dashboard to Cloudflare Pages
- Refresh the data daily with the `update_data.sh` cron wrapper

## v0.1.1 — 2026-08-17

- Add the `run.sh` launcher and trim the README

## v0.1.0 — 2026-08-01: TAIEX drawdown atlas

- Chart every correction wave since 2017 with turnover, 法人 flows and margin balance
- Add the underwater drawdown curve, the normalized episode overlay, and a ranking of the open correction against past ones
- Treat only genuine closes as recoveries, and refetch a month cached before it ended
