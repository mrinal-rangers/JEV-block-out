# Agenda

## Goal

Watch **Jev** solve real **Block Out!** levels live, inside the actual game running on an
Android emulator — without rebuilding the game.

## Principles

- Mod the game *just enough* to read state and send moves. No game re-implementation.
- Jev makes the decisions; code enforces legality and safety.
- Secrets stay local (`TYPESAFE_API_KEY`); no game binaries in the repo.

## What we know about the game (APK v1264)

- Unity, IL2CPP, `armeabi-v7a` native libs only (`libil2cpp.so`, `libunity.so`).
- `global-metadata.dat` is **not encrypted** (standard IL2CPP v31 header) → class/field names are recoverable.
- Relevant types spotted: `BoardSnapshot`, `BlockModel(s)`, `CellModel(s)`, `BoardOccupancy`,
  `BlockMovementAxis`, `CanMove`, `CanBlockPassDoor`, `CheckLevelEnd`, `AllBlocksAreExited`,
  `InBoardGenerator`, `CellElevatorColorSprite`, `BELevelConfig`, `CachedLevelsFileName`.

## Milestones

> Status of each step is tracked in [CHECKPOINTS.md](./CHECKPOINTS.md).

### M0 — Environment spike (go/no-go)
- [ ] Install Android Studio + SDK platform-tools; create Android 13 x86_64 *Google APIs* AVD (rootable).
- [ ] `adb install-multiple` base + `config.armeabi_v7a` splits; confirm game runs under ARM translation.
- [ ] `adb root` and locate cached level files under the app's data dir.
- [ ] Test Frida (gadget in APK and/or frida-server) against the translated process.
- [ ] **Decision:** Path A (Frida hook) or Path B (level files + screen parsing).

### M1 — Game state extraction
- [ ] Dump IL2CPP types (Il2CppDumper) and map board/block/door/elevator/generator models.
- [ ] Path A: hook script that emits board state JSON on each turn.
- [ ] Path B: level-file parser + OpenCV board parser from screenshots.
- [ ] Define a stable `GameState` JSON schema shared by both paths.

### M2 — Move execution
- [ ] Enumerate legal moves (game's `CanMove` in Path A; grid rules in Path B).
- [ ] Execute a move (invoke game method or `adb shell input swipe`).
- [ ] Detect move completion, level win, level fail.

### M3 — Jev integration
- [ ] Bridge (Node/TS) with TypeSafe SDK; key from `TYPESAFE_API_KEY`.
- [ ] Questions: `Choice` (next move), `Score` (progress), `Noul` (dead end?).
- [ ] Confidence routing: low confidence → short lookahead / re-ask.
- [ ] Log every call: state, options, probabilities, confidence, latency, tokens.

### M4 — Live simulation dashboard
- [ ] Vite + React dashboard: current state, move options with probabilities, chosen move, timing.
- [ ] scrcpy mirror side-by-side; one-command `start` script.
- [ ] Record demo video/GIF for the README.

### M5 — Harder mechanics & evaluation
- [ ] Support elevators, generators, ice/locked blocks, arrows, bombs.
- [ ] Metrics: levels solved, moves vs. par, cost per level, avg latency.

## Open questions

- Does Frida work under the emulator's ARM translation? (answered in M0)
- Exact level file format and whether it is encrypted.
- Best move granularity for Jev (block + direction vs. block + target cell).

## Requirements from the owner

- TypeSafe early-access API key.
- Android Studio installed on the PC.
