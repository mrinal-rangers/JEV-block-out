import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const GAME_PACKAGE = "com.grandgames.catblockjam";

export function adbPath(): string {
  if (process.env.ADB) return process.env.ADB;
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ??
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : "");
  const exe = join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  return sdk && existsSync(exe) ? exe : "adb";
}

/** Thin adb wrapper: screenshots, multi-waypoint drags, settle detection. */
export class Device {
  readonly serial: string | undefined;
  private readonly adb = adbPath();
  constructor(serial = process.env.ANDROID_SERIAL || undefined) {
    this.serial = serial;
  }

  private args(a: string[]): string[] {
    return this.serial ? ["-s", this.serial, ...a] : a;
  }

  async shell(cmd: string): Promise<string> {
    const { stdout } = await run(this.adb, this.args(["shell", cmd]), { maxBuffer: 1 << 20 });
    return stdout.toString();
  }

  async screenshot(): Promise<Buffer> {
    const { stdout } = await run(this.adb, this.args(["exec-out", "screencap", "-p"]), {
      encoding: "buffer", maxBuffer: 64 << 20,
    });
    return stdout as Buffer;
  }

  async screenSize(): Promise<{ w: number; h: number }> {
    const m = /(\d+)x(\d+)/.exec(await this.shell("wm size"));
    return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1080, h: 2400 };
  }

  async launchGame(): Promise<void> {
    await this.shell(`monkey -p ${GAME_PACKAGE} -c android.intent.category.LAUNCHER 1`);
  }

  async isGameInstalled(): Promise<boolean> {
    return (await this.shell(`pm path ${GAME_PACKAGE}`)).includes("package:");
  }

  async tap(x: number, y: number): Promise<void> {
    await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, ms = 300): Promise<void> {
    await this.shell(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(ms)}`);
  }

  async key(name: "back" | "home" | "appswitch"): Promise<void> {
    await this.shell(`input keyevent ${{ back: "KEYCODE_BACK", home: "KEYCODE_HOME", appswitch: "KEYCODE_APP_SWITCH" }[name]}`);
  }

  /** Press, move through each waypoint in small steps, release — one adb shell call so timing stays tight. */
  async drag(points: { x: number; y: number }[], stepPx = 40): Promise<void> {
    if (points.length < 2) return;
    const cmds = [`input motionevent DOWN ${points[0]!.x} ${points[0]!.y}`];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / stepPx));
      for (let k = 1; k <= n; k++) {
        cmds.push(`input motionevent MOVE ${Math.round(a.x + ((b.x - a.x) * k) / n)} ${Math.round(a.y + ((b.y - a.y) * k) / n)}`);
      }
    }
    const last = points[points.length - 1]!;
    cmds.push(`input motionevent UP ${last.x} ${last.y}`);
    await this.shell(cmds.join(" && "));
  }

  /** Wait until two consecutive screenshots are identical (animations finished) or the timeout passes. */
  async settle(opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<Buffer> {
    const { intervalMs = 400, timeoutMs = 6000 } = opts;
    const t0 = Date.now();
    let prev = await this.screenshot();
    let prevHash = createHash("sha1").update(prev).digest("hex");
    while (Date.now() - t0 < timeoutMs) {
      await sleep(intervalMs);
      const cur = await this.screenshot();
      const h = createHash("sha1").update(cur).digest("hex");
      if (h === prevHash) return cur;
      prev = cur;
      prevHash = h;
    }
    return prev;
  }

  async isConnected(): Promise<boolean> {
    try {
      return (await this.shell("echo ok")).trim() === "ok";
    } catch {
      return false;
    }
  }
}
