import { parentPort, workerData } from "node:worker_threads";
import { solve, type GameState, type SolveResult } from "@jev-block-out/core";

/** Runs the solver off the server's event loop (so the live video keeps flowing), trying each stage in turn. */
const { state, stages } = workerData as { state: GameState; stages: { weight: number; maxNodes: number }[] };
let r: SolveResult = { solved: false, moves: [], expanded: 0, reason: "no stages", ms: 0 };
for (const st of stages) {
  r = solve(state, st);
  if (r.solved || r.reason !== "node limit") break;
}
parentPort!.postMessage(r);
