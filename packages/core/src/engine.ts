import { DIRS, type Block, type Cell, type Dir, type Door, type GameState, type Move } from "./types.ts";

export const cellKey = (c: Cell) => `${c.x},${c.y}`;

/** Directions a block may travel given its axis restriction. */
function dirsFor(b: Block): Dir[] {
  if (b.axis === "horizontal") return ["left", "right"];
  if (b.axis === "vertical") return ["up", "down"];
  return ["up", "down", "left", "right"];
}

export interface Ctx {
  floor: Set<string>;
  occupied: Map<string, string>;
}

export function context(s: GameState): Ctx {
  const floor = new Set(s.board.floor.map(cellKey));
  const occupied = new Map<string, string>();
  for (const b of s.blocks) for (const c of b.cells) occupied.set(cellKey(c), b.id);
  return { floor, occupied };
}

function isFreeFor(ctx: Ctx, c: Cell, blockId: string): boolean {
  const k = cellKey(c);
  if (!ctx.floor.has(k)) return false;
  const o = ctx.occupied.get(k);
  return o === undefined || o === blockId;
}

const shift = (cells: Cell[], dx: number, dy: number) => cells.map((c) => ({ x: c.x + dx, y: c.y + dy }));

/**
 * Every offset the block can reach by sliding through free floor, with the waypoint path to get there.
 * Paths are lists of cumulative offsets, one per unit step, so the device layer can replay them as a drag.
 */
export function reachable(s: GameState, b: Block, ctx: Ctx = context(s)): Map<string, Cell[]> {
  const out = new Map<string, Cell[]>([["0,0", []]]);
  if (b.ice > 0) return out;
  const queue: Cell[] = [{ x: 0, y: 0 }];
  const dirs = dirsFor(b);
  while (queue.length) {
    const cur = queue.shift()!;
    const curPath = out.get(cellKey(cur))!;
    for (const d of dirs) {
      const nx = cur.x + DIRS[d].x, ny = cur.y + DIRS[d].y;
      const nk = `${nx},${ny}`;
      if (out.has(nk)) continue;
      if (!b.cells.every((c) => isFreeFor(ctx, { x: c.x + nx, y: c.y + ny }, b.id))) continue;
      out.set(nk, [...curPath, { x: nx, y: ny }]);
      queue.push({ x: nx, y: ny });
    }
  }
  return out;
}

/** Can a block, sitting at `cells`, leave straight through `door`? */
export function canExitThrough(ctx: Ctx, b: Block, cells: Cell[], door: Door): boolean {
  if (b.ice > 0 || door.ice > 0 || door.color !== b.color) return false;
  const dirs = dirsFor(b);
  if (!dirs.includes(door.side)) return false;
  const vertical = door.side === "up" || door.side === "down";
  const span = new Set(door.cells.map((c) => (vertical ? c.x : c.y)));
  const line = vertical ? door.cells[0]!.y : door.cells[0]!.x;
  const step = DIRS[door.side];
  for (const c of cells) {
    if (!span.has(vertical ? c.x : c.y)) return false;
    let p = { x: c.x + step.x, y: c.y + step.y };
    while ((vertical ? p.y : p.x) !== line) {
      if (!isFreeFor(ctx, p, b.id)) return false;
      p = { x: p.x + step.x, y: p.y + step.y };
      if (Math.abs(p.x) > 1000 || Math.abs(p.y) > 1000) return false;
    }
  }
  return true;
}

/** Distance (in cells) from the block's leading edge to the door line plus the block's own depth — enough to clear the board. */
function exitTravel(cells: Cell[], door: Door): number {
  const vertical = door.side === "up" || door.side === "down";
  const line = vertical ? door.cells[0]!.y : door.cells[0]!.x;
  const coords = cells.map((c) => (vertical ? c.y : c.x));
  const far = door.side === "up" || door.side === "right" ? Math.min(...coords) : Math.max(...coords);
  return Math.abs(line - far) + 1;
}

export interface LegalMoveOptions {
  /** Cap on returned moves (Jev Choice questions accept at most 255 options). */
  limit?: number;
  /** Include plain relocations (default true). */
  slides?: boolean;
}

/** All legal moves: exits first (shortest path per block/door), then relocations ordered by path length. */
export function legalMoves(s: GameState, opts: LegalMoveOptions = {}): Move[] {
  if (s.status === "won") return [];
  const ctx = context(s);
  const exits: Move[] = [];
  const slides: Move[] = [];
  for (const b of s.blocks) {
    const doorsOpen = s.doors.some((d) => d.color === b.color && d.ice === 0);
    if (!(opts.slides ?? true) && (!doorsOpen || b.ice > 0)) continue;
    const reach = reachable(s, b, ctx);
    const doneDoors = new Set<string>();
    for (const [k, path] of reach) {
      const [dx, dy] = k.split(",").map(Number) as [number, number];
      const cells = shift(b.cells, dx, dy);
      for (const d of s.doors) {
        if ((doneDoors.has(d.id) && b.layers.length === 0) || !canExitThrough(ctx, b, cells, d)) continue;
        doneDoors.add(d.id);
        const n = exitTravel(cells, d);
        const st = DIRS[d.side];
        const tail = Array.from({ length: n }, (_, i) => ({ x: dx + st.x * (i + 1), y: dy + st.y * (i + 1) }));
        exits.push({ kind: "exit", blockId: b.id, doorId: d.id, dx, dy, path: [...path, ...tail] });
      }
      if ((opts.slides ?? true) && (dx !== 0 || dy !== 0)) {
        slides.push({ kind: "slide", blockId: b.id, dx, dy, path });
      }
    }
  }
  slides.sort((a, b) => a.path.length - b.path.length);
  const all = [...exits, ...slides];
  return opts.limit ? all.slice(0, opts.limit) : all;
}

/** Clone the mutable parts of a state; the board is immutable and shared. */
export function cloneState(s: GameState): GameState {
  return {
    ...s,
    blocks: s.blocks.map((b) => ({ ...b, cells: b.cells.map((c) => ({ ...c })), layers: [...b.layers] })),
    doors: s.doors.map((d) => ({ ...d })),
    exited: [...s.exited],
  };
}

/** Apply a move (assumed legal). Returns a new state; the input is not mutated. */
export function applyMove(s: GameState, m: Move): GameState {
  const n = cloneState(s);
  const b = n.blocks.find((x) => x.id === m.blockId);
  if (!b) throw new Error(`No block ${m.blockId}`);
  b.cells = shift(b.cells, m.dx, m.dy);
  n.moveCount += 1;
  if (m.kind === "exit") {
    if (b.layers.length > 0) {
      // Outer layer is collected at the door; the inner block stays where it stopped.
      b.color = b.layers.shift()!;
    } else {
      n.blocks = n.blocks.filter((x) => x.id !== b.id);
      n.exited.push(b.id);
    }
    for (const o of n.blocks) if (o.id !== b.id && o.ice > 0) o.ice -= 1;
    for (const d of n.doors) if (d.ice > 0) d.ice -= 1;
  }
  n.status = n.blocks.length === 0 ? "won" : "playing";
  return n;
}

/** Validate and apply: throws if the move is not in legalMoves(). */
export function applyLegal(s: GameState, m: Move): GameState {
  const ok = legalMoves(s).some(
    (x) => x.kind === m.kind && x.blockId === m.blockId && x.dx === m.dx && x.dy === m.dy &&
      (x.kind !== "exit" || (m.kind === "exit" && x.doorId === m.doorId)),
  );
  if (!ok) throw new Error(`Illegal move ${describeMove(s, m)}`);
  return evaluate(applyMove(s, m));
}

/** Recompute status, including stuck detection. */
export function evaluate(s: GameState): GameState {
  if (s.blocks.length === 0) return { ...s, status: "won" };
  return { ...s, status: legalMoves(s, { limit: 1 }).length === 0 ? "stuck" : "playing" };
}

const dirWord = (dx: number, dy: number) => {
  const parts: string[] = [];
  if (dy) parts.push(`${dy > 0 ? "up" : "down"} ${Math.abs(dy)}`);
  if (dx) parts.push(`${dx > 0 ? "right" : "left"} ${Math.abs(dx)}`);
  return parts.join(", ") || "in place";
};

/** Human-readable move text, used as Jev Choice option descriptions and in logs. */
export function describeMove(s: GameState, m: Move): string {
  const b = s.blocks.find((x) => x.id === m.blockId);
  const name = b ? `${b.color} block ${b.id} (${b.cells.length} cells)` : m.blockId;
  if (m.kind === "exit") {
    const d = s.doors.find((x) => x.id === m.doorId);
    const pre = m.dx || m.dy ? `slide ${dirWord(m.dx, m.dy)}, then ` : "";
    const layered = b && b.layers.length ? ` (sheds outer layer → becomes ${b.layers[0]})` : "";
    return `${name}: ${pre}exit through the ${d?.color} door on the ${d?.side === "up" ? "top" : d?.side === "down" ? "bottom" : d?.side} edge${layered}`;
  }
  return `${name}: slide ${dirWord(m.dx, m.dy)}`;
}

/**
 * Plateau heuristic: for each remaining block, how many other blocks sit in the straight corridor between it
 * and its nearest open matching door (+1 if not lined up with the door, +3 if its door is still frozen).
 */
export function obstruction(s: GameState): number {
  const ctx = context(s);
  let total = 0;
  for (const b of s.blocks) {
    let best = b.ice > 0 ? 3 : Infinity;
    for (const d of s.doors) {
      if (d.color !== b.color) continue;
      if (d.ice > 0) { best = Math.min(best, 3); continue; }
      const vertical = d.side === "up" || d.side === "down";
      const lane = (c: { x: number; y: number }) => (vertical ? c.x : c.y);
      const along = (c: { x: number; y: number }) => (vertical ? c.y : c.x);
      const span = new Set(d.cells.map(lane));
      const line = along(d.cells[0]!);
      const toward = d.side === "up" || d.side === "right" ? 1 : -1;
      const edge = toward > 0 ? Math.max(...b.cells.map(along)) : Math.min(...b.cells.map(along));
      const lanes = new Set(b.cells.map(lane));
      let cost = [...lanes].every((l) => span.has(l)) ? 0 : 1;
      const blockers = new Set<string>();
      for (const l of span) {
        for (let p = edge + toward; p !== line; p += toward) {
          const c = vertical ? { x: l, y: p } : { x: p, y: l };
          const k = cellKey(c);
          if (!ctx.floor.has(k)) { cost += 2; break; }
          const o = ctx.occupied.get(k);
          if (o && o !== b.id) blockers.add(o);
        }
      }
      best = Math.min(best, cost + blockers.size);
    }
    total += best === Infinity ? 3 : best;
  }
  return total;
}

export const moveId = (m: Move) =>
  m.kind === "exit" ? `exit:${m.blockId}:${m.doorId}:${m.dx}:${m.dy}` : `slide:${m.blockId}:${m.dx}:${m.dy}`;
