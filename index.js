require("dotenv").config();

const { Pool } = require("undici");

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  CSFLOAT_API_KEY: process.env.CSFLOAT_API_KEY,

  // Knife family substrings to match against market_hash_name (client-side filter)
  // e.g. "Talon,Karambit,Butterfly" or leave empty to get ALL knives
  KNIFE_FAMILIES: (process.env.KNIFE_FAMILIES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  MIN_PRICE_USD: parseFloat(process.env.MIN_PRICE_USD) || 50,
  MAX_PRICE_USD: parseFloat(process.env.MAX_PRICE_USD) || 5000,

  // "csfloat_base"       → use listing.reference.base_price from CSFloat payload
  // "steam_max_buy_order"→ Steam histogram highest_buy_order
  // "steam_min_listing"  → Steam priceoverview lowest_price
  PRICE_SOURCE: (process.env.PRICE_SOURCE || "csfloat_base").trim(),

  TOP_N: Math.min(20, Math.max(1, parseInt(process.env.TOP_N) || 10)),

  // How many pages to fetch per scan. Each page = 50 listings.
  // CSFloat enforces a minimum 20s delay between listing requests —
  // so 3 pages takes at least 40s to fetch.
  SCAN_PAGES: Math.min(10, Math.max(1, parseInt(process.env.SCAN_PAGES) || 3)),

  // Minimum profit (USD) to include a listing in results.
  //   spread = reference_price - csfloat_ask
  //   e.g. MIN_SPREAD_USD=100 → only show listings where you'd profit $100+
  //   e.g. MIN_SPREAD_USD=0   → show all listings with any positive spread
  //   e.g. MIN_SPREAD_USD=-50 → also show slightly underwater listings
  MIN_SPREAD_USD: parseFloat(process.env.MIN_SPREAD_USD) || 0,

  // 0 = run once and exit. Set to e.g. 300 to rescan every 5 minutes.
  POLL_INTERVAL_SECONDS: parseInt(process.env.POLL_INTERVAL_SECONDS) || 0,

  // Minimum delay between CSFloat listing page requests (API enforces ~20s)
  CSFLOAT_PAGE_DELAY_MS: Math.max(20000, parseInt(process.env.CSFLOAT_PAGE_DELAY_MS) || 20000),

  STEAM_REQUEST_DELAY_MS:  Math.max(500, parseInt(process.env.STEAM_REQUEST_DELAY_MS)  || 1500),
  STEAM_CACHE_TTL_SECONDS: Math.max(60,  parseInt(process.env.STEAM_CACHE_TTL_SECONDS) || 600),

  // CSFloat backoff on 429: 5 min → 10 min → 30 min
  CSFLOAT_BACKOFF_STEPS_MS: [
    5  * 60 * 1000,
    10 * 60 * 1000,
    30 * 60 * 1000,
  ],

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID   || "",

  DEBUG: process.env.DEBUG === "true",
};

const MIN_PRICE_CENTS = Math.round(CONFIG.MIN_PRICE_USD * 100);
const MAX_PRICE_CENTS = Math.round(CONFIG.MAX_PRICE_USD * 100);

const VALID_SOURCES = ["csfloat_base", "steam_max_buy_order", "steam_min_listing"];
if (!VALID_SOURCES.includes(CONFIG.PRICE_SOURCE)) {
  console.error(
    `ERROR: PRICE_SOURCE="${CONFIG.PRICE_SOURCE}" is invalid.\n` +
    `  Valid values: ${VALID_SOURCES.join(", ")}`
  );
  process.exit(1);
}

const USE_STEAM = CONFIG.PRICE_SOURCE !== "csfloat_base";

// ─────────────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────────────
let scanCount = 0;
let csfloatBackoffUntil = 0;
let csfloatBackoffLevel = 0;

const steamNameidCache = new Map();
const steamPriceCache  = new Map();

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP POOLS
// ─────────────────────────────────────────────────────────────────────────────
const csfloatPool = new Pool("https://csfloat.com", {
  connections: 4,
  pipelining:  1,
  keepAliveTimeout:    60_000,
  keepAliveMaxTimeout: 120_000,
  connect: { rejectUnauthorized: true },
});

const steamPool = USE_STEAM
  ? new Pool("https://steamcommunity.com", {
      connections: 2,
      pipelining:  1,
      keepAliveTimeout:    30_000,
      keepAliveMaxTimeout: 60_000,
      maxRedirections:     5,
      connect: { rejectUnauthorized: true },
    })
  : null;

const telegramPool = new Pool("https://api.telegram.org", {
  connections: 2,
  keepAliveTimeout: 30_000,
  connect: { rejectUnauthorized: true },
});

// ─────────────────────────────────────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(cents) {
  return "$" + (cents / 100).toFixed(2);
}

function fmtSign(cents) {
  return (cents >= 0 ? "+" : "") + fmt(cents);
}

function h(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function log(...args) {
  console.log("[" + new Date().toISOString() + "]", ...args);
}

function sourceLabel() {
  return {
    csfloat_base:        "CSFloat Base Price",
    steam_max_buy_order: "Steam Max Buy Order",
    steam_min_listing:   "Steam Min Listing",
  }[CONFIG.PRICE_SOURCE];
}

// ─────────────────────────────────────────────────────────────────────────────
//  CSFLOAT API
// ─────────────────────────────────────────────────────────────────────────────
async function csfloatRequest(path) {
  const now = Date.now();
  if (now < csfloatBackoffUntil) {
    const wait = csfloatBackoffUntil - now;
    log(`  [CSFloat] Backoff active — waiting ${Math.ceil(wait / 1000)}s...`);
    await sleep(wait);
  }

  const { statusCode, body } = await csfloatPool.request({
    method: "GET",
    path,
    headers: {
      Authorization: CONFIG.CSFLOAT_API_KEY,
      "User-Agent":  "KnifeArb/1.0",
      Accept:        "application/json",
    },
  });

  const text = await body.text();

  if (statusCode === 429 || statusCode === 409) {
    // 429 = explicit rate limit; 409 = conflict / too-fast pagination
    csfloatBackoffLevel = Math.min(
      csfloatBackoffLevel + 1,
      CONFIG.CSFLOAT_BACKOFF_STEPS_MS.length - 1
    );
    const delay = CONFIG.CSFLOAT_BACKOFF_STEPS_MS[csfloatBackoffLevel];
    csfloatBackoffUntil = Date.now() + delay;
    const mins = (delay / 60000).toFixed(0);
    log(`  [CSFloat] ⚠️  ${statusCode} — cooling down for ${mins} min (level ${csfloatBackoffLevel})`);
    sendTelegram(
      `⏳ <b>CSFloat Rate Limited (${statusCode})</b>\nLevel ${csfloatBackoffLevel} — cooling for <b>${mins} min</b>`
    ).catch(() => {});
    return null;
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw Object.assign(new Error("CSFloat HTTP " + statusCode), { statusCode, text });
  }

  csfloatBackoffLevel = 0;
  return JSON.parse(text);
}

// ─────────────────────────────────────────────────────────────────────────────
//  CSFLOAT PAGINATION
//
//  CSFloat uses cursor-based pagination.
//  - First page: no cursor param
//  - Subsequent pages: pass cursor=<last_listing_id_from_previous_page>
//  - Rate limit: minimum 20 seconds between requests (409 if too fast)
//
//  Knife filtering is done via rarity=6 (Covert = knives/gloves) server-side,
//  then client-side by KNIFE_FAMILIES substring match.
//  The market_hash_name param only accepts exact full names, not partials.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchPage(cursor) {
  const params = {
    sort_by:   "highest_discount",
    type:      "buy_now",
    min_price: String(MIN_PRICE_CENTS),
    max_price: String(MAX_PRICE_CENTS),
    limit:     "50",
    // rarity=6 = Covert quality (★ knives and gloves) — narrows results server-side
    // so we're not paginating through thousands of rifle skins to find knives
    rarity:    "6",
    // category=0 = any (normal + stattrak + souvenir)
    // category=1 = normal only, category=2 = stattrak only
    // Leaving as 0 to catch both normal and StatTrak knives
    category:  "0",
  };

  if (cursor) params.cursor = cursor;

  const qs   = new URLSearchParams(params);
  const data = await csfloatRequest("/api/v1/listings?" + qs.toString());
  if (!data) return { listings: [], cursor: null };

  // API returns a top-level array of listing objects
  const listings = Array.isArray(data) ? data : (data.data || []);

  // Cursor for next page = the id of the last listing in this batch
  const nextCursor = listings.length === 50 ? listings[listings.length - 1].id : null;

  return { listings, cursor: nextCursor };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CSFLOAT BASE PRICE HELPER
// ─────────────────────────────────────────────────────────────────────────────
function getCsfloatBasePrice(listing) {
  const ref = listing.reference;
  if (!ref) return null;
  const cents = ref.base_price ?? ref.suggested_price ?? null;
  return cents != null && cents > 0 ? cents : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEAM API
// ─────────────────────────────────────────────────────────────────────────────
async function steamGet(path) {
  const { statusCode, body } = await steamPool.request({
    method: "GET",
    path,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      Accept:       "application/json, text/html, */*",
    },
  });

  const text = await body.text();

  if (statusCode === 429) {
    log("  [Steam] ⚠️  429 rate limited on:", path);
    return null;
  }
  if (statusCode !== 200) {
    log(`  [Steam] HTTP ${statusCode} on: ${path}`);
    return null;
  }
  return text;
}

async function getSteamNameid(name) {
  if (steamNameidCache.has(name)) return steamNameidCache.get(name);

  await sleep(CONFIG.STEAM_REQUEST_DELAY_MS);

  const path = "/market/listings/730/" + encodeURIComponent(name);
  const html = await steamGet(path);
  if (!html) return null;

  const match = html.match(/Market_LoadOrderSpread\(\s*(\d+)\s*\)/);
  if (!match) {
    if (CONFIG.DEBUG) log("  [Steam] Could not extract nameid for:", name);
    return null;
  }

  steamNameidCache.set(name, match[1]);
  return match[1];
}

async function getSteamMaxBuyOrder(name) {
  const key    = name + ":max_buy_order";
  const cached = steamPriceCache.get(key);
  const ttlMs  = CONFIG.STEAM_CACHE_TTL_SECONDS * 1000;
  if (cached && Date.now() - cached.ts < ttlMs) return cached.cents;

  const nameid = await getSteamNameid(name);
  if (!nameid) return null;

  await sleep(CONFIG.STEAM_REQUEST_DELAY_MS);

  const qs = new URLSearchParams({
    country:     "US",
    language:    "english",
    currency:    "1",
    item_nameid: nameid,
    two_factor:  "0",
  });

  const text = await steamGet("/market/itemordershistogram?" + qs.toString());
  if (!text) return null;

  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data?.success) return null;

  const cents = data.highest_buy_order ? parseInt(data.highest_buy_order, 10) : null;
  if (cents && cents > 0) steamPriceCache.set(key, { cents, ts: Date.now() });
  return cents || null;
}

async function getSteamMinListing(name) {
  const key    = name + ":min_listing";
  const cached = steamPriceCache.get(key);
  const ttlMs  = CONFIG.STEAM_CACHE_TTL_SECONDS * 1000;
  if (cached && Date.now() - cached.ts < ttlMs) return cached.cents;

  await sleep(CONFIG.STEAM_REQUEST_DELAY_MS);

  const qs = new URLSearchParams({
    appid:            "730",
    currency:         "1",
    market_hash_name: name,
  });

  const text = await steamGet("/market/priceoverview/?" + qs.toString());
  if (!text) return null;

  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data?.success) return null;

  const raw    = data.lowest_price;
  const parsed = raw ? parseFloat(String(raw).replace(/[^0-9.]/g, "")) : NaN;
  if (isNaN(parsed)) return null;

  const cents = Math.round(parsed * 100);
  if (cents > 0) steamPriceCache.set(key, { cents, ts: Date.now() });
  return cents || null;
}

async function getSteamPrice(name) {
  if (CONFIG.PRICE_SOURCE === "steam_max_buy_order") return getSteamMaxBuyOrder(name);
  if (CONFIG.PRICE_SOURCE === "steam_min_listing")   return getSteamMinListing(name);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  KNIFE FILTER (client-side)
//
//  rarity=6 from the API already gives us knives+gloves.
//  If KNIFE_FAMILIES is set, we further narrow by substring match.
//  If KNIFE_FAMILIES is empty, all rarity-6 items are included.
// ─────────────────────────────────────────────────────────────────────────────
function isTargetKnife(listing) {
  const name = (listing.item?.market_hash_name || "").toLowerCase();
  if (CONFIG.KNIFE_FAMILIES.length === 0) return true;
  return CONFIG.KNIFE_FAMILIES.some((f) => name.includes(f.toLowerCase()));
}

// ─────────────────────────────────────────────────────────────────────────────
//  TELEGRAM
// ─────────────────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  const safe = text.length > 4000 ? text.slice(0, 3997) + "..." : text;
  const body = JSON.stringify({
    chat_id:                  CONFIG.TELEGRAM_CHAT_ID,
    text:                     safe,
    parse_mode:               "HTML",
    disable_web_page_preview: true,
  });
  try {
    const { body: res } = await telegramPool.request({
      method: "POST",
      path:   "/bot" + CONFIG.TELEGRAM_BOT_TOKEN + "/sendMessage",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      body,
    });
    await res.text();
  } catch (err) {
    log("  [Telegram] Send failed:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  REPORT BUILDERS
// ─────────────────────────────────────────────────────────────────────────────
function buildConsoleReport(results, scanMs) {
  const W = 115;
  const div = "─".repeat(W);

  const refColHeader = {
    csfloat_base:        "BASE PRICE",
    steam_max_buy_order: "STEAM MAX BO",
    steam_min_listing:   "STEAM MIN LST",
  }[CONFIG.PRICE_SOURCE];

  const lines = [
    "\n" + div,
    `  🗡️  KNIFE ARB — Top ${results.length}  |  Source: ${sourceLabel()}  |  Scan: ${(scanMs / 1000).toFixed(1)}s`,
    div,
    "  " +
      "#".padEnd(3) +
      "SPREAD".padStart(10) +
      "  SPREAD%".padStart(9) +
      "  CSFLOAT".padStart(10) +
      `  ${refColHeader}`.padStart(14) +
      "  FLOAT".padStart(8) +
      "  ITEM NAME",
    div,
  ];

  for (let i = 0; i < results.length; i++) {
    const r         = results[i];
    const rank      = String(i + 1).padEnd(3);
    const spread    = fmt(r.spreadCents).padStart(10);
    const pctStr    = (r.spreadPct >= 0 ? "+" : "") + r.spreadPct.toFixed(1) + "%";
    const csPrice   = fmt(r.csfloatCents).padStart(10);
    const refPrice  = fmt(r.refCents).padStart(14);
    const floatStr  = (r.floatVal != null ? r.floatVal.toFixed(4) : "N/A").padStart(8);
    const emoji     = r.spreadCents >= 500 ? "✅" : r.spreadCents >= 0 ? "🟡" : "🔴";

    lines.push(
      `  ${rank}${spread}  ${pctStr.padStart(8)}  ${csPrice}${refPrice}  ${floatStr}  ${emoji} ${r.name}`
    );
  }

  lines.push(div);
  return lines.join("\n");
}

function buildTelegramReport(results, scanMs) {
  const srcShort = {
    csfloat_base:        "CSFloat base",
    steam_max_buy_order: "Steam max BO",
    steam_min_listing:   "Steam min listing",
  }[CONFIG.PRICE_SOURCE];

  let msg =
    `🗡️ <b>Knife Arb — Top ${results.length}</b>\n` +
    `<i>${h(CONFIG.KNIFE_FAMILIES.join(", ") || "all knives")}  |  ${h(srcShort)}  |  ${(scanMs / 1000).toFixed(1)}s</i>\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r          = results[i];
    const emoji      = r.spreadCents >= 500 ? "✅" : r.spreadCents >= 0 ? "🟡" : "🔴";
    const spreadSign = r.spreadCents >= 0 ? "+" : "";
    const url        = "https://csfloat.com/item/" + r.listingId;
    const refLabel   = CONFIG.PRICE_SOURCE === "csfloat_base" ? "Base" :
                       CONFIG.PRICE_SOURCE === "steam_max_buy_order" ? "Steam BO" : "Steam lst";

    msg +=
      `${emoji} <b>${i + 1}. ${h(r.name)}</b>\n` +
      `   Spread: <b>${spreadSign}${h(fmt(r.spreadCents))}</b> (${spreadSign}${r.spreadPct.toFixed(1)}%)\n` +
      `   CSFloat: <b>${h(fmt(r.csfloatCents))}</b>  ${h(refLabel)}: <b>${h(fmt(r.refCents))}</b>\n` +
      `   Float: <code>${r.floatVal != null ? r.floatVal.toFixed(6) : "N/A"}</code>  ` +
      (r.wearName ? `<i>${h(r.wearName)}</i>  ` : "") +
      `<a href="${h(url)}">View</a>\n\n`;
  }

  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN SCAN
// ─────────────────────────────────────────────────────────────────────────────
async function scan() {
  if (Date.now() < csfloatBackoffUntil) {
    const secs = Math.ceil((csfloatBackoffUntil - Date.now()) / 1000);
    log(`[CSFloat] Cooling down — skipping scan (${secs}s left)`);
    return;
  }

  scanCount++;
  const scanStart = Date.now();
  log(`\n══ SCAN #${scanCount}  [${CONFIG.PRICE_SOURCE}] ${"═".repeat(30)}`);

  // ── 1. Fetch CSFloat pages ─────────────────────────────────────────────────
  const allListings = [];
  let cursor = null;

  for (let p = 0; p < CONFIG.SCAN_PAGES; p++) {
    log(`  [CSFloat] Page ${p + 1}/${CONFIG.SCAN_PAGES}${cursor ? " (cursor)" : ""}...`);

    try {
      const result = await fetchPage(cursor);
      const { listings, cursor: nextCursor } = result;

      if (!listings || listings.length === 0) {
        log(`  [CSFloat] Page ${p + 1} empty — stopping`);
        break;
      }

      allListings.push(...listings);
      log(`  [CSFloat] Page ${p + 1}: got ${listings.length} listings (total: ${allListings.length})`);

      cursor = nextCursor;
      if (!cursor) {
        log(`  [CSFloat] No more pages`);
        break;
      }
    } catch (err) {
      log(`  [CSFloat] Page ${p + 1} error: ${err.message}`);
      break;
    }

    // Must wait at least 20s between CSFloat listing requests
    if (p < CONFIG.SCAN_PAGES - 1 && cursor) {
      log(`  [CSFloat] Waiting ${CONFIG.CSFLOAT_PAGE_DELAY_MS / 1000}s before next page (rate limit)...`);
      await sleep(CONFIG.CSFLOAT_PAGE_DELAY_MS);
    }
  }

  log(`  [CSFloat] Fetched ${allListings.length} listings total`);

  // ── 2. Filter to target knife families ─────────────────────────────────────
  const knifeListings = allListings.filter((l) => l.type === "buy_now" && isTargetKnife(l));
  log(`  [Filter]  Matching knives: ${knifeListings.length}`);

  if (knifeListings.length === 0) {
    log("  No matching listings. Check KNIFE_FAMILIES or widen price range.");
    return;
  }

  // ── 3. Resolve comparison price ───────────────────────────────────────────
  const results = [];
  let hits = 0, misses = 0;

  if (!USE_STEAM) {
    log(`  [CSFloat] Resolving base prices (${knifeListings.length} listings)...`);

    for (const listing of knifeListings) {
      const name         = listing.item?.market_hash_name || "";
      const baseCents    = getCsfloatBasePrice(listing);
      const csfloatCents = listing.price;

      if (CONFIG.DEBUG) {
        process.stdout.write(
          `  [Base] ${name.slice(0, 60).padEnd(60)} → ask: ${fmt(csfloatCents).padStart(9)}  base: `
        );
      }

      if (baseCents == null) {
        if (CONFIG.DEBUG) process.stdout.write("no ref data\n");
        misses++;
        continue;
      }

      const spreadCents = baseCents - csfloatCents;
      const spreadPct   = (spreadCents / csfloatCents) * 100;

      if (CONFIG.DEBUG) {
        process.stdout.write(`${fmt(baseCents).padStart(9)}  spread: ${fmtSign(spreadCents)}\n`);
      }
      hits++;

      if (spreadCents / 100 >= CONFIG.MIN_SPREAD_USD) {
        results.push({
          name,
          listingId:    listing.id,
          csfloatCents,
          refCents:     baseCents,
          spreadCents,
          spreadPct,
          floatVal:     listing.item?.float_value ?? null,
          wearName:     listing.item?.wear_name || "",
        });
      }
    }
    log(`  [Base]  Evaluated: ${knifeListings.length}, Resolved: ${hits}, Missing ref: ${misses}`);

  } else {
    const uniqueNames = [...new Set(
      knifeListings.map((l) => l.item?.market_hash_name).filter(Boolean)
    )];

    log(`  [Steam]  Fetching ${sourceLabel()} for ${uniqueNames.length} unique skin(s) (${knifeListings.length} total listings)...`);
    log(`  [Steam]  Delay: ${CONFIG.STEAM_REQUEST_DELAY_MS}ms | Cache TTL: ${CONFIG.STEAM_CACHE_TTL_SECONDS}s`);

    const refPriceMap = new Map();
    for (let i = 0; i < uniqueNames.length; i++) {
      const name = uniqueNames[i];
      process.stdout.write(
        `  [Steam] ${i + 1}/${uniqueNames.length} — ${name.slice(0, 55).padEnd(55)} `
      );
      const refCents = await getSteamPrice(name);
      if (refCents == null) {
        process.stdout.write("→ no data\n");
      } else {
        process.stdout.write(`→ ${fmt(refCents)}\n`);
        refPriceMap.set(name, refCents);
      }
    }

    log(`  [Steam]  Prices resolved for ${refPriceMap.size}/${uniqueNames.length} unique skins`);

    for (const listing of knifeListings) {
      const name = listing.item?.market_hash_name || "";
      if (!name) continue;

      const refCents = refPriceMap.get(name);
      if (refCents == null) { misses++; continue; }

      const csfloatCents = listing.price;
      const spreadCents  = refCents - csfloatCents;
      const spreadPct    = (spreadCents / csfloatCents) * 100;
      hits++;

      if (CONFIG.DEBUG) {
        log(
          `  [Eval] ${name.slice(0, 50).padEnd(50)}` +
          ` ask: ${fmt(csfloatCents).padStart(9)}  ref: ${fmt(refCents).padStart(9)}  spread: ${fmtSign(spreadCents)}`
        );
      }

      if (spreadCents / 100 >= CONFIG.MIN_SPREAD_USD) {
        results.push({
          name,
          listingId:    listing.id,
          csfloatCents,
          refCents,
          spreadCents,
          spreadPct,
          floatVal:     listing.item?.float_value ?? null,
          wearName:     listing.item?.wear_name || "",
        });
      }
    }
    log(`  [Steam]  Hits: ${hits}, No-ref: ${misses}`);
  }

  // ── 4. Sort and trim ───────────────────────────────────────────────────────
  results.sort((a, b) => b.spreadCents - a.spreadCents);
  const top    = results.slice(0, CONFIG.TOP_N);
  const scanMs = Date.now() - scanStart;

  // ── 5. Output ─────────────────────────────────────────────────────────────
  if (top.length > 0) {
    console.log(buildConsoleReport(top, scanMs));
    sendTelegram(buildTelegramReport(top, scanMs)).catch(() => {});
  } else {
    log(`  No results above MIN_SPREAD_USD=$${CONFIG.MIN_SPREAD_USD}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  if (!CONFIG.CSFLOAT_API_KEY) {
    console.error("ERROR: CSFLOAT_API_KEY is not set in .env");
    process.exit(1);
  }

  const familyLabel = CONFIG.KNIFE_FAMILIES.length > 0
    ? CONFIG.KNIFE_FAMILIES.join(", ")
    : "all knives (rarity=6)";

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║           🗡️  KNIFE ARBITRAGE SCANNER                ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  Families:      ${familyLabel}`);
  console.log(`  Price range:   $${CONFIG.MIN_PRICE_USD} – $${CONFIG.MAX_PRICE_USD}`);
  console.log(`  Price source:  ${sourceLabel()}`);
  if (USE_STEAM) {
    console.log(`  Steam delay:   ${CONFIG.STEAM_REQUEST_DELAY_MS}ms between requests`);
    console.log(`  Steam TTL:     ${CONFIG.STEAM_CACHE_TTL_SECONDS}s`);
  } else {
    console.log(`  Steam:         skipped (base price from CSFloat payload)`);
  }
  console.log(`  Pages/scan:    ${CONFIG.SCAN_PAGES} × 50 = up to ${CONFIG.SCAN_PAGES * 50} listings`);
  console.log(`  Page delay:    ${CONFIG.CSFLOAT_PAGE_DELAY_MS / 1000}s (CSFloat rate limit)`);
  console.log(`  Top N:         ${CONFIG.TOP_N}`);
  console.log(`  Min spread:    $${CONFIG.MIN_SPREAD_USD}  ← only show deals with profit >= this`);
  console.log(`  Poll interval: ${CONFIG.POLL_INTERVAL_SECONDS > 0 ? CONFIG.POLL_INTERVAL_SECONDS + "s" : "single run (set POLL_INTERVAL_SECONDS>0 to loop)"}`);
  console.log(`  Telegram:      ${CONFIG.TELEGRAM_BOT_TOKEN ? "active (chat " + CONFIG.TELEGRAM_CHAT_ID + ")" : "disabled"}`);
  console.log("");

  await scan();

  if (CONFIG.POLL_INTERVAL_SECONDS > 0) {
    log(`\n  Polling every ${CONFIG.POLL_INTERVAL_SECONDS}s. Ctrl+C to stop.`);
    setInterval(scan, CONFIG.POLL_INTERVAL_SECONDS * 1000);
  } else {
    log("  Single-run complete. Set POLL_INTERVAL_SECONDS>0 to keep running.");
    process.exit(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CRASH HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
function buildCrashMsg(reason, label) {
  const msg   = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error && reason.stack
    ? "\n\n<pre>" + h(reason.stack.slice(0, 600)) + "</pre>" : "";
  return `💥 <b>CRASHED — ${h(label)}</b>\n<code>${h(msg)}</code>${stack}`;
}

process.on("uncaughtException", (err) => {
  console.error("[CRASH] uncaughtException:", err);
  sendTelegram(buildCrashMsg(err, "uncaughtException")).catch(() => {}).finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  console.error("[CRASH] unhandledRejection:", reason);
  sendTelegram(buildCrashMsg(reason, "unhandledRejection")).catch(() => {}).finally(() => process.exit(1));
});

main();