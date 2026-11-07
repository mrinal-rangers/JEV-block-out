import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasLevels, loadLevel, loadLevelMeta, parseLevel, type GameState } from "@jev-block-out/core";
import { Device } from "./device.ts";
import { makeDecider } from "./jev.ts";
import { Runner, type RunEvent } from "./runner.ts";

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

interface RunRequest { level?: string | number; decider?: string; delayMs?: number; device?: boolean; paused?: boolean; maxTurns?: number }

/** Live viewer: GET / (page), GET /events (SSE), GET /state, POST /run | /step | /pause | /resume | /stop. */
export function startServer(port = Number(process.env.PORT ?? 5173)) {
  const clients = new Set<ServerResponse>();
  let history: RunEvent[] = [];
  let runner: Runner | null = null;
  let running = false;

  const broadcast = (e: RunEvent) => {
    if (e.type === "start") history = [];
    history.push(e);
    const data = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(data);
  };

  const body = (req: IncomingMessage) =>
    new Promise<RunRequest>((ok) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } });
    });

  const json = (res: ServerResponse, code: number, v: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(readFileSync(join(PUBLIC, "index.html")));
      }
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const e of history) res.write(`data: ${JSON.stringify(e)}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/state") {
        return json(res, 200, { running, events: history.length, last: history.at(-1) ?? null });
      }
      if (req.method === "GET" && url.pathname === "/levels") {
        const meta = hasLevels() ? [...loadLevelMeta().values()].slice(0, 500) : [];
        return json(res, 200, { demo: true, extracted: hasLevels(), levels: meta });
      }
      if (req.method === "POST" && url.pathname === "/run") {
        if (running) return json(res, 409, { error: "a run is in progress — POST /stop first" });
        const r = await body(req);
        const start = loadAnyLevel(String(r.level ?? "demo"));
        const device = r.device ? new Device() : undefined;
        if (device && !(await device.isConnected())) return json(res, 400, { error: "no adb device" });
        const decider = makeDecider(r.decider);
        runner = new Runner();
        if (r.paused) runner.pause(true);
        running = true;
        runner
          .run(start, { decider, stepDelayMs: r.delayMs ?? 700, device, maxTurns: r.maxTurns, onEvent: broadcast })
          .catch((err) => broadcast({ type: "error", message: String(err) }))
          .finally(() => (running = false));
        return json(res, 202, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/step") { runner?.step(); return json(res, 200, { ok: true }); }
      if (req.method === "POST" && url.pathname === "/pause") { runner?.pause(true); return json(res, 200, { ok: true }); }
      if (req.method === "POST" && url.pathname === "/resume") { runner?.pause(false); return json(res, 200, { ok: true }); }
      if (req.method === "POST" && url.pathname === "/stop") { runner?.stop(); return json(res, 200, { ok: true }); }
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
