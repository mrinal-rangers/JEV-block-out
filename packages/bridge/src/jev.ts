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
  source: "jev" | "gemini" | "mock";
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

export const GEMINI_DEFAULT_MODEL = "gemini-3.6-flash";
export const GEMINI_DEFAULT_FALLBACKS = ["gemini-3.5-flash-lite"];

export interface GeminiOptions {
  apiKey?: string;
  model?: string;
  /** Tried in order when the current model is overloaded (503), rate-limited, times out or hits its daily quota. */
  fallbackModels?: string[];
  /** Minimum gap between requests; default 4000 ms keeps under ~15 RPM free-tier limits. */
  minIntervalMs?: number;
  /** Per-request timeout; default 60 s (Node's own default would hang for 300 s). */
  timeoutMs?: number;
  maxRetries?: number;
  /** Optional thinkingLevel (minimal | low | medium | high); omitted = model default. */
  thinkingLevel?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Free alternative to Jev: Gemini API with a Google AI Studio key (free tier, no card).
 * One structured-output call answers all three questions. The move is constrained to the legal ids via a JSON
 * Schema enum; probabilities are the model's self-reported estimates, so they are NOT calibrated like Jev's.
 */
export class GeminiDecider implements Decider {
  readonly name = "gemini";
  private readonly apiKey: string;
  /** Primary model first, then fallbacks. A working fallback stays active for 10 calls, then the primary is retried. */
  private readonly models: string[];
  private active = 0;
  private callsOnFallback = 0;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly thinkingLevel: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextAt = 0;

  constructor(opts: GeminiOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    if (!this.apiKey) throw new Error("gemini decider needs GEMINI_API_KEY (free key: https://aistudio.google.com/apikey)");
    const primary = opts.model ?? (process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL);
    const envFallbacks = process.env.GEMINI_FALLBACK_MODELS;
    const fallbacks = opts.fallbackModels ??
      (envFallbacks !== undefined ? envFallbacks.split(",").map((m) => m.trim()).filter(Boolean) : GEMINI_DEFAULT_FALLBACKS);
    this.models = [...new Set([primary, ...fallbacks])];
    this.minIntervalMs = opts.minIntervalMs ?? Number(process.env.GEMINI_MIN_INTERVAL_MS || 4000);
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.GEMINI_TIMEOUT_MS || 60_000);
    this.maxRetries = opts.maxRetries ?? 4;
    this.thinkingLevel = opts.thinkingLevel ?? (process.env.GEMINI_THINKING || undefined);
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async decide(req: DecisionRequest): Promise<Decision> {
    const t0 = performance.now();
    const ids = Object.keys(req.options);
    if (ids.length === 0) throw new Error("Gemini: no legal moves to choose from");
    const body = {
      contents: [{ role: "user", parts: [{ text: geminiPrompt(req) }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: geminiSchema(ids),
        ...(this.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.thinkingLevel } } : {}),
      },
    };
    const { data, model } = await this.call(body);
    const parts: Array<{ text?: string; thought?: boolean }> = data?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter((p) => !p.thought && p.text).map((p) => p.text).join("");
    if (!text) throw new Error(`Gemini returned no answer (finishReason: ${data?.candidates?.[0]?.finishReason ?? "none"})`);
    let ans: { next_move?: unknown; top_moves?: Array<{ move?: unknown; probability?: unknown }>; progress?: unknown; dead_end?: unknown };
    try {
      ans = JSON.parse(text);
    } catch {
      throw new Error(`Gemini returned invalid JSON: ${text.slice(0, 200)}`);
    }

    const probabilities: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const t of Array.isArray(ans.top_moves) ? ans.top_moves : []) {
      if (typeof t?.move === "string" && Object.hasOwn(probabilities, t.move)) probabilities[t.move]! += clamp(Number(t.probability), 0, 1);
    }
    const ranked = ids.filter((id) => probabilities[id]! > 0).sort((a, b) => probabilities[b]! - probabilities[a]!);
    const choice = typeof ans.next_move === "string" && Object.hasOwn(probabilities, ans.next_move) ? ans.next_move : ranked[0];
    if (!choice) throw new Error(`Gemini picked an unknown move: ${String(ans.next_move)}`);
    if (probabilities[choice] === 0) probabilities[choice] = Math.max(0, 1 - sum(Object.values(probabilities)));
    const z = sum(Object.values(probabilities));
    if (z > 0) for (const id of ids) probabilities[id]! /= z;
    else probabilities[choice] = 1;

    const u = data?.usageMetadata ?? {};
    const out = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
    return {
      choice,
      probabilities,
      confidence: probabilities[choice]!,
      progress: Number.isFinite(Number(ans.progress)) ? clamp(Number(ans.progress), 0, 4) : null,
      deadEnd: Number.isFinite(Number(ans.dead_end)) ? clamp(Number(ans.dead_end), 0, 1) : null,
      latencyMs: Math.round(performance.now() - t0),
      tokens: { input: u.promptTokenCount ?? null, output: u.candidatesTokenCount == null ? null : out },
      model: data?.modelVersion ?? model,
      source: "gemini",
    };
  }

  /**
   * POST generateContent with client-side throttling, a per-request timeout and retries. On 429/5xx/timeout it
   * first switches to a fallback model not yet tried in this call; after that it backs off (honouring retryDelay).
   * A model whose daily quota is spent is dropped for the rest of the run.
   */
  private async call(body: unknown): Promise<{ data: any; model: string }> {
    const tried = new Set<string>();
    if (this.active !== 0 && ++this.callsOnFallback > 10) {
      this.active = 0;
      this.callsOnFallback = 0;
    }
    let lastErr = "Gemini: no models available";
    for (let attempt = 0; attempt <= this.maxRetries + this.models.length; attempt++) {
      if (this.models.length === 0) break;
      this.active %= this.models.length;
      const model = this.models[this.active]!;
      tried.add(model);
      const wait = this.nextAt - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAt = Date.now() + this.minIntervalMs;

      let status = 0;
      let data: any = {};
      let msg: string;
      try {
        const res = await this.fetchFn(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs),
          },
        );
        const raw = await res.text();
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          data = {};
        }
        if (res.ok) return { data, model };
        status = res.status;
        msg = data?.error?.message ?? raw.slice(0, 300);
      } catch (err) {
        const e = err as Error;
        msg = e?.name === "TimeoutError" ? `timed out after ${this.timeoutMs} ms` : String(e?.message ?? err);
      }
      lastErr = `Gemini API ${status || "network error"} (${model}): ${msg}`;
      if (status && status !== 429 && status < 500) throw new Error(lastErr);

      if (/per day|PerDay/i.test(msg)) {
        this.models.splice(this.active, 1);
        continue;
      }
      if (this.models.length > 1) this.active = (this.active + 1) % this.models.length;
      if (!tried.has(this.models[this.active]!)) continue;
      const info = (data?.error?.details ?? []).find((d: any) => typeof d?.retryDelay === "string");
      const hinted = info ? parseFloat(info.retryDelay) * 1000 : 0;
      await this.sleep(Math.min(60_000, Math.max(hinted, 2000 * 2 ** Math.min(attempt, 5))));
    }
    throw new Error(lastErr);
  }
}

export function geminiPrompt(req: DecisionRequest): string {
  const moves = Object.entries(req.options).map(([id, d]) => `- ${id}: ${d}`).join("\n");
  const rubric = PROGRESS_RUBRIC.map((r, i) => `  ${i} = ${r}`).join("\n");
  return [
    NEXT_MOVE_INSTRUCTIONS,
    "",
    "Board (JSON):",
    JSON.stringify(req.view),
    "",
    "Legal moves (id: description):",
    moves,
    "",
    "Reply with JSON:",
    "- next_move: the id of the single best move.",
    "- top_moves: up to 5 of the most promising move ids (including next_move) with your probability (0-1) that each " +
      "is the best move; the probabilities should sum to at most 1.",
    `- progress: how close the position is to solved, 0-4:\n${rubric}`,
    `- dead_end: probability (0-1) that this statement is true: "${DEAD_END_STATEMENT}"`,
  ].join("\n");
}

export function geminiSchema(ids: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      next_move: { type: "string", enum: ids },
      top_moves: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          properties: { move: { type: "string", enum: ids }, probability: { type: "number", minimum: 0, maximum: 1 } },
          required: ["move", "probability"],
        },
      },
      progress: { type: "number", minimum: 0, maximum: 4 },
      dead_end: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["next_move", "top_moves", "progress", "dead_end"],
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
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

/**
 * kind: "jev" | "gemini" | "mock" | "solver" | "auto" (or empty).
 * Auto = JEV_DECIDER, else jev when TYPESAFE_API_KEY is set, else gemini when GEMINI_API_KEY is set, else mock.
 */
export function makeDecider(kind?: string): Decider {
  let k = kind && kind !== "auto" ? kind : process.env.JEV_DECIDER;
  if (!k || k === "auto") k = process.env.TYPESAFE_API_KEY ? "jev" : process.env.GEMINI_API_KEY ? "gemini" : "mock";
  if (k === "solver") return new SolverDecider();
  if (k === "jev") {
    if (!process.env.TYPESAFE_API_KEY) throw new Error("JEV_DECIDER=jev needs TYPESAFE_API_KEY (see .env.example)");
    return new JevDecider();
  }
  if (k === "gemini") return new GeminiDecider();
  if (k !== "mock") throw new Error(`Unknown decider "${k}" (use jev, gemini, mock, solver or auto)`);
  return new MockDecider();
}
