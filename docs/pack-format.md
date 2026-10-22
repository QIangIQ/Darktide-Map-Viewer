# Pack format

`pipeline/build_map.py` writes one folder per mission, `packs/<key>/`. All coordinates are Darktide (Stingray) world
space: Z up, metres. The viewer rotates its scene root to three.js' Y up.

| File | Content |
|---|---|
| `manifest.json` | `format` (`darktide-map-pack`), `version`, `key`, `level`, `template`, `bounds`, `levels`, `meshes`, `materials`, `units`, `instances`, `files` |
| `geometry.bin` | vertex streams and index buffers; each mesh record in the manifest gives offsets and types |
| `instances.bin` | per mesh: column-major float32 instance matrices (mirrored ones last) and the instance ids |
| `overlays.json` | `main_path`, `volumes`, `themes`, `pois`, `poi_labels` |
| `pins.json` | optional, written by the Pins tab |
| `../_tex/` | textures shared by all packs (WebP) |
| `../_icons/` | ability and class icons from `build_icons.py` |

`instances` is a table with `unit` (index into `units`), `level` (index into `levels`) and `pos` per placed unit.
`pois` entries are `{ cat, inst, pos: [x, y, z] }` where `inst` is an index into that table.

`packs/index.json` lists every built pack; the mission menu shows packs that are not in the game's mission templates
under *other*.

Packs are derived from the game's files: keep them on your PC and do not redistribute them.
