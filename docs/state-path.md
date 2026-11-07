# State path decision (checkpoint 0.8)

**Decision: Path B+** — level file + deterministic rules engine for state; screenshots only for
verification; adb input for moves.

## Options considered

| Path | State source | Moves | Verdict |
| - | - | - | - |
| A | Frida hook into IL2CPP `BoardSnapshot` | call game methods | ❌ Frida cannot hook translated ARM code on x86_64 emulators (see game-internals.md) |
| B | OpenCV parse of every screenshot | adb swipe | ⚠️ works without mods but is fragile (animations, effects, ice overlays) |
| **B+** | **level JSON from APK + our engine** | **adb motion events** | ✅ exact state, cheap, testable offline |

## Why B+

- The level files contain the exact initial board, so the full state is known before the first
  move with no vision model.
- After each move the engine computes the next state deterministically. The game has no randomness
  in the supported mechanics, so the engine state stays in sync as long as the move was executed.
- Screenshots are still captured every turn (`shots/<runId>/NNN.png`) and are used to:
  1. detect that animations have settled (two identical frames in a row), and
  2. later, verify engine state against the screen (checkpoint 1.3).
- Everything except the final adb step can run and be tested without the emulator, which made it
  possible to build M1–M3 while the device was blocked.

## Risks

- **Rule drift**: if the engine's rules differ from the game's, the states diverge. Mitigation:
  levels with unmodelled mechanics are skipped; on-device verification is the next step.
- **Calibration**: `screen.ts` guesses the board's screen rectangle; a per-size `calibration.json`
  override exists and will be filled once a level can be opened on device.
