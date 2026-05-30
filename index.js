require("dotenv").config();

const fs   = require("fs");
const path = require("path");
const { Pool, request: undiciRequest } = require("undici");

// ─────────────────────────────────────────────────────────────────────────────
//  STATIC KNIFE NAME LIST
// ─────────────────────────────────────────────────────────────────────────────

const WEARS = ["Factory New", "Minimal Wear", "Field-Tested", "Well-Worn", "Battle-Scarred"];

const WEAR_OVERRIDE = {
  "Doppler":       ["Factory New", "Minimal Wear"],
  "Gamma Doppler": ["Factory New", "Minimal Wear"],
  "Marble Fade":   ["Factory New"],
  "Tiger Tooth":   ["Factory New"],
  "Fade":          ["Factory New", "Minimal Wear"],
  "Bright Water":  ["Factory New", "Minimal Wear", "Field-Tested"],
  "Slaughter":     ["Factory New", "Minimal Wear", "Field-Tested"],
  "Night":         ["Factory New", "Minimal Wear", "Field-Tested"],
  "Rust Coat":     ["Battle-Scarred"],
};

const SHARED_SKINS = [
  "Doppler", "Gamma Doppler", "Marble Fade", "Tiger Tooth", "Fade",
  "Slaughter", "Crimson Web", "Case Hardened", "Black Laminate",
  "Autotronic", "Freehand", "Bright Water", "Ultraviolet", "Night",
  "Blue Steel", "Stained", "Damascus Steel", "Urban Masked", "Scorched",
  "Forest DDPAT", "Boreal Forest", "Rust Coat",
];

const KARAMBIT_ONLY_SKINS = ["Lore"];

function buildNames(knifeBase, skins) {
  const names = [];
  names.push(`★ ${knifeBase}`);
  names.push(`★ StatTrak™ ${knifeBase}`);
  for (const skin of skins) {
    const wears = WEAR_OVERRIDE[skin] ?? WEARS;
    for (const wear of wears) {
      names.push(`★ ${knifeBase} | ${skin} (${wear})`);
      names.push(`★ StatTrak™ ${knifeBase} | ${skin} (${wear})`);
    }
  }
  return names;
}

const KARAMBIT_NAMES  = buildNames("Karambit",   [...SHARED_SKINS, ...KARAMBIT_ONLY_SKINS]);
const TALON_NAMES     = buildNames("Talon Knife", SHARED_SKINS);
const ALL_KNIFE_NAMES = [...new Set([...KARAMBIT_NAMES, ...TALON_NAMES])].sort();

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  CSFLOAT_API_KEY: process.env.CSFLOAT_API_KEY,

  MIN_PRICE_USD: parseFloat(process.env.MIN_PRICE_USD) || 50,
  MAX_PRICE_USD: parseFloat(process.env.MAX_PRICE_USD) || 5000,

  // "csfloat_base"        → use listing.reference.base_price
  // "steam_max_buy_order" → Steam histogram highest_buy_order
  // "steam_min_listing"   → Steam priceoverview lowest_price
  PRICE_SOURCE: (process.env.PRICE_SOURCE || "csfloat_base").trim(),

  TOP_N:             Math.min(50, Math.max(1, parseInt(process.env.TOP_N)             || 10)),
  LISTINGS_PER_NAME: Math.min(50, Math.max(1, parseInt(process.env.LISTINGS_PER_NAME) || 10)),
  MIN_SPREAD_USD:    parseFloat(process.env.MIN_SPREAD_USD) || 0,
  POLL_INTERVAL_SECONDS: parseInt(process.env.POLL_INTERVAL_SECONDS) || 0,

  // CSFloat: minimum 20s between listing requests
  CSFLOAT_NAME_DELAY_MS: Math.max(20000, parseInt(process.env.CSFLOAT_NAME_DELAY_MS) || 20000),

  // CSFloat backoff on 429: 5 min → 10 min → 30 min
  CSFLOAT_BACKOFF_STEPS_MS: [5 * 60_000, 10 * 60_000, 30 * 60_000],

  // Steam: delay between requests, cache TTL, and per-item retry count
  STEAM_REQUEST_DELAY_MS:  Math.max(1500, parseInt(process.env.STEAM_REQUEST_DELAY_MS)  || 3000),
  STEAM_CACHE_TTL_SECONDS: Math.max(300,  parseInt(process.env.STEAM_CACHE_TTL_SECONDS) || 3600),
  STEAM_RETRIES:           Math.max(1,    parseInt(process.env.STEAM_RETRIES)           || 3),
  // How long to cool down after N consecutive Steam failures
  STEAM_BACKOFF_MS:     Math.max(30000, parseInt(process.env.STEAM_BACKOFF_MS)     || 60000),
  STEAM_FAIL_THRESHOLD: Math.max(1,     parseInt(process.env.STEAM_FAIL_THRESHOLD) || 5),

  // Path to persist the Steam price cache between runs
  STEAM_CACHE_FILE: process.env.STEAM_CACHE_FILE || path.join(__dirname, "steam-cache.json"),

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

// CSFloat backoff
let csfloatBackoffUntil = 0;
let csfloatBackoffLevel = 0;

// Steam state
let steamRateLimitUntil   = 0;
let steamConsecutiveFails = 0;
const steamNameidCache    = new Map();
const steamPriceCache     = new Map(); // key → { cents, ts }

// ─────────────────────────────────────────────────────────────────────────────
//  STEAM DISK CACHE
// ─────────────────────────────────────────────────────────────────────────────
function loadSteamCache() {
  try {
    const raw  = fs.readFileSync(CONFIG.STEAM_CACHE_FILE, "utf8");
    const data = JSON.parse(raw);
    const ttlMs = CONFIG.STEAM_CACHE_TTL_SECONDS * 1000;
    let loaded = 0;
    for (const [key, entry] of Object.entries(data)) {
      if (entry && typeof entry.cents === "number" && Date.now() - entry.ts < ttlMs) {
        steamPriceCache.set(key, entry);
        loaded++;
      }
    }
    log(`  [Steam] Loaded ${loaded} valid cached prices from disk (${CONFIG.STEAM_CACHE_FILE})`);
  } catch (err) {
    if (err.code !== "ENOENT") log(`  [Steam] Cache load warning: ${err.message}`);
  }
}

function saveSteamCache() {
  const obj = {};
  for (const [key, val] of steamPriceCache.entries()) obj[key] = val;
  try {
    fs.writeFileSync(CONFIG.STEAM_CACHE_FILE, JSON.stringify(obj, null, 2));
    if (CONFIG.DEBUG) log(`  [Steam] Cache saved (${steamPriceCache.size} entries)`);
  } catch (err) {
    log(`  [Steam] Cache save failed: ${err.message}`);
  }
}

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
      pipelining:  0,
      keepAliveTimeout:    30_000,
      keepAliveMaxTimeout: 60_000,
      // NOTE: maxRedirections on Pool has no effect — redirects are handled
      // manually in steamGet() using undiciRequest() with dispatch options.
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

function fmt(cents)     { return "$" + (cents / 100).toFixed(2); }
function fmtSign(cents) { return (cents >= 0 ? "+" : "") + fmt(cents); }
function h(text) {
  return String(text)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;");
}
function log(...args) { console.log("[" + new Date().toISOString() + "]", ...args); }

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

async function fetchListingsForName(marketHashName) {
  const params =
    `market_hash_name=${encodeURIComponent(marketHashName)}` +
    `&type=buy_now` +
    `&sort_by=lowest_price` +
    `&min_price=${MIN_PRICE_CENTS}` +
    `&max_price=${MAX_PRICE_CENTS}` +
    `&limit=${CONFIG.LISTINGS_PER_NAME}`;

  let data;
  try {
    data = await csfloatRequest("/api/v1/listings?" + params);
  } catch (err) {
    log(`  [CSFloat] Error fetching "${marketHashName}": ${err.message}`);
    return [];
  }

  if (!data) return [];
  const listings = Array.isArray(data) ? data : (data.data || []);
  return listings.filter((l) => l.type === "buy_now");
}

function getCsfloatBasePrice(listing) {
  const ref = listing.reference;
  if (!ref) return null;
  const cents = ref.base_price ?? ref.suggested_price ?? null;
  return cents != null && cents > 0 ? cents : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEAM API
//
//  FIX SUMMARY vs original:
//  1. Removed trailing slash from /market/priceoverview  (was causing 301
//     redirects that undici Pool silently failed on — root cause of all
//     "no data" returns for existing items)
//  2. steamGet() now follows redirects manually via undici.request() with
//     maxRedirections:5 (Pool-level option does NOT work on bare pools)
//  3. Increased default STEAM_RETRIES to 3
//  4. All other logic (backoff, fail counter, cache, headers) unchanged
// ─────────────────────────────────────────────────────────────────────────────

const STEAM_HEADERS = {
  "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":           "application/json, text/javascript, */*; q=0.01",
  "Accept-Language":  "en-US,en;q=0.9",
  "Accept-Encoding":  "gzip, deflate, br",
  "Referer":          "https://steamcommunity.com/market/",
  "X-Requested-With": "XMLHttpRequest",
  "Sec-Fetch-Dest":   "empty",
  "Sec-Fetch-Mode":   "cors",
  "Sec-Fetch-Site":   "same-origin",
};

// ── Core HTTP helper — follows redirects properly ─────────────────────────────
// undici Pool.request() does NOT follow redirects even with maxRedirections set.
// We use the top-level undiciRequest() which DOES honour maxRedirections.
async function steamGet(requestPath) {
  // Global Steam rate-limit gate
  if (Date.now() < steamRateLimitUntil) {
    const wait = steamRateLimitUntil - Date.now();
    log(`  [Steam] Rate-limit gate active — waiting ${Math.ceil(wait / 1000)}s...`);
    await sleep(wait);
  }

  const fullUrl = "https://steamcommunity.com" + requestPath;

  for (let attempt = 1; attempt <= CONFIG.STEAM_RETRIES; attempt++) {
    let statusCode, text;
    try {
      // Use top-level undiciRequest so maxRedirections is honoured
      const resp = await undiciRequest(fullUrl, {
        method:          "GET",
        headers:         STEAM_HEADERS,
        maxRedirections: 5,   // ← works here; does NOT work on Pool.request()
      });
      statusCode = resp.statusCode;
      text = await resp.body.text();
    } catch (connErr) {
      log(`  [Steam] Connection error (attempt ${attempt}): ${connErr.message}`);
      if (attempt < CONFIG.STEAM_RETRIES) await sleep(CONFIG.STEAM_REQUEST_DELAY_MS * attempt);
      continue;
    }

    if (statusCode === 429) {
      const backoff = CONFIG.STEAM_BACKOFF_MS * attempt;
      steamRateLimitUntil = Date.now() + backoff;
      log(`  [Steam] ⚠️  429 — cooling ${(backoff / 1000).toFixed(0)}s (attempt ${attempt})`);
      await sleep(backoff);
      continue;
    }

    if (statusCode !== 200) {
      if (CONFIG.DEBUG) log(`  [Steam] HTTP ${statusCode} on: ${requestPath}`);
      if (attempt < CONFIG.STEAM_RETRIES) await sleep(CONFIG.STEAM_REQUEST_DELAY_MS * attempt);
      continue;
    }

    // Detect HTML response (Steam login redirect, captcha, or block page)
    if (text.trimStart().startsWith("<")) {
      log(`  [Steam] ⚠️  Got HTML instead of JSON — Steam may be blocking requests`);
      if (CONFIG.DEBUG) log(`  [Steam] Response preview: ${text.slice(0, 400)}`);
      steamConsecutiveFails++;
      if (steamConsecutiveFails >= CONFIG.STEAM_FAIL_THRESHOLD) {
        steamRateLimitUntil = Date.now() + CONFIG.STEAM_BACKOFF_MS;
        log(`  [Steam] ⚠️  ${steamConsecutiveFails} consecutive HTML responses — pausing ${CONFIG.STEAM_BACKOFF_MS / 1000}s`);
        steamConsecutiveFails = 0;
      }
      return null;
    }

    // Success — reset failure counter
    steamConsecutiveFails = 0;
    return text;
  }

  return null;
}

// ── Nameid lookup (for max buy order) ─────────────────────────────────────────
async function getSteamNameid(name) {
  if (steamNameidCache.has(name)) return steamNameidCache.get(name);

  await sleep(CONFIG.STEAM_REQUEST_DELAY_MS);

  const requestPath = "/market/listings/730/" + encodeURIComponent(name);
  const html = await steamGet(requestPath);
  if (!html) return null;

  const match = html.match(/Market_LoadOrderSpread\(\s*(\d+)\s*\)/);
  if (!match) {
    if (CONFIG.DEBUG) log(`  [Steam] Could not extract nameid for: ${name}`);
    steamConsecutiveFails++;
    return null;
  }

  steamNameidCache.set(name, match[1]);
  return match[1];
}

// ── Max buy order ─────────────────────────────────────────────────────────────
async function getSteamMaxBuyOrder(name) {
  const cacheKey = name + ":max_buy_order";
  const ttlMs    = CONFIG.STEAM_CACHE_TTL_SECONDS * 1000;
  const cached   = steamPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ttlMs) return cached.cents;

  const nameid = await getSteamNameid(name);
  if (!nameid) return null;

  await sleep(CONFIG.STEAM_REQUEST_DELAY_MS);

  const requestPath =
    `/market/itemordershistogram` +
    `?country=US&language=english&currency=1` +
    `&item_nameid=${encodeURIComponent(nameid)}` +
    `&two_factor=0`;

  const text = await steamGet(requestPath);
  if (!text) return null;

  let data;
  try { data = JSON.parse(text); } catch (e) {
    if (CONFIG.DEBUG) log(`  [Steam] JSON parse error for buy order "${name}": ${e.message}`);
    return null;
  }

  if (!data?.success) {
    if (CONFIG.DEBUG) log(`  [Steam] success=false for buy order "${name}": ${JSON.stringify(data)}`);
    steamConsecutiveFails++;
    return null;
  }

  const cents = data.highest_buy_order ? parseInt(data.highest_buy_order, 10) : null;
  if (cents && cents > 0) {
    steamPriceCache.set(cacheKey, { cents, ts: Date.now() });
    steamConsecutiveFails = 0;
  }
  return cents || null;
}

// ── Min listing price ─────────────────────────────────────────────────────────
async function getSteamMinListing(name) {
  const cacheKey = name + ":min_listing";
  const ttlMs    = CONFIG.STEAM_CACHE_TTL_SECONDS * 1000;
  const cached   = steamPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ttlMs) return cached.cents;

  await sleep(CONFIG.STEAM_REQUEST_DELAY_MS);

  // FIX: NO trailing slash on /market/priceoverview
  // The original had /market/priceoverview/ (with slash) which Steam redirects
  // to /market/priceoverview (no slash) via 301. undici Pool.request() does NOT
  // follow redirects, so every call silently returned null.
  const requestPath =
    `/market/priceoverview` +
    `?appid=730&currency=1` +
    `&market_hash_name=${encodeURIComponent(name)}`;

  const text = await steamGet(requestPath);
  if (!text) return null;

  let data;
  try { data = JSON.parse(text); } catch (e) {
    if (CONFIG.DEBUG) log(`  [Steam] JSON parse error for "${name}": ${e.message}`);
    return null;
  }

  if (!data?.success) {
    if (CONFIG.DEBUG) log(`  [Steam] success=false for "${name}": ${JSON.stringify(data)}`);
    steamConsecutiveFails++;
    return null;
  }

  const raw = data.lowest_price;
  if (!raw) return null;
  const parsed = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  if (isNaN(parsed) || parsed <= 0) return null;

  const cents = Math.round(parsed * 100);
  steamPriceCache.set(cacheKey, { cents, ts: Date.now() });
  steamConsecutiveFails = 0;
  return cents;
}

async function getSteamPrice(name) {
  if (CONFIG.PRICE_SOURCE === "steam_max_buy_order") return getSteamMaxBuyOrder(name);
  if (CONFIG.PRICE_SOURCE === "steam_min_listing")   return getSteamMinListing(name);
  return null;
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
  const W   = 115;
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
    const r       = results[i];
    const pctStr  = (r.spreadPct >= 0 ? "+" : "") + r.spreadPct.toFixed(1) + "%";
    const floatStr = (r.floatVal != null ? r.floatVal.toFixed(4) : "N/A").padStart(8);
    const emoji   = r.spreadCents >= 500 ? "✅" : r.spreadCents >= 0 ? "🟡" : "🔴";
    lines.push(
      `  ${String(i + 1).padEnd(3)}${fmt(r.spreadCents).padStart(10)}  ${pctStr.padStart(8)}  ` +
      `${fmt(r.csfloatCents).padStart(10)}${fmt(r.refCents).padStart(14)}  ${floatStr}  ${emoji} ${r.name}`
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
    `<i>Karambit + Talon  |  ${h(srcShort)}  |  ${(scanMs / 1000).toFixed(1)}s</i>\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r        = results[i];
    const emoji    = r.spreadCents >= 500 ? "✅" : r.spreadCents >= 0 ? "🟡" : "🔴";
    const sign     = r.spreadCents >= 0 ? "+" : "";
    const url      = "https://csfloat.com/item/" + r.listingId;
    const refLabel = CONFIG.PRICE_SOURCE === "csfloat_base"        ? "Base"     :
                     CONFIG.PRICE_SOURCE === "steam_max_buy_order"  ? "Steam BO" : "Steam lst";

    msg +=
      `${emoji} <b>${i + 1}. ${h(r.name)}</b>\n` +
      `   Spread: <b>${sign}${h(fmt(r.spreadCents))}</b> (${sign}${r.spreadPct.toFixed(1)}%)\n` +
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
function makeResult(listing, refCents) {
  const name         = listing.item?.market_hash_name || "";
  const csfloatCents = listing.price;
  const spreadCents  = refCents - csfloatCents;
  const spreadPct    = (spreadCents / csfloatCents) * 100;
  return {
    name,
    listingId:    listing.id,
    csfloatCents,
    refCents,
    spreadCents,
    spreadPct,
    floatVal:  listing.item?.float_value ?? null,
    wearName:  listing.item?.wear_name || "",
  };
}

async function scan() {
  if (Date.now() < csfloatBackoffUntil) {
    const secs = Math.ceil((csfloatBackoffUntil - Date.now()) / 1000);
    log(`[CSFloat] Cooling down — skipping scan (${secs}s left)`);
    return;
  }

  scanCount++;
  const scanStart = Date.now();
  log(`\n══ SCAN #${scanCount}  [${CONFIG.PRICE_SOURCE}]  ${ALL_KNIFE_NAMES.length} names ${"═".repeat(25)}`);

  const results         = [];
  let namesWithListings = 0;
  let namesEmpty        = 0;
  let totalListings     = 0;
  let steamHits         = 0;
  let steamMisses       = 0;

  // ── 1. Pre-fetch Steam prices ─────────────────────────────────────────────
  if (USE_STEAM) {
    // Vanilla knives have no Steam market listing — skip them
    const steamNames = ALL_KNIFE_NAMES.filter(
      (n) => n !== "★ Karambit"          && n !== "★ StatTrak™ Karambit" &&
             n !== "★ Talon Knife"        && n !== "★ StatTrak™ Talon Knife"
    );

    // Only fetch names not already in cache
    const toFetch = steamNames.filter((name) => {
      const key    = name + (CONFIG.PRICE_SOURCE === "steam_max_buy_order" ? ":max_buy_order" : ":min_listing");
      const cached = steamPriceCache.get(key);
      return !(cached && Date.now() - cached.ts < CONFIG.STEAM_CACHE_TTL_SECONDS * 1000);
    });

    log(`  [Steam]  Pre-fetch: ${toFetch.length} uncached / ${steamNames.length} total names`);
    log(`  [Steam]  Delay: ${CONFIG.STEAM_REQUEST_DELAY_MS}ms | TTL: ${CONFIG.STEAM_CACHE_TTL_SECONDS}s | Retries: ${CONFIG.STEAM_RETRIES}`);

    for (let i = 0; i < toFetch.length; i++) {
      const name = toFetch[i];
      const pct  = ((i / toFetch.length) * 100).toFixed(0);

      process.stdout.write(
        `  [Steam] [${pct.padStart(3)}%] ${(i + 1).toString().padStart(4)}/${toFetch.length}` +
        `  ${name.slice(0, 58).padEnd(58)} `
      );

      const refCents = await getSteamPrice(name);

      if (refCents != null) {
        process.stdout.write(`→ ${fmt(refCents)}\n`);
        steamHits++;
      } else {
        process.stdout.write("→ no data\n");
        steamMisses++;
      }
    }

    saveSteamCache();

    const cacheTotal = steamPriceCache.size;
    log(`  [Steam]  Pre-fetch done. Hits: ${steamHits}, Misses: ${steamMisses}, Cache total: ${cacheTotal}`);
  }

  // ── 2. Per-name CSFloat loop ──────────────────────────────────────────────
  for (let i = 0; i < ALL_KNIFE_NAMES.length; i++) {
    const name = ALL_KNIFE_NAMES[i];
    const pct  = ((i / ALL_KNIFE_NAMES.length) * 100).toFixed(0);

    process.stdout.write(
      `  [CSFloat] [${pct.padStart(3)}%] ${(i + 1).toString().padStart(3)}/${ALL_KNIFE_NAMES.length}` +
      `  ${name.slice(0, 58).padEnd(58)} → `
    );

    const listings = await fetchListingsForName(name);

    if (listings.length === 0) {
      process.stdout.write("—\n");
      namesEmpty++;
    } else {
      process.stdout.write(`${listings.length} listing(s)\n`);
      namesWithListings++;
      totalListings += listings.length;

      for (const listing of listings) {
        let refCents = null;

        if (!USE_STEAM) {
          refCents = getCsfloatBasePrice(listing);
        } else {
          const key    = name + (CONFIG.PRICE_SOURCE === "steam_max_buy_order" ? ":max_buy_order" : ":min_listing");
          const cached = steamPriceCache.get(key);
          if (cached) refCents = cached.cents;
        }

        if (refCents == null) continue;

        const result = makeResult(listing, refCents);
        if (CONFIG.DEBUG) {
          log(
            `    ${name.slice(0, 50).padEnd(50)}` +
            `  ask: ${fmt(result.csfloatCents).padStart(9)}` +
            `  ref: ${fmt(refCents).padStart(9)}` +
            `  spread: ${fmtSign(result.spreadCents)}`
          );
        }

        if (result.spreadCents / 100 >= CONFIG.MIN_SPREAD_USD) {
          results.push(result);
        }
      }
    }

    if (i < ALL_KNIFE_NAMES.length - 1) {
      await sleep(CONFIG.CSFLOAT_NAME_DELAY_MS);
    }
  }

  const scanMs = Date.now() - scanStart;

  log(`\n  ── Summary ──────────────────────────────────────────────`);
  log(`  Names checked:   ${ALL_KNIFE_NAMES.length}`);
  log(`  With listings:   ${namesWithListings} | Empty: ${namesEmpty}`);
  log(`  Total listings:  ${totalListings}`);
  log(`  Results:         ${results.length} with spread ≥ $${CONFIG.MIN_SPREAD_USD}`);
  log(`  Scan time:       ${(scanMs / 1000).toFixed(1)}s`);

  results.sort((a, b) => b.spreadCents - a.spreadCents);
  const top = results.slice(0, CONFIG.TOP_N);

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

  if (USE_STEAM) loadSteamCache();

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║           🗡️  KNIFE ARBITRAGE SCANNER                ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  Knives:         Karambit (${KARAMBIT_NAMES.length}) + Talon (${TALON_NAMES.length}) = ${ALL_KNIFE_NAMES.length} unique names`);
  console.log(`  Price range:    $${CONFIG.MIN_PRICE_USD} – $${CONFIG.MAX_PRICE_USD}`);
  console.log(`  Price source:   ${sourceLabel()}`);
  if (USE_STEAM) {
    console.log(`  Steam delay:    ${CONFIG.STEAM_REQUEST_DELAY_MS}ms between requests`);
    console.log(`  Steam retries:  ${CONFIG.STEAM_RETRIES} per item`);
    console.log(`  Steam TTL:      ${CONFIG.STEAM_CACHE_TTL_SECONDS}s (${(CONFIG.STEAM_CACHE_TTL_SECONDS / 3600).toFixed(1)}h)`);
    console.log(`  Steam fail gate:${CONFIG.STEAM_FAIL_THRESHOLD} consecutive fails → ${CONFIG.STEAM_BACKOFF_MS / 1000}s pause`);
    console.log(`  Steam cache:    ${CONFIG.STEAM_CACHE_FILE}`);
  } else {
    console.log(`  Steam:          skipped (using CSFloat base price)`);
  }
  console.log(`  Listings/name:  ${CONFIG.LISTINGS_PER_NAME}`);
  console.log(`  Name delay:     ${CONFIG.CSFLOAT_NAME_DELAY_MS / 1000}s`);
  console.log(`  Est. scan time: ~${((ALL_KNIFE_NAMES.length * CONFIG.CSFLOAT_NAME_DELAY_MS) / 60000).toFixed(0)} min`);
  console.log(`  Top N:          ${CONFIG.TOP_N}`);
  console.log(`  Min spread:     $${CONFIG.MIN_SPREAD_USD}`);
  console.log(`  Poll interval:  ${CONFIG.POLL_INTERVAL_SECONDS > 0 ? CONFIG.POLL_INTERVAL_SECONDS + "s" : "single run"}`);
  console.log(`  Telegram:       ${CONFIG.TELEGRAM_BOT_TOKEN ? "active (chat " + CONFIG.TELEGRAM_CHAT_ID + ")" : "disabled"}`);
  console.log("");

  await scan();

  if (CONFIG.POLL_INTERVAL_SECONDS > 0) {
    log(`\n  Polling every ${CONFIG.POLL_INTERVAL_SECONDS}s. Ctrl+C to stop.`);
    setInterval(scan, CONFIG.POLL_INTERVAL_SECONDS * 1000);
  } else {
    if (USE_STEAM) saveSteamCache();
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
  if (USE_STEAM) saveSteamCache();
  console.error("[CRASH] uncaughtException:", err);
  sendTelegram(buildCrashMsg(err, "uncaughtException")).catch(() => {}).finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  if (USE_STEAM) saveSteamCache();
  console.error("[CRASH] unhandledRejection:", reason);
  sendTelegram(buildCrashMsg(reason, "unhandledRejection")).catch(() => {}).finally(() => process.exit(1));
});

process.on("SIGINT", () => {
  log("\n  Interrupted — saving Steam cache...");
  if (USE_STEAM) saveSteamCache();
  process.exit(0);
});

main();