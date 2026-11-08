import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasLevels, loadLevel, loadLevelMeta, parseLevel, type GameState } from "@jev-block-out/core";
import { Device } from "./device.ts";
import { deciderConfigured, makeDecider } from "./jev.ts";
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

interface RunRequest { lane?: string; level?: string | number; decider?: string; delayMs?: number; device?: boolean; paused?: boolean; maxTurns?: number }
interface InputRequest { type?: string; x?: number; y?: number; x2?: number; y2?: number; ms?: number; key?: string }

const unit = (v: unknown): v is number => typeof v === "number" && v >= 0 && v <= 1;

/** One independent run shown as a column in the viewer. Several lanes can run in parallel. */
interface Lane { runner: Runner | null; running: boolean; device: boolean; history: RunEvent[] }

const LANE_ID = /^[a-z0-9]{1,8}$/;

/**
 * Live viewer.
 *   GET  /              page
 *   GET  /events        SSE; every event carries its `lane`
 *   GET  /state         lanes and whether they are running
 *   GET  /levels        level list + available deciders + device status
 *   GET  /screen        PNG screenshot of the connected emulator
 *   GET  /video         live H.264 stream of the real game (scrcpy), framed as u8 flags + u32 length + Annex B
 *   POST /input         {type: tap|swipe|key|launch, x, y, x2, y2 (0..1 of the screen), ms, key: back|home|appswitch}
 *   POST /run           {lane, level, decider, delayMs, device, paused, maxTurns}
 *   POST /step | /pause | /resume | /stop   {lane?}; no lane = all lanes
 */
export function startServer(port = Number(process.env.PORT ?? 5173)) {
  const clients = new Set<ServerResponse>();
  const lanes = new Map<string, Lane>();
  const lane = (id: string): Lane => {
    let l = lanes.get(id);
    if (!l) lanes.set(id, (l = { runner: null, running: false, device: false, history: [] }));
    return l;
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

  // One shared scrcpy stream for every viewer; started on demand, stopped shortly after the last viewer leaves.
  let video: ScrcpyStream | null = null;
  let videoStarting: Promise<ScrcpyStream> | null = null;
  let videoIdle: NodeJS.Timeout | undefined;
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
          if (!s.subscribers) videoIdle = setTimeout(() => s.subscribers || s.stop(), 15_000);
        });
        return;
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
        const { w, h } = await screenSize(d);
        if (r.type === "tap") await d.tap(r.x * w, r.y * h);
        else if (r.type === "swipe" && unit(r.x2) && unit(r.y2)) await d.swipe(r.x * w, r.y * h, r.x2 * w, r.y2 * h, Math.max(50, Math.min(3000, Number(r.ms) || 300)));
        else return json(res, 400, { error: "type must be tap, swipe (with x2, y2), key or launch" });
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
        const start = loadAnyLevel(String(r.level ?? "demo"));
        const device = r.device ? new Device() : undefined;
        if (device && !(await device.isConnected())) return json(res, 400, { error: "no adb device" });
        const decider = makeDecider(r.decider);
        const runner = new Runner();
        if (r.paused) runner.pause(true);
        Object.assign(l, { runner, running: true, device: !!device });
        runner
          .run(start, { decider, stepDelayMs: r.delayMs ?? 200, device, maxTurns: r.maxTurns, onEvent: (e) => broadcast(id, e) })
          .catch((err) => broadcast(id, { type: "error", message: String(err) }))
          .finally(() => { l.running = false; l.device = false; });
        return json(res, 202, { ok: true, lane: id, decider: decider.name });
      }
      const control = { "/step": (x: Runner) => x.step(), "/pause": (x: Runner) => x.pause(true), "/resume": (x: Runner) => x.pause(false), "/stop": (x: Runner) => x.stop() }[url.pathname];
      if (req.method === "POST" && control) {
        const r = await body(req);
        for (const l of targets(r)) if (l.runner) control(l.runner);
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