import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Append-only JSONL run log (one file per run under logs/). */
export class RunLog {
  readonly path: string;
  constructor(runId: string, dir = resolve(process.env.JEV_LOG_DIR ?? "logs")) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${runId}.jsonl`);
  }
  write(event: Record<string, unknown>): void {
    appendFileSync(this.path, JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n");
  }
}

export function newRunId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}
