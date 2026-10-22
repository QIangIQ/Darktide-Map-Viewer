"""Gameplay overlays from the Darktide Lua source: main path, volumes, mission themes, mission templates."""
import os, re, glob
import lupa
from dtfmt import SOURCE


def lua_table_file(path):
    """Run a self-contained data Lua file and return its value as plain Python."""
    rt = lupa.LuaRuntime(unpack_returned_tuples=True)
    src = open(path, encoding='utf-8-sig', errors='ignore').read()
    try:
        val = rt.execute(src)
    except lupa.LuaError:
        return None
    return _py(val)


def _py(v, depth=0):
    if depth > 40:
        return None
    if lupa.lua_type(v) == 'table':
        keys = list(v.keys())
        if keys and all(isinstance(k, int) for k in keys) and sorted(keys) == list(range(1, len(keys) + 1)):
            return [_py(v[k], depth + 1) for k in sorted(keys)]
        return {str(k): _py(v[k], depth + 1) for k in keys}
    if lupa.lua_type(v) is None:
        return v
    return None


def level_dir(level_path):
    return os.path.join(SOURCE, *level_path.split('/'))


def mission_overlays(mission_level, sublevels):
    """mission_level: 'content/levels/dust/missions/mission_dm_propaganda'.
    sublevels: list of (index, path, 4x4 matrix) for nested levels (world volumes are level-local)."""
    out = dict(main_path=None, volumes=[], themes=None)
    base = os.path.join(SOURCE, *mission_level.split('/'))
    mp = base + '_main_path.lua'
    if os.path.exists(mp):
        out['main_path'] = lua_table_file(mp)
    th = base + '_mission_themes.lua'
    if os.path.exists(th):
        out['themes'] = lua_table_file(th)
    vd = base + '_volume_data.lua'
    if os.path.exists(vd):
        t = lua_table_file(vd)
        for v in _volumes(t):
            v['level'] = 0
            out['volumes'].append(v)
    for li, path, m in sublevels:
        d = os.path.dirname(os.path.join(SOURCE, *path.split('/')))
        f = os.path.join(d, 'world_volume_data.lua')
        if os.path.exists(f):
            for v in _volumes(lua_table_file(f)):
                v['level'] = li
                out['volumes'].append(v)
    return out


def _volumes(t):
    if isinstance(t, dict):
        t = t.get('volume_data') or t.get('volumes') or next((x for x in t.values() if isinstance(x, list)), [])
    res = []
    for v in t or []:
        if not isinstance(v, dict) or not v.get('bottom_points'):
            continue
        res.append(dict(name=v.get('name'), type=v.get('type'), height=v.get('height'),
                        points=v.get('bottom_points')))
    return res


TEMPLATE_FIELDS = ('level', 'mission_name', 'mission_type', 'zone_id', 'game_mode_name', 'mission_description',
                   'coordinates', 'objectives')


def mission_templates():
    """{key: {level, mission_name, zone_id, ...}} parsed from scripts/settings/mission/templates/*.lua.
    Regex over the source text: each template is `key = {` at one tab, fields `field = "value",`."""
    res = {}
    for f in sorted(glob.glob(os.path.join(SOURCE, 'scripts', 'settings', 'mission', 'templates', '*.lua'))):
        txt = open(f, encoding='utf8', errors='ignore').read()
        for m in re.finditer(r'^\t(\w+) = \{\n(.*?)^\t\},?$', txt, re.S | re.M):
            key, block = m.group(1), m.group(2)
            d = {}
            for fld in TEMPLATE_FIELDS:
                mm = re.search(r'^\t\t%s = "([^"]*)"' % fld, block, re.M)
                if mm:
                    d[fld] = mm.group(1)
            if d.get('level'):
                d['file'] = os.path.basename(f)
                import loc as L
                d['title'] = L.loc(d.get('mission_name'))
                d['zone_name'] = L.loc('loc_zone_' + d['zone_id']) if d.get('zone_id') else None
                d['description'] = L.loc(d.get('mission_description'))
                res[key] = d
    return res
