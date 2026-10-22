"""Build a viewer pack for one Darktide mission.

usage: python build_map.py <mission key | content/levels/... path> [--tex-max 1024] [--no-textures] [--themes]

Output: packs/<key>/ manifest.json, geometry.bin, instances.bin, overlays.json; textures shared in packs/_tex/.
All transforms stay in Darktide (Stingray) world space: Z up, metres. The viewer rotates the root.
"""
import os, sys, re, json, time, struct, argparse, traceback
import numpy as np
from concurrent.futures import ProcessPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dtfmt import ROOT, murmur64, hx, have_raw, names, id32
from kinds import kinds
import level as LV
import unit as UN
import material as MA
import overlays as OV

PACKS = os.path.join(ROOT, 'packs')
TEXDIR = os.path.join(PACKS, '_tex')
SHADER_NAMES = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'shader_names.json')))
CH = {v: int(k, 16) for k, v in SHADER_NAMES.items()}
ROLE_CHANNELS = {
    'albedo': ['base_bc', 'bc', 'bca', 'base_color', 'mat1_bc', 'coat_bc'],
    'normal': ['base_nm', 'nm', 'normal', 'mat1_nm', 'coat_nm'],
    'orm': ['base_orm', 'orm', 'mat1_orm', 'coat_orm'],
    'emissive': ['base_em', 'em'],
}


def log(stage, msg='', **kw):
    print(json.dumps(dict(stage=stage, msg=msg, t=round(time.time() - T0, 1), **kw)), flush=True)


T0 = time.time()


# ------------------------------------------------------------------ textures (worker)
def _tex_job(args):
    h, role, tex_max = args
    out = os.path.join(TEXDIR, '%s_%s_%d.webp' % (hx(h), role, tex_max))
    if os.path.exists(out):
        return h, role, os.path.basename(out), json.load(open(out + '.json')) if os.path.exists(out + '.json') else {}
    try:
        import texture as TX
        from PIL import Image
        img, info = TX.load_texture(h, tex_max)
        meta = dict(w=info['w'], h=info['h'], fmt=info['kind'])
        if role == 'normal':
            n = img[..., :2].astype(np.float32) / 255.0 * 2 - 1
            z = np.sqrt(np.clip(1 - n[..., 0] ** 2 - n[..., 1] ** 2, 0, 1))
            rgb = np.dstack([img[..., 0], img[..., 1], ((z * 0.5 + 0.5) * 255).round().astype(np.uint8)])
            im = Image.fromarray(rgb, 'RGB'); im.save(out, 'WEBP', quality=95, method=4)
        elif role == 'albedo':
            a = img[..., 3]
            cut = float((a < 128).mean())
            meta['alpha'] = cut
            if info['kind'] in ('bc1', 'bc4', 'bc5') or cut < 0.002:
                Image.fromarray(img[..., :3], 'RGB').save(out, 'WEBP', quality=90, method=4)
            else:
                Image.fromarray(img, 'RGBA').save(out, 'WEBP', quality=90, method=4)
        else:
            Image.fromarray(img[..., :3], 'RGB').save(out, 'WEBP', quality=90, method=4)
        json.dump(meta, open(out + '.json', 'w'))
        return h, role, os.path.basename(out), meta
    except Exception as e:
        return h, role, None, dict(error=repr(e)[:200])


# Material families, from what the material chain carries (see note 45):
#  helper  - no material bound, or the flat-colour root a570734470cac8a6 (base_color + Roughness only):
#            editor gizmos such as the green direction arrows on decal and spawner units
#  decal   - projector boxes (root 38ecbad13742e4e1, atlas decals with rows_columns / index): the game
#            projects them onto the surfaces inside the box, the box itself is never drawn
#  effect  - no textures, colour/opacity or light_color variables only (light cards, fog sheets)
#  surface - everything else
HELPER_ROOTS = {'a570734470cac8a6'}

# Gameplay categories, matched against strings in the unit's own flow / script data (note 45).
POI_RULES = [
    ('martyr_skull', 'Martyr skull collectible', r'^(martyr_skull_pickup|collectible_01_pickup)$'),
    ('grimoire', 'Grimoire spot', r'^grimoire$'),
    ('scripture', 'Scripture spot', r'^tome$'),
    ('side_mission', 'Side-mission item spot', r'^side_mission$'),
    ('chest', 'Chest', r'^loc_chest$'),
    ('medicae', 'Medicae station', r'^medicae_servitor$'),
    ('pickup', 'Pickup spawn point', r'^c_pickup_\w+$'),
    ('luggable', 'Luggable / socket', r'^(spawn_mission_luggable|luggable_socket|battery_01_luggable)$'),
    ('objective', 'Objective marker', r'^objective_marker_enable$'),
    ('hazard', 'Explosive / gas barrel', r'^content/environment/gameplay/hazard_prop/'),
    ('enemy_gate', 'Enemy spawner gate', r'enemy_spawner_gate'),
    ('door', 'Door', r'^(toggle_open|open_fwd)$'),
    ('player_spawn', 'Player spawner', r'^player_spawner_activate$'),
]
DECAL_ROOTS = {'38ecbad13742e4e1'}


def classify(rec, res):
    if res is None or rec.get('missing'):
        return 'helper'
    root = rec['root']
    if root in HELPER_ROOTS:
        return 'helper'
    if root in DECAL_ROOTS:
        return 'decal'
    if not res['textures']:
        return 'effect'
    return 'surface'


def write_geometry(gf, d):
    """Append one mesh's vertex streams and indices to geometry.bin; return its record (offsets, bounds)."""
    nv = len(d['pos'])
    rec = dict(vertices=nv, attrs={})

    def put(name, arr, typ, comps, norm=False):
        off = gf.tell()
        bb = np.ascontiguousarray(arr).tobytes()
        gf.write(bb)
        gf.write(b'\0' * ((-len(bb)) % 4))
        rec['attrs'][name] = dict(off=off, type=typ, comps=comps, norm=norm)

    # positions/uvs are binary16 in the game files: keep them bit-exact as f16 when they are
    if d.get('pos_half'):
        put('position', d['pos'].astype('<f2'), 'f16', 3)
    else:
        put('position', d['pos'].astype('<f4'), 'f32', 3)
    put('normal', np.round(np.nan_to_num(d['nrm']) * 32767).astype('<i2'), 'i16', 3, True)
    if 'tan' in d:
        put('tangent', np.round(np.nan_to_num(d['tan']) * 32767).astype('<i2'), 'i16', 4, True)
    for si, nm in ((0, 'uv'), (1, 'uv1')):
        a = d.get('uv%d' % si)
        if a is not None:
            half = a.dtype == np.float16
            put(nm, a.astype('<f2' if half else '<f4'), 'f16' if half else 'f32', 2)
    if 'col' in d:
        put('color', d['col'].astype('u1'), 'u8', 4, True)
    idx = d['indices']
    put('index', idx.astype('<u2' if nv < 65536 else '<u4'), 'u16' if nv < 65536 else 'u32', 1)
    rec['indices'] = int(len(idx))
    p = d['pos']
    rec['local_bounds'] = [p.min(0).tolist(), p.max(0).tolist()]
    return rec


def poi_categories(strings):
    out = []
    for key, label, pat in POI_RULES:
        if any(re.search(pat, s) for s in strings):
            out.append(key)
    if 'grimoire' in out or 'scripture' in out:
        out = [c for c in out if c != 'side_mission']
    return out


# ------------------------------------------------------------------ mission resolve
def resolve_mission(arg):
    tpl = OV.mission_templates()
    if arg in tpl:
        return arg, tpl[arg]['level'], tpl[arg]
    for k, v in tpl.items():
        if v['level'] == arg:
            return k, arg, v
    key = arg.rstrip('/').split('/')[-1]
    return key, arg, dict(level=arg)


def build(arg, tex_max=1024, textures=True, themes=True):
    os.makedirs(TEXDIR, exist_ok=True)
    key, level_path, tpl = resolve_mission(arg)
    out_dir = os.path.join(PACKS, key)
    os.makedirs(out_dir, exist_ok=True)
    K = kinds()
    N = names()
    lh = murmur64(level_path)
    if not have_raw(lh, 'level'):
        raise SystemExit('level not found in cache: %s (%s)' % (level_path, hx(lh)))
    log('levels', 'reading %s' % level_path)
    inst, levels = LV.flatten(lh, K, path_of=level_path)
    for l in levels:
        l['group'] = 'world'
    ov = OV.mission_overlays(level_path, [(i, l['path'], l['m']) for i, l in enumerate(levels) if i])
    if themes and ov.get('themes'):
        for tname, tlevels in ov['themes'].items():
            for tp in (tlevels if isinstance(tlevels, list) else [tlevels]):
                th = murmur64(tp)
                first = len(levels)
                LV.flatten(th, K, None, 0, inst, levels, tp)
                for l in levels[first:]:
                    l['group'] = 'theme:' + tname
    log('levels', '%d instances in %d levels' % (len(inst), len(levels)))

    # ---- units
    by_unit = {}
    for i, it in enumerate(inst):
        by_unit.setdefault(it['unit'], []).append(i)
    log('units', 'decoding %d units' % len(by_unit), total=len(by_unit))
    gpath = os.path.join(out_dir, 'geometry.bin')
    gf = open(gpath, 'wb')
    meshes = []          # geometry records (vertex data already written to geometry.bin)
    mesh_index = {}      # (unit, geom) -> mesh id
    mesh_inst = []       # per mesh: list of (instance index, 4x4)
    unit_info = {}
    materials = {}       # material hash -> record (filled later)
    bad_units = 0
    unit_cats = {}
    for n, (uh, idxs) in enumerate(by_unit.items()):
        if n % 200 == 0:
            log('units', '', done=n, total=len(by_unit))
        info = dict(name=N.get(uh, hx(uh)), count=len(idxs), meshes=0)
        unit_info[hx(uh)] = info
        if not have_raw(uh, 'unit'):
            info['error'] = 'missing'; bad_units += 1; continue
        try:
            U = UN.load_unit(uh)
        except Exception as e:
            info['error'] = repr(e)[:120]; bad_units += 1; continue
        info['meshes'] = len(U['meshes'])
        cats = poi_categories(U['strings'])
        if cats:
            info['cats'] = cats
            # exact pickup nodes: node names are IdString32 of the c_pickup_* strings in the unit
            pk = {id32(s): s for s in U['strings'] if re.match(r'^c_pickup_\w+$', s)}
            nodes = [(pk[nm], U['node_world'][ni][:3, 3].tolist()) for ni, nm in enumerate(U['node_names']) if nm in pk]
            if nodes:
                info['pickup_nodes'] = nodes
            unit_cats[uh] = (cats, nodes)
        for m in U['meshes']:
            k = (uh, m['geom'])
            if k not in mesh_index:
                d = m['data']
                batches = []
                for mi, start, cnt, _ in d['batches']:
                    slot = d['mats'][mi] if mi < len(d['mats']) else 0
                    mat = U['materials'].get(slot, 0)
                    materials.setdefault(mat, None)
                    batches.append((start * 3, cnt * 3, mat))
                mesh_index[k] = len(meshes)
                rec = write_geometry(gf, d)
                rec.update(id=len(meshes), unit=hx(uh), geom=m['geom'])
                # unit flow switches visibility groups visible_ineditor / visible_ingame at spawn
                ineditor = 'visible_ineditor' in U['strings']
                meshes.append(dict(unit=uh, geom=m['geom'], rec=rec, batches=batches, skinned=m['skinned'],
                                   ineditor=ineditor))
                mesh_inst.append([])
            mid = mesh_index[k]
            w = m['world'].astype(np.float64)
            for i in idxs:
                mesh_inst[mid].append((i, inst[i]['m'] @ w))
    gf.close()
    log('units', '%d meshes, %d materials, %d units without geometry' % (len(meshes), len(materials), bad_units))

    # ---- materials
    tex_jobs = {}
    mat_records = []
    mat_id = {}
    for mh in materials:
        rec = dict(id=len(mat_records), hash=hx(mh), name=N.get(mh, hx(mh)))
        res = MA.resolved(mh) if mh else None
        if res:
            names_present = []
            for role, chans in ROLE_CHANNELS.items():
                for c in chans:
                    t = res['textures'].get(CH.get(c, -1))
                    if t and have_raw(t, 'texture'):
                        rec[role] = hx(t); rec[role + '_channel'] = c
                        tex_jobs[(t, role)] = True
                        break
            V = {SHADER_NAMES.get('%08x' % k, '%08x' % k): v[1] for k, v in res['variables'].items()}
            for vn in ('base_color', 'color', 'albedo_color', 'tint_color'):
                if vn in V and len(V[vn]) >= 3:
                    rec['color'] = [round(float(x), 4) for x in V[vn][:3]]; break
            if 'emissive_color' in V and len(V['emissive_color']) >= 3:
                rec['emissive_color'] = [round(float(x), 4) for x in V['emissive_color'][:3]]
                for vn in ('emissive_intensity_lumen', 'emissive_intensity', 'intensity'):
                    if vn in V:
                        rec['emissive_intensity'] = round(float(V[vn][0]), 4); break
            if 'opacity' in V:
                rec['opacity'] = round(float(V['opacity'][0]), 4)
            if 'light_color' in V and len(V['light_color']) >= 3:
                rec['emissive_color'] = [round(float(x), 4) for x in V['light_color'][:3]]
            for vn in ('Roughness', 'roughness'):
                if vn in V:
                    rec['roughness'] = round(float(V[vn][0]), 4); break
            rec['channels'] = sorted(SHADER_NAMES.get('%08x' % c, '%08x' % c) for c in res['textures'])
        else:
            rec['missing'] = True
        rec['root'] = hx(res['chain'][-1]) if res and res['chain'] else '0'
        rec['family'] = classify(rec, res)
        mat_id[mh] = rec['id']
        mat_records.append(rec)

    # ---- textures
    tex_files = {}
    if textures:
        jobs = [(t, role, tex_max) for (t, role) in tex_jobs]
        log('textures', 'decoding %d textures (max %d px)' % (len(jobs), tex_max), total=len(jobs))
        with ProcessPoolExecutor(max_workers=max(1, min(8, (os.cpu_count() or 4) - 1))) as ex:
            for n, (t, role, fn, meta) in enumerate(ex.map(_tex_job, jobs, chunksize=4)):
                tex_files[(t, role)] = (fn, meta)
                if n % 100 == 0:
                    log('textures', '', done=n, total=len(jobs))
        for rec in mat_records:
            for role in ROLE_CHANNELS:
                if role in rec:
                    fn, meta = tex_files.get((int(rec[role], 16), role), (None, {}))
                    if fn:
                        rec[role] = fn
                        if role == 'albedo' and meta.get('alpha', 0) > 0.002 and rec.get('albedo_channel') in ('bca', 'texture_map'):
                            rec['alphaTest'] = 0.5
                    else:
                        rec.pop(role)
    else:
        for rec in mat_records:
            for role in ROLE_CHANNELS:
                rec.pop(role, None)

    # ---- write instances
    log('write', 'instances')
    ipath = os.path.join(out_dir, 'instances.bin')
    mrecs = []
    lo = np.full(3, np.inf); hi = np.full(3, -np.inf)
    with open(ipath, 'wb') as inf:
        for mid, M in enumerate(meshes):
            rec = M['rec']
            rec['batches'] = [dict(start=s, count=c, material=mat_id.get(mh, -1)) for s, c, mh in M['batches']]
            # instances (column-major float32 for three.js), mirrored (det < 0) ones last
            mats = np.array([m for _, m in mesh_inst[mid]], np.float64)
            ids = np.array([i for i, _ in mesh_inst[mid]], np.uint32)
            det = np.linalg.det(mats[:, :3, :3])
            order = np.argsort(det < 0, kind='stable')
            mats, ids, det = mats[order], ids[order], det[order]
            rec['mirrored'] = int((det < 0).sum())
            rec['inst_off'] = inf.tell()
            rec['inst_count'] = len(ids)
            inf.write(mats.transpose(0, 2, 1).astype('<f4').tobytes())
            rec['ids_off'] = inf.tell()
            inf.write(ids.tobytes())
            bl, bh = np.array(rec['local_bounds'][0]), np.array(rec['local_bounds'][1])
            corners = np.array([[x, y, z, 1] for x in (bl[0], bh[0]) for y in (bl[1], bh[1]) for z in (bl[2], bh[2])])
            wc = np.einsum('nij,cj->nci', mats, corners)[..., :3].reshape(-1, 3)
            lo = np.minimum(lo, wc.min(0)); hi = np.maximum(hi, wc.max(0))
            # sky / fog domes: untextured meshes hundreds of metres across, drawn by a sky shader in game
            fams = {mat_records[mat_id[mh]]['family'] for _, _, mh in M['batches'] if mh in mat_id}
            if float(np.max(bh - bl)) > 400 and fams <= {'effect', 'helper'}:
                rec['sky'] = True
            # untextured parts of units whose flow hides an editor-only visibility group
            if M.get('ineditor') and fams <= {'effect', 'helper'}:
                rec['editor'] = True
            mrecs.append(rec)

    # ---- instance table
    inst_table = dict(unit=[], level=[], pos=[])
    unit_list = list(unit_info.keys())
    uidx = {u: i for i, u in enumerate(unit_list)}
    for it in inst:
        inst_table['unit'].append(uidx[hx(it['unit'])])
        inst_table['level'].append(it['level'])
        inst_table['pos'].append([round(float(v), 3) for v in it['m'][:3, 3]])

    pois = []
    for i, it in enumerate(inst):
        uc = unit_cats.get(it['unit'])
        if not uc:
            continue
        cats, nodes = uc
        for c in cats:
            if c == 'pickup' and nodes:
                for nm, p in nodes:
                    wp = it['m'] @ np.array([p[0], p[1], p[2], 1.0])
                    pois.append(dict(cat=c, inst=i, pos=[round(float(v), 3) for v in wp[:3]], node=nm))
            else:
                pois.append(dict(cat=c, inst=i, pos=[round(float(v), 3) for v in it['m'][:3, 3]]))
    ov['pois'] = pois
    ov['poi_labels'] = {k: l for k, l, _ in POI_RULES}
    lvls = [dict(index=i, path=l['path'], group=l['group'], depth=l['depth'], units=l['units'],
                 matrix=l['m'].T.reshape(-1).tolist()) for i, l in enumerate(levels)]
    manifest = dict(
        format='darktide-map-pack', version=1, key=key, level=level_path, template=tpl,
        built=time.strftime('%Y-%m-%d %H:%M:%S'), tex_max=tex_max if textures else 0,
        bounds=[lo.tolist(), hi.tolist()], up='z',
        counts=dict(instances=len(inst), meshes=len(meshes), materials=len(mat_records), units=len(unit_list),
                    levels=len(levels)),
        levels=lvls, meshes=mrecs, materials=mat_records, units=[dict(hash=u, **unit_info[u]) for u in unit_list],
        instances=inst_table, files=dict(geometry='geometry.bin', instances='instances.bin', overlays='overlays.json',
                                         textures='../_tex/'))
    json.dump(ov, open(os.path.join(out_dir, 'overlays.json'), 'w'))
    json.dump(manifest, open(os.path.join(out_dir, 'manifest.json'), 'w'), allow_nan=False)
    update_index()
    log('done', 'pack written to %s' % out_dir, counts=manifest['counts'])
    return out_dir


def update_index():
    idx = []
    for d in sorted(os.listdir(PACKS)):
        mf = os.path.join(PACKS, d, 'manifest.json')
        if os.path.exists(mf):
            m = json.load(open(mf))
            idx.append(dict(key=m['key'], level=m['level'], template=m.get('template', {}), built=m['built'],
                            counts=m['counts'], tex_max=m.get('tex_max')))
    json.dump(idx, open(os.path.join(PACKS, 'index.json'), 'w'), indent=1)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('mission')
    ap.add_argument('--tex-max', type=int, default=1024)
    ap.add_argument('--no-textures', action='store_true')
    ap.add_argument('--no-themes', action='store_true')
    a = ap.parse_args()
    try:
        build(a.mission, a.tex_max, not a.no_textures, not a.no_themes)
    except SystemExit:
        raise
    except Exception:
        log('error', traceback.format_exc())
        sys.exit(1)
