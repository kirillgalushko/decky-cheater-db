#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "..");
const GAMES_DIR = path.join(ROOT, "games");
const STEAM_APPS_JSON = process.env.STEAM_APPS_JSON;
const LOG_LEVEL = "info";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function log(level, msg, ...args) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  if (level === "error") console.error(line, ...args);
  else if (level === "warn") console.warn(line, ...args);
  else console.log(line, ...args);
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function withRomanVariants(name) {
  const variants = new Set([name]);
  const romanMap = {
    "1": "I",
    "2": "II",
    "3": "III",
    "4": "IV",
    "5": "V",
    "6": "VI",
    "7": "VII",
    "8": "VIII",
    "9": "IX",
    "10": "X",
  };
  for (const [arabic, roman] of Object.entries(romanMap)) {
    variants.add(name.replace(new RegExp(`\\b${arabic}\\b`, "g"), roman));
    variants.add(name.replace(new RegExp(`\\b${roman}\\b`, "gi"), arabic));
  }
  return [...variants];
}

function findSteamAppId(title, apps) {
  if (!apps) return null;
  const needle = normalizeTitle(title);
  for (const app of apps) {
    const name = normalizeTitle(app.name || "");
    if (name === needle) return String(app.appid);
  }
  return null;
}

async function steamSearch(term) {
  const key = normalizeTitle(term);
  const params = new URLSearchParams({
    term,
    l: "english",
    cc: "us",
    category1: "998",
    supportedlang: "english",
  });
  const url = `https://store.steampowered.com/api/storesearch/?${params.toString()}`;
  const res = await fetch(url, { headers: { "User-Agent": "decky-cheater-db/1.0" } });
  if (!res.ok) {
    throw new Error(`Steam search failed: ${res.status}`);
  }
  const data = await res.json();
  return data;
}

function pickBestSteamMatch(term, results) {
  const needle = normalizeTitle(term);
  const needleTokens = new Set(needle.split(" ").filter(Boolean));
  let best = null;
  let bestScore = -1;
  for (const item of results || []) {
    const name = normalizeTitle(item.name || "");
    if (!name) continue;
    const nameTokens = new Set(name.split(" ").filter(Boolean));
    const common = [...needleTokens].filter((t) => nameTokens.has(t)).length;
    const overlap = needleTokens.size ? common / needleTokens.size : 0;
    let score = 0;
    if (name === needle) score = 100;
    else if (name.includes(needle)) score = 85;
    else if (needle.includes(name)) score = 70;
    else score = Math.round(overlap * 60);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return { best, bestScore };
}

async function googleFallbackSearch(term) {
  const q = encodeURIComponent(`site:store.steampowered.com/app ${term}`);
  const url = `https://r.jina.ai/http://r.jina.ai/http://www.google.com/search?q=${q}`;
  const res = await fetch(url, { headers: { "User-Agent": "decky-cheater-db/1.0" } });
  if (!res.ok) {
    throw new Error(`Google fallback failed: ${res.status}`);
  }
  const text = await res.text();
  const ids = new Set();
  const re = /store\.steampowered\.com\/app\/(\d+)\//g;
  let m;
  while ((m = re.exec(text))) {
    ids.add(m[1]);
  }
  return [...ids];
}

async function fetchAppDetails(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}`;
  const res = await fetch(url, { headers: { "User-Agent": "decky-cheater-db/1.0" } });
  if (!res.ok) return null;
  const data = await res.json();
  const entry = data?.[appid];
  if (!entry?.success) return null;
  return entry.data;
}

function findCtFiles(gameDir) {
  const files = fs.readdirSync(gameDir, { withFileTypes: true });
  const out = [];
  for (const f of files) {
    if (!f.isFile()) continue;
    if (f.name.toLowerCase().endsWith(".ct")) {
      out.push(f.name);
    }
  }
  return out;
}

function buildCandidates(fallbackTitle, ctFiles) {
  const base = [fallbackTitle, ...ctFiles.map((f) => f.replace(/\.[^.]+$/, ""))];
  return [...new Set(base.flatMap(withRomanVariants))];
}

async function trySteamSearch(candidates) {
  for (const candidate of candidates) {
    try {
      log("info", "Steam search: %s", candidate);
      const data = await steamSearch(candidate);
      const { best, bestScore } = pickBestSteamMatch(candidate, data.items || []);
      if (best) {
        log("info", "Steam best match for \"%s\": %s (score=%d)", candidate, best.name, bestScore);
      }
      if (best && bestScore >= 50) {
        return String(best.id);
      }
    } catch (e) {
      log("warn", 'Steam search failed for "%s": %s', candidate, e.message);
    }
  }
  return null;
}

async function tryGoogleFallback(candidates) {
  for (const candidate of candidates) {
    try {
      log("debug", "Google fallback search: %s", candidate);
      const ids = await googleFallbackSearch(candidate);
      let bestId = null;
      let bestScore = -1;
      for (const id of ids.slice(0, 5)) {
        const details = await fetchAppDetails(id);
        if (!details?.name) continue;
        const { bestScore: score } = pickBestSteamMatch(candidate, [{ name: details.name, id }]);
        if (score > bestScore) {
          bestScore = score;
          bestId = id;
        }
      }
      if (bestId && bestScore >= 50) {
        return String(bestId);
      }
    } catch (e) {
      log("warn", 'Google fallback failed for "%s": %s', candidate, e.message);
    }
  }
  return null;
}

async function resolveSteamAppId(fallbackTitle, ctFiles, steamApps) {
  const direct = findSteamAppId(fallbackTitle, steamApps);
  if (direct) return direct;
  const candidates = buildCandidates(fallbackTitle, ctFiles);
  const bySteam = await trySteamSearch(candidates);
  if (bySteam) return bySteam;
  const byGoogle = await tryGoogleFallback(candidates);
  return byGoogle;
}

function loadOrCreateMeta(gameId, gameDir, steamApps) {
  const metaPath = path.join(gameDir, "meta.json");
  if (fs.existsSync(metaPath)) {
    log("debug", "meta.json found for %s", gameId);
    return { meta: readJson(metaPath), created: false };
  }
  const ctFiles = findCtFiles(gameDir);
  const fallbackTitle = gameId.replace(/[-_]/g, " ").trim();
  return { metaPath, ctFiles, fallbackTitle, created: true };
}

async function ensureMeta(gameId, gameDir, steamApps) {
  const existing = loadOrCreateMeta(gameId, gameDir, steamApps);
  if (!existing.created) {
    return { meta: existing.meta, metaPath: path.join(gameDir, "meta.json") };
  }
  const { ctFiles, fallbackTitle, metaPath } = existing;
  log("info", "Creating meta.json for %s (ct files: %d)", gameId, ctFiles.length);
  const steamAppId = await resolveSteamAppId(fallbackTitle, ctFiles, steamApps);
  const meta = {
    id: gameId,
    title: fallbackTitle || gameId,
    executables: [],
    steam_appid: steamAppId || "",
    exe_hashes: [],
    tables: ctFiles.map((f) => ({ path: f })),
  };
  writeJson(metaPath, meta);
  if (!steamAppId) {
    log("warn", 'Steam app not found for "%s". Created default meta.json in %s', fallbackTitle, gameId);
  }
  return { meta, metaPath };
}

function updateTables(gameDir, meta, metaPath, gameId) {
  const ctFiles = findCtFiles(gameDir);
  const tables = Array.isArray(meta.tables) ? meta.tables : [];
  const known = new Set(tables.map((t) => t.path).filter(Boolean));
  for (const file of ctFiles) {
    if (!known.has(file)) {
      tables.push({ path: file });
    }
  }
  meta.tables = tables;
  writeJson(metaPath, meta);
  log("info", "Updated meta.json for %s (tables: %d)", gameId, tables.length);
}

async function main() {
  if (!fs.existsSync(GAMES_DIR)) {
    log("error", "games/ directory not found");
    process.exit(1);
  }

  let steamApps = null;
  if (STEAM_APPS_JSON && fs.existsSync(STEAM_APPS_JSON)) {
    try {
      steamApps = readJson(STEAM_APPS_JSON);
    } catch (e) {
      log("warn", "Failed to read STEAM_APPS_JSON: %s", e.message);
    }
  }
  const games = [];
  const entries = fs.readdirSync(GAMES_DIR, { withFileTypes: true });
  log("info", "Scanning games directory (%d entries)", entries.length);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const gameId = entry.name;
    const gameDir = path.join(GAMES_DIR, gameId);
    const { meta, metaPath } = await ensureMeta(gameId, gameDir, steamApps);

    const metaId = meta.id || gameId;
    if (metaId !== gameId) {
      log("error", "meta.json id mismatch in %s", gameId);
      process.exit(1);
    }

    updateTables(gameDir, meta, metaPath, gameId);

    games.push({
      id: metaId,
      title: meta.title || metaId,
      executables: meta.executables || [],
      steam_appid: meta.steam_appid || "",
      meta_path: `games/${gameId}/meta.json`,
    });
  }

  writeJson(path.join(ROOT, "index.json"), { games });
  log("info", "Wrote index.json (%d games)", games.length);
}

main().catch((err) => {
  log("error", String(err));
  process.exit(1);
});
