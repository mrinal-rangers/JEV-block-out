import { applyMove, legalMoves } from "./engine.ts";
import { renderAscii } from "./render.ts";
import { DIRS, type ColorName, type GameState, type Move } from "./types.ts";

export interface SolveResult {
  solved: boolean;
  moves: Move[];
  expanded: number;
  reason?: string;
  ms: number;
}

/**
 * Fast solver on a compact grid encoding. The readable engine (engine.ts) stays the source of truth:
 * every step the solver finds is replayed through legalMoves()/applyMove(), so a rules mismatch between
 * the two throws instead of producing a bogus plan.
 *
 * Ice on blocks/doors drops by one per exit, so it is derived from the exit count rather than stored.
 */
export function solve(start: GameState, opts: { maxNodes?: number; weight?: number } = {}): SolveResult {
  const t0 = Date.now();
  const maxNodes = opts.maxNodes ?? 200_000;
  const weight = opts.weight ?? 2;
  if (start.unsupported.length) {
    return { solved: false, moves: [], expanded: 0, reason: `unsupported: ${start.unsupported.join(", ")}`, ms: 0 };
  }
  const P = compile(start);
  const nB = P.blocks.length;

  interface Node { anchors: Int16Array; layer: Uint8Array; exits: number; g: number; f: number; parent: Node | null; step: Step | null }
  const root: Node = {
    anchors: Int16Array.from(P.blocks.map((b) => b.anchor0)),
    layer: new Uint8Array(nB),
    exits: 0, g: 0, f: 0, parent: null, step: null,
  };
  closeExits(P, root);
  const open = new Heap<Node>();
  open.push(root);
  const seen = new Set<string>([key(root)]);
  let expanded = 0;

  while (open.size) {
    const node = open.pop()!;
    if (remaining(node) === 0) return { solved: true, moves: replay(start, node), expanded, ms: Date.now() - t0 };
    if (++expanded > maxNodes) return { solved: false, moves: [], expanded, reason: "node limit", ms: Date.now() - t0 };
    const occ = occupancy(P, node.anchors);
    for (let bi = 0; bi < nB; bi++) {
      if (node.anchors[bi]! < 0 || iceOf(P.blocks[bi]!.ice, node.exits) > 0) continue;
      const lb = P.blocks[bi]!;
      if (node.layer[bi]! < lb.layers.length) {
        const exit = findExit(P, occ, bi, node.anchors[bi]!, colorAt(lb, node.layer[bi]!), node.exits);
        if (exit) {
          const child: Node = {
            anchors: node.anchors.slice(), layer: node.layer.slice(), exits: node.exits + 1,
            g: node.g + 1, f: 0, parent: node, step: { bi, kind: "exit", to: exit.a, door: exit.di },
          };
          child.anchors[bi] = exit.a;
          child.layer[bi]! += 1;
          closeExits(P, child);
          const k = key(child);
          if (!seen.has(k)) {
            seen.add(k);
            child.f = child.g + weight * (remaining(child) * 3 + blockers(P, child));
            open.push(child);
          }
        }
      }
      for (const a of reach(P, occ, bi, node.anchors[bi]!)) {
        const child: Node = {
          anchors: node.anchors.slice(), layer: node.layer.slice(), exits: node.exits,
          g: node.g + 1, f: 0, parent: node, step: { bi, kind: "slide", to: a },
        };
        child.anchors[bi] = a;
        closeExits(P, child);
        const k = key(child);
        if (seen.has(k)) continue;
        seen.add(k);
        child.f = child.g + weight * (remaining(child) * 3 + blockers(P, child));
        open.push(child);
      }
    }
  }
  return { solved: false, moves: [], expanded, reason: "no solution", ms: Date.now() - t0 };

  function remaining(n: Node) {
    let r = 0;
    for (let i = 0; i < nB; i++) if (n.anchors[i]! >= 0) r++;
    return r;
  }
  function key(n: Node) {
    return String.fromCharCode(...n.anchors.map((a) => a + 1)) + String.fromCharCode(...n.layer);
  }
  /** Greedily take every exit that removes a block; layered blocks are left to the search. */
  function closeExits(P: Compiled, n: Node) {
    for (let progress = true; progress;) {
      progress = false;
      const occ = occupancy(P, n.anchors);
      for (let bi = 0; bi < nB && !progress; bi++) {
        const a0 = n.anchors[bi]!;
        const b = P.blocks[bi]!;
        if (a0 < 0 || n.layer[bi]! < b.layers.length || iceOf(b.ice, n.exits) > 0) continue;
        const exit = findExit(P, occ, bi, a0, colorAt(b, n.layer[bi]!), n.exits);
        if (!exit) continue;
        const prev: Node = { ...n, anchors: n.anchors.slice(), layer: n.layer.slice() };
        n.parent = prev;
        n.step = { bi, kind: "exit", to: exit.a, door: exit.di };
        n.anchors[bi] = -1;
        n.exits += 1;
        progress = true;
      }
    }
  }  function blockers(P: Compiled, n: Node): number {
    const occ = occupancy(P, n.anchors);
    let total = 0;
    for (let bi = 0; bi < nB; bi++) {
      const a = n.anchors[bi]!;
      if (a < 0) continue;
      const b = P.blocks[bi]!;
      const color = colorAt(b, n.layer[bi]!);
      let best = 4;
      for (const d of P.doors) {
        if (d.color !== color) continue;
        if (iceOf(d.ice, n.exits) > 0) { best = Math.min(best, 3); continue; }
        best = Math.min(best, corridorCost(P, occ, bi, a, d));
      }
      total += best;
    }
    return total;
  }
}

// ---------------------------------------------------------------------------------------------

type Step = { bi: number; kind: "slide"; to: number } | { bi: number; kind: "exit"; to: number; door: number };

interface CBlock { id: string; shape: Int16Array; anchor0: number; ice: number; dirs: number[]; colors: ColorName[]; layers: ColorName[] }
interface CDoor { id: string; color: ColorName; ice: number; vertical: boolean; toward: number; step: number; line: number; span: Set<number> }
interface Compiled { W: number; ox: number; oy: number; floor: Uint8Array; blocks: CBlock[]; doors: CDoor[]; stamp: Int32Array; tick: { v: number } }

const iceOf = (ice: number, exits: number) => Math.max(0, ice - exits);
const colorAt = (b: CBlock, layer: number) => b.colors[layer]!;

function compile(s: GameState): Compiled {
  const all = [...s.board.floor, ...s.board.walls, ...s.doors.flatMap((d) => d.cells), ...s.blocks.flatMap((b) => b.cells)];
  const ox = Math.min(...all.map((c) => c.x)) - 1;
  const oy = Math.min(...all.map((c) => c.y)) - 1;
  const W = Math.max(...all.map((c) => c.x)) - ox + 2;
  const H = Math.max(...all.map((c) => c.y)) - oy + 2;
  const idx = (x: number, y: number) => x - ox + (y - oy) * W;
  const floor = new Uint8Array(W * H);
  for (const c of s.board.floor) floor[idx(c.x, c.y)] = 1;
  const dirStep = { up: W, down: -W, left: -1, right: 1 } as const;
  const blocks: CBlock[] = s.blocks.map((b) => {
    const a = idx(b.cells[0]!.x, b.cells[0]!.y);
    const dirs = b.axis === "horizontal" ? [-1, 1] : b.axis === "vertical" ? [W, -W] : [W, -W, -1, 1];
    return {
      id: b.id,
      shape: Int16Array.from(b.cells.map((c) => idx(c.x, c.y) - a)),
      anchor0: a, ice: b.ice, dirs, colors: [b.color, ...b.layers], layers: b.layers,
    };
  });
  const doors: CDoor[] = s.doors.map((d) => {
    const vertical = d.side === "up" || d.side === "down";
    return {
      id: d.id, color: d.color, ice: d.ice, vertical,
      toward: DIRS[d.side].x + DIRS[d.side].y,
      step: dirStep[d.side],
      line: vertical ? d.cells[0]!.y - oy : d.cells[0]!.x - ox,
      span: new Set(d.cells.map((c) => (vertical ? c.x - ox : c.y - oy))),
    };
  });
  return { W, ox, oy, floor, blocks, doors, stamp: new Int32Array(W * H), tick: { v: 0 } };
}

function occupancy(P: Compiled, anchors: Int16Array): Int16Array {
  const occ = new Int16Array(P.floor.length).fill(-1);
  for (let bi = 0; bi < anchors.length; bi++) {
    const a = anchors[bi]!;
    if (a < 0) continue;
    for (const o of P.blocks[bi]!.shape) occ[a + o] = bi;
  }
  return occ;
}

function fits(P: Compiled, occ: Int16Array, bi: number, a: number): boolean {
  for (const o of P.blocks[bi]!.shape) {
    const i = a + o;
    if (!P.floor[i]) return false;
    const v = occ[i]!;
    if (v !== -1 && v !== bi) return false;
  }
  return true;
}

/** Anchor positions reachable by sliding (excluding the start). */
function reach(P: Compiled, occ: Int16Array, bi: number, start: number): number[] {
  const t = ++P.tick.v;
  P.stamp[start] = t;
  const out: number[] = [];
  const q = [start];
  const dirs = P.blocks[bi]!.dirs;
  for (let h = 0; h < q.length; h++) {
    const cur = q[h]!;
    for (const d of dirs) {
      const n = cur + d;
      if (P.stamp[n] === t || !fits(P, occ, bi, n)) continue;
      P.stamp[n] = t;
      out.push(n);
      q.push(n);
    }
  }
  return out;
}

/** First (reach-order) anchor from which the block can leave through an open door of its colour. */
function findExit(P: Compiled, occ: Int16Array, bi: number, a0: number, color: ColorName, exits: number): { a: number; di: number } | null {
  const open = P.doors.map((d, i) => [d, i] as const).filter(([d]) => d.color === color && iceOf(d.ice, exits) === 0);
  if (!open.length) return null;
  for (const a of [a0, ...reach(P, occ, bi, a0)]) {
    for (const [d, di] of open) if (exitOk(P, occ, bi, a, d)) return { a, di };
  }
  return null;
}

function exitOk(P: Compiled, occ: Int16Array, bi: number, a: number, d: CDoor): boolean {
  const b = P.blocks[bi]!;
  if (!b.dirs.includes(d.step)) return false;
  for (const o of b.shape) {
    const i = a + o;
    const x = i % P.W, y = (i / P.W) | 0;
    if (!d.span.has(d.vertical ? x : y)) return false;
    for (let j = i + d.step, along = (d.vertical ? y : x) + d.toward; along !== d.line; j += d.step, along += d.toward) {
      if (!P.floor[j]) return false;
      const v = occ[j]!;
      if (v !== -1 && v !== bi) return false;
    }
  }
  return true;
}

/** Heuristic: misalignment + distinct blockers in the straight corridor to the door (+2 per wall). */
function corridorCost(P: Compiled, occ: Int16Array, bi: number, a: number, d: CDoor): number {
  const b = P.blocks[bi]!;
  let cost = 0;
  const lanes = new Set<number>();
  let edge = d.toward > 0 ? -Infinity : Infinity;
  for (const o of b.shape) {
    const i = a + o;
    const x = i % P.W, y = (i / P.W) | 0;
    lanes.add(d.vertical ? x : y);
    const al = d.vertical ? y : x;
    edge = d.toward > 0 ? Math.max(edge, al) : Math.min(edge, al);
  }
  for (const l of lanes) if (!d.span.has(l)) { cost = 1; break; }
  const seen = new Set<number>();
  for (const l of d.span) {
    for (let al = edge + d.toward; al !== d.line; al += d.toward) {
      const i = d.vertical ? l + al * P.W : al + l * P.W;
      if (!P.floor[i]) { cost += 2; break; }
      const v = occ[i]!;
      if (v !== -1 && v !== bi) seen.add(v);
    }
  }
  return cost + seen.size;
}

interface Chain { parent: Chain | null; step: Step | null }

/** Convert the compact step chain back into engine Moves (with drag paths) and validate each one. */
function replay(start: GameState, end: Chain): Move[] {
  const P = compile(start);
  const steps: Step[] = [];
  for (let n: Chain | null = end; n; n = n.parent) if (n.step) steps.push(n.step);
  steps.reverse();
  let s = start;
  const out: Move[] = [];
  for (const st of steps) {
    const b = P.blocks[st.bi]!;
    const cur = s.blocks.find((x) => x.id === b.id)!;
    const dx = (st.to % P.W) + P.ox - cur.cells[0]!.x;
    const dy = Math.floor(st.to / P.W) + P.oy - cur.cells[0]!.y;
    const doorId = st.kind === "exit" ? P.doors[st.door]!.id : undefined;
    // A block that fully leaves can use any approach; a layered block's resting spot matters.
    const anyApproach = st.kind === "exit" && cur.layers.length === 0;
    const m = legalMoves(s).find((x) =>
      x.blockId === b.id && x.kind === st.kind && (anyApproach || (x.dx === dx && x.dy === dy)) &&
      (x.kind === "slide" || x.doorId === doorId));
    if (!m) {
      throw new Error(`Solver/engine mismatch at move ${out.length + 1}: ${st.kind} ${b.id} (${dx},${dy}) ${doorId ?? ""}\n${renderAscii(s)}`);
    }
    out.push(m);
    s = applyMove(s, m);
  }
  if (s.blocks.length) throw new Error("Solver plan does not clear the board");
  return out;
}

class Heap<T extends { f: number }> {
  private a: T[] = [];
  get size() { return this.a.length; }
  push(n: T) {
    const a = this.a;
    a.push(n);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p]!.f <= a[i]!.f) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.f < a[m]!.f) m = l;
        if (r < a.length && a[r]!.f < a[m]!.f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}
