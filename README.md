# Darktide Map Viewer

A local 3D and 2D map viewer for **Warhammer 40,000: Darktide**, in the spirit of Atlas (the Tarkov map viewer).
It rebuilds every mission from your own game files: level layouts, every placed model, materials and textures,
plus the gameplay data the game ships for each mission (main path, kill and no-spawn volumes, themes, chests,
grimoire and scripture spots, pickup spawn points, medicae stations and more).

- **3D fly-through** of any mission, with a height slice, top-down map and isometric view.
- **Strikemap mode** (press `T`): a flat tactical map in the style of Strikemap / MapGenie, with a sidebar of
  marker categories, **chest and collectible spawns you can tick off as found**, progress counters, and a PNG export.
- Search by gameplay category (`chest`, `grimoire`, ...) or by unit name or hash, ruler tool, shareable camera URLs.
- A build pipeline you can run yourself, so you can make maps of every mission and re-make them after a game update.

> **No game data is in this repository.** The viewer builds its maps on your PC from your own Darktide install and
> keeps them in `packs/` and `cache/` (both git-ignored). Those files are derived from the game: use them
> personally and do not redistribute them. This is an unofficial fan tool and is not affiliated with Fatshark.
> Warhammer 40,000 and Darktide are trademarks of their owners.

License: MIT for the tool's code (see [LICENSE](LICENSE)). Warhammer 40,000: Darktide, its game files and anything
built from them (`cache/`, `packs/`) belong to their owners and are not licensed here.

## Install

You need Windows, the game installed through Steam, and free disk space: about 12 GB for all missions at 1024 px
textures (one mission was about 0.4 GB in testing, plus textures shared between missions).

1. Install **Python 3.10 or newer** (tick "Add python.exe to PATH") and then the libraries:
   ```
   python -m pip install -r requirements.txt
   ```
2. Get the **Darktide Lua source dump**, https://github.com/Aussiemon/Darktide-Source-Code, and clone or unzip it to
   `Darktide-Source-Code\` next to `serve.py` (a GitHub zip unpacks as `Darktide-Source-Code-master`, which is also
   found). Or keep it anywhere and set `DARKTIDE_SOURCE` to that folder. The viewer reads mission templates, main
   paths and volumes from it.
3. Get **limn**, a Darktide bundle extractor, and copy `limn.exe` to `tools\limn.exe`
   (see [tools/README.md](tools/README.md)). It is not included here; where to get it is not recorded in this
   repository yet.
4. **Close Darktide**, then double-click **`run.bat`**. On the first run it reads the game files into `cache\`
   (about a minute) and then opens the mission list at http://127.0.0.1:8740/.
5. Click **Build** on a mission (10 to 60 seconds), then **Open**. **Build all missing** builds every mission
   (about 10 minutes the first time).

The page loads three.js from a CDN, so the first open needs an internet connection.

## Run

Download the zip from Releases (or clone the repository), add `limn.exe` and the Lua source as above, and
double-click **`run.bat`**. The page is the menu: pick a mission, build it, open it. No command line is needed.

- **Build everything:** `scripts\Build All Maps.cmd` queues every mission, skips the ones that already have a
  pack, and can be stopped and restarted.
- **Other game or source folders:** copy `config.example.json` to `config.local.json` (git-ignored) and set
  `game_root` and `source_root`, or set the `DARKTIDE_ROOT` and `DARKTIDE_SOURCE` environment variables.
  Without either, the game is looked up in your Steam libraries.
- **Docs:** [docs/](docs/README.md) has the full setup guide, the pack format, and where markers and radii come from.

The full guide, including building your own maps, texture sizes, adding marker categories and troubleshooting,
is in **[docs/SETUP.md](docs/SETUP.md)**.

## Strikemap mode

Open a mission and press **T** (or click **Strikemap**).

- The view switches to a flat map: dark floor plan, light wall outlines, tinted by height.
- **Playable area only** keeps just the corridor around the main path, so backdrops and platforms do not clutter
  the map. The range slider sets how many metres around the path to keep.
- The **Strike** tab groups markers like a MapGenie sidebar: loot and collectibles (chests, grimoires, scriptures,
  martyr skulls, side-mission items), supplies, mission markers, and hazards and enemies. Each category has a
  checkbox, a count, and an expandable list with a **Go** button for every spawn.
- **Click a marker** (or its checkbox in the list) to mark it found. Found markers dim, or hide with
  *Hide found markers*. Progress is saved in your browser, per mission.
- Move the **map slice** (Q / E or the slider) to look at one floor at a time. `I` gives an isometric Strikemap.
- **P** or *Save PNG* exports the current view. `T` again returns to the normal viewer.

### Look, small objects and play zones

- **Look:** *Flat* is the dark tactical style; *Textured* shows floors and walls with the game's own textures (the
  pack must be built with textures, not `--no-textures`). Both keep the height slice and *Playable area only*.
- **Solid walls:** level meshes are one-sided, so from outside or behind a wall you can see through it. Graphics >
  *Solid walls* (on by default) draws both sides of every surface.
- **Hide small objects and debris:** presets (Off, Debris, Small, Structure) and a radius slider hide mesh parts
  smaller than that radius in metres, so only floors, walls and large structures remain. It also works in the
  normal 3D view.
- **Play zones:** outline where people should play. Pick a type (Play here, Hold / fallback, Avoid, Staging /
  route), press *New zone*, click the vertices, then *Finish* (Enter or double-click). Zones are filled, named and
  listed; rename or delete them, and **Export JSON / Lua** writes the polygons in Darktide world coordinates
  (`{ name, kind, pts }`), ready for a mod to read.

### Ability radius circles and path drawing

Both live in the **Strike** tab and are saved in your browser per mission.

- **Ability radius circles**: pick an ability, click the map to place its circle, with the ability icon and class
  badge at the centre. Radii are the game's own numbers, read from the Lua source:

  | Ability | Radius |
  |---|---|
  | Veteran shout (Voice of Command) | 9 m |
  | Psyker shout | 30 m |
  | Ogryn taunt | 12 m |
  | Adamant shout | 6 m near, 12 m far |
  | Zealot relic pulse (Bolstering Prayer) | 10 m growing 0.1 m per second of the 5.5 s channel; five rings for t = 1 to 5 s (10.1 to 10.5 m) |

  The icons are decoded from your own game files by `python pipeline/build_icons.py` (it also runs at the end of
  `extract.py`). Without them the circles use a coloured letter instead.
- **Draw on the map**: drag to draw a path anywhere, choose a colour and width, `Ctrl+Z` removes the last stroke.
  Circles and drawings are part of the PNG export.

Chest and pickup positions come from the game's own placed units (their flow data marks them as chest or pickup
spawn points). They show where a spawn can appear, not what the director spawns in a given run.

## Controls

| Input | Action |
|---|---|
| Right mouse drag | Look |
| W A S D, Q / E | Move, down / up |
| Shift / Ctrl | Fast / slow |
| Wheel | Movement speed (map views: zoom) |
| Double-click | Identify object (unit, level section, gameplay category, materials) |
| Alt + click | Ruler point (path length, straight distance, height change); Alt + right-click clears |
| F | Focus the selected object |
| M | Top-down map with a height slice (Q / E moves it); click to jump there |
| I, R | Isometric map; R rotates it 90 degrees |
| T | Strikemap mode |
| P | Screenshot |
| H | Help |

The address bar keeps the mission and camera (`#pack=<mission>&cam=x,y,z,yaw,pitch`, Darktide coordinates),
so a view can be bookmarked.

## Known limits

- Lighting is a generic sun, sky and reflection probe, not the game's baked lighting.
- Projected decals (decal boxes) are not projected; mesh decals are drawn as alpha-tested geometry.
- Gameplay categories come from keywords in each unit's own flow data; they say *where* something can appear.
- Strikemap does not show room or area names; it is unlabelled apart from the numbered main path.
- Windows only (the Oodle decompressor is loaded from the game's `binaries` folder).
