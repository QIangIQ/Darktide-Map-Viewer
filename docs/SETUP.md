# Setup guide: build your own Darktide maps

This guide takes you from a fresh PC to a map of any Darktide mission, and explains how each part works so you can
change it. Short version: [README.md](../README.md).

## 1. What you need

| Need | Why | Where it goes |
|---|---|---|
| Windows 10 or 11 | the game's Oodle compressor is a Windows DLL | |
| Darktide installed through Steam | source of all maps | found automatically, or set `DARKTIDE_ROOT` |
| Python 3.10+ | runs the pipeline and the local server | on PATH |
| `numpy`, `Pillow`, `texture2ddecoder`, `lupa` | geometry, texture decode (BCn to WebP), Lua parsing | `pip install -r requirements.txt` |
| Darktide Lua source dump (https://github.com/Aussiemon/Darktide-Source-Code) | mission templates, main path, volumes, mission themes | `Darktide-Source-Code\` or `DARKTIDE_SOURCE` |
| `limn.exe` | reads the game's bundle files | `tools\limn.exe` |
| A WebGL2 browser | draws the map | Chrome, Edge, Firefox |

Nothing from the game is downloaded or shipped by this repository. The Oodle DLL (`oo2core_9_win64.dll`) is read from
the game's own `binaries` folder.

## 2. Folder layout

```
serve.py            local web server (127.0.0.1 only) + build job runner
run.bat             starts the server (and the first-run extract)
requirements.txt    Python libraries
viewer/             the web app (three.js): index.html, app.js, style.css
pipeline/           the builder: extract.py, build_map.py, build_all.py and the format readers
  data/shader_names.json   texture channel names
tools/limn.exe      you add this (see tools/README.md)
Darktide-Source-Code/   you add this (Lua source dump)
cache/              created: raw game resources (derived from the game, git-ignored)
packs/              created: one folder per built mission, plus packs/_tex shared textures (git-ignored)
```

## 3. Step by step

1. **Python libraries**: `python -m pip install -r requirements.txt`.
2. **Lua source**: put the dump in `Darktide-Source-Code\` so that
   `Darktide-Source-Code\scripts\settings\mission\templates\` exists. Use a different folder by setting
   `DARKTIDE_SOURCE`. Use a dump that matches your game version where you can: after a patch, an old dump can
   miss new missions or have outdated volumes.
3. **limn**: copy `limn.exe` to `tools\`.
4. **Extract** (game closed): run `run.bat`. If `cache\raw` does not exist it runs
   `python pipeline\extract.py`, which uses limn to dump levels, units, materials and textures, the English
   strings and the resource hash list into `cache\`, then builds the name indexes. Run it again after every game
   update (the page also has a **Refresh game cache** button).
5. **Server**: `run.bat` then runs `python serve.py` and opens http://127.0.0.1:8740/. Set `MAPVIEWER_PORT` to use
   another port.
6. **Build a mission** from the mission list, or from a terminal (see section 4).
7. **Open it**, then press `T` for the Strikemap view.

Settings (all optional). Each is read from the environment variable first, then from `config.local.json` (copy
`config.example.json`; it is git-ignored), then found automatically:

| Variable | `config.local.json` key | Default | Meaning |
|---|---|---|---|
| `DARKTIDE_ROOT` | `game_root` | found in your Steam libraries | game folder, the one that has `bundle` and `binaries` |
| `DARKTIDE_SOURCE` | `source_root` | `./Darktide-Source-Code` | Lua source dump |
| `MAPVIEWER_PORT` | | `8740` | server port |

Build every mission with `scripts\Build All Maps.cmd` (resumable: it skips missions that already have a pack).
More pages: [pack-format.md](pack-format.md), [gameplay-data.md](gameplay-data.md).

## 3a. Quick checks when something does not start

- `python --version` must print 3.10 or newer. A bare `python` that opens the Microsoft Store is the Store
  stub: install Python from python.org and tick "Add to PATH".
- `python -c "import numpy, PIL, texture2ddecoder, lupa"` must print nothing.
- `tools\limn.exe` must exist, and the game must be closed while extracting.
- `python -c "import sys; sys.path.insert(0,'pipeline'); import dtfmt; print(dtfmt.GAME, dtfmt.SOURCE)"` prints the
  two folders the pipeline will use. Fix them with the environment variables above.

## 4. Building maps

From the mission list: **Build** (one mission), **Build all missing**, texture size menu (512, 1024 or 2048 px,
applies to the next build; textures are shared between missions in `packs\_tex`).

From a terminal, in `pipeline\`:

```
python build_map.py <mission key> [--tex-max 1024] [--no-textures] [--no-themes]
python build_all.py [--tex-max 1024] [key ...]        # no keys = every mission
```

- `<mission key>` is a key from the game's mission templates, for example `dm_propaganda` (it is the folder name
  under `packs\`). It can also be a level path such as `content/levels/dust/missions/mission_dm_propaganda`.
- List the keys you can build:
  ```
  python -c "import sys; sys.path.insert(0,'pipeline'); import overlays; print('\n'.join(overlays.mission_templates()))"
  ```
- `--no-textures` builds in a few seconds with flat grey materials: enough for Strikemap work and layout checks.
- `--no-themes` leaves out the mission theme variants (darkness, toxic gas and so on).
- Output: `packs\<key>\manifest.json`, `geometry.bin`, `instances.bin`, `overlays.json`. `packs\index.json` lists
  everything built.

Disk and time (1024 px textures): one mission takes 10 to 60 seconds (one tested pack was about 0.4 GB, with the
textures shared in `packs\_tex`); all missions take about 10 minutes and about 12 GB.

### Making maps of your own levels

Any level in the cache can be built with its path: `python build_map.py content/levels/<...>/<level>`. The viewer lists
packs it does not recognise from the templates under *extra* in the mission menu. A level that is not a mission has
no main path or volumes, so the map frames the whole level bounds instead.

## 5. Using Strikemap for a chest and collectible map

1. Open the mission, press `T`.
2. In the **Strike** tab, tick the categories you want. Chests, grimoires, scriptures, martyr skulls and
   side-mission items are on by default.
3. Click markers as you collect them. Open the `list` under a category to jump to each spawn with **Go**.
4. Use the map slice to isolate a floor, **Playable area only** to cut the scenery, then **Save PNG** to export.

Where the data comes from: at build time every placed unit's flow data is scanned for keywords. `loc_chest` becomes
a **Chest** marker, `tome` a scripture, `medicae_servitor` a medicae station, and so on. The rules are the
`POI_RULES` list in `pipeline/build_map.py`: add a line `('key', 'Label', r'regex')` there, rebuild the mission,
and a new category appears in the Layers tab and in Strikemap. Give it a colour and letter in `POI_STYLE` and a
group in `STRIKE_GROUPS` in `viewer/app.js` to place it in the sidebar.

### Ability circles, icons and drawing

The ability list is `ABILITIES` in `viewer/app.js`: each entry has a label, class, icon name, colour and `rings`
(`{ r: <metres>, label }`). Every note names the Lua source file the radius came from; to add an ability, read its
radius from `scripts/settings/ability/` or `scripts/settings/talent/` in the Lua source and add an entry. Icon
textures are listed in `pipeline/build_icons.py` (`ICONS`: output name to game texture path, using each ability's
`hud_icon`); run it again after adding one. Icons are written to `packs/_icons/` and are derived from the game, so
they stay out of git like the rest of `packs/`.

Drawings and circles are stored in `localStorage` as `mv_draw_<mission>` and `mv_abil_<mission>`, in Darktide world
coordinates.

Found ticks are stored in your browser (`localStorage`, key `mv_found_<mission>`), so they stay on your PC and
survive rebuilds of the same mission.

## 6. How it works

```
game bundles --limn--> cache\raw (levels, units, materials, textures)
pipeline\build_map.py <mission>
  level.py     mission level + nested sub-levels -> placed units (position, rotation, scale)
  unit.py      unit scene graph, LOD0 mesh objects, vertex streams, material slots
  material.py  material chains -> texture channels (data/shader_names.json) and variables
  texture.py   Oodle + 64 KiB chunk un-tiling + BCn decode -> WebP
  overlays.py  main path, volumes, themes, mission templates from the Lua source
-> packs\<mission>\ manifest.json, geometry.bin, instances.bin, overlays.json
viewer\ (three.js) renders the pack with GPU instancing; serve.py serves it and runs builds.
```

All coordinates stay in Darktide world space (Z up, metres); the viewer rotates the scene root to three.js' Y up.
`manifest.json` lists levels, meshes, materials, units and the instance table; `geometry.bin` holds vertex streams
and indices; `instances.bin` holds per-mesh instance matrices; `overlays.json` holds `main_path`, `volumes`,
`themes`, `pois` (`{cat, inst, pos}`) and `poi_labels`.

Strikemap is a re-skin of the loaded pack, not a second build: it swaps every surface material for a small
shader (floor colour by height, light walls, height slice, optional corridor mask around the main path) and
draws the POI sprites at a constant on-screen size. The code is the `strikemap` section of `viewer/app.js`.

## 7. After a game update

1. Update your Lua source dump if the update changed missions.
2. Close the game, press **Refresh game cache** (or run `python pipeline\extract.py`).
3. Rebuild the missions you use.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `tools/limn.exe missing` | copy limn to `tools\` |
| `oodle decompress failed` or DLL not found | the game's `binaries\oo2core_9_win64.dll` is missing; set `DARKTIDE_ROOT` correctly |
| Mission list is empty | the Lua source dump is not found: check `DARKTIDE_SOURCE` and that `scripts\settings\mission\templates` is inside it |
| A mission builds but is empty or partly flat grey | textures were skipped (`--no-textures`) or the cache is from an older game version: refresh the cache and rebuild |
| Blank page or three.js errors | the first load needs internet (three.js comes from a CDN); use a WebGL2 browser |
| Strikemap shows scenery far from the route | keep **Playable area only** on and lower its range; check the map slice |
| Port already in use | set `MAPVIEWER_PORT` to a free port |

## 9. Credits and rights

- three.js (MIT) draws the map.
- Fatshark owns Darktide and its content. Packs, textures and the cache are derived from the game files and are for
  personal use only.
- Oodle belongs to its owner; the viewer only calls the copy that ships with the game.
