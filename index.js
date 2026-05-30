require("dotenv").config();

const { Pool } = require("undici");

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  CSFLOAT_API_KEY: process.env.CSFLOAT_API_KEY,

  // Knife families to scan (matched against market_hash_name, case-insensitive)
  KNIFE_FAMILIES: (process.env.KNIFE_FAMILIES || "Talon,Karambit,Butterfly")
    .split(",")
    .map((s) => s.trim()),

  // Price window (USD)
  MIN_PRICE_USD: parseFloat(process.env.MIN_PRICE_USD) || 50,
  MAX_PRICE_USD: parseFloat(process.env.MAX_PRICE_USD) || 5000,

  // ── Price source ──────────────────────────────────────────────────────────
  // "csfloat_base"       → use listing.reference.base_price from CSFloat payload
  //                        (no Steam calls at all — instant, no rate-limit risk)
  // "steam_max_buy_order"→ Steam histogram highest_buy_order
  // "steam_min_listing"  → Steam priceoverview lowest_price
  PRICE_SOURCE: (process.env.PRICE_SOURCE || "csfloat_base").trim(),

  // How many top results to display / send to Telegram
  TOP_N: Math.min(20, Math.max(1, parseInt(process.env.TOP_N) || 10)),

  // CSFloat pages per scan (100 listings/page, max 10)
  SCAN_PAGES: Math.min(10, Math.max(1, parseInt(process.env.SCAN_PAGES) || 3)),

  // Minimum spread to include in results (USD). Negative = show underwater items too.
  MIN_SPREAD_USD: parseFloat(process.env.MIN_SPREAD_USD) || 0,

  // Repeat scan every N seconds. 0 = run once and exit.
  POLL_INTERVAL_SECONDS: parseInt(process.env.POLL_INTERVAL_SECONDS) || 0,

  // ── Steam settings (only relevant when PRICE_SOURCE != "csfloat_base") ────
  STEAM_REQUEST_DELAY_MS:   Math.max(500, parseInt(process.env.STEAM_REQUEST_DELAY_MS)   || 1500),
  STEAM_CACHE_TTL_SECONDS:  Math.max(60,  parseInt(process.env.STEAM_CACHE_TTL_SECONDS)  || 600),

  // CSFloat backoff on 429: 5 min → 10 min → 30 min
  CSFLOAT_BACKOFF_STEPS_MS: [
    5  * 60 * 1000,
    10 * 60 * 1000,
    30 * 60 * 1000,
  ],

  // Telegram (optional)
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID   || "",

  DEBUG: process.env.DEBUG === "true",
};

// Derived — cents
const MIN_PRICE_CENTS = Math.round(CONFIG.MIN_PRICE_USD * 100);
const MAX_PRICE_CENTS = Math.round(CONFIG.MAX_PRICE_USD * 100);

// Validate PRICE_SOURCE
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

// CSFloat rate-limit
let csfloatBackoffUntil = 0;
let csfloatBackoffLevel = 0;

// Steam caches (only used when USE_STEAM = true)
const steamNameidCache = new Map();  // market_hash_name → nameid (permanent in-process)
const steamPriceCache  = new Map();  // "name:mode" → { cents, ts }

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

// Steam pool — created only when needed
const steamPool = USE_STEAM
  ? new Pool("https://steamcommunity.com", {
      connections: 2,
      pipelining:  1,
      keepAliveTimeout:    30_000,
      keepAliveMaxTimeout: 60_000,
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

/** Human-readable label for the configured price source. */
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

  if (statusCode === 429) {
    csfloatBackoffLevel = Math.min(
      csfloatBackoffLevel + 1,
      CONFIG.CSFLOAT_BACKOFF_STEPS_MS.length - 1
    );
    const delay = CONFIG.CSFLOAT_BACKOFF_STEPS_MS[csfloatBackoffLevel];
    csfloatBackoffUntil = Date.now() + delay;
    const mins = (delay / 60000).toFixed(0);
    log(`  [CSFloat] ⚠️  429 — cooling down for ${mins} min (level ${csfloatBackoffLevel})`);
    sendTelegram(
      `⏳ <b>CSFloat Rate Limited</b>\nLevel ${csfloatBackoffLevel} — cooling for <b>${mins} min</b>`
    ).catch(() => {});
    return null;
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw Object.assign(new Error("CSFloat HTTP " + statusCode), { statusCode, text });
  }

  csfloatBackoffLevel = 0;
  return JSON.parse(text);
}

async function fetchPage(page) {
  const qs = new URLSearchParams({
    sort_by:   "highest_discount",
    type:      "buy_now",
    min_price: String(MIN_PRICE_CENTS),
    max_price: String(MAX_PRICE_CENTS),
    limit:     "50", // max allowed by CSFloat
    page:      String(page),
    category:  "2",   // Knives
  });
  const data = await csfloatRequest("/api/v1/listings?" + qs.toString());
  return data?.data || [];
}

// ─────────────────────────────────────────────────────────────────────────────
//  CSFLOAT BASE PRICE HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the CSFloat reference/base price from a listing in cents.
 * CSFloat returns reference.base_price (median market) and
 * reference.suggested_price (their own suggested price).
 * We prefer base_price; fall back to suggested_price.
 * Returns null if neither is available.
 */
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
      Accept:       "application/json, */*",
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

/** Resolves and caches the Steam Market nameid for an item. Permanent cache. */
async function getSteamNameid(name) {
  if (steamNameidCache.has(name)) return steamNameidCache.get(name);

  await sleep(CONFIG.STEAM_REQUEST_DELAY_MS);

  const path = "/market/listings/730/" + encodeURIComponent(name);
  const html = await steamGet(path);
  if (!html) return null;

  const match = html.match(/Market_LoadOrderSpread\(\s*(\d+)\s*\)/);
  if (!match) {
    log("  [Steam] Could not extract nameid for:", name);
    return null;
  }

  steamNameidCache.set(name, match[1]);
  return match[1];
}

/**
 * Steam max buy order (histogram API).
 * Steam returns highest_buy_order in cents already.
 */
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

/**
 * Steam min listing price (priceoverview API).
 * Returns lowest listed price in cents.
 */
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

  // lowest_price is a formatted string like "$123.45"
  const raw    = data.lowest_price;
  const parsed = raw ? parseFloat(String(raw).replace(/[^0-9.]/g, "")) : NaN;
  if (isNaN(parsed)) return null;

  const cents = Math.round(parsed * 100);
  if (cents > 0) steamPriceCache.set(key, { cents, ts: Date.now() });
  return cents || null;
}

/** Unified Steam price fetch — dispatches to the configured mode. */
async function getSteamPrice(name) {
  if (CONFIG.PRICE_SOURCE === "steam_max_buy_order") return getSteamMaxBuyOrder(name);
  if (CONFIG.PRICE_SOURCE === "steam_min_listing")   return getSteamMinListing(name);
  return null; // should never reach — csfloat_base bypasses this entirely
}

// ─────────────────────────────────────────────────────────────────────────────
//  KNIFE FILTER
// ─────────────────────────────────────────────────────────────────────────────
function isTargetKnife(listing) {
  const name = (listing.item?.market_hash_name || "").toLowerCase();
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

  // Dynamic header for the comparison price column
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
    `<i>${h(CONFIG.KNIFE_FAMILIES.join(", "))}  |  ${h(srcShort)}  |  ${(scanMs / 1000).toFixed(1)}s</i>\n\n`;

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
  for (let p = 0; p < CONFIG.SCAN_PAGES; p++) {
    log(`  [CSFloat] Page ${p + 1}/${CONFIG.SCAN_PAGES}...`);
    try {
      const page = await fetchPage(p);
      if (!page || page.length === 0) { log(`  [CSFloat] Page ${p + 1} empty — stopping`); break; }
      allListings.push(...page);
      if (page.length < 100) break;
    } catch (err) {
      log(`  [CSFloat] Page ${p + 1} error: ${err.message}`);
      break;
    }
    if (p < CONFIG.SCAN_PAGES - 1) await sleep(500);
  }
  log(`  [CSFloat] Fetched ${allListings.length} listings total`);

  // ── 2. Filter to target knife families ─────────────────────────────────────
  const knifeListings = allListings.filter((l) => l.type === "buy_now" && isTargetKnife(l));
  log(`  [Filter]  Matching knives: ${knifeListings.length}`);

  if (knifeListings.length === 0) {
    log("  No matching knife listings found. Try widening price range or SCAN_PAGES.");
    return;
  }

  // ── 3. Dedup — cheapest listing per market_hash_name ──────────────────────
  //   Reduces Steam API calls.
  //   For csfloat_base: each listing already carries its own reference price,
  //   so we still dedup to avoid surfacing the same skin multiple times.
  const cheapestByName = new Map();
  for (const l of knifeListings) {
    const name = l.item?.market_hash_name || "";
    if (!name) continue;
    const ex = cheapestByName.get(name);
    if (!ex || l.price < ex.price) cheapestByName.set(name, l);
  }
  log(`  [Dedup]   Unique skins: ${cheapestByName.size}`);

  // ── 4. Resolve comparison price ───────────────────────────────────────────
  const results  = [];
  const entries  = [...cheapestByName.entries()];
  let hits = 0, misses = 0;

  if (!USE_STEAM) {
    // ── csfloat_base: reference price is already in the payload ──────────────
    log(`  [CSFloat] Resolving base prices from payload...`);
    for (const [name, listing] of entries) {
      const baseCents    = getCsfloatBasePrice(listing);
      const csfloatCents = listing.price;

      process.stdout.write(
        `  [Base] ${(name).slice(0, 60).padEnd(60)} ` +
        `→ ask: ${fmt(csfloatCents).padStart(9)}  base: `
      );

      if (baseCents == null) {
        process.stdout.write("no ref data\n");
        misses++;
        continue;
      }

      const spreadCents = baseCents - csfloatCents;
      const spreadPct   = (spreadCents / csfloatCents) * 100;
      process.stdout.write(
        `${fmt(baseCents).padStart(9)}  spread: ${fmtSign(spreadCents)}\n`
      );
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
    log(`\n  [Base]  Resolved: ${hits}, Missing ref: ${misses}`);

  } else {
    // ── steam_max_buy_order or steam_min_listing: sequential Steam requests ───
    log(`  [Steam]  Fetching ${sourceLabel()} for ${entries.length} item(s)...`);
    log(`  [Steam]  Delay: ${CONFIG.STEAM_REQUEST_DELAY_MS}ms | Cache TTL: ${CONFIG.STEAM_CACHE_TTL_SECONDS}s`);

    for (let i = 0; i < entries.length; i++) {
      const [name, listing] = entries[i];
      process.stdout.write(
        `  [Steam] ${i + 1}/${entries.length} — ${name.slice(0, 55).padEnd(55)} `
      );

      const refCents = await getSteamPrice(name);
      if (refCents == null) {
        process.stdout.write("→ no data\n");
        misses++;
        continue;
      }

      const csfloatCents = listing.price;
      const spreadCents  = refCents - csfloatCents;
      const spreadPct    = (spreadCents / csfloatCents) * 100;

      process.stdout.write(
        `→ ask: ${fmt(csfloatCents).padStart(9)}  ref: ${fmt(refCents).padStart(9)}  spread: ${fmtSign(spreadCents)}\n`
      );
      hits++;

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
    log(`\n  [Steam]  Resolved: ${hits}, Missing: ${misses}`);
  }

  // ── 5. Sort and trim ───────────────────────────────────────────────────────
  results.sort((a, b) => b.spreadCents - a.spreadCents);
  const top     = results.slice(0, CONFIG.TOP_N);
  const scanMs  = Date.now() - scanStart;

  // ── 6. Output ─────────────────────────────────────────────────────────────
  if (top.length > 0) {
    console.log(buildConsoleReport(top, scanMs));
    sendTelegram(buildTelegramReport(top, scanMs)).catch(() => {});
  } else {
    log(`  No results above MIN_SPREAD_USD=${CONFIG.MIN_SPREAD_USD}`);
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

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║           🗡️  KNIFE ARBITRAGE SCANNER                ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  Families:      ${CONFIG.KNIFE_FAMILIES.join(", ")}`);
  console.log(`  Price range:   $${CONFIG.MIN_PRICE_USD} – $${CONFIG.MAX_PRICE_USD}`);
  console.log(`  Price source:  ${sourceLabel()}`);
  if (USE_STEAM) {
    console.log(`  Steam delay:   ${CONFIG.STEAM_REQUEST_DELAY_MS}ms between requests`);
    console.log(`  Steam TTL:     ${CONFIG.STEAM_CACHE_TTL_SECONDS}s`);
  } else {
    console.log(`  Steam:         skipped (base price from CSFloat payload)`);
  }
  console.log(`  Pages/scan:    ${CONFIG.SCAN_PAGES} (up to ${CONFIG.SCAN_PAGES * 100} listings)`);
  console.log(`  Top N:         ${CONFIG.TOP_N}`);
  console.log(`  Min spread:    $${CONFIG.MIN_SPREAD_USD}`);
  console.log(`  Poll interval: ${CONFIG.POLL_INTERVAL_SECONDS > 0 ? CONFIG.POLL_INTERVAL_SECONDS + "s" : "single run"}`);
  console.log(`  Telegram:      ${CONFIG.TELEGRAM_BOT_TOKEN ? "active (chat " + CONFIG.TELEGRAM_CHAT_ID + ")" : "disabled"}`);
  console.log("");

  await scan();

  if (CONFIG.POLL_INTERVAL_SECONDS > 0) {
    log(`\n  Polling every ${CONFIG.POLL_INTERVAL_SECONDS}s. Ctrl+C to stop.`);
    setInterval(scan, CONFIG.POLL_INTERVAL_SECONDS * 1000);
  } else {
    log("  Single-run complete.");
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
