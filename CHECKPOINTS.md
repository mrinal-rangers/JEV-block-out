# Checkpoint Tracker

Single source of truth for progress. Update the **Status** and **Evidence** columns as each
checkpoint is completed. Detailed rationale lives in [AGENDA.md](./AGENDA.md).

**Legend:** ⬜ Not started · 🟨 In progress · ✅ Done · ⛔ Blocked · ⏸️ Deferred · ⏭️ Skipped
**Owner:** 👤 You (mrinal-rangers) · 🤖 Copilot

## Summary

| Phase | Name | Progress |
| - | - | - |
| M0 | Environment spike (go/no-go) | 1 / 8 (1 deferred) |
| M1 | Game state extraction | 0 / 5 |
| M2 | Move execution | 0 / 4 |
| M3 | Jev integration | 0 / 6 |
| M4 | Live simulation dashboard | 0 / 4 |
| M5 | Harder mechanics & evaluation | 0 / 4 |

---

## M0 — Environment spike (go/no-go)

| # | Checkpoint | Owner | Status | Done when (evidence) |
| - | - | - | - | - |
| 0.1 | Install Android SDK (cmdline-tools, platform-tools, emulator, API 33 x86_64 Google APIs image) + JDK 17 | 🤖 | ✅ | adb 1.0.41 / platform-tools 37.0.1, emulator 37.2.13, WHPX usable. Full Android Studio IDE optional. |
| 0.2 | Get TypeSafe API key; set `TYPESAFE_API_KEY` locally | 👤 | ⏸️ | Key exists in env (never committed) — deferred, not needed until M3 |
| 0.3 | Create Android 13 x86_64 *Google APIs* AVD (rootable) | 🤖 | ⬜ | Emulator boots; `adb root` succeeds |
| 0.4 | Install game splits with `adb install-multiple` | 🤖 | ⬜ | Game launches under ARM translation |
| 0.5 | Play level 1 manually via `adb shell input swipe` | 🤖 | ⬜ | Screenshot of a completed level |
| 0.6 | Locate cached level files in app data | 🤖 | ⬜ | File path + format notes in `docs/` |
| 0.7 | Test Frida (gadget / server) on translated process | 🤖 | ⬜ | Hello-world hook logs from game |
| 0.8 | **Decision:** Path A (Frida) or Path B (screen + level files) | 👤🤖 | ⬜ | Decision recorded below |

**M0 decision:** _pending_

## M1 — Game state extraction

| # | Checkpoint | Owner | Status | Done when (evidence) |
| - | - | - | - | - |
| 1.1 | Dump IL2CPP types (Il2CppDumper) | 🤖 | ⬜ | Type map of board/block/door classes in `docs/` |
| 1.2 | Define shared `GameState` JSON schema | 🤖 | ⬜ | Schema + example file committed |
| 1.3 | Extract live board state (Path A hook or Path B parser) | 🤖 | ⬜ | State JSON matches screen for 3 levels |
| 1.4 | Handle doors, colors, block shapes | 🤖 | ⬜ | Fixtures for 3 levels pass tests |
| 1.5 | Detect level start / win / fail | 🤖 | ⬜ | Events logged correctly |

## M2 — Move execution

| # | Checkpoint | Owner | Status | Done when (evidence) |
| - | - | - | - | - |
| 2.1 | Enumerate legal moves | 🤖 | ⬜ | Legal-move list matches game for 3 levels |
| 2.2 | Execute a chosen move in game | 🤖 | ⬜ | Block moves as commanded |
| 2.3 | Detect move completion before next decision | 🤖 | ⬜ | No double-moves over 20 moves |
| 2.4 | Scripted solve of level 1 end-to-end (no AI) | 🤖 | ⬜ | Video/GIF of scripted win |

## M3 — Jev integration

| # | Checkpoint | Owner | Status | Done when (evidence) |
| - | - | - | - | - |
| 3.1 | Bridge scaffold (Node/TS, Fastify) + TypeSafe SDK | 🤖 | ⬜ | Health check + test Jev call works |
| 3.2 | `Choice` question: pick next move | 🤖 | ⬜ | Valid move returned with probabilities |
| 3.3 | `Score` / `Noul`: progress + dead-end check | 🤖 | ⬜ | Values logged per move |
| 3.4 | Confidence routing (low confidence → lookahead / re-ask) | 🤖 | ⬜ | Rule covered by unit test |
| 3.5 | Call log: state, options, probs, confidence, latency, tokens | 🤖 | ⬜ | JSONL log per run |
| 3.6 | **First level solved by Jev** 🎉 | 🤖 | ⬜ | Recording committed/linked |

## M4 — Live simulation dashboard

| # | Checkpoint | Owner | Status | Done when (evidence) |
| - | - | - | - | - |
| 4.1 | Vite + React dashboard streaming decisions | 🤖 | ⬜ | Live updates per move |
| 4.2 | Probability bars, confidence, latency, cost | 🤖 | ⬜ | Screenshot in README |
| 4.3 | scrcpy mirror + one-command `start` script | 🤖 | ⬜ | `pnpm start` launches everything |
| 4.4 | Demo recording in README | 👤🤖 | ⬜ | GIF/video linked |

## M5 — Harder mechanics & evaluation

| # | Checkpoint | Owner | Status | Done when (evidence) |
| - | - | - | - | - |
| 5.1 | Elevators & generators | 🤖 | ⬜ | Levels with these mechanics solved |
| 5.2 | Ice / locked / arrow / bomb blocks | 🤖 | ⬜ | Levels with these mechanics solved |
| 5.3 | Metrics report (solve rate, moves, cost, latency) | 🤖 | ⬜ | `docs/results.md` |
| 5.4 | Solve 10 consecutive levels unattended | 🤖 | ⬜ | Run log + recording |

---

## Log

| Date | Checkpoint | Note |
| - | - | - |
| 2026-11-07 | — | Repo created; README, AGENDA, tracker added. APK inspected: Unity IL2CPP, unencrypted metadata. |
| 2026-11-07 | 0.1 | Android SDK + JDK 17 installed to `%LOCALAPPDATA%\Android` (no admin). `ANDROID_HOME`, `JAVA_HOME`, PATH set for user. Host is a Hyper-V VM; WHPX acceleration usable. |
| 2026-11-07 | 0.2 | Deferred — API key to be provided later (needed for M3). |
