/**
 * One-command launcher: `npm start`.
 *
 * 1. Reports which decision models have keys (from .env or the environment; values are never printed).
 * 2. Finds an Android device, or boots the first emulator AVD, and opens the game if it is installed.
 * 3. Extracts levels from the game installed on that device (kept locally in ./levels, gitignored).
 * 4. Starts the arena and opens it in the browser.
 *
 * Flags: --port N, --level N|demo, --no-emulator, --no-levels, --no-open, --no-autorun
 */
import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_LEVELS_DIR, hasLevels } from "@jev-block-out/core";
import { adbPath, Device, GAME_PACKAGE } from "./device.ts";
import { deciderConfigured } from "./jev.ts";
import { startServer } from "./server.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const flag = (f: string) => { const i = args.indexOf(`--${f}`); return i >= 0 ? args[i + 1] : undefined; };
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const no = (s: string) => console.log(`  \x1b[33m–\x1b[0m ${s}`);
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const KEYS: [string, string, string][] = [
  ["jev", "TypeSafe Jev", "TYPESAFE_API_KEY  ($5 free credit: console.typesafe.ai)"],
  ["openai", "OpenAI Decisions", "OPENAI_API_KEY  (or AZURE_OPENAI_API_KEY + OPENAI_BASE_URL)"],
  ["clef", "Cloudflare Clef", "CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID  (free daily allowance)"],
  ["gemini", "Gemini (slow baseline)", "GEMINI_API_KEY  (free: aistudio.google.com/apikey)"],
];

function checkKeys(): void {
  step("Decision models");
  if (!existsSync(".env") && existsSync(".env.example")) {
    copyFileSync(".env.example", ".env");
    no("Created .env from .env.example — put your keys there (it is gitignored), then run npm start again");
  }
  let any = false;
  for (const [id, name, hint] of KEYS) {
    if (deciderConfigured(id)) { ok(`${name}`); any = true; }
    else no(`${name}: set ${hint}`);
  }
  if (process.env.CLOUDFLARE_API_TOKEN && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    no("CLOUDFLARE_API_TOKEN is set but CLOUDFLARE_ACCOUNT_ID is missing (the 32-character ID in your dash.cloudflare.com URL)");
  }
  ok("solver and mock (offline, always available)");
  if (!any) console.log("    No model keys yet: the arena still runs with the solver and mock deciders.");
}

function sdkTool(dir: string, name: string): string | undefined {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ??
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : join(process.env.HOME ?? "", "Android", "Sdk"));
  const exe = join(sdk, dir, process.platform === "win32" ? `${name}.exe` : name);
  return existsSync(exe) ? exe : undefined;
}

async function bootEmulator(device: Device): Promise<boolean> {
  const emulator = sdkTool("emulator", "emulator");
  if (!emulator) { no("No Android emulator found (install the Android SDK emulator, see README)"); return false; }
  const avds = (await run(emulator, ["-list-avds"]).then((r) => r.stdout, () => "")).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const avd = process.env.EMULATOR_AVD || avds[0];
  if (!avd) { no("No emulator AVD found (create one, see README)"); return false; }
  console.log(`    Booting emulator "${avd}" (first boot can take a minute or two)…`);
  spawn(emulator, ["-avd", avd, "-no-snapshot", "-no-audio", "-gpu", "swiftshader_indirect", "-no-boot-anim",
    "-memory", "4096", "-cores", "4", "-feature", "-Vulkan,GLESDynamicVersion"], { detached: true, stdio: "ignore" }).unref();
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await device.isConnected() && (await device.shell("getprop sys.boot_completed").catch(() => "")).trim() === "1") return true;
  }
  no("Emulator did not finish booting in 4 minutes; continuing without it");
  return false;
}

async function setupDevice(): Promise<Device | undefined> {
  step("Game");
  const device = new Device();
  let connected = await device.isConnected().catch(() => false);
  if (!connected && !has("no-emulator")) connected = await bootEmulator(device);
  if (!connected) { no("No Android device — the arena shows the decision models on the board view only"); return undefined; }
  ok(`Device ${device.serial ?? "(default)"} connected`);
  if (!(await device.isGameInstalled())) {
    no(`Block Out! (${GAME_PACKAGE}) is not installed. Download it yourself (Google Play or APKPure XAPK) and run:`);
    console.log("      adb install-multiple base.apk config.<abi>.apk     # the APK files inside the XAPK");
    return device;
  }
  ok("Block Out! installed");
  await device.launchGame().catch(() => {});
  return device;
}

async function python(): Promise<string | undefined> {
  for (const py of process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]) {
    if (await run(py, ["--version"]).then(() => true, () => false)) return py;
  }
  return undefined;
}

/** Levels ship inside the game APK; extract them from the copy installed on the user's device. */
async function setupLevels(device: Device | undefined): Promise<boolean> {
  step("Levels");
  if (hasLevels()) { ok(`Levels found in ${DEFAULT_LEVELS_DIR}`); return true; }
  const fallback = () => { no("Using the built-in demo level. Real levels: npm run levels -- <your.xapk>"); return false; };
  if (has("no-levels") || !device || !(await device.isGameInstalled().catch(() => false))) return fallback();
  const py = await python();
  if (!py) { no("Python 3 is needed to extract levels"); return fallback(); }
  if (!(await run(py, ["-c", "import UnityPy"]).then(() => true, () => false))) {
    console.log("    Installing UnityPy (Python package used to read the game's assets)…");
    if (!(await run(py, ["-m", "pip", "install", "--quiet", "--user", "UnityPy"], { maxBuffer: 16 << 20 }).then(() => true, () => false))) {
      no("pip install UnityPy failed"); return fallback();
    }
  }
  const paths = (await device.shell(`pm path ${GAME_PACKAGE}`)).split(/\r?\n/)
    .map((l) => l.replace(/^package:/, "").trim()).filter((p) => p.endsWith(".apk"));
  const base = paths.find((p) => p.endsWith("/base.apk")) ?? paths[0];
  if (!base) return fallback();
  const dir = resolve("packages", "bridge", ".cache");
  mkdirSync(dir, { recursive: true });
  const local = join(dir, "game-base.apk");
  console.log("    Copying the game APK from the device and extracting levels (one time)…");
  try {
    await run(adbPath(), [...(device.serial ? ["-s", device.serial] : []), "pull", base, local], { maxBuffer: 16 << 20 });
    await run(py, [resolve("tools", "extract_levels.py"), local, "--out", DEFAULT_LEVELS_DIR], { maxBuffer: 64 << 20 });
  } catch (err) {
    no(`Level extraction failed: ${(err as Error).message.split("\n")[0]}`);
    return fallback();
  }
  if (!hasLevels()) return fallback();
  ok(`Levels extracted to ${DEFAULT_LEVELS_DIR} (local only, never committed)`);
  return true;
}

const portFree = (port: number) => new Promise<boolean>((r) => {
  const s = createServer().once("error", () => r(false)).once("listening", () => s.close(() => r(true)));
  s.listen(port, "127.0.0.1");
});

function openBrowser(url: string): void {
  const [cmd, a] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, a as string[], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

async function main(): Promise<void> {
  console.log("\x1b[1mJev × Block Out!\x1b[0m");
  checkKeys();
  const device = await setupDevice();
  const levels = await setupLevels(device);

  step("Arena");
  let port = Number(flag("port") ?? process.env.PORT ?? 5173);
  for (let i = 0; i < 20 && !(await portFree(port)); i++) port++;
  startServer(port);
  const level = flag("level") ?? (levels ? "1" : "demo");
  const url = `http://127.0.0.1:${port}/?level=${level}&lanes=2${has("no-autorun") ? "" : "&autorun=1"}`;
  ok(`Live arena: ${url}`);
  if (device) console.log("    The real game streams in the Emulator panel. Accept the game's terms there yourself on first launch.");
  console.log("    Press Ctrl+C to stop.");
  if (!has("no-open")) openBrowser(url);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
