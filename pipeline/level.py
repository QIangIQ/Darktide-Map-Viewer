"""Darktide level (version 0x7d) -> placed unit instances, recursively through nested levels.

Measured on retail levels (note 43):
  body u32[0]=0, u32[1]=0x7d, u32[2]=unit count; unit array at body+192, stride 96:
    u64 id, u64 name, u64 unit resource, u64 0, f32 pos[3], f32 quat[4] (x,y,z,w), f32 scale[3], 24 bytes
  nested level records: u64 level resource, f32 pos[3], quat[4], scale[3], u32 len, u32 0, path string
"""
import struct, math, re
import numpy as np
from dtfmt import read_resource, raw_path, have_raw, hx

UNIT_ARRAY = 192
STRIDE = 96


def trs(pos, q, s):
    x, y, z, w = q
    n = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    r = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]], np.float64)
    m = np.eye(4)
    m[:3, :3] = r * np.array(s)[None, :]
    m[:3, 3] = pos
    return m


def _qok(q):
    return abs(math.sqrt(sum(v * v for v in q)) - 1) < 1e-3


def parse_level(h, kinds):
    """kinds: hash -> set of resource types (from hashes.bin). Returns dict(units, sublevels, strings)."""
    body, _ = read_resource(raw_path(h, 'level'))
    ver, count = struct.unpack_from('<II', body, 4)
    units = []
    for i in range(count):
        o = UNIT_ARRAY + STRIDE * i
        uid, name, unit = struct.unpack_from('<QQQ', body, o)
        pos = struct.unpack_from('<3f', body, o + 32)
        q = struct.unpack_from('<4f', body, o + 44)
        s = struct.unpack_from('<3f', body, o + 60)
        units.append(dict(id=uid, name=name, unit=unit, m=trs(pos, q, s)))
    # nested levels: scan after the unit array
    subs = []
    start = UNIT_ARRAY + STRIDE * count
    seen = set()
    for o in range(start, len(body) - 48, 2):
        v = struct.unpack_from('<Q', body, o)[0]
        if v == h or v in seen or 'level' not in kinds.get(v, ()):
            continue
        pos = struct.unpack_from('<3f', body, o + 8)
        q = struct.unpack_from('<4f', body, o + 20)
        s = struct.unpack_from('<3f', body, o + 36)
        if not _qok(q) or not all(abs(c) < 1e5 for c in pos):
            continue
        n = struct.unpack_from('<I', body, o + 48)[0]
        path = ''
        txt = body[o + 56:o + 56 + 200]
        mm = re.match(rb'content/[ -~]+?(?=\x00)', txt)
        if mm:
            path = mm.group(0).decode()
        seen.add(v)
        subs.append(dict(level=v, m=trs(pos, q, s), path=path))
    strings = sorted(set(s.decode() for s in re.findall(rb'content/[a-z0-9_/\-\.]+', body)))
    return dict(version=ver, units=units, sublevels=subs, strings=strings)


def flatten(h, kinds, m=None, depth=0, out=None, levels=None, path_of=None):
    """All unit instances in world space, following nested levels."""
    if out is None:
        out, levels = [], []
    if m is None:
        m = np.eye(4)
    if not have_raw(h, 'level') or depth > 8:
        return out, levels
    L = parse_level(h, kinds)
    li = len(levels)
    levels.append(dict(level=h, path=path_of or hx(h), units=len(L['units']), depth=depth, m=m))
    for u in L['units']:
        out.append(dict(unit=u['unit'], id=u['id'], name=u['name'], m=m @ u['m'], level=li))
    for s in L['sublevels']:
        flatten(s['level'], kinds, m @ s['m'], depth + 1, out, levels, s['path'] or None)
    return out, levels
