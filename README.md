# TW Stock Flow · 台股大盤修正波段與個股籌碼

**線上版：<https://tw-stock-flow.pages.dev>**

追蹤台股的資金流向，分兩頁：

- **大盤**（`index.html`）：自 2017 年以來加權指數的每一次修正波段（峰谷法偵測），疊上成交金額、
  三大法人買賣超與融資餘額。
- **個股籌碼**（`stock.html`）：所有上市櫃股票與 ETF 的日 K、三大法人、融資、股東結構；
  觀察清單與成交值前 200 名另有主力買賣超與券商分點。

資料全部來自證交所、櫃買中心等公開來源；**不使用任何模擬資料**，抓不到就報錯、網頁拒絕渲染。

![儀表板截圖](docs/screenshot.png)

```
pipeline/fetch_data.py     →   web/data/taiex-daily.{json,js}   →   web/index.html
pipeline/fetch_stocks.py   →   web/data/stocks/*.js             →   web/stock.html
```

> 程式碼與註解一律使用英文，介面與本文件使用中文。

## 快速開始

```bash
./run.sh                 # 增量抓取資料，再起本機伺服器 http://localhost:3001
./run.sh --no-fetch      # 跳過抓取，直接用現有資料
./run.sh deploy          # 發佈到 Cloudflare Pages（需先 wrangler login）
```

首次抓取約 110 分鐘（三大法人與融資只能逐日查詢，需遵守 rate limit）；之後原始回應都快取在
`web/data/raw/`，每天只補新交易日，數秒完成。`web/index.html` 也可直接以 `file://` 開啟。
`python3 pipeline/bundle.py` 會產生內嵌 ECharts 與資料的單檔離線版 `dist/taiex-atlas-standalone.html`。

### 每日更新（cron）

`scripts/update_data.sh` 負責加鎖、日誌輪替（`fetch.log`）與失敗通知；證交所約 19:00 發佈籌碼資料：

```cron
0 20 * * 1-5 /path/to/tw-stock-flow/scripts/update_data.sh --bundle --deploy --quiet
```

旗標：`--bundle` 重打包、`--commit` 資料有變才 commit、`--deploy` 發佈、`--start YYYY-MM`
限縮抓取範圍。部署只上傳 `web/` 底下頁面用到的檔案（`index.html`、`stock.html`、`js/detect.js`、`data/` 輸出）；
專案名稱可用 `CF_PAGES_PROJECT` 覆寫。

## 資料來源

| 資料 | Endpoint | 查詢單位 |
|---|---|---|
| 加權指數日 K | `TAIEX/MI_5MINS_HIST` | 月 |
| 市場成交資訊 | `afterTrading/FMTQIK` | 月 |
| 三大法人買賣金額 | `fund/BFI82U` | **日** |
| 信用交易統計 | `marginTrading/MI_MARGN` | **日** |

髒數值（`--`、`X`、空字串）一律轉 `null`，絕不轉 `0`。外資 = 「外資及陸資」+「外資自營商」
（2022 年起拆兩列）。當月與近五日的「無資料」快取會自動重抓。

## 偵測規則

實作於 `web/js/detect.js`，網頁與 `scripts/verify.js` 共用：

1. 追蹤 running peak，回檔跌破門檻即進入修正，持續追蹤最低點。
2. **收復前高才算一波結束**——同一波途中的反彈不另計，所以 2022 年整段熊市只算一波。
3. 到序列結尾仍未收復 → `ongoing`。

門檻（5/7/10/15%）、價格基準（盤中 / 收盤）、收復容差與反彈切分都是頁面上的即時控制項。
預設 7% + 收盤價 + 嚴格收復。

- **谷底後 1M / 3M / 1Y**：自谷底收盤價起算 21 / 63 / 252 個交易日報酬；資料不足顯示「未滿」。
- **融資殺盤幅度** = 區間融資減幅(%) ÷ 指數跌幅(%)。> 1.5 通常代表融資籌碼清洗較徹底。

本專案只描述已發生的籌碼變化，不構成投資建議。

## 個股籌碼監控（`stock.html`）

**所有上市、上櫃股票與 ETF**（約 2,300 檔）皆可用代號或名稱搜尋，**不做波段 / 回撤分析**，只呈現籌碼。
`config/stocks.txt` 觀察清單與 `config/top200.txt`（成交值前 200 名）裡的股票另外加上主力與券商分點（清單本身不會顯示在頁面上；觀察清單第一檔為預設開啟）。
使用者可用 Google 帳號登入，各自維護自己的**自選**清單（見下方「帳號與自選」）。

| 面板 | 來源 | 頻率 | 涵蓋 |
|---|---|---|---|
| 日 K（含 MA5/20/60）、成交量 | TWSE `afterTrading/MI_INDEX`、TPEx `afterTrading/otc`（全市場） | 日 | 全部 |
| 三大法人買賣超（外資 / 投信 / 自營商） | TWSE `fund/T86`、TPEx `insti/dailyTrade`（全市場） | 日 | 全部 |
| 融資增減、融資餘額 | TWSE `marginTrading/MI_MARGN`（ALL）、TPEx `margin/balance` | 日 | 全部 |
| 股東人數、大戶人數（>400 張，提示框另列 >1000 張） | [神秘金字塔](https://norway.twsthr.info/StockHolders.aspx?stock=2327) | 週 | 全部 |
| 主力買賣超、券商分點買賣超前 15 名（1/5/20 日） | [富邦 e-Broker](https://fubon-ebrokerdj.fbs.com.tw/z/zc/zco/zco_2327.djhtm) | 日 | 觀察清單 + 成交值前 200 |

```bash
python3 pipeline/fetch_stocks.py                   # 全市場（預設 24 個月）+ 追蹤股的分點資料（近 12 個月）
python3 pipeline/fetch_stocks.py --refresh-top     # 先依近 60 日平均成交值重排 config/top200.txt
python3 pipeline/fetch_stocks.py --watchlist-only  # 只建 config/stocks.txt（快）
python3 pipeline/fetch_stocks.py --stocks 2454     # 只建指定股票，含分點資料
echo 2317 >> config/stocks.txt                     # 把股票加入觀察清單（多出主力與分點）
```

- 單位一律為**張**。日 K、法人、融資都是「一天一次全市場查詢」，快取只保留需要的欄位，不論建幾檔股票，
  每天都只有 6 個請求（證交所、櫃買中心各 3 個）。櫃買法人表的欄位名稱重複，依位置取值，
  並逐列驗證外資 + 投信 + 自營商 = 三大法人合計，不符的列捨棄。
- 股東 / 大戶每週更新一次（週六之後第一次執行時重抓全部股票的集保頁，約 2,300 頁、75 分鐘）。
- 主力與分點需要每檔每日一個請求，只對**追蹤股**抓取：`config/stocks.txt`（觀察清單）加上 `config/top200.txt`
  （近 60 日平均成交值前 200 名，排除 ETF；`--refresh-top` 才重排，可手動編輯）。逐日分點表
  （自設區間查詢，過去日永久快取）只回補近 12 個月（`--broker-months`），更早的日子只讀快取。
  主力 = 當日分點表的合計買超 − 合計賣超。每晚每檔 3 個請求：當日分點表與近 5/20 日統計。
- 富邦頁面每個請求間隔 0.8 秒，出錯時自動加倍（上限 3.2 秒），連續 200 個請求成功再減半。新增一檔追蹤股約需 245 個請求（~4 分鐘）。
  同一時間只允許一個 `fetch_stocks.py`，另一個會直接略過。
- **首次建置**（本機沒有 `web/data/raw/` 快取）：上市櫃全部約 3 小時（櫃買中心回應較慢）；之後每晚數分鐘
  （週六後首次含集保頁約 1.5 小時）。
- 頁面上的**日期**欄可檢視任一交易日的籌碼與當日分點；三大法人面板右上可分別開關外資 / 投信 / 自營商 / 合計。
- 預設開啟 2330；`stock.html#2327` 可直接開其他股票。
- 集保股權分散在減資 / 分割當週會出現「1 人持有 100%」的佔位列，一律剔除。
- **還原 K 線**：面額變更（分割）、減資後以參考價恢復交易，之前的價格與成交量依「停止買賣前收盤價 ÷
  恢復買賣參考價」換算，K 線不再斷崖，提示框另列實際成交價。事件取自證交所 `change/TWTB8U`、
  `reducation/TWTAUU`（按月快取）；ETF 分割與上櫃股票不在表內，改由「停牌兩個交易日以上 + 開盤跳空近整數倍」
  偵測，上市者再以當日 `MI_INDEX` 的漲跌價差回推參考價求得精確比例，上櫃者暫為推算值（頁面標註「依價格推算」）。
- `run.sh`、`scripts/update_data.sh` 在 `config/stocks.txt` 存在時自動一併更新；個股抓取失敗只記警告，不影響大盤資料。
- `web/data/stocks/` 不進 git：在執行抓取的機器上產生，`./run.sh deploy` 直接從本機上傳（約 2,300 個檔案、
  一百多 MB，遠低於 Cloudflare Pages 免費方案的 20,000 檔 / 單檔 25 MiB 上限）。新 clone 須先跑一次
  `python3 pipeline/fetch_stocks.py`，頁面才有個股資料。
- 缺漏一律留白：ETF 沒有集保分散頁、新上市股票從掛牌日開始、當日無法人 / 融資列的股票即為斷點。

## 帳號與自選（Google 登入）

`web/stock.html` 右上可用 Google 帳號登入；登入後按標題旁的 ☆ 把股票加入自選，自選顯示在頁首、跨裝置保存，
可拖曳調整順序（手機上長按再拖）。
自選只是個人書籤，**不影響**哪些股票有主力 / 分點資料（那仍由站方的 `config/stocks.txt` 決定）。

後端是 Cloudflare Pages Functions（`functions/api/*` → `server/account.mjs`）加一個 D1 資料庫，
`./run.sh deploy` 會一併部署。伺服器端驗證 Google ID token（簽章、發行者、audience、到期），
session 以 HttpOnly Cookie 保存，資料庫只存 token 的 SHA-256；每位使用者只存 Google 帳號 ID、
email、名稱、頭像網址與自選代號。

一次性設定：

1. **Google OAuth 用戶端**：Google Cloud Console → API 和服務 → 憑證 → 建立 OAuth 用戶端 ID（網頁應用程式）。
   「已授權的 JavaScript 來源」填 `https://tw-stock-flow.pages.dev`（要在預覽網址或本機測試再加
   `https://<branch>.tw-stock-flow.pages.dev`、`http://localhost:8788`），不需要重新導向 URI。
   OAuth 同意畫面設為「外部」並**發布**（測試模式只允許測試使用者登入）。
2. **D1 資料庫**：`npx wrangler d1 create tw-stock-atlas`（資料表會在第一次請求時自動建立）。
3. **Cloudflare Pages 專案設定**（Workers & Pages → `tw-stock-flow` → Settings）：
   - Bindings → Add → D1 database：變數名稱 `DB`，選上一步的資料庫。
   - Variables and Secrets → 新增 `GOOGLE_CLIENT_ID`（第 1 步的用戶端 ID），Production 與 Preview 都加。
4. 重新 `./run.sh deploy`。

沒有設定以上兩項時，`/api/*` 回 503，頁面自動隱藏登入與自選，其他功能照常。
`./run.sh` 的本機伺服器沒有後端，同樣不顯示登入；要在本機測試帳號：

```bash
npx wrangler pages dev web --d1 DB=local --binding GOOGLE_CLIENT_ID=<用戶端 ID>   # http://localhost:8788/stock.html
```

## 測試

```bash
npm install   # 只有 render 測試需要 jsdom + echarts；未安裝時該套件顯示 SKIP
npm test      # 全部；node tests/js/run.js detect 只跑名稱含 detect 的套件
```

| 套件 | 內容 |
|---|---|
| `tests/js/detect.test.js` | 演算法規則，跑在手工序列上 |
| `tests/py/fetch_test.py` | 抓取腳本的解析與快取（不連網） |
| `tests/py/stock_fetch_test.py` | 個股抓取的解析（不連網） |
| `tests/js/stock.test.js` | 在 jsdom 中實際執行 `stock.html`（含模擬 API 的登入 / 自選流程） |
| `tests/js/account.test.js` | 帳號後端：Google token 驗證、session、自選（SQLite 模擬 D1） |
| `tests/js/render.test.js` | 在 jsdom 中實際執行 `index.html` |
| `tests/js/bundle.test.js` | `dist/` 是否落後於來源 |
| `scripts/verify.js` | 真實資料完整性與已知波段比對 |

## 檔案

```
web/                 網站本體（部署根目錄，也可直接 file:// 開啟）
  index.html         大盤儀表板（CDN 載入 ECharts）
  stock.html         個股籌碼頁
  js/detect.js       修正波段偵測（網頁與 verify.js 共用）
  data/              抓取輸出：taiex-daily.{json,js}、stocks/、raw/ 快取
pipeline/            Python 資料管線
  fetch_data.py      大盤抓取 + 快取 + 合併
  fetch_stocks.py    個股抓取
  bundle.py          打包單檔離線 HTML
config/              stocks.txt 觀察清單、top200.txt 成交值前 200
functions/api/       Pages Functions：登入、自選 API（實作在 server/account.mjs）
server/              帳號後端
scripts/             update_data.sh（cron 每日更新）、verify.js（資料與演算法驗證）
tests/js/ tests/py/  測試；執行器是 tests/js/run.js
run.sh               本機抓取 + 伺服器 / deploy
docs/                README 截圖
```
