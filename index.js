require("dotenv").config();

const { Pool } = require("undici");

// ─────────────────────────────────────────────────────────────────────────────
//  STATIC KNIFE NAME LIST
//  Generates every combination of (knife type) × (skin) × (wear) × (stattrak?)
//  for Karambit and Talon Knife.
//  CSFloat will simply return 0 listings for combinations that don't exist
//  in-game — no error handling needed.
// ─────────────────────────────────────────────────────────────────────────────

const WEARS = [
  "Factory New",
  "Minimal Wear",
  "Field-Tested",
  "Well-Worn",
  "Battle-Scarred",
];

// Skins that only come in specific wears.
// If a skin isn't listed here it gets all 5 wears.
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

// All skins available on both Karambit and Talon Knife.
const SHARED_SKINS = [
  "Doppler",
  "Gamma Doppler",
  "Marble Fade",
  "Tiger Tooth",
  "Fade",
  "Slaughter",
  "Crimson Web",
  "Case Hardened",
  "Black Laminate",
  "Autotronic",
  "Freehand",
  "Bright Water",
  "Ultraviolet",
  "Night",
  "Blue Steel",
  "Stained",
  "Damascus Steel",
  "Urban Masked",
  "Scorched",
  "Forest DDPAT",
  "Boreal Forest",
  "Rust Coat",
];

// Skins exclusive to Karambit (added before Talon existed)
const KARAMBIT_ONLY_SKINS = [
  "Lore",
];

function buildNames(knifeBase, skins) {
  const names = [];

  // Vanilla — no skin suffix, no wear
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

const KARAMBIT_NAMES = buildNames("Karambit", [...SHARED_SKINS, ...KARAMBIT_ONLY_SKINS]);
const TALON_NAMES    = buildNames("Talon Knife", SHARED_SKINS);

// Master list — deduplicated, alphabetically sorted for predictable scan order
const ALL_KNIFE_NAMES = [...new Set([...KARAMBIT_NAMES, ...TALON_NAMES])].sort();

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  CSFLOAT_API_KEY: process.env.CSFLOAT_API_KEY,

  MIN_PRICE_USD: parseFloat(process.env.MIN_PRICE_USD) || 50,
  MAX_PRICE_USD: parseFloat(process.env.MAX_PRICE_USD) || 5000,

  // "csfloat_base"       → use listing.reference.base_price from CSFloat payload
  // "steam_max_buy_order"→ Steam histogram highest_buy_order
  // "steam_min_listing"  → Steam priceoverview lowest_price
  PRICE_SOURCE: (process.env.PRICE_SOURCE || "csfloat_base").trim(),

  TOP_N: Math.min(50, Math.max(1, parseInt(process.env.TOP_N) || 10)),

  // How many listings to fetch per knife name (max 50 per CSFloat page).
  LISTINGS_PER_NAME: Math.min(50, Math.max(1, parseInt(process.env.LISTINGS_PER_NAME) || 10)),

  // Minimum profit (USD) to include a listing in results.
  MIN_SPREAD_USD: parseFloat(process.env.MIN_SPREAD_USD) || 0,

  // 0 = run once and exit. Set to e.g. 300 to rescan every 5 minutes.
  POLL_INTERVAL_SECONDS: parseInt(process.env.POLL_INTERVAL_SECONDS) || 0,

  // Delay between each per-name CSFloat request (API enforces ~20s)
  CSFLOAT_NAME_DELAY_MS: Math.max(20000, parseInt(process.env.CSFLOAT_NAME_DELAY_MS) || 20000),

  STEAM_REQUEST_DELAY_MS:  Math.max(500,  parseInt(process.env.STEAM_REQUEST_DELAY_MS)  || 1500),
  STEAM_CACHE_TTL_SECONDS: Math.max(60,   parseInt(process.env.STEAM_CACHE_TTL_SECONDS) || 600),

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
//  FETCH LISTINGS FOR A SPECIFIC MARKET HASH NAME
//
//  Queries CSFloat for buy-now listings of an exact skin name.
//  Returns the cheapest N listings sorted by price ascending.
//  If CSFloat returns nothing (skin doesn't exist or no listings), returns [].
// ─────────────────────────────────────────────────────────────────────────────
async function fetchListingsForName(marketHashName) {
  const params = new URLSearchParams({
    market_hash_name: marketHashName,
    type:             "buy_now",
    sort_by:          "lowest_price",
    min_price:        String(MIN_PRICE_CENTS),
    max_price:        String(MAX_PRICE_CENTS),
    limit:            String(CONFIG.LISTINGS_PER_NAME),
  });

  let data;
  try {
    data = await csfloatRequest("/api/v1/listings?" + params.toString());
  } catch (err) {
    log(`  [CSFloat] Error fetching "${marketHashName}": ${err.message}`);
    return [];
  }

  if (!data) return []; // rate-limited, backoff already applied

  const listings = Array.isArray(data) ? data : (data.data || []);
  return listings.filter((l) => l.type === "buy_now");
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
    `<i>Karambit + Talon  |  ${h(srcShort)}  |  ${(scanMs / 1000).toFixed(1)}s</i>\n\n`;

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
//  PROCESS ONE LISTING → RESULT OBJECT
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
    floatVal:     listing.item?.float_value ?? null,
    wearName:     listing.item?.wear_name || "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN SCAN
//
//  Iterates over every knife name in ALL_KNIFE_NAMES.
//  For each name:
//    1. Fetch cheapest N listings from CSFloat
//    2. Resolve the reference price (CSFloat base or Steam)
//    3. Compute spread and collect qualifying results
//    4. Wait CSFLOAT_NAME_DELAY_MS before the next name
//
//  Total scan time ≈ ALL_KNIFE_NAMES.length × 20s
//  (~196 names × 20s ≈ 65 minutes for a full scan)
//  Set POLL_INTERVAL_SECONDS accordingly (e.g. 3600 to re-scan hourly).
// ─────────────────────────────────────────────────────────────────────────────
async function scan() {
  if (Date.now() < csfloatBackoffUntil) {
    const secs = Math.ceil((csfloatBackoffUntil - Date.now()) / 1000);
    log(`[CSFloat] Cooling down — skipping scan (${secs}s left)`);
    return;
  }

  scanCount++;
  const scanStart = Date.now();
  log(`\n══ SCAN #${scanCount}  [${CONFIG.PRICE_SOURCE}]  ${ALL_KNIFE_NAMES.length} names to check ${"═".repeat(20)}`);

  const results = [];
  let namesWithListings = 0;
  let namesEmpty        = 0;
  let totalListings     = 0;

  // ── Pre-fetch Steam prices if needed (batch before the CSFloat loop) ────────
  // We know all names upfront so we can warm the Steam cache in advance.
  // This avoids interleaving slow Steam calls inside the already-slow CSFloat loop.
  if (USE_STEAM) {
    const uniqueNames = ALL_KNIFE_NAMES.filter((n) => !n.endsWith("Karambit") && !n.endsWith("Talon Knife")); // vanilla has no steam listing usually
    log(`  [Steam]  Pre-fetching ${sourceLabel()} for ${uniqueNames.length} names...`);
    log(`  [Steam]  Delay: ${CONFIG.STEAM_REQUEST_DELAY_MS}ms | Cache TTL: ${CONFIG.STEAM_CACHE_TTL_SECONDS}s`);

    for (let i = 0; i < uniqueNames.length; i++) {
      const name = uniqueNames[i];
      const pct  = ((i / uniqueNames.length) * 100).toFixed(0);
      process.stdout.write(
        `  [Steam] [${pct.padStart(3)}%] ${(i + 1)}/${uniqueNames.length} — ${name.slice(0, 55).padEnd(55)} `
      );
      const refCents = await getSteamPrice(name);
      process.stdout.write(refCents != null ? `→ ${fmt(refCents)}\n` : "→ no data\n");
    }

    log(`  [Steam]  Pre-fetch complete. Cache has ${steamPriceCache.size} entries.`);
  }

  // ── Per-name CSFloat loop ──────────────────────────────────────────────────
  for (let i = 0; i < ALL_KNIFE_NAMES.length; i++) {
    const name = ALL_KNIFE_NAMES[i];
    const pct  = ((i / ALL_KNIFE_NAMES.length) * 100).toFixed(0);

    process.stdout.write(
      `  [CSFloat] [${pct.padStart(3)}%] ${(i + 1).toString().padStart(3)}/${ALL_KNIFE_NAMES.length} ` +
      `${name.slice(0, 60).padEnd(60)} → `
    );

    const listings = await fetchListingsForName(name);

    if (listings.length === 0) {
      process.stdout.write("no listings\n");
      namesEmpty++;
    } else {
      process.stdout.write(`${listings.length} listing(s)`);
      namesWithListings++;
      totalListings += listings.length;

      for (const listing of listings) {
        let refCents = null;

        if (!USE_STEAM) {
          refCents = getCsfloatBasePrice(listing);
        } else {
          // Use cached Steam price (warm-fetched above)
          const key =
            name + (CONFIG.PRICE_SOURCE === "steam_max_buy_order" ? ":max_buy_order" : ":min_listing");
          const cached = steamPriceCache.get(key);
          if (cached) refCents = cached.cents;
        }

        if (refCents == null) {
          if (CONFIG.DEBUG) process.stdout.write(" [no ref]");
          continue;
        }

        const result = makeResult(listing, refCents);

        if (CONFIG.DEBUG) {
          process.stdout.write(
            `\n    ask: ${fmt(result.csfloatCents).padStart(9)}  ref: ${fmt(refCents).padStart(9)}  spread: ${fmtSign(result.spreadCents)}`
          );
        }

        if (result.spreadCents / 100 >= CONFIG.MIN_SPREAD_USD) {
          results.push(result);
        }
      }

      process.stdout.write("\n");
    }

    // Wait between CSFloat requests (except after the last one)
    if (i < ALL_KNIFE_NAMES.length - 1) {
      await sleep(CONFIG.CSFLOAT_NAME_DELAY_MS);
    }
  }

  const scanMs = Date.now() - scanStart;

  log(`\n  ── Summary ──────────────────────────────────────────────`);
  log(`  Names checked:     ${ALL_KNIFE_NAMES.length}`);
  log(`  Names with data:   ${namesWithListings}`);
  log(`  Names empty:       ${namesEmpty}`);
  log(`  Total listings:    ${totalListings}`);
  log(`  Results (spread ≥ $${CONFIG.MIN_SPREAD_USD}): ${results.length}`);
  log(`  Scan time:         ${(scanMs / 1000).toFixed(1)}s`);

  // ── Sort and trim ──────────────────────────────────────────────────────────
  results.sort((a, b) => b.spreadCents - a.spreadCents);
  const top = results.slice(0, CONFIG.TOP_N);

  // ── Output ────────────────────────────────────────────────────────────────
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

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║           🗡️  KNIFE ARBITRAGE SCANNER                ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`  Knives:        Karambit (${KARAMBIT_NAMES.length} names) + Talon (${TALON_NAMES.length} names)`);
  console.log(`  Total names:   ${ALL_KNIFE_NAMES.length} unique market_hash_names`);
  console.log(`  Price range:   $${CONFIG.MIN_PRICE_USD} – $${CONFIG.MAX_PRICE_USD}`);
  console.log(`  Price source:  ${sourceLabel()}`);
  if (USE_STEAM) {
    console.log(`  Steam delay:   ${CONFIG.STEAM_REQUEST_DELAY_MS}ms between requests`);
    console.log(`  Steam TTL:     ${CONFIG.STEAM_CACHE_TTL_SECONDS}s`);
  } else {
    console.log(`  Steam:         skipped (using CSFloat base price)`);
  }
  console.log(`  Listings/name: ${CONFIG.LISTINGS_PER_NAME}`);
  console.log(`  Name delay:    ${CONFIG.CSFLOAT_NAME_DELAY_MS / 1000}s (CSFloat rate limit)`);
  console.log(`  Est. scan:     ~${((ALL_KNIFE_NAMES.length * CONFIG.CSFLOAT_NAME_DELAY_MS) / 60000).toFixed(0)} min per full scan`);
  console.log(`  Top N:         ${CONFIG.TOP_N}`);
  console.log(`  Min spread:    $${CONFIG.MIN_SPREAD_USD}`);
  console.log(`  Poll interval: ${CONFIG.POLL_INTERVAL_SECONDS > 0 ? CONFIG.POLL_INTERVAL_SECONDS + "s" : "single run"}`);
  console.log(`  Telegram:      ${CONFIG.TELEGRAM_BOT_TOKEN ? "active (chat " + CONFIG.TELEGRAM_CHAT_ID + ")" : "disabled"}`);
  console.log("");

  // Print the full name list so the user can verify what will be scanned
  if (CONFIG.DEBUG) {
    console.log("  ── Names to scan ─────────────────────────────────────────────────────");
    ALL_KNIFE_NAMES.forEach((n, i) => console.log(`  ${String(i + 1).padStart(3)}. ${n}`));
    console.log("");
  }

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