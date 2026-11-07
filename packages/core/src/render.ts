import { cellKey } from "./engine.ts";
import type { ColorName, GameState } from "./types.ts";

export const COLOR_CHAR: Record<ColorName, string> = {
  red: "R", blue: "B", yellow: "Y", green: "G", purple: "P", orange: "O",
  pink: "K", darkblue: "D", turquoise: "T", darkgreen: "E", white: "W", black: "X",
};

/** ASCII board, top row first. Blocks = UPPER, doors = lower, frozen = '*' suffix in legend, wall '#', floor '.'. */
export function renderAscii(s: GameState): string {
  const grid = new Map<string, string>();
  for (const w of s.board.walls) grid.set(cellKey(w), "#");
  for (const f of s.board.floor) grid.set(cellKey(f), ".");
  for (const d of s.doors) for (const c of d.cells) grid.set(cellKey(c), d.ice > 0 ? "=" : COLOR_CHAR[d.color].toLowerCase());
  for (const b of s.blocks) for (const c of b.cells) grid.set(cellKey(c), COLOR_CHAR[b.color]);
  const xs = [...grid.keys()].map((k) => Number(k.split(",")[0]));
  const ys = [...grid.keys()].map((k) => Number(k.split(",")[1]));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const rows: string[] = [];
  for (let y = y1; y >= y0; y--) {
    let r = "";
    for (let x = x0; x <= x1; x++) r += grid.get(`${x},${y}`) ?? " ";
    rows.push(r);
  }
  const notes = [
    ...s.blocks.filter((b) => b.ice > 0 || b.layers.length || b.axis !== "both").map((b) =>
      `${b.id} ${b.color}${b.ice ? ` ice=${b.ice}` : ""}${b.layers.length ? ` layers=${b.layers.join(">")}` : ""}${b.axis !== "both" ? ` axis=${b.axis}` : ""}`),
    ...s.doors.filter((d) => d.ice > 0).map((d) => `${d.id} ${d.color} door ice=${d.ice}`),
  ];
  return rows.join("\n") + (notes.length ? `\n${notes.join("\n")}` : "");
}
