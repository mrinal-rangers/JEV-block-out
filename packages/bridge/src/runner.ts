import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyLegal, evaluate, renderAscii, type GameState } from "@jev-block-out/core";
import { DEFAULT_AGENT_CONFIG, decideTurn, stateKey, type AgentConfig, type TurnResult } from "./agent.ts";
import type { Device } from "./device.ts";
import type { CallEvent, Decider } from "./jev.ts";
import { newRunId, RunLog } from "./log.ts";
import { dragPath, loadCalibration, type Calibration } from "./screen.ts";

export type RunEvent =
  | { type: "start"; runId: string; level: string; decider: string; mode: "sim" | "device"; state: GameState; calibration?: Calibration }
  | ({ type: "turn"; n: number; before: GameState; after: GameState; ms: number } & TurnResult)
  | ({ type: "call"; n: number } & CallEvent)
  | { type: "end"; status: string; turns: number; ms: number; reason?: string; state: GameState }
  | { type: "info"; message: string }
  | { type: "error"; message: string };

export interface RunOptions {
  decider: Decider;
  agent?: Partial<AgentConfig>;
  /** Pause between turns so a human can follow (sim mode). */
  stepDelayMs?: number;
  maxTurns?: number;
  /** When set, every move is also dragged on the emulator and a settled screenshot is saved. */
  device?: Device;
  /** Board-to-screen mapping for `device` (e.g. from level recognition); detected from a screenshot when omitted. */
  calibration?: Calibration;
  onEvent?: (e: RunEvent) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const keepShots = process.env.JEV_SHOTS === "1";
    const img = opts.device && !opts.calibration ? await opts.device.rawScreenshot().catch(() => null) : null;
    const cal = opts.device ? (opts.calibration ?? loadCalibration(start, img)) : null;
    if (opts.device && keepShots) mkdirSync(shotsDir, { recursive: true });
    const moveWaitMs = Number(process.env.DEVICE_MOVE_MS) || 350;

    const t0 = Date.now();
    let s = evaluate(start);
    const seen = new Map<string, number>();
    emit({ type: "start", runId, level: String(start.levelIndex ?? start.levelId), decider: opts.decider.name, mode: opts.device ? "device" : "sim", state: s, ...(cal ? { calibration: cal } : {}) });
    if (opts.device && keepShots) writeFileSync(join(shotsDir, "000.png"), await opts.device.screenshot());

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
        turn = await decideTurn(s, opts.decider, cfg, seen, (c) => emit({ type: "call", n, ...c }));
      } catch (err) {
        emit({ type: "error", message: (err as Error).message });
        return end("error", (err as Error).message);
      }
      if (!turn) break;
      const before = s;
      s = applyLegal(s, turn.move);
      if (opts.device && cal) {
        await opts.device.drag(dragPath(cal, before, turn.move));
        // The game's timer and hints never let the screen go still, so wait a fixed time for the slide/exit animation.
        await sleep(moveWaitMs);
        if (keepShots) writeFileSync(join(shotsDir, `${String(n).padStart(3, "0")}.png`), await opts.device.screenshot());
      }
      emit({ type: "turn", n, before, after: s, ms: Date.now() - t1, ...turn });
      if (opts.stepDelayMs && !this.paused) await sleep(opts.stepDelayMs);
    }
    if (s.status === "won") return end("won");
    if (s.status === "stuck") return end("stuck", renderAscii(s));
    return end("max-turns");
  }
}
