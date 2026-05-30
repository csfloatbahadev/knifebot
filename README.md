# 🗡️ Knife Arbitrage Scanner

Scans CSFloat for **Talon / Karambit / Butterfly** knife listings and compares
each price against the **Steam max buy order**, surfacing the best arbitrage
opportunities (buy on CSFloat, sell via Steam buy order).

---

## How it works

1. Fetches up to `SCAN_PAGES × 100` knife listings from CSFloat (category = Knives,
   sorted by highest discount).
2. Deduplicates by `market_hash_name` — keeps the **cheapest listing per skin**.
3. Looks up the **Steam max buy order** for each unique name via the histogram API.
4. Calculates **spread = Steam buy order − CSFloat ask**.
5. Sorts by spread descending and prints the **Top N** results.

A positive spread means you can buy on CSFloat and immediately cover an active
Steam buy order at a profit.

---

## Setup

```bash
npm install
cp .env.example .env
# edit .env — set CSFLOAT_API_KEY at minimum
node index.js
```

---

## Key config (.env)

| Variable | Default | Description |
|---|---|---|
| `CSFLOAT_API_KEY` | — | **Required.** Your CSFloat API key |
| `KNIFE_FAMILIES` | `Talon,Karambit,Butterfly` | Comma-separated knife name substrings |
| `MIN_PRICE_USD` / `MAX_PRICE_USD` | `50` / `5000` | Price window |
| `SCAN_PAGES` | `3` | CSFloat pages per scan (100 items/page) |
| `TOP_N` | `10` | Results to display / send to Telegram |
| `MIN_SPREAD_USD` | `0` | Hide results below this spread |
| `POLL_INTERVAL_SECONDS` | `0` | `0` = run once; `>0` = loop |
| `STEAM_REQUEST_DELAY_MS` | `1500` | Delay between Steam requests — keep ≥1000ms |
| `STEAM_CACHE_TTL_SECONDS` | `600` | Steam price cache lifetime |
| `TELEGRAM_BOT_TOKEN` | — | Optional — Telegram report |
| `TELEGRAM_CHAT_ID` | — | Optional — Telegram report |

---

## Rate limiting

### CSFloat
- Exponential backoff on 429: **5 min → 10 min → 30 min**.
- The poll loop skips the scan entirely while cooling down.

### Steam
- Sequential requests with `STEAM_REQUEST_DELAY_MS` between each call.
- **Nameids** (used to call the histogram API) are cached **permanently** in memory.
- **Buy order prices** are cached for `STEAM_CACHE_TTL_SECONDS`.
- Steam's histogram endpoint is much more stable than `priceoverview` for high-value items.

---

## Sample console output

```
──────────────────────────────────────────────────────────────────────────
  KNIFE ARBITRAGE REPORT — Top 10 items
  Families: Talon, Karambit, Butterfly | Scan time: 42.3s
──────────────────────────────────────────────────────────────────────────
  #    SPREAD   SPREAD%    CSFLOAT  STEAM BO     FLOAT  ITEM NAME
──────────────────────────────────────────────────────────────────────────
  1    $38.00    +14.2%    $267.42   $305.42    0.1832  ✅ ★ Karambit | Doppler (Factory New)
  2    $22.50     +8.9%    $252.81   $275.31    0.0741  ✅ ★ Butterfly Knife | Fade (Factory New)
  3     $7.10     +2.8%    $253.60   $260.70    0.4521  🟡 ★ Talon Knife | Tiger Tooth (MW)
  4    -$4.20     -1.5%    $280.00   $275.80    0.1230  🔴 ★ Karambit | Gamma Doppler (FN)
```
