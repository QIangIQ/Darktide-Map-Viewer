"""Darktide unit (v0x73 = 115) -> render meshes in unit space.

Body layout from dacp unit_v115.cpp build_unit_v115 (checked on retail units):
  u32 0x73, u32 n_geom, n_geom x MeshGeometry, u32 n_skins + skins, simple-animation blob + groups,
  SceneGraph (u32 n; n x (rot3x3, pos3, scale3); n x world 4x4 col-major; n x (u16 parent_type, u16 parent);
  n x u32 name; u32 0), u32 n_mesh_objects x (name, node, geometry(1-based), skin, render_flags, kind,
  enabled, bounds10, u32), tail (actors, lights, LOD objects, ...), material table at the very end:
  u32 n x (u32 slot id32, u64 material), u64 0, u64 0, u64 skeleton, u32 0.
MeshGeometry: u32 1, u32 n_streams x (blob, u32 0, u32 0, u32 verts, u32 stride),
  u32 n_channels x (u32 semantic, u32 type, u32 set, u32 stream, u8), u32 0, u32 0, u32 index_type,
  u32 n_indices, blob indices, u32 n_batches x (u32 material index, u32 start tri, u32 tris, u32 bone set),
  bounds10, u32 n_materials x u32 slot id32, u32 0.
Streamed geometry: blobs are empty; data sits in the resource's .stream file, in geometry order,
  as u32 n_streams x blob, then the index blob.
LOD objects (tail): steps of (f32 max, f32 min, u32 n, n x u32 mesh-object index, u32, u32), first max=FLT_MAX.
"""
import struct, re
import numpy as np
from dtfmt import R, read_resource, read_stream, raw_path, have_raw

FLT_MAX = 0x7f7fffff
# semantic ids (compiler: {4,17} tangent frame, {0,17} position, {1,15} normal oct, {5,15,set} uv,
# {8,17} weights, {7,19} joints); 6 seen on retail units with stride 4 (vertex colour)
SEM_POS, SEM_NRM, SEM_TBN, SEM_UV, SEM_COL, SEM_IDX, SEM_W = 0, 1, 4, 5, 6, 7, 8
TYPES = {2: ('<f4', 3), 17: ('<f2', 4), 15: ('<f2', 2), 18: ('u1', 4), 19: ('u1', 4), 16: ('<f2', 3)}


def oct_decode(e):
    """inverse of compiler oct_encode (values in [0,1])"""
    f = e.astype(np.float32) * 2.0 - 1.0
    x, y = f[:, 0].copy(), f[:, 1].copy()
    z = 1.0 - np.abs(x) - np.abs(y)
    neg = z < 0
    ox = (1.0 - np.abs(y)) * np.where(x >= 0, 1.0, -1.0)
    oy = (1.0 - np.abs(x)) * np.where(y >= 0, 1.0, -1.0)
    x = np.where(neg, ox, x); y = np.where(neg, oy, y)
    v = np.stack([x, y, z], 1)
    n = np.linalg.norm(v, axis=1, keepdims=True)
    return v / np.maximum(n, 1e-12)


def _geom_header(r):
    v = r.u32()
    if v != 1:
        raise ValueError('mesh geometry version %d' % v)
    streams = []
    for _ in range(r.u32()):
        b = r.blob(); r.u32(); r.u32(); nv = r.u32(); st = r.u32()
        streams.append([b, nv, st])
    chans = []
    for _ in range(r.u32()):
        chans.append((r.u32(), r.u32(), r.u32(), r.u32())); r.u8()
    r.u32(); r.u32(); itype = r.u32(); ni = r.u32(); ib = r.blob()
    batches = [(r.u32(), r.u32(), r.u32(), r.u32()) for _ in range(r.u32())]
    bounds = r.f(10)
    mats = [r.u32() for _ in range(r.u32())]
    r.u32()
    return dict(streams=streams, chans=chans, itype=itype, ni=ni, ib=ib, batches=batches,
                bounds=bounds, mats=mats)


def _decode_geom(g):
    out = {}
    nv = g['streams'][0][1] if g['streams'] else 0
    for sem, typ, sset, si in g['chans']:
        b, n, st = g['streams'][si]
        if typ not in TYPES:
            continue
        dt, cnt = TYPES[typ]
        a = np.frombuffer(b, dtype=np.dtype(dt), count=n * cnt).reshape(n, cnt)
        out[(sem, sset)] = a
    idx = np.frombuffer(g['ib'], dtype='<u2' if g['itype'] == 0 else '<u4', count=g['ni']).astype(np.uint32)
    m = dict(nv=nv, indices=idx, batches=g['batches'], mats=g['mats'])
    p = out.get((SEM_POS, 0))
    if p is None or len(idx) == 0 or int(idx.max()) >= len(p):
        return None
    if not np.isfinite(p[:, :3].astype(np.float32)).all():
        return None
    m['pos'] = p[:, :3].astype(np.float32)
    m['pos_half'] = p.dtype == np.float16
    if (SEM_NRM, 0) in out:
        m['nrm'] = oct_decode(out[(SEM_NRM, 0)][:, :2])
    if (SEM_TBN, 0) in out:
        t = out[(SEM_TBN, 0)].astype(np.float32)
        tan = oct_decode(t[:, :2]); nbit = oct_decode(t[:, 2:4])  # -bitangent
        if 'nrm' in m:
            # handedness: bitangent = w * cross(n, t); stored value is -bitangent
            w = np.sign(np.einsum('ij,ij->i', np.cross(m['nrm'], tan), -nbit))
            w[w == 0] = 1
            m['tan'] = np.concatenate([tan, w[:, None]], 1).astype(np.float32)
    for s in range(4):
        if (SEM_UV, s) in out:
            m['uv%d' % s] = out[(SEM_UV, s)]
    if (SEM_COL, 0) in out:
        m['col'] = out[(SEM_COL, 0)]
    m['skinned'] = (SEM_W, 0) in out
    return m


def _lod_objects(tail, n_mo):
    """Find LOD step tables. Returns list of [step0 mesh idx list, other idx list]."""
    lods = []
    used = set()
    o = 0
    L = len(tail)
    while True:
        o = tail.find(b'\xff\xff\x7f\x7f', o)
        if o < 0:
            break
        if o < 4 or o in used:
            o += 1; continue
        nsteps = struct.unpack_from('<I', tail, o - 4)[0]
        if not (1 <= nsteps <= 16):
            o += 1; continue
        p = o; steps = []; prev_min = None; ok = True
        try:
            for s in range(nsteps):
                mx, mn = struct.unpack_from('<ff', tail, p)
                if s == 0:
                    pass
                elif abs(mx - prev_min) > 1e-6:
                    ok = False; break
                n = struct.unpack_from('<I', tail, p + 8)[0]
                if not (0 <= n <= 64):
                    ok = False; break
                idx = list(struct.unpack_from('<%dI' % n, tail, p + 12))
                if any(i >= n_mo for i in idx):
                    ok = False; break
                steps.append(idx); prev_min = mn
                p += 12 + 4 * n + 8
        except struct.error:
            ok = False
        if ok and steps:
            lods.append(steps); used.add(o); o = p
        else:
            o += 1
    return lods


def load_unit(h):
    """-> dict(meshes=[{geom data..., world (4x4 col-major), mo index}], materials={slot: material hash})"""
    body, sname = read_resource(raw_path(h, 'unit'))
    r = R(body)
    if r.u32() != 0x73:
        raise ValueError('unit version')
    geoms = [_geom_header(r) for _ in range(r.u32())]
    for _ in range(r.u32()):  # skins
        n = r.u32(); r.skip(64 * n); k = r.u32(); r.skip(4 * k)
        for _ in range(r.u32()):
            k = r.u32(); r.skip(4 * k)
    r.blob()  # simple animation
    for _ in range(r.u32()):
        r.u32(); k = r.u32(); r.skip(4 * k)
    nn = r.u32()
    r.skip(60 * nn)
    world = np.frombuffer(body, '<f4', 16 * nn, r.o).reshape(nn, 4, 4).transpose(0, 2, 1).copy()  # row-major
    r.skip(64 * nn)
    parents = [(r.u16(), r.u16()) for _ in range(nn)]
    node_names = [r.u32() for _ in range(nn)]
    r.u32()
    mos = []
    for _ in range(r.u32()):
        name, node, geom, skin, flags, kind, en = (r.u32() for _ in range(7))
        bounds = r.f(10); r.u32()
        mos.append(dict(name=name, node=node, geom=geom, skin=skin, flags=flags, kind=kind, enabled=en))
    tail = body[r.o:]
    # material table from the end
    materials = {}
    end = len(body) - 28
    for k in range(0, 256):
        p = end - 12 * k - 4
        if p < r.o:
            break
        if struct.unpack_from('<I', body, p)[0] == k:
            for i in range(k):
                slot, mat = struct.unpack_from('<IQ', body, p + 4 + 12 * i)
                materials[slot] = mat
            break
    # streamed geometry
    if any(len(s[0]) == 0 and s[1] > 0 for g in geoms for s in g['streams']):
        # The .stream file holds one entry per streamed geometry (u32 n x blob, then index blob), but NOT
        # in geometry order: match each entry to its geometry by the exact byte sizes it must have.
        sd = read_stream(sname) if sname else b''
        sr = R(sd)
        entries = {}
        while sr.o + 4 <= len(sd):
            try:
                n = sr.u32()
                if n > 32:
                    break
                blobs = [sr.blob() for _ in range(n)]
                ib = sr.blob()
            except struct.error:
                break
            if sr.o > len(sd):
                break
            sig = tuple(len(b) for b in blobs) + (len(ib),)
            entries.setdefault(sig, []).append((blobs, ib))
        for g in geoms:
            if g['streams'] and all(len(s[0]) == 0 for s in g['streams']):
                isz = g['ni'] * (2 if g['itype'] == 0 else 4)
                sig = tuple(s[1] * s[2] for s in g['streams']) + (isz,)
                lst = entries.get(sig)
                if lst:
                    blobs, ib = lst.pop(0)
                    for i, b in enumerate(blobs):
                        g['streams'][i][0] = b
                    g['ib'] = ib
    lods = _lod_objects(tail, len(mos))
    hidden = set()
    for steps in lods:
        for st in steps[1:]:
            hidden.update(st)
    for st in lods:
        hidden.difference_update(st[0])
    decoded = {}
    meshes = []
    for i, mo in enumerate(mos):
        if i in hidden or not mo['enabled'] or not (mo['flags'] & 1):
            continue
        gi = mo['geom'] - 1
        if not (0 <= gi < len(geoms)):
            continue
        if gi not in decoded:
            try:
                decoded[gi] = _decode_geom(geoms[gi])
            except Exception:
                decoded[gi] = None
        g = decoded[gi]
        if g is None or 'nrm' not in g:
            continue
        meshes.append(dict(geom=gi, mo=i, name=mo['name'], world=world[mo['node']], flags=mo['flags'],
                           skinned=bool(mo['skin']), data=g))
    strings = sorted(set(x.decode() for x in re.findall(rb'(?<![ -~])([a-z][a-z0-9_]{3,}(?:/[a-z0-9_]+)*)\x00', body)))
    return dict(meshes=meshes, materials=materials, nodes=nn, node_names=node_names, node_world=world, lods=lods,
                strings=strings)
