# Checkpoint Tracker

Single source of truth for progress. Update the **Status** and **Evidence** columns as each
checkpoint is completed. Detailed rationale lives in [AGENDA.md](./AGENDA.md).

**Legend:** ⬜ Not started · 🟨 In progress · ✅ Done · ⛔ Blocked · ⏸️ Deferred · ⏭️ Skipped
**Owner:** 👤 You (mrinal-rangers) · 🤖 Copilot

> **Current blockers (need 👤):**
> 1. **Accept the game's Terms of Service** in the running emulator (tap *ACCEPT* once). This is a
>    legal agreement, so Copilot will not click it for you. It unblocks 0.4, 0.5, 1.3 and 2.1–2.4.
> 2. **TypeSafe API key** in `TYPESAFE_API_KEY` (0.2). Unblocks 3.6. **Free stand-in:** a Gemini key from
>    [AI Studio](https://aistudio.google.com/apikey) in `GEMINI_API_KEY` (3.7) — Google login only.

## Summary

| Phase | Name | Progress |
| - | - | - |
| M0 | Environment spike (go/no-go) | 5 / 8 (1 deferred, 1 blocked on ToS) |
| M1 | Game state extraction | 4 / 5 (on-device check blocked on ToS) |
| M2 | Move execution | 0 / 4 (all built and tested in sim; on-device blocked on ToS) |
| M3 | Jev integration | 6 / 8 (first Jev solve needs API key; first Gemini solve needs a free key) |
| M4 | Live simulation dashboard | 0 / 4 (4.1, 4.2 partly done early) |
| M5 | Harder mechanics & evaluation | 0 / 4 (5.3 baseline started) |

---

## M0 — Environment spike (go/no-go)

| # | Checkpoint | Owner | Status | Done when (evidence) |
| - | - | - | - | - |
| 0.1 | Install Android SDK (cmdline-tools, platform-tools, emulator, x86_64 Google APIs image) + JDK 17 | 🤖 | ✅ | adb 1.0.41 / platform-tools 37.0.1, emulator 37.2.13, WHPX usable. Full Android Studio IDE optional. |
| 0.2 | Get TypeSafe API key; set `TYPESAFE_API_KEY` locally | 👤 | ⏸️ | Key exists in env (never committed) — deferred; only 3.6 needs it |
| 0.3 | Create x86_64 *Google APIs* AVD (rootable) | 🤖 | ✅ | AVD `blockout`, **API 30** (not 33), boots with flags in [docs/game-internals.md](./docs/game-internals.md); `adb root` works |
| 0.4 | Install game splits with `adb install-multiple` | 🤖 | 🟨 | Installed, launches and renders under ARM translation; stops at the ToS dialog |
| 0.5 | Play level 1 manually via `adb shell input swipe` | 🤖 | ⛔ | Blocked: ToS must be accepted by 👤 |
| 0.6 | Locate level files | 🤖 | ✅ | Levels are Unity TextAssets **inside the APK**, not app data. `tools/extract_levels.py` → 1,296 files. See [docs/game-internals.md](./docs/game-internals.md) |
| 0.7 | Test Frida (gadget / server) on translated process | 🤖 | ✅ | Negative result: Frida crashes the ARM-translated game process → Path A not viable on this host |
| 0.8 | **Decision:** Path A (Frida) or Path B (screen + level files) | 👤🤖 | ✅ | **Path B+** — see below and [docs/state-path.md](./docs/state-path.md) |

**M0 decision (2026-11-07):** **Path B+.** State comes from the level JSON in the APK plus our own
deterministic rules engine (`packages/core`); screenshots are used only for settle detection and
verification; moves are adb motion events. Frida (Path A) cannot hook translated ARM code on the
x86_64 emulator.

## M1 — Game state extraction

| # | Checkpoint | Owner | Status | Done when (evidence) |
| - | - | - | - | - |
| 1.1 | Dump IL2CPP types (Il2CppDumper) | 🤖 | ✅ | `LevelModel` / block / door field map in [docs/game-internals.md](./docs/game-internals.md) |
| 1.2 | Define shared `GameState` JSON schema | 🤖 | ✅ | [schema/game-state.schema.json](./schema/game-state.schema.json) + [examples/game-state.example.json](./examples/game-state.example.json) (validated with ajv) |
| 1.3 | Extract live board state (Path A hook or Path B parser) | 🤖 | 🟨 | `parseLevel` + engine done; "matches screen for 3 levels" blocked on ToS |
| 1.4 | Handle doors, colors, block shapes | 🤖 | ✅ | `packages/core/test/engine.test.ts`: synthetic fixtures + real levels 1–5 solved (local-only test) |
| 1.5 | Detect level start / win / fail | 🤖 | ✅ | Engine `won` / `stuck` + runner `start`/`end` events (loop and turn-cap detection); logged to JSONL |

## M2 — Move execution

| # | Checkpoint | Owner | Status | Done when (evidence) |
| - | - | - | - | - |
| 2.1 | Enumerate legal moves | 🤖 | 🟨 | `legalMoves()` done and tested; "matches game for 3 levels" blocked on ToS |
| 2.2 | Execute a chosen move in game | 🤖 | 🟨 | `Device.drag()` via `input motionevent` + `screen.ts` calibration implemented; unverified on device (ToS) |
| 2.3 | Detect move completion before next decision | 🤖 | 🟨 | Settle = two identical screenshot hashes, implemented; unverified on device (ToS) |
| 2.4 | Scripted solve of level 1 end-to-end (no AI) | 🤖 | 🟨 | Solver solves 24 / 28 supported levels in sim ([docs/results.md](./docs/results.md)); on-device run blocked on ToS |

## M3 — Jev integration

| # | Checkpoint | Owner | Status | Done when (evidence) |
| - | - | - | - | - |
| 3.1 | Bridge scaffold (Node/TS) + TypeSafe SDK | 🤖 | ✅ | `packages/bridge`, `@typesafe-ai/sdk` 0.7. Uses `node:http` + SSE instead of Fastify (no extra deps). Health: `GET /state`. Live Jev call needs key |
| 3.2 | `Choice` question: pick next move | 🤖 | ✅ | `next_move` Choice over legal move ids (≤255) with text descriptions; unknown ids rejected |
| 3.3 | `Score` / `Noul`: progress + dead-end check | 🤖 | ✅ | `progress` Score (0–4) + `dead_end` Noul, sent every turn and logged |
| 3.4 | Confidence routing (low confidence → lookahead / re-ask) | 🤖 | ✅ | forced → confident (≥0.35) → re-ask top 5 → solver fallback; `packages/bridge/test/agent.test.ts` |
| 3.5 | Call log: state, options, probs, confidence, latency, tokens | 🤖 | ✅ | `logs/<runId>.jsonl`, one line per turn |
| 3.6 | **First level solved by Jev** 🎉 | 🤖 | ⛔ | Needs `TYPESAFE_API_KEY` (0.2). Mock decider already wins the demo level end-to-end |
| 3.7 | Free alternative decider: Gemini API (`--decider gemini`) | 🤖 | ✅ | `GeminiDecider` in `packages/bridge/src/jev.ts`: enum-constrained structured output, self-reported probs, throttle + 429 retry; 5 fake-fetch tests. Live endpoint reached (400 on dummy key) |
| 3.8 | First level solved by Gemini | 👤🤖 | ⛔ | Needs `GEMINI_API_KEY` (free, Google login) |

## M4 — Live simulation dashboard

| # | Checkpoint | Owner | Status | Done when (evidence) |
| - | - | - | - | - |
| 4.1 | Dashboard streaming decisions | 🤖 | 🟨 | Plain HTML/canvas viewer over SSE at `npm run bridge` (Vite + React not needed so far) |
| 4.2 | Probability bars, confidence, latency, cost | 🤖 | 🟨 | Bars, confidence, progress, P(dead end), latency done ([screenshot](./docs/viewer.png)); cost pending real Jev usage |
| 4.3 | scrcpy mirror + one-command `start` script | 🤖 | ⬜ | `npm start` launches everything |
| 4.4 | Demo recording in README | 👤🤖 | ⬜ | GIF/video linked |

## M5 — Harder mechanics & evaluation

| # | Checkpoint | Owner | Status | Done when (evidence) |
| - | - | - | - | - |
| 5.1 | Elevators, generators, curtain locks, inner walls | 🤖 | ⬜ | Levels with these mechanics solved (32 of levels 1–60 skipped today) |
| 5.2 | Ice / locked / arrow / bomb blocks | 🤖 | ⬜ | Ice, arrows (axis) and layers already modelled; keys/locks, bombs pending |
| 5.3 | Metrics report (solve rate, moves, cost, latency) | 🤖 | 🟨 | Solver baseline in [docs/results.md](./docs/results.md); Jev numbers pending |
| 5.4 | Solve 10 consecutive levels unattended | 🤖 | ⬜ | Run log + recording |

---

## Log

| Date | Checkpoint | Note |
| - | - | - |
| 2026-11-07 | — | Repo created; README, AGENDA, tracker added. APK inspected: Unity IL2CPP, unencrypted metadata. |
| 2026-11-07 | 0.1 | Android SDK + JDK 17 installed to `%LOCALAPPDATA%\Android` (no admin). `ANDROID_HOME`, `JAVA_HOME`, PATH set for user. Host is a Hyper-V VM; WHPX acceleration usable. |
| 2026-11-07 | 0.2 | Deferred — API key to be provided later (needed for M3). |
| 2026-11-07 | 0.3–0.4 | API 30 x86_64 AVD (rooted) runs the game with Vulkan off; game stops at ToS dialog (needs owner). |
| 2026-11-07 | 0.6–0.8, 1.1 | Levels found as APK TextAssets; IL2CPP dump mapped `LevelModel`; Frida crashes translated process → Path B+. |
| 2026-11-08 | 1.2–1.5, 2.1 | `packages/core`: schema, parser, rules engine, weighted-A* solver, tests. Solver: 24 / 28 supported levels in 1–60. |
| 2026-11-08 | 2.2–2.4, 3.1–3.5 | `packages/bridge`: adb device control, Jev / mock / solver deciders, confidence routing, runner, JSONL logs, CLI, SSE server + live viewer (early 4.1/4.2). |
| 2026-11-08 | 3.7 | Free alternative to Jev: `gemini` decider (Google AI Studio key, free tier). Also considered GitHub Models, OpenRouter free, Groq, Ollama. `auto` falls back jev → gemini → mock. |
