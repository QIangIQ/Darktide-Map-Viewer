"""Darktide material (v60-62 stream) -> texture channels + variables.

Layout from dacp material_v61.cpp parse_material_stream:
 header: u32 version, u32 material_offset(28), u32 material_size, u32 shader_off, u32 shader_size,
         u32 other_off, u32 other_size
 material: u32 direct_shader_selector, u64 shader_provider_material, u64 parent_material,
           u32 n + n*u32, u32 n + n*(u32 channel id32, u64 texture), u32 n + n*(u32 name, u32 value),
           u32 n + n*(u32 class, u32 elements, u32 name id32, u32 data_offset, u32 stride),
           u32 size + variable data, u32 n + n*5 bytes, u32 n + n*8 bytes
"""
import struct
from dtfmt import read_resource, raw_path, have_raw, R

_cache = {}


def parse_material(h):
    if h in _cache:
        return _cache[h]
    out = None
    if have_raw(h, 'material'):
        body, _ = read_resource(raw_path(h, 'material'))
        r = R(body)
        ver = r.u32(); moff = r.u32(); msize = r.u32()
        if ver in (60, 61, 62) and moff == 28:
            r.o = moff
            sel = r.u32(); provider = r.u64(); parent = r.u64()
            n = r.u32(); r.skip(4 * n)
            n = r.u32(); textures = {}
            for _ in range(n):
                ch = r.u32(); tex = r.u64(); textures[ch] = tex
            n = r.u32(); contexts = {}
            for _ in range(n):
                a = r.u32(); b = r.u32(); contexts[a] = b
            n = r.u32(); vars_ = []
            for _ in range(n):
                vars_.append((r.u32(), r.u32(), r.u32(), r.u32(), r.u32()))
            vsize = r.u32(); vdata = body[r.o:r.o + vsize]; r.skip(vsize)
            variables = {}
            for klass, elements, name, off, stride in vars_:
                # compiler variable_width(): class 0..3 = 1..4 floats
                n = klass + 1 if klass <= 3 else 0
                if n and off + 4 * n <= vsize:
                    variables[name] = (klass, struct.unpack_from('<%df' % n, vdata, off))
            out = dict(provider=provider, parent=parent, selector=sel, textures=textures,
                       contexts=contexts, variables=variables)
    _cache[h] = out
    return out


def resolved(h, depth=0):
    """Material with parent (and shader provider) textures/variables merged in; child wins."""
    m = parse_material(h)
    if m is None:
        return None
    tex = {}; var = {}
    chain = []
    cur = h
    while cur and depth < 8:
        mm = parse_material(cur)
        if mm is None:
            break
        chain.append(cur)
        cur = mm['parent'] or mm['provider']
        depth += 1
    for c in reversed(chain):
        mm = parse_material(c)
        tex.update(mm['textures']); var.update(mm['variables'])
    return dict(textures=tex, variables=var, chain=chain, contexts=m['contexts'])
