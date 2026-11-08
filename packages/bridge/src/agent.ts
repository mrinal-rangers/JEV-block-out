import {
  applyMove, COLOR_CHAR, describeMove, legalMoves, moveId, renderAscii, solve,
  type GameState, type Move,
} from "@jev-block-out/core";
import type { Decider, Decision, DecisionRequest } from "./jev.ts";

/** Position identity used for loop detection (block positions/colours + how many have exited). */
export const stateKey = (s: GameState) =>
  s.blocks.map((b) => `${b.id}:${b.color}:${b.cells[0]!.x},${b.cells[0]!.y}`).join("|") + `#${s.exited.length}`;

export interface AgentConfig {
  /** Below this, the agent re-asks Jev with only the top-k options. */
  lowConfidence: number;
  /** Size of the re-ask shortlist. */
  topK: number;
  /** If the re-ask is still below this, consult the solver (when allowed). */
  fallbackConfidence: number;
  /** Let the solver override low-confidence picks. */
  solverFallback: boolean;
  /** Node budget for the solver fallback. */
  solverNodes: number;
  /** Jev Choice questions accept at most 255 options. */
  maxOptions: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  lowConfidence: 0.35,
  topK: 5,
  fallbackConfidence: 0.35,
  solverFallback: true,
  solverNodes: 20_000,
  maxOptions: 255,
};

export type Route = "forced" | "confident" | "reask" | "solver-fallback" | "low-confidence-accept";

export interface TurnResult {
  move: Move;
  moveId: string;
  description: string;
  route: Route;
  options: Record<string, string>;
  decisions: Decision[];
}

/** Compact, model-friendly description of the position. */
export function stateView(s: GameState): Record<string, unknown> {
  const legend = Object.fromEntries(Object.entries(COLOR_CHAR).map(([c, ch]) => [ch, c]));
  return {
    level: s.levelIndex ?? s.levelId,
    board_ascii: renderAscii(s),
    legend: { "#": "wall", ".": "empty floor", "=": "frozen door", uppercase: "block colour", lowercase: "door colour", ...legend },
    blocks: s.blocks.map((b) => ({
      id: b.id, color: b.color, cells: b.cells.map((c) => [c.x, c.y]),
      ...(b.ice ? { ice: b.ice } : {}), ...(b.layers.length ? { inner_layers: b.layers } : {}),
      ...(b.axis !== "both" ? { moves_only: b.axis } : {}),
    })),
    doors: s.doors.map((d) => ({ id: d.id, color: d.color, edge: d.side, cells: d.cells.map((c) => [c.x, c.y]), ...(d.ice ? { ice: d.ice } : {}) })),
    blocks_exited: s.exited.length,
    moves_made: s.moveCount,
    coordinates: "x grows to the right, y grows upward",
  };
}

export function buildRequest(s: GameState, moves: Move[]): DecisionRequest {
  const options: Record<string, string> = {};
  const byId: Record<string, Move> = {};
  for (const m of moves) {
    const id = moveId(m);
    options[id] = describeMove(s, m);
    byId[id] = m;
  }
  return { state: s, view: stateView(s), options, moves: byId };
}

function topK(probs: Record<string, number>, k: number): string[] {
  return Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
}

/**
 * One turn: ask Jev, route on calibrated confidence, and enforce legality in code.
 *   confidence ≥ lowConfidence           → take Jev's choice
 *   else re-ask with Jev's top-k options → take it if ≥ fallbackConfidence
 *   else solver lookahead (if enabled and it finds a plan) → take the plan's first move
 *   else take Jev's best re-ask answer anyway.
 * `avoid` holds keys of positions already visited this run: moves that lead back to one are not offered
 * (unless every legal move does), which stops memoryless deciders from sliding a block back and forth.
 */
export async function decideTurn(
  s: GameState,
  decider: Decider,
  cfg: AgentConfig = DEFAULT_AGENT_CONFIG,
  avoid?: { has(key: string): boolean },
): Promise<TurnResult | null> {
  let moves = legalMoves(s, { limit: cfg.maxOptions });
  if (moves.length === 0) return null;
  if (avoid) {
    const fresh = moves.filter((m) => !avoid.has(stateKey(applyMove(s, m))));
    if (fresh.length > 0) moves = fresh;
  }
  const req = buildRequest(s, moves);
  const finish = (id: string, route: Route, decisions: Decision[]): TurnResult => {
    const move = req.moves[id];
    if (!move) throw new Error(`Decider chose ${id}, which is not a legal option`);
    return { move, moveId: id, description: req.options[id]!, route, options: req.options, decisions };
  };

  if (moves.length === 1) return finish(Object.keys(req.moves)[0]!, "forced", []);

  const first = await decider.decide(req);
  const decisions = [first];
  if (!(first.choice in req.moves)) throw new Error(`Decider returned unknown option ${first.choice}`);
  if (first.confidence >= cfg.lowConfidence) return finish(first.choice, "confident", decisions);

  const shortlist = topK(first.probabilities, cfg.topK);
  const sub: DecisionRequest = {
    ...req,
    options: Object.fromEntries(shortlist.map((id) => [id, req.options[id]!])),
    moves: Object.fromEntries(shortlist.map((id) => [id, req.moves[id]!])),
  };
  const second = await decider.decide(sub);
  decisions.push(second);
  const pick = second.choice in sub.moves ? second.choice : first.choice;
  if (second.confidence >= cfg.fallbackConfidence) return finish(pick, "reask", decisions);

  if (cfg.solverFallback) {
    const plan = solve(s, { maxNodes: cfg.solverNodes, weight: 1 });
    if (plan.solved && plan.moves.length) {
      const m = plan.moves[0]!;
      const id = moveId(m);
      if (!(id in req.moves)) {
        // The solver's move can fall outside the 255-option cap; it is still legal (replayed through the engine).
        req.moves[id] = m;
        req.options[id] = describeMove(s, m);
      }
      return finish(id, "solver-fallback", decisions);
    }
  }
  return finish(pick, "low-confidence-accept", decisions);
}
