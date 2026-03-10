#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "..");
const GAMES_DIR = path.join(ROOT, "games");

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
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

function main() {
  if (!fs.existsSync(GAMES_DIR)) {
    console.error("games/ directory not found");
    process.exit(1);
  }

  const games = [];
  const entries = fs.readdirSync(GAMES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const gameId = entry.name;
    const metaPath = path.join(GAMES_DIR, gameId, "meta.json");
    if (!fs.existsSync(metaPath)) continue;

    const meta = readJson(metaPath);
    const metaId = meta.id || gameId;
    if (metaId !== gameId) {
      console.error(`meta.json id mismatch in ${gameId}`);
      process.exit(1);
    }

    const ctFiles = findCtFiles(path.join(GAMES_DIR, gameId));
    const tables = Array.isArray(meta.tables) ? meta.tables : [];
    const known = new Set(tables.map((t) => t.path).filter(Boolean));
    for (const file of ctFiles) {
      if (!known.has(file)) {
        tables.push({ path: file });
      }
    }
    meta.tables = tables;
    writeJson(metaPath, meta);

    games.push({
      id: metaId,
      title: meta.title || metaId,
      executables: meta.executables || [],
      steam_appid: meta.steam_appid || "",
      meta_path: `games/${gameId}/meta.json`,
    });
  }

  writeJson(path.join(ROOT, "index.json"), { games });
}

main();
