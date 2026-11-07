# Results

## Offline solver baseline (levels 1–60)

Command (levels extracted locally, not committed):

```powershell
$env:JEV_LEVELS_DIR = "path\to\levels"
npm run solve -- 1 60          # weighted A*, weight 1, 60k node budget
```

| Outcome | Levels | Count |
| - | - | - |
| ✅ Solved | 1–6, 8–18, 31, 33, 50–53, 60 | **24** |
| ⏱️ Node limit (60k) | 7, 19 (super-hard), 25, 32 | 4 |
| ⏭️ Skipped (unmodelled mechanics) | 20–30 except 25, 34–49, 54–59 | 32 |

- **24 / 28 supported levels solved (86%)**, 24 / 60 overall.
- Solved plans range from 3 moves (L1) to 67 moves (L17); median 32.
- Most solves take < 0.5 s; the slowest (L10) takes 4.2 s / 6.5k nodes.
- Level 7 was also run with a 3M node budget (310 s) and still hit the limit, so it is either
  very deep or unsolvable under the engine's current rules (possible rule mismatch, to check on
  device).
- Skips by mechanic: curtain locks (24 levels), generators (14), inner walls (14), keys/locks (1).
  A level can have several.

Full per-level output is reproducible with the command above.

## Jev runs

_Pending the TypeSafe API key (checkpoint 0.2 / 3.6)._ The mock decider (one-ply lookahead
softmax) plus solver fallback wins the synthetic demo level in 7 moves; the solver decider wins
level 12 in 35 moves through the live server.
