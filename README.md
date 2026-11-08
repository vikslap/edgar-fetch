# EDGAR Fetch

A screener.in-style site for US stocks, built on SEC EDGAR, running as one Cloudflare Worker.

- **Company pages:** 9 years of P&L, balance sheet and cash flow, 10 quarters, ratios, valuation (DCF / reverse DCF), quality scores (Piotroski, Altman Z, Beneish), filings, and Excel export or filling your own model.
- **Screens:** query every US-listed company, e.g. `Price to earning < 50 AND Market Capitalization < 5000` ($ millions).
- **Telegram alerts:** each night the screens in `screens.json` are rerun, and @SP500Filings_bot messages you about companies that enter or leave them.

## How it fits together

```
GitHub Actions (nightly, 14:47 IST Tue–Sat)
  builder/build.mjs
    ├─ SEC company_tickers_exchange.json   → listed companies (NYSE, Nasdaq, …)
    ├─ Nasdaq screener download            → price + sector for every stock (Yahoo fallback)
    ├─ Yahoo 2-year daily closes           → DMA 50/200, golden/death cross, 52-week high, returns
    ├─ SEC companyfacts.zip (~1 GB)        → every company's XBRL financials
    ├─ public/core.js + screen-core.js     → same maths as the website
    ├─ SEC submissions.zip                 → filings list per company
    ├─ public/data/screener.json           → the screener table (deployed, not committed)
    ├─ public/data/snap/                   → per-company copy the site reads first
    └─ screens.json + state/               → Telegram alerts on changes
  wrangler deploy                          → website + fresh data to Cloudflare
```

## One-time setup

### 1. Cloudflare Worker secret (if not already set)
```
npx wrangler secret put SEC_UA          # Souveek Pal your@email.com
npx wrangler secret put ACCESS_KEY      # optional password for the site's API
```

### 2. GitHub repository secrets
Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | What to put |
|---|---|
| `SEC_UA` | Your name and email, same as above (the SEC requires it) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create → template **"Edit Cloudflare Workers"** |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → right-hand sidebar |
| `TELEGRAM_BOT_TOKEN` | The token of @SP500Filings_bot (from @BotFather → /mybots → API Token) |
| `TELEGRAM_CHAT_ID` | Your chat ID with that bot: the same one your US filings bot sends to. Or message the bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id` |

And under the **Variables** tab: `SITE_URL` = your Worker address, e.g. `https://edgar-fetch.<you>.workers.dev` (used for links in alerts).

### 3. First run
Actions → **Nightly screener build** → **Run workflow**. It takes about 15–25 minutes. You'll get a "tracking started" Telegram message for each alert screen. After that you only hear about changes.

> Deploy through GitHub from now on. A manual `wrangler deploy` from your PC would publish the site without `public/data/screener.json` (it isn't committed), and Screens would be empty until the next nightly run.

## Where company pages get their data
SEC often refuses requests from Cloudflare's shared servers (HTTP 403), sometimes for hours. So the nightly build also saves every listed company's financials and filings list from SEC's bulk files into `public/data/snap/`, and company pages load from that copy (up to a day old, no SEC request). The Worker asks SEC live only when a company isn't in the copy (e.g. OTC stocks) or when **Bypass the cache** is ticked in Settings, and falls back to the copy if SEC refuses.

## Concall transcripts (optional)

The **Concalls** section on every company page lists each quarter's earnings release from SEC filings (press release, shareholder letter, slides, and any transcript the company filed). That part works with no setup.

To read call transcripts inside the page:
1. Get a free key at https://www.alphavantage.co/support/#api-key (about 25 transcripts a day).
2. Cloudflare → Workers & Pages → **edgar-fetch** → Settings → Variables and Secrets → **Add** → type *Secret*, name `ALPHAVANTAGE_KEY`, paste the key.
3. To keep every transcript permanently (so reopening one costs no request): Storage & databases → **Workers KV** → Create namespace `edgar-fetch-transcripts`, copy its **ID**, and paste it into the commented block at the bottom of `wrangler.toml` (uncomment the three lines). Commit; the workflow redeploys.

Transcripts are only fetched when you click **Read**, never when a page opens. Each one is stored compressed (about 20 KB), so the free 1 GB holds tens of thousands.

## Watchlist, saved screens and custom peers (synced)

Your watchlist (☆ on any company page, or the **Watchlist** link), saved screens and custom peer lists are stored in the same KV namespace as transcripts, so every browser and device sees the same lists.

**Set an access key so only you can see or change them:** Cloudflare → edgar-fetch → Settings → Variables and Secrets → Add → *Secret* `ACCESS_KEY` (any password). Then enter the same password on the site under Data tools → Settings, once per browser.

## Profit & Loss layout
Quarterly Results and Profit & Loss follow screener.in's layout: Operating Profit is before depreciation (EBITDA), Expenses / Other Income / Net Profit / EPS expand with **+**, and YoY growth rows sit under Sales, Net Profit and EPS. **Net Profit is the reported net income attributable to shareholders** (used for EPS, P/E, ROE and screens); the breakdown shows minority share, discontinued operations and unusual items, and "P/E excl. unusual items" is available in Screens. The page shows up to 12 years; *Fill my model* still writes the latest 9 so your template is unchanged.

## Coverage notes
- **Banks:** revenue = interest income + noninterest income; noninterest expense is used as SG&A. Bank ratios are still approximate (no bank-specific template yet).
- **Foreign filers (20-F / 40-F):** IFRS line items are mapped; figures in other currencies are converted to USD at today's rate for every year (growth rates stay in the home currency). ADR share counts are scaled using the quoted market cap. Many foreign filers only file annual reports, so they have no quarterly data.
- **No revenue yet:** included with sales shown as 0.
- `python/fetch_edgar.py` still covers US-GAAP filers only.

## Alert screens

Edit `screens.json` (the **Copy for Telegram alerts** button on the Screens page gives you a ready line):
```json
[
  { "name": "Piotroski 8+ mid & large caps", "query": "Piotroski score >= 8 AND Market Capitalization > 2000", "alert": true }
]
```
Set `"alert": false` to pause one. Changing a query restarts its tracking.

## Local test of the builder
```
cd builder && npm ci
SEC_UA="Your Name you@example.com" LIMIT=200 node build.mjs     # first 200 companies, alerts print to console without Telegram secrets
```

## Folder guide
- `src/worker.js`: API relay (SEC, prices, 10-year Treasury) and caching
- `public/`: the website (`index.html`, `app.js`), shared maths (`core.js`, `screen-core.js`), line-item mapping (`mapping.json`)
- `builder/`: nightly screener builder
- `screens.json`, `state/`: alert screens and their last results (committed by the workflow)
- `python/`: the standalone `fetch_edgar.py` script and `My_Model.xlsx` template
