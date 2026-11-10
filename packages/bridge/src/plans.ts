import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { applyMove, solve, type GameState, type Move, type SolveResult } from "@jev-block-out/core";

/** Position identity used for loop detection and plan lookup (block positions/colours + how many have exited). */
export const stateKey = (s: GameState) =>
  s.blocks.map((b) => `${b.id}:${b.color}:${b.cells[0]!.x},${b.cells[0]!.y}`).join("|") + `#${s.exited.length}`;

export interface SolveStage { weight: number; maxNodes: number }

/**
 * Exact-ish search first (short plans, usually milliseconds); if that hits its node budget, a greedier weight finds
 * a longer plan for the hard levels (level 7 needs ~125k nodes at weight 5, ~25 s).
 */
export const PLAN_STAGES: SolveStage[] = [{ weight: 1, maxNodes: 20_000 }, { weight: 5, maxNodes: 400_000 }, { weight: 2, maxNodes: 400_000 }];

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "plans");
const known = new Map<string, Move[]>();
const pending = new Map<string, Promise<Move[] | null>>();
/** Positions (with the stages tried) the solver already gave up on, so polling doesn't re-run long searches. */
const failed = new Set<string>();

/** The plan from `s` if one is already known (from this process or the on-disk cache), without solving. */
export function knownPlan(s: GameState): Move[] | null {
  const k = stateKey(s);
  const hit = known.get(k);
  if (hit) return hit;
  const saved = readSaved(s);
  if (saved && saved.key === k) return remember(s, saved.moves);
  return null;
}

/**
 * A winning move sequence from `s`, or null if the solver gives up. Plans are solved once in a worker thread and
 * remembered for every position along them, so following a plan costs nothing per turn; level-start plans are also
 * saved under packages/bridge/.cache/plans so the next run starts instantly.
 */
export function planFor(s: GameState, stages: SolveStage[] = PLAN_STAGES): Promise<Move[] | null> {
  const hit = knownPlan(s);
  if (hit) return Promise.resolve(hit);
  const k = stateKey(s);
  const attempt = `${k}@${JSON.stringify(stages)}`;
  if (failed.has(attempt)) return Promise.resolve(null);
  let p = pending.get(k);
  if (!p) {
    p = solveOffThread(s, stages)
      .then((r) => {
        if (!r.solved) {
          if (failed.size > 10_000) failed.clear();
          failed.add(attempt);
          return null;
        }
        if (s.moveCount === 0) save(s, k, r.moves);
        return remember(s, r.moves);
      })
      .finally(() => pending.delete(k));
    pending.set(k, p);
  }
  return p;
}

function remember(s: GameState, moves: Move[]): Move[] {
  if (known.size > 50_000) known.clear();
  let cur = s;
  for (let i = 0; i < moves.length; i++) {
    known.set(stateKey(cur), moves.slice(i));
    cur = applyMove(cur, moves[i]!);
  }
  return moves;
}

function solveOffThread(s: GameState, stages: SolveStage[]): Promise<SolveResult> {
  const inline = () => {
    let r: SolveResult = { solved: false, moves: [], expanded: 0, reason: "no stages", ms: 0 };
    for (const st of stages) {
      r = solve(s, st);
      if (r.solved || r.reason !== "node limit") break;
    }
    return r;
  };
  return new Promise((done) => {
    let w: Worker;
    try {
      w = new Worker(new URL("./solve-worker.ts", import.meta.url), { workerData: { state: s, stages } });
    } catch {
      return done(inline());
    }
    let settled = false;
    w.once("message", (r: SolveResult) => { settled = true; done(r); void w.terminate(); });
    w.once("error", () => { if (!settled) { settled = true; done(inline()); } });
    w.once("exit", () => { if (!settled) { settled = true; done(inline()); } });
  });
}

const file = (s: GameState) => resolve(DIR, `${String(s.levelId).replace(/[^\w.-]/g, "_")}.json`);

function readSaved(s: GameState): { key: string; moves: Move[] } | null {
  if (s.moveCount !== 0 || !s.levelId) return null;
  try { return JSON.parse(readFileSync(file(s), "utf8")); } catch { return null; }
}

function save(s: GameState, key: string, moves: Move[]) {
  if (!s.levelId) return;
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file(s), JSON.stringify({ key, moves }));
  } catch { /* the cache is only an optimisation */ }
}
