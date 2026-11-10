import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { adbPath } from "./device.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** scrcpy-server (Apache-2.0, Genymobile) is downloaded on first use and checked against the release's SHA-256. */
export const SCRCPY_VERSION = "5.0.1";
const SCRCPY_SHA256 = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";
const SCRCPY_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
const CACHE = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".cache");
const REMOTE_JAR = "/data/local/tmp/jev-scrcpy-server.jar";

export async function ensureServerJar(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (process.env.SCRCPY_SERVER) return process.env.SCRCPY_SERVER;
  const file = join(CACHE, `scrcpy-server-v${SCRCPY_VERSION}`);
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  if (existsSync(file) && sha(readFileSync(file)) === SCRCPY_SHA256) return file;
  const res = await fetchImpl(SCRCPY_URL);
  if (!res.ok) throw new Error(`scrcpy-server download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== SCRCPY_SHA256) throw new Error("scrcpy-server checksum mismatch — refusing to use it");
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, buf);
  return file;
}

export interface VideoPacket { config: boolean; key: boolean; pts: bigint; data: Buffer }

/**
 * Splits the scrcpy video socket into packets. Each packet has a 12-byte header:
 * u64 (bit63 = session packet, bit62 = config, bit61 = key frame, rest = PTS) + u32 size.
 * Session packets (sent when the capture size changes) carry no payload.
 */
export class PacketParser {
  private buf: Buffer = Buffer.alloc(0);
  private readonly onPacket: (p: VideoPacket) => void;
  private readonly onSession?: (w: number, h: number) => void;
  constructor(onPacket: (p: VideoPacket) => void, onSession?: (w: number, h: number) => void) {
    this.onPacket = onPacket;
    this.onSession = onSession;
  }

  feed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 12) {
      const head = this.buf.readBigUInt64BE(0);
      if (head >> 63n) {
        this.onSession?.(this.buf.readUInt32BE(4), this.buf.readUInt32BE(8));
        this.buf = this.buf.subarray(12);
        continue;
      }
      const size = this.buf.readUInt32BE(8);
      if (this.buf.length < 12 + size) break;
      this.onPacket({
        config: !!((head >> 62n) & 1n),
        key: !!((head >> 61n) & 1n),
        pts: head & ((1n << 61n) - 1n),
        data: Buffer.from(this.buf.subarray(12, 12 + size)),
      });
      this.buf = this.buf.subarray(12 + size);
    }
  }
}

/** Browser wire format: u8 flags (1 = config, 2 = key frame) + u32 length + H.264 Annex B bytes. */
export function frame(p: Pick<VideoPacket, "config" | "key" | "data">): Buffer {
  const h = Buffer.alloc(5);
  h[0] = (p.config ? 1 : 0) | (p.key ? 2 : 0);
  h.writeUInt32BE(p.data.length, 1);
  return Buffer.concat([h, p.data]);
}

type Sink = (chunk: Buffer) => void;

export type TouchAction = "down" | "up" | "move";

/**
 * scrcpy INJECT_TOUCH_EVENT control message (32 bytes): u8 type=2, u8 action, i64 pointer id, i32 x, i32 y,
 * u16 width, u16 height (must equal the current video size), u16 pressure, u32 action button, u32 buttons.
 */
export function touchMessage(action: TouchAction, x: number, y: number, w: number, h: number): Buffer {
  const b = Buffer.alloc(32);
  b[0] = 2;
  b[1] = { down: 0, up: 1, move: 2 }[action];
  b.writeBigInt64BE(-2n, 2); // generic finger
  b.writeInt32BE(Math.round(x), 10);
  b.writeInt32BE(Math.round(y), 14);
  b.writeUInt16BE(w, 18);
  b.writeUInt16BE(h, 20);
  b.writeUInt16BE(action === "up" ? 0 : 0xffff, 22);
  return b;
}

/**
 * Streams the real device screen as H.264 via scrcpy-server over an adb forward tunnel.
 * New subscribers get the codec config plus the current group of pictures, so they can start decoding at once.
 */
export class ScrcpyStream {
  private proc: ChildProcess | null = null;
  private sock: Socket | null = null;
  private ctrl: Socket | null = null;
  private port = 0;
  private config: Buffer | null = null;
  private gop: Buffer[] = [];
  private gopBytes = 0;
  private sinks = new Set<Sink>();
  private log: string[] = [];
  private onEnd = new Set<(why: string) => void>();
  ended = false;
  size: { w: number; h: number } | null = null;
  private readonly serial: string | undefined;
  private readonly maxSize: number;

  constructor(serial = process.env.ANDROID_SERIAL || undefined, maxSize = Number(process.env.STREAM_MAX_SIZE || 720)) {
    this.serial = serial;
    this.maxSize = maxSize;
  }

  private adb(args: string[]) {
    return this.serial ? ["-s", this.serial, ...args] : args;
  }

  async start(): Promise<void> {
    const adb = adbPath();
    const jar = await ensureServerJar();
    await run(adb, this.adb(["push", jar, REMOTE_JAR]));
    const scid = randomInt(1, 0x7fffffff).toString(16).padStart(8, "0");
    const { stdout } = await run(adb, this.adb(["forward", "tcp:0", `localabstract:scrcpy_${scid}`]));
    this.port = Number(String(stdout).trim());
    if (!this.port) throw new Error(`adb forward gave no port: ${stdout}`);
    this.proc = spawn(adb, this.adb(["shell", `CLASSPATH=${REMOTE_JAR}`, "app_process", "/", "com.genymobile.scrcpy.Server", SCRCPY_VERSION,
      `scid=${scid}`, "log_level=info", "tunnel_forward=true", "audio=false", "control=true", "cleanup=false",
      "clipboard_autosync=false", "power_off_on_close=false",
      "video_codec=h264", `max_size=${this.maxSize}`, "max_fps=30", "video_bit_rate=4000000",
      "send_device_meta=false", "send_stream_meta=true"]), { stdio: ["ignore", "pipe", "pipe"] });
    const keep = (d: Buffer) => { this.log.push(...String(d).split(/\r?\n/).filter(Boolean)); this.log = this.log.slice(-20); };
    this.proc.stdout!.on("data", keep);
    this.proc.stderr!.on("data", keep);
    this.proc.on("exit", () => this.end("scrcpy-server exited"));
    this.sock = await this.connectVideo();
    // With a forward tunnel the control socket is the second connection, made right after the video one.
    this.ctrl = await new Promise<Socket>((ok, fail) => {
      const c = connect(this.port, "127.0.0.1", () => ok(c));
      c.once("error", fail);
    });
    this.ctrl.on("data", () => {}); // device messages (clipboard etc.) are not used
    this.ctrl.on("error", () => {});
    this.ctrl.on("close", () => (this.ctrl = null));
    const parser = new PacketParser((p) => this.onPacket(p), (w, h) => (this.size = { w, h }));
    // Stream meta: a u32 codec id, then a session packet carrying the video size (needed to inject touches).
    let codecId = 4;
    this.sock.on("data", (d: Buffer) => {
      if (codecId > 0) {
        const skip = Math.min(codecId, d.length);
        codecId -= skip;
        d = d.subarray(skip);
      }
      if (d.length) parser.feed(d);
    });
    this.sock.on("close", () => this.end("video socket closed"));
    this.sock.on("error", () => {});
    this.sock.resume();
  }

  /** With a forward tunnel the TCP connect succeeds before the server listens; the server's dummy byte proves it is really there. */
  private async connectVideo(): Promise<Socket> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (this.ended) break;
      const s = await new Promise<Socket | null>((ok) => {
        const sock = connect(this.port, "127.0.0.1");
        const fail = () => { sock.destroy(); ok(null); };
        const timer = setTimeout(fail, 1500);
        sock.once("error", fail);
        sock.once("close", fail);
        sock.once("data", (d) => {
          clearTimeout(timer);
          sock.removeAllListeners();
          sock.pause();
          if (d.length > 1) sock.unshift(d.subarray(1));
          ok(sock);
        });
      });
      if (s) return s;
      await sleep(250);
    }
    const why = `could not connect to scrcpy-server${this.log.length ? ": " + this.log.slice(-3).join(" | ") : ""}`;
    this.end(why);
    throw new Error(why);
  }

  private onPacket(p: VideoPacket) {
    const f = frame(p);
    if (p.config) {
      this.config = f;
      this.gop = [];
      this.gopBytes = 0;
    } else {
      if (p.key) { this.gop = []; this.gopBytes = 0; }
      if (this.gopBytes < 16 << 20) { this.gop.push(f); this.gopBytes += f.length; }
    }
    for (const s of this.sinks) s(f);
  }

  subscribe(sink: Sink): () => void {
    if (this.config) sink(this.config);
    for (const f of this.gop) sink(f);
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  get subscribers() { return this.sinks.size; }

  /** True once touches can be injected (control socket open and the video size known). */
  get canTouch() { return !!this.ctrl && !!this.size && !this.ended; }

  /**
   * Presses at the first point, glides through the rest and releases. Points are 0..1 fractions of the screen.
   * Moves are sent every `stepMs` in ~1/100-of-height steps so the game sees a continuous finger. A drag takes at
   * least `minDurationMs`: the game's blocks trail the finger, and a quick one-cell flick snaps back unmoved.
   */
  async gesture(points: { x: number; y: number }[], opts: { stepMs?: number; holdMs?: number; durationMs?: number; minDurationMs?: number } = {}): Promise<void> {
    if (!this.canTouch || !points.length) throw new Error("scrcpy control is not ready");
    const { w, h } = this.size!;
    const stepMs = opts.stepMs ?? 12, holdMs = opts.holdMs ?? 40;
    const px = points.map((p) => ({ x: p.x * w, y: p.y * h }));
    const steps: { x: number; y: number }[] = [];
    for (let i = 1; i < px.length; i++) {
      const a = px[i - 1]!, b = px[i]!;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (h / 100)));
      for (let k = 1; k <= n; k++) steps.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
    const minDt = steps.length ? (opts.minDurationMs ?? 300) / steps.length : 0;
    const dt = opts.durationMs && steps.length ? opts.durationMs / steps.length : Math.max(stepMs, minDt);
    const send = (a: TouchAction, p: { x: number; y: number }) => {
      if (!this.ctrl) throw new Error("scrcpy control closed");
      this.ctrl.write(touchMessage(a, Math.min(w - 1, Math.max(0, p.x)), Math.min(h - 1, Math.max(0, p.y)), w, h));
    };
    send("down", px[0]!);
    await sleep(holdMs);
    for (const p of steps) {
      send("move", p);
      await sleep(dt);
    }
    await sleep(holdMs);
    send("up", px.at(-1)!);
  }

  onceEnded(fn: (why: string) => void): () => void {
    this.onEnd.add(fn);
    return () => this.onEnd.delete(fn);
  }

  private end(why: string) {
    if (this.ended) return;
    this.ended = true;
    this.sock?.destroy();
    this.ctrl?.destroy();
    this.proc?.kill();
    if (this.port) run(adbPath(), this.adb(["forward", "--remove", `tcp:${this.port}`])).catch(() => {});
    for (const fn of this.onEnd) fn(why);
  }

  stop() { this.end("stopped"); }
}
