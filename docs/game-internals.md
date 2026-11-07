# Game internals (Block Out! v1264)

Notes from inspecting **our own copy** of the APK. No game files are committed; levels are
extracted locally with `tools/extract_levels.py` into the gitignored `levels/` folder.

## Binary

- Unity, IL2CPP, `armeabi-v7a` only (`libil2cpp.so`, `libunity.so`). On x86_64 emulators it runs
  under the ARM→x86 native-bridge translation layer.
- `global-metadata.dat` is unencrypted (IL2CPP v31). Il2CppDumper recovers every class and field
  name (`dump.cs`, ~41 MB; kept local, not committed).

## Where the levels live

Levels are **Unity TextAssets inside the APK** (`assets/bin/Data`, split bundles `*.split0..N`),
not in the app's data directory (checkpoint 0.6). Names look like `t249-level-12`,
`t160-level-12`, plus `LevelsConfig`. 1,296 level files were found. Each is Newtonsoft JSON
(sometimes with a UTF-8 BOM) of `LevelModel`, using short `[JsonProperty]` keys.

## LevelModel

| Key | C# property | Meaning | Engine |
| - | - | - | - |
| `LID` | `LevelId` | level id string | ✅ |
| `CMS` | `CellModels` | floor cells (`{BPM:{x,y}}`) | ✅ |
| `WMS` | `WallModels` | wall cells (`{BPM, BI}`) | ✅ |
| `BMS` | `BlockModels` | blocks (table below) | ✅ |
| `DMS` | `DoorModels` | exit doors (table below) | ✅ |
| `IWMS` / `CIWMS` | inner walls / colour inner walls | walls between cells | ❌ flagged |
| `GMS` / `IBG` | generators / in-board generators | spawn new blocks | ❌ flagged |
| `EMS` | elevators | | ❌ flagged |
| `CLMS` / `CCLMS` | curtain locks / colour curtain locks | | ❌ flagged |
| `CCMS` | colour cells | | ❌ flagged |
| `GRM` / `CGRM` | grinders / colour grinders | | ❌ flagged |
| `CBMS` | connected blocks | | ❌ flagged |
| `IMS` | ivy | | ❌ flagged |
| `BKMS` | box keys | | ❌ flagged |

"Flagged" means `parseLevel` lists the mechanic in `GameState.unsupported` and the solver/CLI skip
the level rather than play it with wrong rules.

### BlockModel (`BMS[i]`)

| Key | C# property | Engine handling |
| - | - | - |
| `BCT` | `BlockColorType` | colour (see table below) |
| `BPMS` | `BoardPositionModels` | absolute cells covered |
| `BIC` | `BlockIceCount` | `ice`: frozen until that many blocks have exited |
| `BAD` | `BlockArrowDirection` | `axis`: 1 = horizontal only, 2 = vertical only, else both |
| `ILE` / `LBCT` | `IsLayerExists` / `LayerBlockColorType` | `layers`: outer colour exits, inner colour remains |
| `KID`, `LID`, `LKI` | key / lock ids | flagged `keys/locks` |
| `BKID` | `BoxKeyId` | flagged `box keys` |
| `BD` | `BombDuration` | flagged `bomb timers` |
| `MIC` | `IsMovingIce` | flagged `moving ice` |
| `LIC` | `LayeredIceCount` | flagged `layered ice` |
| `SLBCT` | `StackedLayerBlockColorTypes` | flagged `stacked layers` |
| `BHS`, `AD` | `BlockHasStar`, `AdditionalDuration` | cosmetic / timer; ignored |

### DoorModel (`DMS[i]`)

| Key | C# property | Engine handling |
| - | - | - |
| `BCT` | `BlockColorType` | colour; only matching blocks may exit |
| `BPMS` | `BoardPositionModels` | door cells (just outside the floor) |
| `IH` | `IsHorizontal` | door lies on the top/bottom edge; `side` is inferred from which neighbour is floor |
| `BI` | `BoardId` | `boardId` |
| `DIC` | `DoorIceCount` | `ice`: closed until that many blocks have exited |
| `TBD` | `TurnBasedDoor` | flagged `turn-based doors` |
| `DHS` | `DoorHasStar` | cosmetic; ignored |

### Colours (`BlockColorType`)

| 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
| - | - | - | - | - | - | - | - | - | - | - | - |
| red | blue | yellow | green | purple | orange | pink | darkblue | turquoise | darkgreen | white | black |

### Coordinates

- Board `y` grows **upward** (Unity). The viewer and `screen.ts` flip it for screen space.
- Most files serialise positions as `{x, y}`; some older ones use `{X, Y}`. `parseLevel` accepts both.

## Rules as modelled (packages/core/src/engine.ts)

- A block slides any number of cells along an allowed axis until it hits a wall, a block or the edge.
- A block exits when it slides into a door of its colour, its full cross-section fits the door
  span, and the door's ice is 0.
- Every exit decrements `ice` on all frozen blocks and doors by one.
- A layered block exits its outer colour and stays in place with the inner colour.
- Win = no blocks left. Stuck = no legal moves.

These rules are derived from the type names and level data and are **not yet verified against the
running game** (blocked on the ToS screen, see CHECKPOINTS.md).

## Runtime instrumentation (negative result)

Frida (frida-server on the rooted API 30 x86_64 image) crashes the game process when
instrumenting it: the game code runs as translated ARM, which Frida's x86_64 agent cannot hook.
An ARM64 host or physical ARM device would be needed for Path A.

## Emulator notes (Hyper-V host, WHPX)

- **API 30 x86_64 Google APIs** (rootable) is the working image; API 33 was not used.
- Vulkan is disabled and GLES pinned for reliable rendering on this host:

  ```powershell
  emulator -avd blockout -no-snapshot -no-audio -gpu swiftshader_indirect -no-boot-anim `
    -memory 4096 -cores 4 -feature "-Vulkan,GLESDynamicVersion"
  ```

- On Windows editions without Media Foundation (`mfplat.dll`, e.g. N / Server), install the
  Media Feature Pack if the emulator refuses to start.
- Screen is 1080×2400.
