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

/**
 * First guess before on-device calibration: board centred horizontally using ~88% of the width (capped so tall
 * boards fit ~55% of the height), centred slightly below mid-screen. Refine with `calibration.json`.
 */
export function guessCalibration(s: Pick<GameState, "board">, screenW = 1080, screenH = 2400): Calibration {
  const cols = s.board.maxX - s.board.minX + 1;
  const rows = s.board.maxY - s.board.minY + 1;
  const cellPx = Math.floor(Math.min((screenW * 0.88) / cols, (screenH * 0.55) / rows));
  return {
    screenW, screenH, cellPx,
    left: Math.round((screenW - cols * cellPx) / 2),
    top: Math.round(screenH * 0.53 - (rows * cellPx) / 2),
  };
}

export function loadCalibration(s: Pick<GameState, "board">, file = CALIBRATION_FILE): Calibration {
  if (!existsSync(file)) return guessCalibration(s);
  const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, Calibration>;
  const key = `${s.board.maxX - s.board.minX + 1}x${s.board.maxY - s.board.minY + 1}`;
  return all[key] ?? guessCalibration(s);
}

export function saveCalibration(s: Pick<GameState, "board">, cal: Calibration, file = CALIBRATION_FILE): void {
  const all = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Calibration>) : {};
  all[`${s.board.maxX - s.board.minX + 1}x${s.board.maxY - s.board.minY + 1}`] = cal;
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
