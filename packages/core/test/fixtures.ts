import type { RawBlock, RawDoor, RawLevel } from "../src/level.ts";

export const P = (x: number, y: number) => ({ x, y });

/** Rectangular W×H floor with a wall ring; door cells replace ring cells. */
export function rawLevel(w: number, h: number, blocks: RawBlock[], doors: RawDoor[], extra: Record<string, unknown> = {}): RawLevel {
  const doorCells = new Set(doors.flatMap((d) => d.BPMS.map((p) => `${p.x ?? p.X},${p.y ?? p.Y}`)));
  const CMS: RawLevel["CMS"] = [], WMS: RawLevel["WMS"] = [];
  for (let x = -1; x <= w; x++) for (let y = -1; y <= h; y++) {
    if (x >= 0 && x < w && y >= 0 && y < h) CMS.push({ BPM: P(x, y) });
    else if (!doorCells.has(`${x},${y}`)) WMS.push({ BPM: P(x, y) });
  }
  return { LID: "fixture", BMS: blocks, DMS: doors, WMS, CMS, ...extra };
}
