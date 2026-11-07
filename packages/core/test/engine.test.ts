import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyLegal, applyMove, evaluate, hasLevels, legalMoves, loadLevel, moveId, parseLevel, renderAscii, solve,
  type GameState,
} from "../src/index.ts";
import { P, rawLevel } from "./fixtures.ts";

const demo = () => parseLevel(readFileSync(new URL("../../../examples/demo-level.json", import.meta.url), "utf8"), { levelId: "demo" });
const exits = (s: GameState) => legalMoves(s).filter((m) => m.kind === "exit");

describe("parseLevel", () => {
  it("derives door sides from the adjacent floor cell", () => {
    const s = demo();
    expect(Object.fromEntries(s.doors.map((d) => [d.color, d.side]))).toEqual({
      red: "up", blue: "right", yellow: "down", green: "left", purple: "left",
    });
  });

  it("reads upper-case X/Y keys and strips a BOM", () => {
    const raw = rawLevel(2, 1, [{ BCT: 0, BPMS: [{ X: 0, Y: 0 }] }], [{ BCT: 0, BPMS: [{ X: 2, Y: 0 }], IH: false }]);
    const s = parseLevel("\uFEFF" + JSON.stringify(raw));
    expect(s.blocks[0]!.cells).toEqual([P(0, 0)]);
    expect(s.doors[0]!.side).toBe("right");
  });

  it("flags mechanics the engine does not model", () => {
    const raw = rawLevel(2, 1, [{ BCT: 0, BPMS: [P(0, 0)], BD: 5 }], [{ BCT: 0, BPMS: [P(2, 0)] }], { GMS: [{}] });
    expect(parseLevel(raw).unsupported).toEqual(["bomb timers", "generators"]);
    expect(solve(parseLevel(raw)).reason).toMatch(/^unsupported/);
  });
});

describe("rules", () => {
  it("only lets a block exit through a same-coloured door it fits in", () => {
    const raw = rawLevel(3, 2,
      [{ BCT: 0, BPMS: [P(0, 0), P(1, 0)] }, { BCT: 1, BPMS: [P(2, 1)] }],
      [{ BCT: 0, BPMS: [P(0, -1)], IH: true }, { BCT: 1, BPMS: [P(3, 1)], IH: false }]);
    const s = parseLevel(raw);
    // red is 2 wide, red door is 1 wide → no exit; blue exits right immediately.
    expect(exits(s).map((m) => m.blockId)).toEqual(["b1"]);
  });

  it("requires a clear corridor to the door", () => {
    const raw = rawLevel(3, 1,
      [{ BCT: 0, BPMS: [P(0, 0)] }, { BCT: 1, BPMS: [P(1, 0)], BIC: 5 }],
      [{ BCT: 0, BPMS: [P(3, 0)], IH: false }]);
    expect(exits(parseLevel(raw))).toHaveLength(0);
  });

  it("freezes blocks and doors until enough exits melt the ice", () => {
    const raw = rawLevel(3, 1,
      [{ BCT: 0, BPMS: [P(0, 0)] }, { BCT: 1, BPMS: [P(2, 0)], BIC: 1 }],
      [{ BCT: 0, BPMS: [P(-1, 0)], IH: false }, { BCT: 1, BPMS: [P(3, 0)], IH: false, DIC: 1 }]);
    let s = parseLevel(raw);
    expect(legalMoves(s).filter((m) => m.blockId === "b1")).toHaveLength(0);
    s = applyLegal(s, exits(s)[0]!);
    expect(s.blocks[0]!.ice).toBe(0);
    expect(s.doors[1]!.ice).toBe(0);
    s = applyLegal(s, exits(s)[0]!);
    expect(s.status).toBe("won");
  });

  it("restricts axis-locked blocks", () => {
    const raw = rawLevel(3, 3, [{ BCT: 0, BPMS: [P(1, 1)], BAD: 1 }], [{ BCT: 1, BPMS: [P(1, 3)], IH: true }]);
    const slides = legalMoves(parseLevel(raw));
    expect(slides.length).toBe(2);
    expect(slides.every((m) => m.dy === 0)).toBe(true);
  });

  it("keeps a layered block in place with its inner colour after the outer layer exits", () => {
    const raw = rawLevel(2, 1,
      [{ BCT: 0, BPMS: [P(1, 0)], ILE: true, LBCT: 1 }],
      [{ BCT: 0, BPMS: [P(2, 0)], IH: false }, { BCT: 1, BPMS: [P(-1, 0)], IH: false }]);
    let s = parseLevel(raw);
    s = applyLegal(s, exits(s)[0]!);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]!.color).toBe("blue");
    s = applyLegal(s, exits(s)[0]!);
    expect(s.status).toBe("won");
  });

  it("detects stuck positions", () => {
    const raw = rawLevel(1, 1, [{ BCT: 0, BPMS: [P(0, 0)] }], [{ BCT: 1, BPMS: [P(1, 0)], IH: false }]);
    expect(evaluate(parseLevel(raw)).status).toBe("stuck");
  });

  it("gives every legal move a unique id", () => {
    const s = demo();
    const ids = legalMoves(s).map(moveId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not mutate the input state", () => {
    const s = demo();
    const before = JSON.stringify(s);
    applyMove(s, legalMoves(s)[0]!);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("renders ASCII with walls, doors and blocks", () => {
    expect(renderAscii(demo()).split("\n")[0]).toBe("##rr####");
  });
});

describe("solver", () => {
  it("solves the demo level and the plan replays as legal moves", () => {
    const s0 = demo();
    const r = solve(s0, { weight: 1 });
    expect(r.solved).toBe(true);
    let s = s0;
    for (const m of r.moves) s = applyLegal(s, m);
    expect(s.status).toBe("won");
  });

  it("solves a level that needs a blocker moved out of the way first", () => {
    // Red must exit up through x=0, but blue sits on top of it; blue can only leave to the right.
    const raw = rawLevel(3, 3,
      [{ BCT: 0, BPMS: [P(0, 0)] }, { BCT: 1, BPMS: [P(0, 1)] }],
      [{ BCT: 0, BPMS: [P(0, 3)], IH: true }, { BCT: 1, BPMS: [P(3, 0)], IH: false }]);
    const r = solve(parseLevel(raw), { weight: 1 });
    expect(r.solved).toBe(true);
    expect(r.moves.length).toBeGreaterThanOrEqual(2);
  });

  it("reports no solution when one is impossible", () => {
    const raw = rawLevel(2, 1, [{ BCT: 0, BPMS: [P(0, 0)] }, { BCT: 1, BPMS: [P(1, 0)] }], [{ BCT: 0, BPMS: [P(2, 0)], IH: false }]);
    expect(solve(parseLevel(raw)).solved).toBe(false);
  });
});

describe.skipIf(!hasLevels())("extracted levels (local only)", () => {
  it("solves the first five game levels", () => {
    for (let n = 1; n <= 5; n++) expect(solve(loadLevel(n), { weight: 1, maxNodes: 60_000 }).solved).toBe(true);
  });
});
