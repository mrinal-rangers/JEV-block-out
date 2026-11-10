import { listLevels, loadLevel, type GameState } from "@jev-block-out/core";
import type { Device } from "./device.ts";
import { homePlay, identifyLevel, popupClose, winPopupContinue, type LevelMatch } from "./screen.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lazily parsed extracted levels, used to recognise which level the real game is showing. */
export class LevelIndex {
  private cache = new Map<number, GameState | null>();
  private nums: number[] | null = null;
  private loading: Promise<GameState[]> | null = null;

  numbers(): number[] {
    return (this.nums ??= listLevels());
  }

  get(n: number): GameState | null {
    if (!this.cache.has(n)) {
      try { this.cache.set(n, loadLevel(n)); } catch { this.cache.set(n, null); }
    }
    return this.cache.get(n)!;
  }

  /** Levels in [from, to] that exist and parse. */
  range(from: number, to: number): GameState[] {
    return this.numbers().filter((n) => n >= from && n <= to).map((n) => this.get(n)).filter((s): s is GameState => !!s);
  }

  /** Every level; parsing ~1,300 files takes a few seconds, so it yields to the event loop as it goes. */
  all(): Promise<GameState[]> {
    return (this.loading ??= (async () => {
      const out: GameState[] = [];
      for (const [i, n] of this.numbers().entries()) {
        const s = this.get(n);
        if (s) out.push(s);
        if (i % 50 === 49) await new Promise((r) => setImmediate(r));
      }
      return out;
    })());
  }
}

export type GameLevel = LevelMatch<GameState> & { level: number };

/**
 * Waits until the real game shows a level we know, and says which one (from its blocks' colours and positions).
 * Levels near `hint` are tried first; with a hint the full set is only searched in the last third of the wait, so a
 * half-drawn level during the game's transition is not mistaken for another one. Unless `stable` is false, the same
 * level must be seen on two screenshots in a row. Null on timeout or when `cancelled()`.
 */
export async function findGameLevel(
  device: Device,
  index: LevelIndex,
  opts: { hint?: number; timeoutMs?: number; intervalMs?: number; stable?: boolean; cancelled?: () => boolean; dismissPopups?: boolean; onDismiss?: (popup: "continue" | "close" | "home") => void } = {},
): Promise<GameLevel | null> {
  const timeout = opts.timeoutMs ?? 8000, t0 = Date.now(), deadline = t0 + timeout;
  let prev: number | null = null;
  for (;;) {
    if (opts.cancelled?.()) return null;
    const img = await device.rawScreenshot().catch(() => null);
    let m: LevelMatch<GameState> | null = null;
    if (img) {
      const near = opts.hint ? index.range(opts.hint - 1, opts.hint + 3) : [];
      const wide = !opts.hint || Date.now() - t0 >= (timeout * 2) / 3;
      m = identifyLevel(img, near) ?? (wide ? identifyLevel(img, await index.all()) : null);
      if (!m && opts.dismissPopups) {
        const cont = winPopupContinue(img), close = cont ? null : popupClose(img), home = cont || close ? null : homePlay(img), at = cont ?? close ?? home;
        if (at) { await device.tap(at.x, at.y).catch(() => {}); opts.onDismiss?.(cont ? "continue" : close ? "close" : "home"); }
      }
    }
    const level = m?.state.levelIndex ?? null;
    if (m && level != null && (opts.stable === false || level === prev)) return { ...m, level };
    prev = level;
    if (Date.now() >= deadline && (opts.stable === false || prev == null)) return null;
    if (Date.now() >= deadline + (opts.intervalMs ?? 600) * 2) return null;
    await sleep(opts.intervalMs ?? 600);
  }
}
