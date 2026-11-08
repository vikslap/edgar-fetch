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
    ├─ SEC companyfacts.zip (~1 GB)        → every company's XBRL financials
    ├─ public/core.js + screen-core.js     → same maths as the website
    ├─ public/data/screener.json           → the screener table (deployed, not committed)
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
