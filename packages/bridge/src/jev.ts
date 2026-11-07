import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { applyMove, evaluate, moveId, obstruction, solve, type GameState, type Move } from "@jev-block-out/core";

/** One Jev System One round-trip for a turn: Choice (next move) + Score (progress) + Noul (dead end). */
export interface DecisionRequest {
  state: GameState;
  /** Compact JSON view of the board sent to the model. */
  view: Record<string, unknown>;
  /** option id → human description; ids are stable move ids. */
  options: Record<string, string>;
  /** Legal moves keyed by the same ids (never sent to the model). */
  moves: Record<string, Move>;
}

export interface Decision {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  /** Expected progress on a 0–4 rubric (Score question). */
  progress: number | null;
  /** Probability the position is a dead end (Noul question). */
  deadEnd: number | null;
  latencyMs: number;
  tokens: { input: number | null; output: number | null };
  model: string;
  source: "jev" | "mock";
}

export interface Decider {
  readonly name: string;
  decide(req: DecisionRequest): Promise<Decision>;
}

export const NEXT_MOVE_INSTRUCTIONS =
  "You are playing Block Out!, a sliding colour-block puzzle. Each block can slide through empty floor cells and " +
  "leaves the board through a door of the SAME colour, if the block fits inside the door's width and the door is " +
  "not frozen (ice > 0). Ice on doors and blocks melts by one each time any block leaves. The level is won when every " +
  "block has left. Pick the single best next move from the legal options. Prefer moves that let a block exit now or " +
  "clear the corridor in front of a matching door; avoid moves that wall in other blocks.";

export const PROGRESS_RUBRIC = [
  "No progress: the board is jammed and no block can reach its door.",
  "Little progress: a few blocks could exit after several repositioning moves.",
  "Some progress: at least one block can exit soon; others need work.",
  "Good progress: most remaining blocks have a clear route to their doors.",
  "Nearly solved: every remaining block can exit with at most one preparatory move.",
] as const;

export const DEAD_END_STATEMENT =
  "This position is a dead end: no sequence of legal moves can get every remaining block out through its matching door.";

/** Real Jev via @typesafe-ai/sdk. Needs TYPESAFE_API_KEY (and optionally TYPESAFE_DEFAULT_MODEL). */
export class JevDecider implements Decider {
  readonly name = "jev";
  private client: TypeSafeClient;
  private model: string | undefined;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.client = new TypeSafeClient(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? process.env.JEV_MODEL;
  }

  async decide(req: DecisionRequest): Promise<Decision> {
    const t0 = performance.now();
    const res = await this.client.systemOne({
      state: req.view as never,
      questions: {
        next_move: choice(NEXT_MOVE_INSTRUCTIONS, req.options),
        progress: score("How close is this position to being solved?", PROGRESS_RUBRIC),
        dead_end: noul(DEAD_END_STATEMENT),
      },
      ...(this.model ? { model: this.model } : {}),
    });
    const a = res.answers;
    return {
      choice: a.next_move.choice,
      probabilities: { ...a.next_move.probabilities } as Record<string, number>,
      confidence: a.next_move.confidence,
      progress: a.progress.score,
      deadEnd: a.dead_end.noul,
      latencyMs: Math.round(performance.now() - t0),
      tokens: { input: res.usage.input_tokens, output: res.usage.output_tokens },
      model: res.model,
      source: "jev",
    };
  }
}

/**
 * Offline stand-in with the same response shape, so the whole pipeline (agent, routing, logs, viewer)
 * runs without an API key. Scores each option by one-ply lookahead and softmaxes the scores.
 */
export class MockDecider implements Decider {
  readonly name = "mock";
  private readonly temperature: number;
  constructor(temperature = 1.5) {
    this.temperature = temperature;
  }

  async decide(req: DecisionRequest): Promise<Decision> {
    const t0 = performance.now();
    const ids = Object.keys(req.options);
    const before = req.state.blocks.length * 3 + obstruction(req.state);
    const raw = ids.map((id) => {
      const m = req.moves[id]!;
      const after = evaluate(applyMove(req.state, m));
      if (after.status === "won") return 100;
      if (after.status === "stuck") return -100;
      const gain = before - (after.blocks.length * 3 + obstruction(after));
      return gain * 2 - m.path.length * 0.05;
    });
    const mx = Math.max(...raw);
    const ex = raw.map((v) => Math.exp((v - mx) / this.temperature));
    const z = ex.reduce((a, b) => a + b, 0);
    const probabilities = Object.fromEntries(ids.map((id, i) => [id, ex[i]! / z]));
    const best = ids[raw.indexOf(mx)]!;
    const remaining = req.state.blocks.length;
    const total = remaining + req.state.exited.length;
    return {
      choice: best,
      probabilities,
      confidence: probabilities[best]!,
      progress: total ? Math.round((4 * (total - remaining)) / total * 100) / 100 : 4,
      deadEnd: ids.length === 0 ? 1 : 0.05,
      latencyMs: Math.round(performance.now() - t0),
      tokens: { input: null, output: null },
      model: "mock-heuristic",
      source: "mock",
    };
  }
}

/** Baseline: plays the solver's plan (confidence 1 on the planned move). Useful to compare Jev against. */
export class SolverDecider implements Decider {
  readonly name = "solver";
  async decide(req: DecisionRequest): Promise<Decision> {
    const t0 = performance.now();
    const plan = solve(req.state, { maxNodes: 60_000, weight: 1 });
    const ids = Object.keys(req.options);
    const planned = plan.solved && plan.moves[0] ? moveId(plan.moves[0]) : undefined;
    const pick = planned && planned in req.options ? planned : ids[0]!;
    return {
      choice: pick,
      probabilities: Object.fromEntries(ids.map((id) => [id, id === pick ? 1 : 0])),
      confidence: planned === pick ? 1 : 0,
      progress: null,
      deadEnd: plan.reason === "no solution" ? 1 : 0,
      latencyMs: Math.round(performance.now() - t0),
      tokens: { input: null, output: null },
      model: `solver(${plan.solved ? plan.moves.length + " moves left" : plan.reason})`,
      source: "mock",
    };
  }
}

/** kind: "jev" | "mock" | "solver" | "auto" (or empty). Auto = JEV_DECIDER, else jev when a key is set, else mock. */
export function makeDecider(kind?: string): Decider {
  let k = kind && kind !== "auto" ? kind : process.env.JEV_DECIDER;
  if (!k || k === "auto") k = process.env.TYPESAFE_API_KEY ? "jev" : "mock";
  if (k === "solver") return new SolverDecider();
  if (k === "jev") {
    if (!process.env.TYPESAFE_API_KEY) throw new Error("JEV_DECIDER=jev needs TYPESAFE_API_KEY (see .env.example)");
    return new JevDecider();
  }
  if (k !== "mock") throw new Error(`Unknown decider "${k}" (use jev, mock, solver or auto)`);
  return new MockDecider();
}
