import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { legalMoves, moveId, parseLevel, type GameState } from "@jev-block-out/core";
import { buildRequest, decideTurn, DEFAULT_AGENT_CONFIG } from "../src/agent.ts";
import { makeDecider, MockDecider, type Decider, type Decision, type DecisionRequest } from "../src/jev.ts";
import { Runner } from "../src/runner.ts";
import { cellCenter, dragPath, guessCalibration } from "../src/screen.ts";
import { DEMO_LEVEL } from "../src/server.ts";

const demo = (): GameState => parseLevel(readFileSync(DEMO_LEVEL, "utf8"), { levelId: "demo" });

/** Scripted decider: returns the given confidences in order, always picking the last option (worst-ranked). */
class Scripted implements Decider {
  readonly name = "scripted";
  calls: DecisionRequest[] = [];
  private confidences: number[];
  private pickId: ((r: DecisionRequest) => string) | undefined;
  constructor(confidences: number[], pickId?: (r: DecisionRequest) => string) {
    this.confidences = confidences;
    this.pickId = pickId;
  }
  async decide(req: DecisionRequest): Promise<Decision> {
    this.calls.push(req);
    const ids = Object.keys(req.options);
    const choice = this.pickId ? this.pickId(req) : ids[ids.length - 1]!;
    const c = this.confidences[this.calls.length - 1] ?? 1;
    return {
      choice, confidence: c, probabilities: Object.fromEntries(ids.map((id, i) => [id, id === choice ? c : (1 - c) / Math.max(1, ids.length - 1) - i * 1e-6])),
      progress: null, deadEnd: null, latencyMs: 0, tokens: { input: null, output: null }, model: "scripted", source: "mock",
    };
  }
}

describe("confidence routing", () => {
  it("takes a confident answer as-is", async () => {
    const d = new Scripted([0.9]);
    const t = (await decideTurn(demo(), d))!;
    expect(t.route).toBe("confident");
    expect(d.calls).toHaveLength(1);
  });

  it("re-asks with a top-k shortlist when confidence is low", async () => {
    const d = new Scripted([0.1, 0.8]);
    const t = (await decideTurn(demo(), d))!;
    expect(t.route).toBe("reask");
    expect(Object.keys(d.calls[1]!.options).length).toBe(DEFAULT_AGENT_CONFIG.topK);
  });

  it("falls back to the solver when the re-ask is still unsure", async () => {
    const t = (await decideTurn(demo(), new Scripted([0.1, 0.1])))!;
    expect(t.route).toBe("solver-fallback");
  });

  it("accepts the low-confidence answer when the solver fallback is disabled", async () => {
    const t = (await decideTurn(demo(), new Scripted([0.1, 0.1]), { ...DEFAULT_AGENT_CONFIG, solverFallback: false }))!;
    expect(t.route).toBe("low-confidence-accept");
  });

  it("rejects answers that are not legal options", async () => {
    await expect(decideTurn(demo(), new Scripted([0.9], () => "slide:b0:99:99"))).rejects.toThrow(/unknown option/);
  });

  it("caps options at 255 for Jev Choice questions", () => {
    const s = demo();
    const req = buildRequest(s, legalMoves(s, { limit: 255 }));
    expect(Object.keys(req.options).length).toBeLessThanOrEqual(255);
    expect(Object.keys(req.options)).toEqual(Object.keys(req.moves));
  });
});

describe("MockDecider", () => {
  it("returns a legal option and a normalised distribution", async () => {
    const s = demo();
    const req = buildRequest(s, legalMoves(s));
    const d = await new MockDecider().decide(req);
    expect(Object.keys(req.moves)).toContain(d.choice);
    const sum = Object.values(d.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(d.confidence).toBe(d.probabilities[d.choice]);
  });
});

describe("screen mapping", () => {
  const s = demo();
  const cal = guessCalibration(s, 1080, 2400);

  it("fits the board on screen and flips y", () => {
    const tl = cellCenter(cal, s, { x: s.board.minX, y: s.board.maxY });
    const br = cellCenter(cal, s, { x: s.board.maxX, y: s.board.minY });
    expect(tl.x).toBeLessThan(br.x);
    expect(tl.y).toBeLessThan(br.y);
    expect(br.x).toBeLessThan(1080);
    expect(br.y).toBeLessThan(2400);
  });

  it("drags from the block along its path", () => {
    const m = legalMoves(s).find((x) => x.kind === "slide" && x.blockId === "b5")!;
    const pts = dragPath(cal, s, m);
    expect(pts[0]).toEqual(cellCenter(cal, s, s.blocks.find((b) => b.id === "b5")!.cells[0]!));
    expect(pts.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Runner", () => {
  it("plays the demo level to a win with the mock decider and logs JSONL", async () => {
    process.env.JEV_LOG_DIR = mkdtempSync(join(tmpdir(), "jevlog-"));
    const events: string[] = [];
    const end = await new Runner().run(demo(), { decider: new MockDecider(), onEvent: (e) => events.push(e.type) });
    expect(end.status).toBe("won");
    expect(events[0]).toBe("start");
    expect(events.at(-1)).toBe("end");
    expect(events.filter((e) => e === "turn").length).toBe(end.turns);
  });

  it("ids in turn events match the applied move", async () => {
    const seen: string[] = [];
    await new Runner().run(demo(), {
      decider: new MockDecider(),
      onEvent: (e) => { if (e.type === "turn") seen.push(e.moveId === moveId(e.move) ? "ok" : "bad"); },
    });
    expect(seen.every((x) => x === "ok")).toBe(true);
  });
});

describe("makeDecider", () => {
  it("resolves auto / empty / env and rejects unknown kinds", () => {
    const saved = { key: process.env.TYPESAFE_API_KEY, kind: process.env.JEV_DECIDER };
    try {
      delete process.env.TYPESAFE_API_KEY;
      delete process.env.JEV_DECIDER;
      expect(makeDecider().name).toBe("mock");
      expect(makeDecider("").name).toBe("mock");
      expect(makeDecider("auto").name).toBe("mock");
      expect(makeDecider("solver").name).toBe("solver");
      process.env.JEV_DECIDER = "solver";
      expect(makeDecider("").name).toBe("solver");
      expect(makeDecider("mock").name).toBe("mock");
      expect(() => makeDecider("jev")).toThrow(/TYPESAFE_API_KEY/);
      expect(() => makeDecider("nope")).toThrow(/Unknown decider/);
    } finally {
      if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved.key;
      if (saved.kind === undefined) delete process.env.JEV_DECIDER; else process.env.JEV_DECIDER = saved.kind;
    }
  });
});
