import { hasLevels, loadLevel, loadLevelMeta, renderAscii, solve } from "@jev-block-out/core";
import { Device } from "./device.ts";
import { makeDecider } from "./jev.ts";
import { Runner } from "./runner.ts";
import { loadAnyLevel, startServer } from "./server.ts";

const USAGE = `jev-block-out
  solve <from> [to] [--nodes N] [--weight W]   solve extracted levels with the search solver
  play <level|demo> [--decider auto|jev|mock|solver] [--device] [--delay ms]
                                                play one level in the terminal (and on the emulator with --device)
  serve [--port 5173]                           live viewer at http://127.0.0.1:5173`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && args[i - 1] !== "--device"));

  if (cmd === "solve") {
    if (!hasLevels()) throw new Error("No extracted levels (set JEV_LEVELS_DIR or run `npm run levels -- <xapk>`)");
    const from = Number(pos[0] ?? 1), to = Number(pos[1] ?? from);
    const maxNodes = Number(flag(args, "nodes") ?? 60_000), weight = Number(flag(args, "weight") ?? 1);
    const meta = loadLevelMeta();
    let ok = 0, skipped = 0;
    for (let n = from; n <= to; n++) {
      const s = loadLevel(n);
      const r = solve(s, { maxNodes, weight });
      if (r.reason?.startsWith("unsupported")) skipped++;
      if (r.solved) ok++;
      const hard = meta.get(n)?.isSuperHard ? " super-hard" : meta.get(n)?.isHard ? " hard" : "";
      console.log(`L${n}${hard}: ${r.solved ? `solved in ${r.moves.length} moves` : r.reason} (${r.expanded} nodes, ${r.ms} ms)`);
    }
    const total = to - from + 1;
    console.log(`\n${ok}/${total} solved, ${skipped} skipped (unsupported mechanics), ${total - ok - skipped} unsolved within budget`);
    return;
  }

  if (cmd === "play") {
    const start = loadAnyLevel(pos[0] ?? "demo");
    const decider = makeDecider(flag(args, "decider"));
    const device = args.includes("--device") ? new Device() : undefined;
    if (device && !(await device.isConnected())) throw new Error("--device: no adb device connected");
    console.log(renderAscii(start) + "\n");
    const end = await new Runner().run(start, {
      decider, device, stepDelayMs: Number(flag(args, "delay") ?? 0),
      onEvent: (e) => {
        if (e.type === "turn") {
          const d = e.decisions.at(-1);
          console.log(`${String(e.n).padStart(3)}. [${e.route}${d ? ` ${(d.confidence * 100).toFixed(0)}%` : ""}] ${e.description}`);
        } else if (e.type === "error") console.error("error:", e.message);
      },
    });
    console.log(`\n${renderAscii(end.state)}\n${end.status} after ${end.turns} moves in ${(end.ms / 1000).toFixed(1)} s${end.reason && end.status !== "stuck" ? ` — ${end.reason}` : ""}`);
    process.exitCode = end.status === "won" ? 0 : 1;
    return;
  }

  if (cmd === "serve") {
    const port = Number(flag(args, "port") ?? process.env.PORT ?? 5173);
    startServer(port);
    console.log(`Live viewer: http://127.0.0.1:${port}/?level=demo  (decider: ${makeDecider().name})`);
    return;
  }

  console.log(USAGE);
  if (cmd) process.exitCode = 2;
}

main(process.argv.slice(2)).catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
