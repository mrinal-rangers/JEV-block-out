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
- [x] Install Android SDK + JDK 17; create **API 30** x86_64 *Google APIs* AVD (rootable).
- [x] `adb install-multiple` base + `config.armeabi_v7a` splits; game runs under ARM translation.
- [ ] Play a level by hand over adb — **blocked until the owner accepts the game's ToS**.
- [x] Locate level files → they are TextAssets inside the APK, not app data.
- [x] Test Frida → crashes the translated process (negative result).
- [x] **Decision: Path B+** (level files + own rules engine; screenshots only to verify).

### M1 — Game state extraction
- [x] Dump IL2CPP types and map `LevelModel` (blocks, doors, walls, feature arrays).
- [x] Level-file parser (`packages/core/src/level.ts`) + rules engine (`engine.ts`).
- [x] Stable `GameState` JSON schema (`schema/`).
- [ ] Check engine state against the screen on device (after ToS).

### M2 — Move execution
- [x] Enumerate legal moves (own grid rules; slides + exits, ice, axis, layers).
- [x] Execute a move as an adb touch drag; detect settle from screenshots.
- [x] Detect win / stuck / loops in the runner.
- [ ] Verify on device (after ToS).

### M3 — Jev integration
- [x] Bridge (Node/TS) with `@typesafe-ai/sdk`; key from `TYPESAFE_API_KEY`.
- [x] Questions: `Choice` (next move), `Score` (progress), `Noul` (dead end?).
- [x] Confidence routing: low confidence → re-ask top 5 → solver fallback.
- [x] Log every call: state, options, probabilities, confidence, latency, tokens (JSONL).
- [ ] First real Jev solve (needs API key).

### M4 — Live simulation dashboard
- [x] Browser viewer over SSE: board animation, option probabilities, confidence, latency.
- [ ] Cost display, scrcpy mirror side-by-side, one-command `start` script.
- [ ] Record demo video/GIF for the README.

### M5 — Harder mechanics & evaluation
- [ ] Support curtain locks, generators, inner walls, elevators, keys/locks, bombs.
- [ ] Metrics: levels solved, moves vs. par, cost per level, avg latency (solver baseline in `docs/results.md`).

## Open questions

- Do the engine's rules (door ice, exit conditions, layered blocks) match the game exactly? Needs
  on-device checks.
- Is level 7 solvable under the real rules? The solver hits a 3M node limit.
- Best move granularity for Jev: currently block + direction (+ door for exits). Working well with the mock.

## Requirements from the owner

- Accept the game's Terms of Service once in the emulator.
- TypeSafe early-access API key.