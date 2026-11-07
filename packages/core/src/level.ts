import { COLOR_NAMES, type Axis, type Block, type Cell, type ColorName, type Dir, type Door, type GameState } from "./types.ts";

/** Raw level JSON as shipped in the game (Newtonsoft short keys, see docs/game-internals.md). */
/** Most levels use lower-case x/y; some older ones serialise X/Y. */
export interface RawPos { x?: number; y?: number; X?: number; Y?: number }
const pos = (p: RawPos): Cell => ({ x: p.x ?? p.X ?? NaN, y: p.y ?? p.Y ?? NaN });
export interface RawBlock {
  BCT: number; BPMS: RawPos[]; BIC?: number; BAD?: number; KID?: number; BKID?: number;
  LKI?: number[] | null; LID?: number; BHS?: boolean; BD?: number; ILE?: boolean; LBCT?: number;
  SLBCT?: number[] | null; LIC?: number; MIC?: boolean; AD?: number;
}
export interface RawDoor { BCT: number; BPMS: RawPos[]; IH?: boolean; BI?: number; DIC?: number; TBD?: number; DHS?: boolean }
export interface RawLevel {
  LID?: string;
  BMS: RawBlock[];
  DMS: RawDoor[];
  WMS: { BPM: RawPos; BI?: number }[];
  CMS: { BPM: RawPos }[];
  [key: string]: unknown;
}

/** Optional level arrays and what they mean (from LevelModel in the IL2CPP dump). */
const FEATURE_ARRAYS: Record<string, string> = {
  IWMS: "inner walls",
  CIWMS: "colour inner walls",
  GMS: "generators",
  EMS: "elevators",
  CLMS: "curtain locks",
  CCMS: "colour cells",
  GRM: "grinders",
  CGRM: "colour grinders",
  CBMS: "connected blocks",
  IBG: "in-board generators",
  CCLMS: "colour curtain locks",
  IMS: "ivy",
  BKMS: "box keys",
};

export function colorName(c: number): ColorName {
  const n = COLOR_NAMES[c];
  if (!n) throw new Error(`Unknown BlockColorType ${c}`);
  return n;
}

const key = (c: Cell) => `${c.x},${c.y}`;

function axisOf(bad: number | undefined): Axis {
  if (bad === 1) return "horizontal";
  if (bad === 2) return "vertical";
  return "both";
}

function doorSide(cells: Cell[], horizontal: boolean, floor: Set<string>): Dir {
  for (const c of cells) {
    if (horizontal) {
      if (floor.has(key({ x: c.x, y: c.y - 1 }))) return "up";
      if (floor.has(key({ x: c.x, y: c.y + 1 }))) return "down";
    } else {
      if (floor.has(key({ x: c.x - 1, y: c.y }))) return "right";
      if (floor.has(key({ x: c.x + 1, y: c.y }))) return "left";
    }
  }
  throw new Error(`Door at ${cells.map(key).join(" ")} does not touch the floor`);
}

export function parseLevel(raw: RawLevel | string, opts: { levelId?: string; levelIndex?: number } = {}): GameState {
  const lvl: RawLevel = typeof raw === "string" ? JSON.parse(raw.replace(/^\uFEFF/, "")) : raw;
  const floor = lvl.CMS.map((c) => pos(c.BPM));
  const walls = lvl.WMS.map((w) => pos(w.BPM));
  const floorSet = new Set(floor.map(key));
  const unsupported = new Set<string>();

  for (const [k, label] of Object.entries(FEATURE_ARRAYS)) {
    const v = lvl[k];
    if (Array.isArray(v) && v.length > 0) unsupported.add(label);
  }

  const blocks: Block[] = lvl.BMS.map((b, i) => {
    if (b.KID || b.LID || (b.LKI && b.LKI.length)) unsupported.add("keys/locks");
    if (b.BKID) unsupported.add("box keys");
    if (b.BD) unsupported.add("bomb timers");
    if (b.MIC) unsupported.add("moving ice");
    if (b.LIC) unsupported.add("layered ice");
    if (b.SLBCT && b.SLBCT.length) unsupported.add("stacked layers");
    const layers: ColorName[] = b.ILE ? [colorName(b.LBCT ?? 0)] : [];
    return {
      id: `b${i}`,
      color: colorName(b.BCT),
      cells: b.BPMS.map(pos),
      axis: axisOf(b.BAD),
      ice: b.BIC ?? 0,
      layers,
    };
  });

  const doors: Door[] = lvl.DMS.map((d, i) => {
    if (d.TBD) unsupported.add("turn-based doors");
    const cells = d.BPMS.map(pos);
    return {
      id: `d${i}`,
      color: colorName(d.BCT),
      cells,
      side: doorSide(cells, !!d.IH, floorSet),
      ice: d.DIC ?? 0,
      boardId: d.BI ?? 1,
    };
  });

  const xs = [...floor, ...walls].map((c) => c.x);
  const ys = [...floor, ...walls].map((c) => c.y);
  return {
    levelId: opts.levelId ?? lvl.LID ?? "unknown",
    levelIndex: opts.levelIndex,
    board: { floor, walls, minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    blocks,
    doors,
    exited: [],
    moveCount: 0,
    status: blocks.length === 0 ? "won" : "playing",
    unsupported: [...unsupported].sort(),
  };
}
