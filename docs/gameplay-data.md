# Gameplay data: where markers come from

Each map pack carries gameplay data on top of the geometry.

- **Main path, volumes and themes** are read from the Lua source dump (`pipeline/overlays.py`): the mission's
  `*_main_path.lua`, `*_volume_data.lua`, `*_mission_themes.lua` and each sub-level's `world_volume_data.lua`.
- **Mission templates** (title, zone, level path) come from `scripts/settings/mission/templates/*.lua`; titles come
  from the game's English strings.
- **Markers (`pois`)** are found at build time: every placed unit's flow data is scanned for keywords by the
  `POI_RULES` list in `pipeline/build_map.py`, one line per category:

  ```
  ('chest', 'Chest', r'^loc_chest$'),
  ('scripture', 'Scripture spot', r'^tome$'),
  ('medicae', 'Medicae station', r'^medicae_servitor$'),
  ```

  Pickups also use the unit's pickup spawn nodes. They show where something can appear, not what the director
  spawns in a given run.

To add a category: add a `POI_RULES` line, rebuild the mission, then give it a colour and letter in `POI_STYLE` and a
sidebar group in `STRIKE_GROUPS` (both in `viewer/app.js`).

## Play zones export

The Strike tab's **Export Lua** writes, per mission:

```lua
return {
    mission = "dm_propaganda",
    zones = {
        { name = "Play here 1", kind = "play", pts = { { x, y, z }, { x, y, z }, { x, y, z } } },
    },
}
```

`kind` is `play`, `hold`, `avoid` or `route`; `pts` is the polygon outline in Darktide world coordinates (metres, z up;
z is the height of the map slice when it was drawn). **Export JSON** has the same data.

## Ability circles

The radii in the Strike tab are read from the Lua source (`scripts/settings/ability/` and `scripts/settings/talent/`);
every entry in `ABILITIES` (`viewer/app.js`) names its source file. The ability and class icons are decoded from the
game's texture resources by `pipeline/build_icons.py`.
