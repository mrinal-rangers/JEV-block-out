import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyMove, parseLevel, type GameState } from "@jev-block-out/core";
import type { Device } from "../src/device.ts";
import { findGameLevel, LevelIndex } from "../src/game.ts";
import { knownPlan, planFor } from "../src/plans.ts";
import { popupClose, winPopupContinue, type RgbaImage } from "../src/screen.ts";
import { DEMO_LEVEL } from "../src/server.ts";

const demo = (id = "demo"): GameState => parseLevel(readFileSync(DEMO_LEVEL, "utf8"), { levelId: id });

/** A 1080×2400 screen filled with `bg`, with optional coloured rectangles (fractions of the screen). */
function screen(bg: [number, number, number], rects: { x0: number; y0: number; x1: number; y1: number; c: [number, number, number] }[] = []): RgbaImage {
  const w = 1080, h = 2400, data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = rects.findLast((q) => x >= q.x0 * w && x < q.x1 * w && y >= q.y0 * h && y < q.y1 * h);
    const [cr, cg, cb] = r ? r.c : bg;
    const i = (y * w + x) * 4;
    data[i] = cr; data[i + 1] = cg; data[i + 2] = cb; data[i + 3] = 255;
  }
  return { w, h, data };
}

const PANEL: [number, number, number] = [74, 58, 199], GREEN: [number, number, number] = [54, 209, 15], DARK: [number, number, number] = [12, 10, 30];
const popup = () => screen(DARK, [
  { x0: 0.05, y0: 0.2, x1: 0.95, y1: 0.75, c: PANEL },
  { x0: 0.25, y0: 0.6, x1: 0.75, y1: 0.675, c: GREEN },
  { x0: 0.35, y0: 0.635, x1: 0.65, y1: 0.655, c: [255, 255, 255] },
]);

describe("winPopupContinue", () => {
  it("finds the green button on the end-of-level popup, despite its white label", () => {
    const p = winPopupContinue(popup());
    expect(p).not.toBeNull();
    expect(p!.x).toBe(540);
    expect(p!.y / 2400).toBeGreaterThan(0.6);
    expect(p!.y / 2400).toBeLessThan(0.675);
  });

  it("ignores a green button without the purple panel (e.g. the coin-spending Add Time)", () => {
    expect(winPopupContinue(screen(DARK, [{ x0: 0.17, y0: 0.74, x1: 0.83, y1: 0.82, c: GREEN }]))).toBeNull();
  });

  it("ignores a thin row of green blocks inside the purple board frame", () => {
    expect(winPopupContinue(screen(DARK, [
      { x0: 0.1, y0: 0.25, x1: 0.9, y1: 0.75, c: PANEL },
      { x0: 0.2, y0: 0.6, x1: 0.8, y1: 0.63, c: GREEN },
    ]))).toBeNull();
  });
});

const RED: [number, number, number] = [255, 48, 48], WHITE: [number, number, number] = [250, 245, 238];
/** "Out of Time": a red X in the top-right and a coin-spending green "Add Time" button low on a dark screen. */
const outOfTime = (opts: { cross?: boolean; green?: boolean } = {}) => screen(DARK, [
  ...(opts.green === false ? [] : [{ x0: 0.17, y0: 0.74, x1: 0.83, y1: 0.82, c: GREEN }]),
  { x0: 0.86, y0: 0.08, x1: 0.94, y1: 0.116, c: RED },
  ...(opts.cross === false ? [] : [{ x0: 0.885, y0: 0.093, x1: 0.915, y1: 0.103, c: WHITE }]),
]);

describe("popupClose", () => {
  it("finds the red X on a coin-spending popup, never the green button", () => {
    const p = popupClose(outOfTime());
    expect(p).not.toBeNull();
    expect(p!.x / 1080).toBeGreaterThan(0.86);
    expect(p!.x / 1080).toBeLessThan(0.94);
    expect(p!.y / 2400).toBeGreaterThan(0.08);
    expect(p!.y / 2400).toBeLessThan(0.116);
  });

  it("needs both the green button and a white cross (so red blocks during play are left alone)", () => {
    expect(popupClose(outOfTime({ green: false }))).toBeNull();
    expect(popupClose(outOfTime({ cross: false }))).toBeNull();
  });
});

describe("findGameLevel", () => {
  class NoLevels extends LevelIndex { override numbers() { return []; } }

  it("taps the popup button while waiting for a level, but only when asked to", async () => {
    const taps: { x: number; y: number }[] = [];
    const device = { rawScreenshot: async () => popup(), tap: async (x: number, y: number) => void taps.push({ x, y }) } as unknown as Device;
    let dismissed = 0;
    expect(await findGameLevel(device, new NoLevels(), { timeoutMs: 0, intervalMs: 1, stable: false })).toBeNull();
    expect(taps).toHaveLength(0);
    expect(await findGameLevel(device, new NoLevels(), { timeoutMs: 0, intervalMs: 1, stable: false, dismissPopups: true, onDismiss: () => dismissed++ })).toBeNull();
    expect(taps.length).toBeGreaterThan(0);
    expect(taps[0]!.x).toBe(540);
    expect(dismissed).toBe(taps.length);
  });
});

describe("planFor", () => {
  it("solves once (off the main thread) and then knows the plan from every position along it", async () => {
    const s = demo(`demo-plan-test`);
    const plan = await planFor({ ...s, moveCount: 1 });
    expect(plan?.length).toBeGreaterThan(0);
    let cur = s;
    for (let i = 0; i < plan!.length; i++) {
      expect(knownPlan(cur)).toEqual(plan!.slice(i));
      cur = applyMove(cur, plan![i]!);
    }
    expect(cur.status).toBe("won");
    expect(await planFor(cur)).toEqual([]);
  });

  it("gives null when the solver can't find a plan, and remembers that", async () => {
    const d = demo();
    const s = { ...d, moveCount: 1, blocks: d.blocks.map((b, i) => (i === 0 ? { ...b, color: "no-such-exit" } : b)) } as GameState;
    const tiny = [{ weight: 1, maxNodes: 2_000 }];
    expect(await planFor(s, tiny)).toBeNull();
    const t0 = performance.now();
    expect(await planFor(s, tiny)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(20);
  });
});
