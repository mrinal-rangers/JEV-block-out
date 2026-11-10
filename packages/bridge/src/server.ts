import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasLevels, loadLevel, loadLevelMeta, parseLevel, type GameState } from "@jev-block-out/core";
import { Device } from "./device.ts";
import { findGameLevel, LevelIndex, type GameLevel } from "./game.ts";
import { deciderConfigured, makeDecider } from "./jev.ts";
import { planFor } from "./plans.ts";
import { Runner, type RunEvent } from "./runner.ts";
import { ScrcpyStream } from "./stream.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, "..", "public");
export const DEMO_LEVEL = resolve(here, "..", "..", "..", "examples", "demo-level.json");

export function loadAnyLevel(level: string): GameState {
  if (level === "demo") return parseLevel(readFileSync(DEMO_LEVEL, "utf8"), { levelId: "demo" });
  const n = Number(level);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Bad level ${level}`);
  if (!hasLevels()) throw new Error("No extracted levels found — run `npm run levels -- <your.xapk>` or use level=demo");
  return loadLevel(n);
}

/** Which deciders can run with the keys in this process's environment. */
export function availableDeciders(): Record<string, boolean> {
  return Object.fromEntries(["jev", "openai", "clef", "gemini", "mock", "solver"].map((k) => [k, deciderConfigured(k)]));
}

interface RunRequest { lane?: string; level?: string | number; decider?: string; delayMs?: number; device?: boolean; keepPlaying?: boolean; paused?: boolean; maxTurns?: number }
interface InputRequest { type?: string; x?: number; y?: number; x2?: number; y2?: number; ms?: number; key?: string }

const unit = (v: unknown): v is number => typeof v === "number" && v >= 0 && v <= 1;

/** One independent run shown as a column in the viewer. Several lanes can run in parallel. */
interface Lane { runner: Runner | null; running: boolean; device: boolean; stopped: boolean; history: RunEvent[] }

const LANE_ID = /^[a-z0-9]{1,8}$/;

/**
 * Live viewer.
 *   GET  /              page
 *   GET  /events        SSE; every event carries its `lane`
 *   GET  /state         lanes and whether they are running
 *   GET  /levels        level list + available deciders + device status
 *   GET  /screen        PNG screenshot of the connected emulator
 *   GET  /game          which level the real game is showing: {level, score} or {level: null}
 *   GET  /video         live H.264 stream of the real game (scrcpy), framed as u8 flags + u32 length + Annex B
 *   POST /input         {type: tap|swipe|key|launch, x, y, x2, y2 (0..1 of the screen), ms, key: back|home|appswitch}
 *   POST /run           {lane, level, decider, delayMs, device, keepPlaying, paused, maxTurns}; with device the level
 *                       is read from the game screen and keepPlaying continues as the game moves on to the next level
 *   POST /step | /pause | /resume | /stop   {lane?}; no lane = all lanes
 */
export function startServer(port = Number(process.env.PORT ?? 5173)) {
  const clients = new Set<ServerResponse>();
  const lanes = new Map<string, Lane>();
  const lane = (id: string): Lane => {
    let l = lanes.get(id);
    if (!l) lanes.set(id, (l = { runner: null, running: false, device: false, stopped: false, history: [] }));
    return l;
  };
  const index = new LevelIndex();
  // Recognising the game's level compares the screen against every extracted level; parse them up front.
  if (hasLevels()) setTimeout(() => void index.all(), 500);
  // Solve the game's current and next level in a worker while they are on screen, so play starts without waiting.
  const prefetch = (level: number) => {
    for (const n of [level, level + 1]) {
      const s = index.get(n);
      if (s) void planFor(s).catch(() => {});
    }
  };

  const broadcast = (id: string, e: RunEvent) => {
    const l = lane(id);
    if (e.type === "start") l.history = [];
    l.history.push(e);
    const data = `data: ${JSON.stringify({ lane: id, ...e })}\n\n`;
    for (const c of clients) c.write(data);
  };

  const body = <T = RunRequest>(req: IncomingMessage) =>
    new Promise<T>((ok) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({} as T); } });
    });

  // One shared scrcpy stream for every viewer and for touch injection; started on demand, stopped shortly after the
  // last viewer leaves unless a device run still needs it.
  let video: ScrcpyStream | null = null;
  let videoStarting: Promise<ScrcpyStream> | null = null;
  let videoIdle: NodeJS.Timeout | undefined;
  let videoPins = 0;
  const getVideo = (): Promise<ScrcpyStream> => {
    if (video && !video.ended) return Promise.resolve(video);
    if (!videoStarting) {
      const s = new ScrcpyStream();
      videoStarting = s.start()
        .then(() => { video = s; s.onceEnded(() => { if (video === s) video = null; }); return s; })
        .finally(() => { videoStarting = null; });
    }
    return videoStarting;
  };
  const idleVideo = () => {
    clearTimeout(videoIdle);
    const s = video;
    if (s && !s.subscribers && !videoPins) videoIdle = setTimeout(() => s.subscribers || videoPins || s.stop(), 15_000);
  };
  /** Touches through scrcpy's control socket (~1 s per drag instead of ~20 s with `adb shell input`). */
  const gesture = async (points: { x: number; y: number }[], durationMs?: number) => {
    const s = await getVideo();
    for (let i = 0; i < 30 && !s.canTouch; i++) await new Promise((r) => setTimeout(r, 100));
    await s.gesture(points, durationMs ? { durationMs } : {});
  };
  let screen: { w: number; h: number; at: number } | null = null;
  const screenSize = async (d: Device) => {
    if (!screen || Date.now() - screen.at > 30_000) screen = { ...(await d.screenSize()), at: Date.now() };
    return screen;
  };

  const json = (res: ServerResponse, code: number, v: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };

  const targets = (r: RunRequest): Lane[] => (r.lane ? (lanes.has(r.lane) ? [lanes.get(r.lane)!] : []) : [...lanes.values()]);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(readFileSync(join(PUBLIC, "index.html")));
      }
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(": connected\n\n");
        for (const [id, l] of lanes) for (const e of l.history) res.write(`data: ${JSON.stringify({ lane: id, ...e })}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/state") {
        return json(res, 200, {
          lanes: Object.fromEntries([...lanes].map(([id, l]) => [id, { running: l.running, events: l.history.length, last: l.history.at(-1)?.type ?? null }])),
        });
      }
      if (req.method === "GET" && url.pathname === "/levels") {
        const meta = hasLevels() ? [...loadLevelMeta().values()] : [];
        const d = new Device();
        const device = await d.isConnected().catch(() => false);
        const game = device ? await d.isGameInstalled().catch(() => false) : false;
        return json(res, 200, { demo: true, extracted: hasLevels(), levels: meta, deciders: availableDeciders(), device, game });
      }
      if (req.method === "GET" && url.pathname === "/video") {
        let s: ScrcpyStream;
        try {
          s = await getVideo();
        } catch (err) {
          return json(res, 503, { error: (err as Error).message });
        }
        clearTimeout(videoIdle);
        res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        const unsub = s.subscribe((c) => (res.writableLength > 8 << 20 ? res.destroy() : res.write(c)));
        const offEnd = s.onceEnded(() => res.end());
        req.on("close", () => {
          unsub();
          offEnd();
          idleVideo();
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/game") {
        const d = new Device();
        if (!hasLevels() || !(await d.isConnected().catch(() => false))) return json(res, 200, { level: null });
        const hint = Number(url.searchParams.get("hint")) || undefined;
        const m = await findGameLevel(d, index, { hint, timeoutMs: 0, stable: false });
        if (m) prefetch(m.level);
        return json(res, 200, m ? { level: m.level, score: m.score } : { level: null });
      }
      if (req.method === "POST" && url.pathname === "/input") {
        const r = await body<InputRequest>(req);
        const d = new Device();
        if (r.type === "launch") { await d.launchGame(); return json(res, 200, { ok: true }); }
        if (r.type === "key") {
          if (r.key !== "back" && r.key !== "home" && r.key !== "appswitch") return json(res, 400, { error: "key must be back, home or appswitch" });
          await d.key(r.key);
          return json(res, 200, { ok: true });
        }
        if (!unit(r.x) || !unit(r.y)) return json(res, 400, { error: "x and y must be numbers in 0..1" });
        const swipe = r.type === "swipe" && unit(r.x2) && unit(r.y2);
        if (r.type !== "tap" && !swipe) return json(res, 400, { error: "type must be tap, swipe (with x2, y2), key or launch" });
        const ms = Math.max(50, Math.min(3000, Number(r.ms) || 300));
        try {
          await gesture(swipe ? [{ x: r.x, y: r.y }, { x: r.x2!, y: r.y2! }] : [{ x: r.x, y: r.y }], swipe ? ms : undefined);
        } catch {
          const { w, h } = await screenSize(d);
          if (swipe) await d.swipe(r.x * w, r.y * h, r.x2! * w, r.y2! * h, ms);
          else await d.tap(r.x * w, r.y * h);
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/screen") {
        const d = new Device();
        if (!(await d.isConnected().catch(() => false))) return json(res, 404, { error: "no adb device" });
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        return res.end(await d.screenshot());
      }
      if (req.method === "POST" && url.pathname === "/run") {
        const r = await body(req);
        const id = r.lane ?? "a";
        if (!LANE_ID.test(id)) return json(res, 400, { error: `bad lane ${id}` });
        const l = lane(id);
        if (l.running) return json(res, 409, { error: `lane ${id} is already running — stop it first` });
        if (r.device && [...lanes.values()].some((o) => o !== l && o.running && o.device)) {
          return json(res, 409, { error: "the emulator is already used by another lane" });
        }
        const decider = makeDecider(r.decider);
        const onEvent = (e: RunEvent) => broadcast(id, e);
        if (r.device) {
          const device = new Device();
          if (!(await device.isConnected())) return json(res, 400, { error: "no adb device" });
          if (!hasLevels()) return json(res, 400, { error: "Playing the real game needs the extracted levels — run `npm run levels -- <your.xapk>`" });
          // Claim the lane before the (slow) screen search so a second /run can't race in.
          Object.assign(l, { runner: null, running: true, device: true, stopped: false });
          const first = await findGameLevel(device, index, { timeoutMs: 15_000, dismissPopups: true }).catch(() => null);
          if (!first) Object.assign(l, { running: false, device: false });
          if (!first) return json(res, 409, { error: "Can't recognise a level on the game screen — open the game on a level (no menu or popup) and try again" });
          device.touch = (p) => gesture(p);
          videoPins++;
          clearTimeout(videoIdle);
          (async () => {
            let cur: GameLevel | null = first, tries = 0;
            while (cur && !l.stopped) {
              prefetch(cur.level);
              const runner = (l.runner = new Runner());
              if (r.paused && cur === first) runner.pause(true);
              const e = await runner.run(cur.state, { decider, stepDelayMs: r.delayMs ?? 0, device, calibration: cur.calibration, maxTurns: r.maxTurns, onEvent });
              if (!r.keepPlaying || l.stopped) break;
              const won = e.status === "won";
              tries = won ? 0 : tries + 1;
              if (tries >= 3) { onEvent({ type: "error", message: `Level ${cur.level} failed 3 times in a row — stopped` }); break; }
              const next: number = won ? cur.level + 1 : cur.level;
              onEvent({ type: "info", message: won ? `Level ${cur.level} solved — waiting for the game to show the next level` : `Level ${cur.level} not solved (${e.status}) — retrying it` });
              cur = await findGameLevel(device, index, {
                hint: next, timeoutMs: 20_000, cancelled: () => l.stopped, dismissPopups: true,
                onDismiss: (p) => onEvent({ type: "info", message: p === "continue"
                  ? `Tapped the game's popup button ("Continue" after a win, "Try Again" after a fail)`
                  : p === "home" ? `Tapped "Level N" on the game's home screen`
                  : `Closed the game's "Out of Time" / "Continue?" popup (never spends coins) — the level will be retried` }),
              });
              if (cur && won && cur.level < next) onEvent({ type: "info", message: `The game is on level ${cur.level} again (it didn't count the win — out of time?) — replaying it` });
              if (!cur && !l.stopped) onEvent({ type: "error", message: "The game did not show a level we recognise (a menu or popup we don't handle?) — stopped" });
            }
          })()
            .catch((err) => onEvent({ type: "error", message: String(err) }))
            .finally(() => { l.running = false; l.device = false; videoPins--; idleVideo(); });
          return json(res, 202, { ok: true, lane: id, decider: decider.name, level: first.level });
        }
        const start = loadAnyLevel(String(r.level ?? "demo"));
        const runner = new Runner();
        if (r.paused) runner.pause(true);
        Object.assign(l, { runner, running: true, device: false, stopped: false });
        runner
          .run(start, { decider, stepDelayMs: r.delayMs ?? 200, maxTurns: r.maxTurns, onEvent })
          .catch((err) => onEvent({ type: "error", message: String(err) }))
          .finally(() => { l.running = false; });
        return json(res, 202, { ok: true, lane: id, decider: decider.name });
      }
      const control = { "/step": (x: Runner) => x.step(), "/pause": (x: Runner) => x.pause(true), "/resume": (x: Runner) => x.pause(false), "/stop": (x: Runner) => x.stop() }[url.pathname];
      if (req.method === "POST" && control) {
        const r = await body(req);
        for (const l of targets(r)) {
          if (url.pathname === "/stop") l.stopped = true;
          if (l.runner) control(l.runner);
        }
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
  });
  server.listen(port, "127.0.0.1");
  server.on("close", () => { clearTimeout(videoIdle); video?.stop(); });
  return server;
}