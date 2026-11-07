import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyLegal, evaluate, renderAscii, type GameState } from "@jev-block-out/core";
import { DEFAULT_AGENT_CONFIG, decideTurn, type AgentConfig, type TurnResult } from "./agent.ts";
import type { Device } from "./device.ts";
import type { Decider } from "./jev.ts";
import { newRunId, RunLog } from "./log.ts";
import { dragPath, loadCalibration } from "./screen.ts";

export type RunEvent =
  | { type: "start"; runId: string; level: string; decider: string; mode: "sim" | "device"; state: GameState }
  | ({ type: "turn"; n: number; before: GameState; after: GameState; ms: number } & TurnResult)
  | { type: "end"; status: string; turns: number; ms: number; reason?: string; state: GameState }
  | { type: "error"; message: string };

export interface RunOptions {
  decider: Decider;
  agent?: Partial<AgentConfig>;
  /** Pause between turns so a human can follow (sim mode). */
  stepDelayMs?: number;
  maxTurns?: number;
  /** When set, every move is also dragged on the emulator and a settled screenshot is saved. */
  device?: Device;
  onEvent?: (e: RunEvent) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stateKey = (s: GameState) =>
  s.blocks.map((b) => `${b.id}:${b.color}:${b.cells[0]!.x},${b.cells[0]!.y}`).join("|") + `#${s.exited.length}`;

/** Drives one level to completion. The engine state is the source of truth (Path B+); the device mirrors it. */
export class Runner {
  private stopped = false;
  private paused = false;
  private stepToken: (() => void) | null = null;

  stop(): void {
    this.stopped = true;
    this.stepToken?.();
  }
  pause(p: boolean): void {
    this.paused = p;
    if (!p) this.stepToken?.();
  }
  /** Advance one turn while paused. */
  step(): void {
    this.stepToken?.();
  }

  async run(start: GameState, opts: RunOptions): Promise<RunEvent & { type: "end" }> {
    const cfg = { ...DEFAULT_AGENT_CONFIG, ...opts.agent };
    const runId = newRunId(`L${start.levelIndex ?? start.levelId}-${opts.decider.name}`);
    const log = new RunLog(runId);
    const emit = (e: RunEvent) => {
      log.write(e as unknown as Record<string, unknown>);
      opts.onEvent?.(e);
    };
    const shotsDir = resolve("shots", runId);
    const cal = opts.device ? loadCalibration(start) : null;
    if (opts.device) mkdirSync(shotsDir, { recursive: true });

    const t0 = Date.now();
    let s = evaluate(start);
    const seen = new Map<string, number>();
    emit({ type: "start", runId, level: String(start.levelIndex ?? start.levelId), decider: opts.decider.name, mode: opts.device ? "device" : "sim", state: s });
    if (opts.device) writeFileSync(join(shotsDir, "000.png"), await opts.device.settle());

    const end = (status: string, reason?: string) => {
      const e = { type: "end" as const, status, turns: s.moveCount, ms: Date.now() - t0, state: s, ...(reason ? { reason } : {}) };
      emit(e);
      return e;
    };

    for (let n = 1; n <= (opts.maxTurns ?? 300); n++) {
      if (this.stopped) return end("stopped");
      if (this.paused) {
        await new Promise<void>((r) => (this.stepToken = r));
        this.stepToken = null;
        if (this.stopped) return end("stopped");
      }
      if (s.status !== "playing") break;
      const key = stateKey(s);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (seen.get(key)! > 3) return end("loop", "position repeated 3 times");

      const t1 = Date.now();
      let turn: TurnResult | null;
      try {
        turn = await decideTurn(s, opts.decider, cfg);
      } catch (err) {
        emit({ type: "error", message: (err as Error).message });
        return end("error", (err as Error).message);
      }
      if (!turn) break;
      const before = s;
      s = applyLegal(s, turn.move);
      if (opts.device && cal) {
        await opts.device.drag(dragPath(cal, before, turn.move));
        writeFileSync(join(shotsDir, `${String(n).padStart(3, "0")}.png`), await opts.device.settle());
      }
      emit({ type: "turn", n, before, after: s, ms: Date.now() - t1, ...turn });
      if (opts.stepDelayMs && !this.paused) await sleep(opts.stepDelayMs);
    }
    if (s.status === "won") return end("won");
    if (s.status === "stuck") return end("stuck", renderAscii(s));
    return end("max-turns");
  }
}
