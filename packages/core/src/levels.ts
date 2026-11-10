import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseLevel } from "./level.ts";
import type { GameState } from "./types.ts";

/** Folder produced by tools/extract_levels.py (gitignored — game content stays local). */
export const DEFAULT_LEVELS_DIR = resolve(process.env.JEV_LEVELS_DIR ?? "levels");

export interface LevelMeta {
  levelIndex: number;
  isHard: boolean;
  isSuperHard: boolean;
  levelDuration: number;
}

export function hasLevels(dir = DEFAULT_LEVELS_DIR): boolean {
  return existsSync(dir) && readdirSync(dir).some((f) => /level-\d+\.txt$/.test(f));
}

/** Level numbers available for `prefix`, ascending. */
export function listLevels(dir = DEFAULT_LEVELS_DIR, prefix = "t249"): number[] {
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${prefix}-level-(\\d+)\\.txt$`);
  return readdirSync(dir).map((f) => re.exec(f)?.[1]).filter((n): n is string => !!n).map(Number).sort((a, b) => a - b);
}

/** Level file prefix: the game ships two sets (t249-*, t160-*); t249 is the one LevelsConfig indexes. */
export function loadLevel(n: number, dir = DEFAULT_LEVELS_DIR, prefix = "t249"): GameState {
  const file = join(dir, `${prefix}-level-${n}.txt`);
  if (!existsSync(file)) throw new Error(`Level file not found: ${file} (run: npm run levels -- <path-to-apk>)`);
  return parseLevel(readFileSync(file, "utf8"), { levelId: `${prefix}-level-${n}`, levelIndex: n });
}

export function loadLevelMeta(dir = DEFAULT_LEVELS_DIR): Map<number, LevelMeta> {
  const file = join(dir, "LevelsConfig.txt");
  const out = new Map<number, LevelMeta>();
  if (!existsSync(file)) return out;
  const raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { levelConfigModels: LevelMeta[] };
  for (const m of raw.levelConfigModels) out.set(m.levelIndex, m);
  return out;
}
