import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Cell, GameState, Move } from "@jev-block-out/core";

/**
 * Board-cell → screen-pixel mapping. Board y grows upward, screen y grows downward, so rows are flipped.
 * (left, top) is the pixel of the top-left corner of the board's bounding box (cell minX, maxY).
 */
export interface Calibration {
  screenW: number;
  screenH: number;
  left: number;
  top: number;
  cellPx: number;
}

export const CALIBRATION_FILE = resolve(process.env.JEV_CALIBRATION ?? "calibration.json");

export function cellCenter(cal: Calibration, s: Pick<GameState, "board">, c: Cell): { x: number; y: number } {
  return {
    x: Math.round(cal.left + (c.x - s.board.minX + 0.5) * cal.cellPx),
    y: Math.round(cal.top + (s.board.maxY - c.y + 0.5) * cal.cellPx),
  };
}

// Geometry of Block Out!'s purple board frame, measured on a 1080x2400 screen: around a floor of cols x rows cells the
// frame is (cols + 1.245) cells wide and (rows + 1.32) cells tall, and the first floor cell starts 0.64 cells right of /
// 0.80 cells below its outer corner.
const FRAME_EXTRA_W = 1.245;
const FRAME_EXTRA_H = 1.32;
const FRAME_INSET_X = 0.64;
const FRAME_INSET_Y = 0.8;

/** Floor bounding box (the board bounds also include the wall/door ring) and its offset inside the board bounds. */
function floorBox(s: Pick<GameState, "board">) {
  const f = s.board.floor.length ? s.board.floor : [{ x: s.board.minX, y: s.board.minY }, { x: s.board.maxX, y: s.board.maxY }];
  const xs = f.map((c) => c.x), ys = f.map((c) => c.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { cols: maxX - minX + 1, rows: maxY - minY + 1, padL: minX - s.board.minX, padT: s.board.maxY - maxY };
}

function fromFrame(s: Pick<GameState, "board">, frameL: number, frameT: number, cellPx: number, screenW: number, screenH: number): Calibration {
  const { padL, padT } = floorBox(s);
  return {
    screenW, screenH, cellPx: Math.round(cellPx * 10) / 10,
    left: Math.round(frameL + (FRAME_INSET_X - padL) * cellPx),
    top: Math.round(frameT + (FRAME_INSET_Y - padT) * cellPx),
  };
}

const boardKey = (s: Pick<GameState, "board">) => `${s.board.maxX - s.board.minX + 1}x${s.board.maxY - s.board.minY + 1}`;

/** Fallback when no screenshot is available: the frame is centred, ~85% of the width, centred at ~50.6% of the height. */
export function guessCalibration(s: Pick<GameState, "board">, screenW = 1080, screenH = 2400): Calibration {
  const { cols, rows } = floorBox(s);
  const cellPx = Math.min((screenW * 0.85) / (cols + FRAME_EXTRA_W), (screenH * 0.6) / (rows + FRAME_EXTRA_H));
  const frameL = (screenW - (cols + FRAME_EXTRA_W) * cellPx) / 2;
  const frameT = screenH * 0.506 - ((rows + FRAME_EXTRA_H) * cellPx) / 2;
  return fromFrame(s, frameL, frameT, cellPx, screenW, screenH);
}

export interface RgbaImage {
  w: number;
  h: number;
  /** w*h*4 bytes, RGBA. */
  data: Uint8Array;
}

const isFramePurple = (r: number, g: number, b: number) => b >= 150 && r >= 55 && r <= 120 && g >= 45 && g <= 110 && b - r > 70;

const isButtonGreen = (r: number, g: number, b: number) => g >= 150 && g - r > 70 && g - b > 90;

/**
 * Where to tap the green button on the game's end-of-level popup ("Continue" after a win, the free "Try Again" after
 * a fail): a purple panel spanning the screen with a green button at ~64% height. Null when no such popup is showing.
 * Coin-spending buttons such as "Add Time" sit lower on a dark backdrop, so they never match.
 */
export function winPopupContinue(img: RgbaImage): { x: number; y: number } | null {
  const { w, h, data } = img;
  const px = (x: number, y: number) => {
    const i = (Math.floor(y) * w + Math.floor(x)) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!] as const;
  };
  const panel = [0.15, 0.85].every((fx) => [0.4, 0.5].every((fy) => isFramePurple(...px(w * fx, h * fy))));
  if (!panel) return null;
  // The button is one green band ~7% of the screen tall (its white label breaks a few rows); a row of green blocks is
  // shorter and broken by gaps.
  let first = -1, last = -1, rows = 0;
  for (let fy = 0.56; fy <= 0.72; fy += 0.005) {
    let green = 0, n = 0;
    for (let fx = 0.3; fx <= 0.7; fx += 0.02, n++) if (isButtonGreen(...px(w * fx, h * fy))) green++;
    if (green / n >= 0.6) { if (first < 0) first = fy; last = fy; rows++; }
  }
  const span = last - first;
  return first >= 0 && span >= 0.05 && span <= 0.12 && rows >= (span / 0.005 + 1) * 0.6 ? { x: w / 2, y: h * ((first + last) / 2) } : null;
}

const isCloseRed = (r: number, g: number, b: number) => r >= 180 && g <= 90 && b <= 90;
const isWhite = (r: number, g: number, b: number) => r >= 215 && g >= 200 && b >= 180;

/**
 * Where to tap the red X that closes the game's coin-spending popups ("Out of Time → Add Time 900",
 * "Continue? → Play On 900"). Closing them leads to the free "FAILED → Try Again" popup. Matches only a round red
 * button with a white cross in the top-right corner while a wide green button is on screen; never returns the green
 * button itself, so no coins are spent.
 */
export function popupClose(img: RgbaImage): { x: number; y: number } | null {
  const { w, h, data } = img;
  const px = (x: number, y: number) => {
    const i = (Math.floor(y) * w + Math.floor(x)) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!] as const;
  };
  let greenRows = 0;
  for (let fy = 0.45; fy <= 0.9; fy += 0.005) {
    let green = 0, n = 0;
    for (let fx = 0.3; fx <= 0.7; fx += 0.02, n++) if (isButtonGreen(...px(w * fx, h * fy))) green++;
    if (green / n >= 0.6) greenRows++;
  }
  if (greenRows < 8) return null;
  const x0 = Math.floor(w * 0.8), x1 = Math.floor(w * 0.99), step = Math.max(1, Math.floor(w / 540));
  // The X button is the only big red blob in the top-right; look at each band where one could sit.
  for (let fy = 0.04; fy < 0.32; fy += 0.01) {
    const y0 = Math.floor(h * fy), y1 = Math.floor(h * (fy + 0.06));
    let n = 0, sx = 0, sy = 0, minX = w, maxX = 0, minY = h, maxY = 0;
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      if (!isCloseRed(...px(x, y))) continue;
      n++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const bw = maxX - minX, bh = maxY - minY;
    if (n * step * step < w * w * 0.002 || bw < w * 0.05 || bw > w * 0.14 || bh < bw * 0.7 || bh > bw * 1.3) continue;
    // Not touching the band's edges (so the whole button is inside it), and with a white cross in the middle.
    if (minY <= y0 + step || maxY >= y1 - 2 * step) continue;
    const cx = sx / n, cy = sy / n;
    let white = 0, m = 0;
    for (let y = cy - bh * 0.3; y <= cy + bh * 0.3; y += step) for (let x = cx - bw * 0.3; x <= cx + bw * 0.3; x += step, m++) if (isWhite(...px(x, y))) white++;
    if (white / m >= 0.08 && white / m <= 0.6) return { x: Math.round(cx), y: Math.round(cy) };
  }
  return null;
}

/**
 * Where to tap the big green "Level N" play button on the game's home screen (the game goes there after a lost
 * level). Matches one green band at ~74–83% height above the purple bottom navigation bar.
 */
export function homePlay(img: RgbaImage): { x: number; y: number } | null {
  const { w, h, data } = img;
  const px = (x: number, y: number) => {
    const i = (Math.floor(y) * w + Math.floor(x)) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!] as const;
  };
  const [nr, ng, nb] = px(w / 2, h * 0.96);
  if (!(nb >= 110 && nb - nr > 60 && nb - ng > 60)) return null;
  let first = -1, last = -1, rows = 0;
  for (let fy = 0.7; fy <= 0.87; fy += 0.005) {
    let green = 0, n = 0;
    for (let fx = 0.3; fx <= 0.7; fx += 0.02, n++) if (isButtonGreen(...px(w * fx, h * fy))) green++;
    if (green / n >= 0.6) { if (first < 0) first = fy; last = fy; rows++; }
  }
  const span = last - first;
  return first >= 0 && span >= 0.05 && span <= 0.12 && rows >= (span / 0.005 + 1) * 0.5 ? { x: w / 2, y: h * ((first + last) / 2) } : null;
}

export interface Frame {
  left: number;
  top: number;
  w: number;
  h: number;
}

/** Bounding box of the game's purple board frame, or null when none is visible (menu, popup, another app). */
export function detectFrame(img: RgbaImage): Frame | null {
  const { w, h, data } = img;
  const y0 = Math.floor(h * 0.15), y1 = Math.floor(h * 0.85);
  const rowHits = new Uint32Array(h), colHits = new Uint32Array(w);
  for (let y = y0; y < y1; y++) {
    let i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4) {
      if (isFramePurple(data[i]!, data[i + 1]!, data[i + 2]!)) { rowHits[y]!++; colHits[x]!++; }
    }
  }
  const min = Math.max(20, Math.round(w * 0.02));
  let top = -1, bottom = -1, left = -1, right = -1;
  for (let y = y0; y < y1; y++) if (rowHits[y]! > min) { if (top < 0) top = y; bottom = y; }
  for (let x = 0; x < w; x++) if (colHits[x]! > min) { if (left < 0) left = x; right = x; }
  if (top < 0 || left < 0) return null;
  const frameW = right - left + 1, frameH = bottom - top + 1;
  if (frameW < w * 0.3 || frameH < w * 0.3) return null;
  return { left, top, w: frameW, h: frameH };
}

/** Calibration for level `s` inside a detected frame, or null when the frame's shape does not fit the level. */
export function calibrationFromFrame(f: Frame, s: Pick<GameState, "board">, screenW: number, screenH: number): Calibration | null {
  const { cols, rows } = floorBox(s);
  const cw = f.w / (cols + FRAME_EXTRA_W), ch = f.h / (rows + FRAME_EXTRA_H);
  // The frame wraps the floor's bounding box, so both axes must agree; otherwise this is not the expected level.
  if (Math.abs(cw - ch) / Math.max(cw, ch) > 0.08) return null;
  return fromFrame(s, f.left, f.top, (cw + ch) / 2, screenW, screenH);
}

/**
 * Finds the board from the game's purple frame in a raw screenshot. Returns null when no plausible frame is visible
 * or its shape does not fit `s`, so callers can fall back to the guess.
 */
export function detectCalibration(img: RgbaImage, s: Pick<GameState, "board">): Calibration | null {
  const f = detectFrame(img);
  return f && calibrationFromFrame(f, s, img.w, img.h);
}

type Rgb = [number, number, number];
const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Empty floor tiles are dark navy; black blocks are dark but neutral. */
const isFloor = ([r, g, b]: Rgb) => Math.max(r, g, b) < 130 && b - r > 15 && b - g > 15;

function sampleCell(img: RgbaImage, cal: Calibration, s: Pick<GameState, "board">, c: Cell): Rgb | null {
  const p = cellCenter(cal, s, c);
  const k = Math.max(1, Math.round(cal.cellPx * 0.04));
  if (p.x - k < 0 || p.y - k < 0 || p.x + k >= img.w || p.y + k >= img.h) return null;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = p.y - k; y <= p.y + k; y++) {
    for (let x = p.x - k, i = (y * img.w + x) * 4; x <= p.x + k; x++, i += 4) { r += img.data[i]!; g += img.data[i + 1]!; b += img.data[i + 2]!; n++; }
  }
  return [r / n, g / n, b / n];
}

/**
 * How well the screen shows level `s` (0..1): every empty floor cell must look like floor, and the cells of each block
 * colour must look alike, unlike the floor and unlike the other colours. Wrong levels put floor where blocks are and
 * mix colours, so they score low.
 */
export function screenMatch(img: RgbaImage, s: Pick<GameState, "board" | "blocks">, cal: Calibration): number {
  const occupied = new Set<string>();
  const byColor = new Map<string, Rgb[]>();
  let skipped = 0;
  for (const b of s.blocks) {
    for (const c of b.cells) {
      occupied.add(`${c.x},${c.y}`);
      if (b.ice > 0) continue; // frozen blocks are drawn under ice
      const px = sampleCell(img, cal, s, c);
      if (!px) { skipped++; continue; }
      byColor.set(b.color, [...(byColor.get(b.color) ?? []), px]);
    }
  }
  let ok = 0, total = skipped;
  for (const c of s.board.floor) {
    if (occupied.has(`${c.x},${c.y}`)) continue;
    const px = sampleCell(img, cal, s, c);
    total++;
    if (px && isFloor(px)) ok++;
  }
  const means = new Map<string, Rgb>();
  for (const [color, pxs] of byColor) {
    means.set(color, [0, 1, 2].map((i) => pxs.reduce((a, p) => a + p[i]!, 0) / pxs.length) as Rgb);
  }
  for (const [color, pxs] of byColor) {
    const m = means.get(color)!;
    const distinct = [...means].every(([o, om]) => o === color || dist(m, om) > 40);
    for (const p of pxs) {
      total++;
      if (distinct && !isFloor(p) && dist(p, m) < 50) ok++;
    }
  }
  return total ? ok / total : 0;
}

export interface LevelMatch<T extends Pick<GameState, "board" | "blocks">> {
  state: T;
  calibration: Calibration;
  score: number;
}

/** The candidate level the screen shows best (score ≥ `min`), or null when none fits (menu, popup, mid-level). */
export function identifyLevel<T extends Pick<GameState, "board" | "blocks">>(img: RgbaImage, candidates: Iterable<T>, min = 0.9): LevelMatch<T> | null {
  const f = detectFrame(img);
  if (!f) return null;
  let best: LevelMatch<T> | null = null;
  for (const state of candidates) {
    const cal = calibrationFromFrame(f, state, img.w, img.h);
    if (!cal) continue;
    const score = screenMatch(img, state, cal);
    if (score >= min && (!best || score > best.score)) best = { state, calibration: cal, score };
  }
  return best;
}

/** `calibration.json` (keyed "COLSxROWS") wins, then frame detection on `img`, then the guess. */
export function loadCalibration(s: Pick<GameState, "board">, img?: RgbaImage | null, file = CALIBRATION_FILE): Calibration {
  if (existsSync(file)) {
    const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, Calibration>;
    if (all[boardKey(s)]) return all[boardKey(s)]!;
  }
  return (img && detectCalibration(img, s)) ?? guessCalibration(s, img?.w, img?.h);
}

export function saveCalibration(s: Pick<GameState, "board">, cal: Calibration, file = CALIBRATION_FILE): void {
  const all = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Calibration>) : {};
  all[boardKey(s)] = cal;
  writeFileSync(file, JSON.stringify(all, null, 2));
}

/**
 * Pixel waypoints for dragging a move: press on the block's first cell, follow the move path (cumulative offsets),
 * release. Exit paths already extend through the door.
 */
export function dragPath(cal: Calibration, s: GameState, m: Move): { x: number; y: number }[] {
  const b = s.blocks.find((x) => x.id === m.blockId);
  if (!b) throw new Error(`No block ${m.blockId}`);
  const grip = b.cells[0]!;
  const pts = [cellCenter(cal, s, grip), ...m.path.map((o) => cellCenter(cal, s, { x: grip.x + o.x, y: grip.y + o.y }))];
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.y !== pts[i - 1]!.y);
}
