// Shared GameState model. Mirrors schema/game-state.schema.json.

export const COLOR_NAMES = [
  "red", "blue", "yellow", "green", "purple", "orange",
  "pink", "darkblue", "turquoise", "darkgreen", "white", "black",
] as const;

export type ColorName = (typeof COLOR_NAMES)[number];

export interface Cell {
  x: number;
  y: number;
}

/** Direction a block travels. Board y grows upward (Unity convention). */
export type Dir = "up" | "down" | "left" | "right";

export type Axis = "both" | "horizontal" | "vertical";

export interface Block {
  id: string;
  color: ColorName;
  /** Absolute board cells currently covered. */
  cells: Cell[];
  axis: Axis;
  /** Frozen while > 0; drops by one every time any block exits. */
  ice: number;
  /** Inner layer colours revealed after the outer layer exits (outer → inner). */
  layers: ColorName[];
}

export interface Door {
  id: string;
  color: ColorName;
  cells: Cell[];
  /** Which edge of the board the door sits on; blocks exit by moving toward it. */
  side: Dir;
  /** Closed while > 0; drops by one every time any block exits. */
  ice: number;
  boardId: number;
}

export interface Board {
  /** Playable floor cells. */
  floor: Cell[];
  walls: Cell[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Status = "playing" | "won" | "stuck";

export interface GameState {
  levelId: string;
  levelIndex?: number;
  board: Board;
  blocks: Block[];
  doors: Door[];
  exited: string[];
  moveCount: number;
  status: Status;
  /** Level mechanics present in the source file that the engine does not model yet. */
  unsupported: string[];
}

export type Move =
  | { kind: "slide"; blockId: string; dx: number; dy: number; path: Cell[] }
  | { kind: "exit"; blockId: string; doorId: string; dx: number; dy: number; path: Cell[] };

export const DIRS: Record<Dir, Cell> = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
