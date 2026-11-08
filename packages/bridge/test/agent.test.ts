import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMove, legalMoves, moveId, parseLevel, type GameState } from "@jev-block-out/core";
import { buildRequest, decideTurn, DEFAULT_AGENT_CONFIG, stateKey } from "../src/agent.ts";
import { GeminiDecider, makeDecider, MockDecider, type CallEvent, type Decider, type Decision, type DecisionRequest } from "../src/jev.ts";
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

describe("revisit avoidance", () => {
  it("does not offer moves back to a visited position unless every move would", async () => {
    const s = demo();
    const all = legalMoves(s);
    const keep = all[all.length - 1]!;
    const visited = new Set(all.filter((m) => m !== keep).map((m) => stateKey(applyMove(s, m))));
    const d = new Scripted([0.9]);
    const t = (await decideTurn(s, d, DEFAULT_AGENT_CONFIG, visited))!;
    expect(t.route).toBe("forced");
    expect(t.moveId).toBe(moveId(keep));
    const everything = new Set(all.map((m) => stateKey(applyMove(s, m))));
    await decideTurn(s, d, DEFAULT_AGENT_CONFIG, everything);
    expect(Object.keys(d.calls.at(-1)!.options)).toHaveLength(all.length);
  });
});

describe("makeDecider", () => {
  it("resolves auto / empty / env and rejects unknown kinds", () => {
    const saved = { key: process.env.TYPESAFE_API_KEY, kind: process.env.JEV_DECIDER, gem: process.env.GEMINI_API_KEY };
    try {
      delete process.env.TYPESAFE_API_KEY;
      delete process.env.JEV_DECIDER;
      delete process.env.GEMINI_API_KEY;
      expect(makeDecider().name).toBe("mock");
      expect(makeDecider("").name).toBe("mock");
      expect(makeDecider("auto").name).toBe("mock");
      expect(makeDecider("solver").name).toBe("solver");
      expect(() => makeDecider("gemini")).toThrow(/GEMINI_API_KEY/);
      process.env.GEMINI_API_KEY = "test-key";
      expect(makeDecider("auto").name).toBe("gemini");
      expect(makeDecider("gemini").name).toBe("gemini");
      process.env.JEV_DECIDER = "solver";
      expect(makeDecider("").name).toBe("solver");
      expect(makeDecider("mock").name).toBe("mock");
      expect(() => makeDecider("jev")).toThrow(/TYPESAFE_API_KEY/);
      expect(() => makeDecider("nope")).toThrow(/Unknown decider/);
    } finally {
      if (saved.key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved.key;
      if (saved.kind === undefined) delete process.env.JEV_DECIDER; else process.env.JEV_DECIDER = saved.kind;
      if (saved.gem === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.gem;
    }
  });
});

describe("GeminiDecider", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const answer = (a: unknown, usage = { promptTokenCount: 900, candidatesTokenCount: 40, thoughtsTokenCount: 10 }) =>
    json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(a) }] } }], usageMetadata: usage, modelVersion: "gemini-test-001" });
  const noSleep = async () => {};

  it("sends a schema-constrained request and maps the answer onto a Decision", async () => {
    const req = buildRequest(demo(), legalMoves(demo()));
    const ids = Object.keys(req.options);
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const d = new GeminiDecider({
      apiKey: "k", model: "gemini-test", minIntervalMs: 0, sleep: noSleep,
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({ url, init });
        return answer({ next_move: ids[1], top_moves: [{ move: ids[1], probability: 0.6 }, { move: ids[0], probability: 0.2 }, { move: "bogus", probability: 0.5 }], progress: 2.5, dead_end: 0.1 });
      }) as typeof fetch,
    });
    const dec = await d.decide(req);
    expect(sent[0]!.url).toContain("/models/gemini-test:generateContent");
    expect((sent[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(String(sent[0]!.init.body));
    expect(body.generationConfig.responseJsonSchema.properties.next_move.enum).toEqual(ids);
    expect(body.contents[0].parts[0].text).toContain(ids[0]);
    expect(dec.choice).toBe(ids[1]);
    expect(dec.confidence).toBeCloseTo(0.75);
    expect(dec.probabilities[ids[0]!]).toBeCloseTo(0.25);
    expect(Object.keys(dec.probabilities)).toEqual(ids);
    expect(dec).toMatchObject({ progress: 2.5, deadEnd: 0.1, model: "gemini-test-001", source: "gemini", tokens: { input: 900, output: 50 } });
  });

  it("gives the chosen move the leftover mass when the model omits it from top_moves", async () => {
    const req = buildRequest(demo(), legalMoves(demo()));
    const ids = Object.keys(req.options);
    const d = new GeminiDecider({
      apiKey: "k", minIntervalMs: 0, sleep: noSleep,
      fetch: (async () => answer({ next_move: ids[0], top_moves: [{ move: ids[1], probability: 0.3 }], progress: 9, dead_end: -1 })) as typeof fetch,
    });
    const dec = await d.decide(req);
    expect(dec.choice).toBe(ids[0]);
    expect(dec.confidence).toBeCloseTo(0.7);
    expect(dec.progress).toBe(4);
    expect(dec.deadEnd).toBe(0);
  });

  it("retries 429s using the server's retryDelay, then succeeds", async () => {
    const req = buildRequest(demo(), legalMoves(demo()));
    const ids = Object.keys(req.options);
    const waits: number[] = [];
    let n = 0;
    const d = new GeminiDecider({
      apiKey: "k", fallbackModels: [], minIntervalMs: 0, sleep: async (ms) => { waits.push(ms); },
      fetch: (async () => (++n === 1
        ? json(429, { error: { code: 429, message: "Resource exhausted", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }] } })
        : answer({ next_move: ids[0], top_moves: [{ move: ids[0], probability: 0.9 }], progress: 1, dead_end: 0 }))) as typeof fetch,
    });
    expect((await d.decide(req)).choice).toBe(ids[0]);
    expect(n).toBe(2);
    expect(waits).toContain(7000);
  });

  it("fails fast on non-retryable errors and exhausted daily quota", async () => {
    const req = buildRequest(demo(), legalMoves(demo()));
    let n = 0;
    const bad = new GeminiDecider({ apiKey: "k", minIntervalMs: 0, sleep: noSleep, fetch: (async () => { n++; return json(400, { error: { message: "API key not valid" } }); }) as typeof fetch });
    await expect(bad.decide(req)).rejects.toThrow(/400 \(gemini-3.6-flash\): API key not valid/);
    const daily = new GeminiDecider({ apiKey: "k", fallbackModels: [], minIntervalMs: 0, sleep: noSleep, fetch: (async () => { n++; return json(429, { error: { message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 20 per day" } }); }) as typeof fetch });
    await expect(daily.decide(req)).rejects.toThrow(/429/);
    expect(n).toBe(2);
  });

  it("falls back to the next model on 503 / network errors, stays on it, then retries the primary", async () => {
    const req = buildRequest(demo(), legalMoves(demo()));
    const ids = Object.keys(req.options);
    const urls: string[] = [];
    const waits: number[] = [];
    let netErr = true;
    const d = new GeminiDecider({
      apiKey: "k", model: "primary", fallbackModels: ["backup"], minIntervalMs: 0, sleep: async (ms) => { waits.push(ms); },
      fetch: (async (url: string) => {
        urls.push(url);
        if (url.includes("/primary:")) return json(503, { error: { code: 503, message: "high demand" } });
        if (netErr) { netErr = false; throw new TypeError("fetch failed"); }
        return answer({ next_move: ids[0], top_moves: [{ move: ids[0], probability: 0.8 }], progress: 1, dead_end: 0 });
      }) as typeof fetch,
    });
    const dec = await d.decide(req);
    expect(dec.choice).toBe(ids[0]);
    expect(urls.map((u) => u.match(/models\/(\w+):/)![1])).toEqual(["primary", "backup", "primary", "backup"]);
    expect(waits.length).toBeGreaterThan(0);
    urls.length = 0;
    await d.decide(req);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/backup:");
    for (let i = 0; i < 9; i++) await d.decide(req);
    expect(urls.every((u) => u.includes("/backup:"))).toBe(true);
    urls.length = 0;
    await d.decide(req);
    expect(urls.map((u) => u.match(/models\/(\w+):/)![1])).toEqual(["primary", "backup"]);
  });

  it("traces every attempt as a request/response pair without leaking the API key", async () => {
    const req = buildRequest(demo(), legalMoves(demo()));
    const ids = Object.keys(req.options);
    let n = 0;
    const d = new GeminiDecider({
      apiKey: "secret-key", model: "m", fallbackModels: [], minIntervalMs: 0, sleep: async () => {},
      fetch: (async () => (++n === 1 ? json(503, { error: { message: "busy" } })
        : answer({ next_move: ids[0], top_moves: [{ move: ids[0], probability: 0.9 }], progress: 2, dead_end: 0 }))) as typeof fetch,
    });
    const events: CallEvent[] = [];
    await d.decide(req, (e) => events.push(e));
    expect(events.map((e) => `${e.phase}:${e.status ?? ""}`)).toEqual(["request:", "response:503", "request:", "response:200"]);
    expect(events[0]!.callId).toBe(events[1]!.callId);
    expect(events[2]!.attempt).toBe(2);
    expect(JSON.stringify(events)).not.toContain("secret-key");
    expect(JSON.stringify(events[0]!.payload)).toContain(ids[0]);

    const mockEvents: CallEvent[] = [];
    const t = await decideTurn(demo(), new MockDecider(0.05), { ...DEFAULT_AGENT_CONFIG, lowConfidence: 0 }, undefined, (e) => mockEvents.push(e));
    expect(mockEvents.map((e) => `${e.phase}:${e.round}`)).toEqual(["request:first", "response:first"]);
    expect((mockEvents[1]!.body as { next_move: string }).next_move).toBe(t!.moveId);
  });

  it("drops a model whose daily quota is spent and gives up when none are left", async () => {
    const req = buildRequest(demo(), legalMoves(demo()));
    const urls: string[] = [];
    const d = new GeminiDecider({
      apiKey: "k", model: "a", fallbackModels: ["b"], minIntervalMs: 0, sleep: async () => {},
      fetch: (async (url: string) => { urls.push(url); return json(429, { error: { message: "Quota exceeded ... per day" } }); }) as typeof fetch,
    });
    await expect(d.decide(req)).rejects.toThrow(/429 \(b\)/);
    expect(urls).toHaveLength(2);
  });

  it("throttles consecutive requests to the configured interval", async () => {
    const req = buildRequest(demo(), legalMoves(demo()));
    const ids = Object.keys(req.options);
    const waits: number[] = [];
    const d = new GeminiDecider({
      apiKey: "k", minIntervalMs: 4000, sleep: async (ms) => { waits.push(ms); },
      fetch: (async () => answer({ next_move: ids[0], top_moves: [], progress: 0, dead_end: 0 })) as typeof fetch,
    });
    await d.decide(req);
    await d.decide(req);
    expect(waits).toHaveLength(1);
    expect(waits[0]!).toBeGreaterThan(3000);
  });
});
