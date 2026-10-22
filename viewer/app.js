// Darktide Map Viewer - renders packs built by pipeline/build_map.py.
// Everything inside `root` is in Darktide world space (Z up, metres); root is rotated to three's Y up.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ShapeUtils } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
const fmt = (n) => n.toLocaleString('en-US');

// ---------------------------------------------------------------- renderer
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
// performance settings, kept per browser
const PERF = { scale: 1, fps: 60, minPx: 2, dist: 0, aniso: 4 };
try { Object.assign(PERF, JSON.parse(localStorage.getItem('mv_perf') || '{}')); } catch (_) {}
const savePerf = () => { try { localStorage.setItem('mv_perf', JSON.stringify(PERF)); } catch (_) {} };
renderer.setPixelRatio(PERF.scale);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1e1f);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 6000);
camera.rotation.order = 'YXZ';
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
const hemi = new THREE.HemisphereLight(0xdfe6ff, 0x3a3226, 0.9);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.0);
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera; sc.left = sc.bottom = -120; sc.right = sc.top = 120; sc.near = 1; sc.far = 1500;
scene.add(hemi, sun, sun.target);
const root = new THREE.Group();
root.rotation.x = -Math.PI / 2; // Darktide Z-up -> three Y-up
scene.add(root);
const worldGroup = new THREE.Group(), overlayGroup = new THREE.Group();
root.add(worldGroup, overlayGroup);
const stingrayToThree = (x, y, z) => new THREE.Vector3(x, z, -y);
const threeToStingray = (v) => [v.x, -v.z, v.y];

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  updateOrtho(); invalidate();
}
addEventListener('resize', resize);

// ---------------------------------------------------------------- state
const S = {
  pack: null, manifest: null, overlays: null, meshes: [], materials: [], texCache: new Map(),
  levelOn: [], hideCharacters: true, hiddenUnits: new Set(), selected: null, mapMode: false,
  speed: 8, keys: new Set(), look: false, overlayObjs: {}, labels: [], sunAz: 40, sunEl: 55,
};

// ---------------------------------------------------------------- menu
const ZONE_NAMES = { dust: 'Dust', entertainment: 'Entertainment', transit: 'Transit', watertown: 'Watertown',
  throneside: 'Throneside', tank_foundry: 'Tank Foundry', operations: 'Operations', horde: 'Horde',
  hub: 'Hub', prologue: 'Prologue', training_grounds: 'Training Grounds', void: 'Void', expeditions: 'Expeditions' };
const prettyKey = (k) => k.replace(/^(dm|hm|lm|cm|fm|km|sm|om)_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {});
  return r.json();
}

async function showMenu() {
  $('#menu').hidden = false; $('#hud').hidden = true;
  const d = await api('/api/missions');
  const box = $('#missions'); box.innerHTML = '';
  const zones = {};
  S.titles = {};
  for (const m of d.missions) { (zones[m.zone_id || 'other'] ||= []).push(m); if (m.title) S.titles[m.key] = m.title; }
  const zoneTitle = {};
  for (const m of d.missions) if (m.zone_name) zoneTitle[m.zone_id] = m.zone_name;
  for (const e of d.extra) (zones.other ||= []).push({ key: e.key, level: e.level, pack: e });
  for (const [z, list] of Object.entries(zones)) {
    box.append(el('h2', {}, zoneTitle[z] || ZONE_NAMES[z] || z));
    const grid = el('div', { class: 'grid' });
    for (const m of list.sort((a, b) => a.key.localeCompare(b.key))) {
      const p = m.pack;
      const state = p ? `built ${p.built} · ${fmt(p.counts.instances)} objects · tex ${p.tex_max || 'off'}` : 'not built';
      grid.append(el('div', { class: 'card' },
        el('h3', {}, m.title || prettyKey(m.key)),
        el('div', { class: 'sub' }, `${m.key}${m.mission_type ? ' · ' + m.mission_type : ''}`),
        el('div', { class: 'sub' }, m.level),
        el('div', { class: 'row' },
          el('span', { class: 'state' + (p ? ' ok' : '') }, state),
          el('button', { onclick: () => startBuild(m.key) }, p ? 'Rebuild' : 'Build'),
          p ? el('button', { class: 'primary', onclick: () => openPack(m.key) }, 'Open') : null)));
    }
    box.append(grid);
  }
  pollJob();
}

async function startBuild(key) {
  const r = await api('/api/build', { key, tex_max: +$('#texmax').value });
  if (r.error) alert(r.error); else pollJob();
}
$('#btn-buildall').onclick = async () => {
  const d = await api('/api/missions');
  const todo = d.missions.filter((m) => !m.pack).map((m) => m.key);
  if (!todo.length) { alert('Every mission is already built. Use Rebuild on a card to refresh one.'); return; }
  if (!confirm(`Build ${todo.length} missions? About 10-60 s each.`)) return;
  const r = await api('/api/buildall', { keys: todo, tex_max: +$('#texmax').value }); if (r.error) alert(r.error); else pollJob();
};
$('#btn-extract').onclick = async () => {
  if (!confirm('Re-read the game bundles into the cache? Close Darktide first. Takes about a minute.')) return;
  const r = await api('/api/extract', {}); if (r.error) alert(r.error); else pollJob();
};

let polling = false;
async function pollJob() {
  if (polling) return; polling = true;
  try {
    for (;;) {
      const j = await api('/api/build/status');
      const box = $('#job');
      if (!j.key) { box.hidden = true; break; }
      box.hidden = false;
      const L = j.last || {};
      const pct = L.total ? (100 * (L.done || 0) / L.total) : (L.stage === 'done' ? 100 : 5);
      box.querySelector('i').style.width = pct + '%';
      $('#job-text').textContent = `${j.key}: ${j.running ? (L.stage || 'starting') + ' ' + (L.msg || '') : (j.ok ? 'finished' : 'FAILED - ' + (j.lines.slice(-3).join(' | ')))}`;
      if (!j.running) { if (j.ok && !$('#menu').hidden) { polling = false; showMenu(); return; } break; }
      await new Promise((r) => setTimeout(r, 700));
    }
  } finally { polling = false; }
}

// ---------------------------------------------------------------- loading a pack
async function fetchBuf(url, label) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  const total = +r.headers.get('Content-Length') || 0;
  const reader = r.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    setLoading(`${label} ${(got / 1048576).toFixed(0)} MB${total ? ' / ' + (total / 1048576).toFixed(0) + ' MB' : ''}`, total ? got / total : 0);
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf.buffer;
}
function setLoading(text, frac) {
  const L = $('#loading'); L.hidden = text == null;
  if (text != null) { L.querySelector('span').textContent = text; L.querySelector('i').style.width = (100 * (frac || 0)) + '%'; }
}

function clearScene() {
  if (S.strike) setStrike(false);
  for (const g of [worldGroup, overlayGroup]) {
    for (const c of [...g.children]) { g.remove(c); c.traverse?.((o) => { o.geometry?.dispose?.(); }); }
  }
  for (const m of S.materials) m?.dispose();
  for (const t of S.texCache.values()) t.dispose?.();
  S.texCache.clear(); S.meshes = []; S.materials = [];
  for (const l of S.labels) l.el.remove();
  S.labels = [];
  ruler.pts = []; redrawRuler();
  select(null);
}

async function openPack(key) {
  $('#menu').hidden = true; $('#hud').hidden = false;
  S.ready = false;
  clearScene();
  const base = `/packs/${key}/`;
  setLoading('manifest', 0);
  const manifest = await (await fetch(base + 'manifest.json')).json();
  const overlays = await (await fetch(base + 'overlays.json')).json();
  S.pack = key; S.manifest = manifest; S.overlays = overlays; S.base = base;
  if (!S.titles) { try { const d = await api('/api/missions'); S.titles = Object.fromEntries(d.missions.map((x) => [x.key, x.title])); } catch (_) { S.titles = {}; } }
  $('#map-title').textContent = manifest.template?.title || S.titles?.[key] || prettyKey(key);
  const geo = await fetchBuf(base + manifest.files.geometry, 'geometry');
  const ins = await fetchBuf(base + manifest.files.instances, 'instances');
  setLoading('building scene', 1);
  await new Promise((r) => setTimeout(r));
  // matte paintings are sky cards drawn by a special shader in game; placed literally they slice through the map
  S.levelOn = manifest.levels.map((l) => (l.group === 'world' || l.group === 'theme:default') && !/mattepainting/.test(l.path));
  buildMaterials(manifest);
  buildMeshes(manifest, geo, ins);
  buildOverlays(manifest, overlays);
  S.pinGroup = new THREE.Group(); S.pinGroup.name = 'Pins'; overlayGroup.add(S.pinGroup); S.pinLabels = [];
  loadPins();
  buildLayersUI(); buildGfxUI(); applyVisibility();
  setLoading(null);
  $('#stats').textContent = `${fmt(manifest.counts.instances)} objects · ${fmt(manifest.counts.meshes)} meshes · ${fmt(manifest.counts.materials)} materials · ${manifest.levels.length} levels`;
  if (!readHash()) homeCamera();
  updateSun();
  S.cullKey = null; // camera was placed after the first cull
  S.ready = true;
}

// ---------------------------------------------------------------- materials
const texLoader = new THREE.TextureLoader();
function tex(file, srgb) {
  const k = file + (srgb ? 's' : 'l');
  if (S.texCache.has(k)) return S.texCache.get(k);
  const t = texLoader.load(S.base + S.manifest.files.textures + file, invalidate);
  t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = Math.min(PERF.aniso, renderer.capabilities.getMaxAnisotropy());
  S.texCache.set(k, t);
  return t;
}
function buildMaterials(m) {
  S.materials = m.materials.map((r) => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    if (r.albedo) mat.map = tex(r.albedo, true);
    else if (r.color) mat.color.setRGB(...r.color, THREE.LinearSRGBColorSpace);
    else mat.color.setRGB(0.55, 0.55, 0.55);
    if (r.normal) { mat.normalMap = tex(r.normal, false); }
    if (r.orm) { const t = tex(r.orm, false); mat.aoMap = t; mat.roughnessMap = t; mat.metalnessMap = t; mat.metalness = 1; mat.aoMapIntensity = 1; }
    else mat.roughness = r.roughness ?? 0.8;
    if (r.emissive) { mat.emissiveMap = tex(r.emissive, true); mat.emissive.setRGB(1, 1, 1); mat.emissiveIntensity = 1; }
    else if (r.emissive_color && !r.albedo) { mat.emissive.setRGB(...r.emissive_color); mat.emissiveIntensity = Math.min(4, Math.max(0.5, r.emissive_intensity ?? 1)); }
    if (r.alphaTest) { mat.alphaTest = r.alphaTest; mat.side = THREE.DoubleSide; }
    if (r.family === 'effect') {
      // light cards / fog sheets: no textures, colour + opacity only -> additive, unlit
      const c = r.emissive_color || r.color || [1, 1, 1];
      const e = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...c), transparent: true,
        opacity: Math.min(1, r.opacity ?? 0.25), blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      e.userData.rec = r; mat.dispose(); return e;
    }
    mat.userData.rec = r;
    return mat;
  });
  applyFamilies();
  S.fallbackMat = new THREE.MeshStandardMaterial({ color: 0x8c8c8c, roughness: 0.9 });
  S.fallbackMat.userData.rec = { family: 'helper' };
}
const FAMILIES = { surface: 'Surfaces', effect: 'Light cards / fog sheets', decal: 'Decal projector boxes', helper: 'Editor helpers (gizmos)', sky: 'Sky / fog domes' };
S.familyOn = { surface: true, effect: true, decal: false, helper: false, sky: false };
function applyFamilies() {
  for (const m of [...S.materials, S.fallbackMat]) if (m) m.visible = !!S.familyOn[m.userData.rec?.family || 'surface'];
  if (S.strike) strikeApplyMaterials();
}

// ---------------------------------------------------------------- meshes
const MIRROR = new THREE.Matrix4().makeScale(1, 1, -1);
function attr(buf, a, n) {
  const comps = a.comps, count = n * comps;
  switch (a.type) {
    case 'f32': return new THREE.BufferAttribute(new Float32Array(buf, a.off, count), comps);
    case 'f16': return new THREE.Float16BufferAttribute(new Uint16Array(buf, a.off, count), comps);
    case 'i16': return new THREE.BufferAttribute(new Int16Array(buf, a.off, count), comps, true);
    case 'u8': return new THREE.BufferAttribute(new Uint8Array(buf, a.off, count), comps, true);
    case 'u16': return new THREE.BufferAttribute(new Uint16Array(buf, a.off, count), 1);
    case 'u32': return new THREE.BufferAttribute(new Uint32Array(buf, a.off, count), 1);
  }
}
function buildMeshes(m, geo, ins) {
  const unitNames = m.units.map((u) => u.name);
  const unitIdx = new Map(m.units.map((u, i) => [u.hash, i]));
  S.instUnit = m.instances.unit; S.instLevel = m.instances.level;
  for (const r of m.meshes) {
    const g = new THREE.BufferGeometry();
    const nv = r.vertices;
    g.setAttribute('position', attr(geo, r.attrs.position, nv));
    g.setAttribute('normal', attr(geo, r.attrs.normal, nv));
    if (r.attrs.tangent) g.setAttribute('tangent', attr(geo, r.attrs.tangent, nv));
    if (r.attrs.uv) g.setAttribute('uv', attr(geo, r.attrs.uv, nv));
    if (r.attrs.uv1) g.setAttribute('uv1', attr(geo, r.attrs.uv1, nv));
    g.setIndex(attr(geo, r.attrs.index, r.indices));
    const mats = [];
    r.batches.forEach((b, i) => { g.addGroup(b.start, b.count, i); mats.push(S.materials[b.material] || S.fallbackMat); });
    const [bl, bh] = r.local_bounds;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(...bl), new THREE.Vector3(...bh));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const all = new Float32Array(ins, r.inst_off, r.inst_count * 16);
    const ids = new Uint32Array(ins, r.ids_off, r.inst_count);
    const unit = unitIdx.get(r.unit);
    const entry = { rec: r, geom: g, mats, all, ids, unit, isChar: /^content\/characters\//.test(unitNames[unit]), objs: [] };
    // world-space bounding sphere per instance, for per-instance culling
    const sph = new Float32Array(r.inst_count * 4), lc = g.boundingSphere.center, lr = g.boundingSphere.radius;
    root.updateMatrixWorld();
    for (let k = 0; k < r.inst_count; k++) {
      _m.fromArray(all, k * 16);
      const sc = _m.getMaxScaleOnAxis();
      _v.copy(lc).applyMatrix4(_m).applyMatrix4(root.matrixWorld);
      sph[k * 4] = _v.x; sph[k * 4 + 1] = _v.y; sph[k * 4 + 2] = _v.z; sph[k * 4 + 3] = lr * sc;
    }
    entry.sph = sph;
    // normal and mirrored (det < 0) instance sets; mirrored ones live under a z-flipped object so three flips winding
    const nMir = r.mirrored || 0, nNorm = r.inst_count - nMir;
    for (const [mirror, start, cnt] of [[false, 0, nNorm], [true, nNorm, nMir]]) {
      if (!cnt) continue;
      const im = new THREE.InstancedMesh(g, mats, cnt);
      im.frustumCulled = false; // culled per instance in applyVisibility
      if (mirror) im.scale.set(1, 1, -1);
      im.userData = { entry, mirror, start, cnt, vis: new Uint32Array(cnt) };
      worldGroup.add(im);
      entry.objs.push(im);
    }
    S.meshes.push(entry);
  }
}
const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _sphere = new THREE.Sphere();
const cullCam = new THREE.PerspectiveCamera();
function applyVisibility() {
  // per-instance culling: outside a widened view frustum, smaller than PERF.minPx on screen, or beyond PERF.dist
  const map = S.mapMode, shadows = renderer.shadowMap.enabled;
  let cam = ortho;
  if (!map) {
    cullCam.copy(camera); cullCam.fov = Math.min(170, camera.fov + 30); cullCam.aspect = camera.aspect * 1.25;
    cullCam.updateProjectionMatrix(); cullCam.updateMatrixWorld(); cam = cullCam;
  } else { ortho.updateMatrixWorld(); }
  _frustum.setFromProjectionMatrix(_pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const H = Math.max(200, renderer.domElement.clientHeight || innerHeight || 0); // 0 while the tab is hidden
  const pxK = map ? ortho.zoom * H / (ortho.top - ortho.bottom) : (H / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const cp = camera.position, minPx = PERF.minPx, maxD = PERF.dist;
  let drawn = 0;
  for (const e of S.meshes) {
    const hideUnit = S.hiddenUnits.has(e.unit) || (S.hideCharacters && e.isChar) || (e.rec.sky && !S.familyOn.sky) || (e.rec.editor && !S.familyOn.helper);
    for (const im of e.objs) {
      const { start, cnt, mirror, vis } = im.userData;
      let n = 0;
      if (!hideUnit) {
        for (let i = 0; i < cnt; i++) {
          const k = start + i;
          if (!S.levelOn[S.instLevel[e.ids[k]]]) continue;
          const o = k * 4, rad = e.sph[o + 3];
          _sphere.center.set(e.sph[o], e.sph[o + 1], e.sph[o + 2]); _sphere.radius = rad;
          if (!shadows && !_frustum.intersectsSphere(_sphere)) continue;
          if (!map) {
            const d = Math.max(0.01, _sphere.center.distanceTo(cp) - rad);
            if (maxD && d > maxD && rad < maxD * 0.25) continue;
            if (minPx && rad * pxK / d < minPx) continue;
          } else if (minPx && rad * 2 * pxK < minPx) continue;
          _m.fromArray(e.all, k * 16);
          if (mirror) _m.premultiply(MIRROR);
          im.setMatrixAt(n, _m); vis[n] = k; n++;
        }
      }
      im.count = n; im.visible = n > 0; drawn += n;
      if (n) im.instanceMatrix.needsUpdate = true;
    }
  }
  S.drawnInstances = drawn;
  S.cullKey = camKey();
  invalidate();
}
const _m = new THREE.Matrix4(), _v = new THREE.Vector3();

// ---------------------------------------------------------------- overlays
const VOL_COLORS = { player_instakill: 0xff3b30, minion_instakill: 0xff8a3d, no_spawn: 0x4fc3f7, player_mover_blocker: 0x9e9e9e,
  gwnav: 0x7e57c2, generic: 0x66bb6a, safe_volume: 0x00e676, minion_no_destination: 0xffd54f, cinematic: 0xec407a };
function volColor(type) {
  for (const [k, c] of Object.entries(VOL_COLORS)) if (type && type.includes(k)) return c;
  return 0xbdbdbd;
}
const volLabel = (t) => (t || 'default').split('/').pop();
function buildOverlays(m, ov) {
  S.overlayObjs = {}; S.poiMats = {};
  const levelMats = m.levels.map((l) => new THREE.Matrix4().fromArray(l.matrix));
  // main path
  const mp = ov.main_path;
  if (mp) {
    const g = new THREE.Group(); g.name = 'Main path';
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffd740, depthTest: false, transparent: true, opacity: 0.9 });
    for (const seg of mp.main_path_segments || []) {
      const pts = (seg.nodes || []).map((p) => new THREE.Vector3(p[0], p[1], p[2] + 0.15));
      if (pts.length > 1) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat); l.renderOrder = 10; g.add(l); }
    }
    const dot = new THREE.SphereGeometry(0.35, 12, 8);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffab00, depthTest: false });
    for (const pm of mp.path_markers || []) {
      const s = new THREE.Mesh(dot, dotMat); s.position.set(...pm.position); s.renderOrder = 11; g.add(s);
      S.labels.push({ pos: new THREE.Vector3(...pm.position), text: `${pm.order}`, group: g, el: el('div', { class: 'label3d' }, `${pm.order}`) });
    }
    overlayGroup.add(g); S.overlayObjs['Main path'] = { obj: g, color: 0xffd740, on: true, count: (mp.path_markers || []).length };
  }
  // gameplay POIs (classified from each unit's flow data at build time)
  const POI_STYLE = { martyr_skull: ['#ff4081', 'M'], grimoire: ['#8bc34a', 'G'], scripture: ['#29b6f6', 'S'],
    side_mission: ['#c5e1a5', '?'], chest: ['#ffca28', 'C'], medicae: ['#ef5350', '+'], pickup: ['#ffffff', 'p'],
    luggable: ['#ab47bc', 'L'], objective: ['#ffd740', '!'], hazard: ['#ff7043', 'B'], enemy_gate: ['#e53935', 'E'],
    door: ['#a1887f', 'D'], player_spawn: ['#26a69a', 'P'] };
  const byCat = {};
  for (const p of ov.pois || []) (byCat[p.cat] ||= []).push(p);
  S.poiSprites = [];
  for (const [cat, list] of Object.entries(byCat)) {
    const [col, ch] = POI_STYLE[cat] || ['#bbbbbb', '*'];
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const c2 = cv.getContext('2d');
    c2.fillStyle = '#000a'; c2.beginPath(); c2.arc(32, 32, 27, 0, 7); c2.fill();
    c2.lineWidth = 6; c2.strokeStyle = col; c2.stroke();
    c2.fillStyle = col; c2.font = 'bold 30px Segoe UI, sans-serif'; c2.textAlign = 'center'; c2.textBaseline = 'middle'; c2.fillText(ch, 32, 34);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const smat = new THREE.SpriteMaterial({ map: t, depthTest: false, sizeAttenuation: false, transparent: true });
    const dimMat = smat.clone(); dimMat.opacity = 0.25; // "found" look in Strikemap mode
    (S.poiMats ||= {})[cat] = { on: smat, off: dimMat };
    const g = new THREE.Group(); g.name = cat;
    for (const p of list) {
      const sp = new THREE.Sprite(smat); sp.position.set(p.pos[0], p.pos[1], p.pos[2] + 0.4);
      sp.scale.set(0.028, 0.028, 1); sp.renderOrder = 20; sp.userData.poi = p; g.add(sp); S.poiSprites.push(sp);
    }
    const label = (ov.poi_labels || {})[cat] || cat;
    const on = !['door', 'hazard', 'pickup'].includes(cat);
    g.visible = on;
    overlayGroup.add(g); S.overlayObjs[label] = { obj: g, color: parseInt(col.slice(1), 16), on, count: list.length, poi: true };
  }
  // volumes, grouped by type
  const byType = {};
  for (const v of ov.volumes || []) (byType[volLabel(v.type)] ||= []).push(v);
  for (const [t, list] of Object.entries(byType)) {
    const g = new THREE.Group(); g.name = t;
    const color = volColor(list[0].type);
    const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });
    const edge = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 });
    for (const v of list) {
      const pts = v.points || []; if (pts.length < 3) continue;
      const h = v.height || 0.1;
      const pos = [], idx = [];
      const n = pts.length;
      for (const p of pts) pos.push(p[0], p[1], p[2]);
      for (const p of pts) pos.push(p[0], p[1], p[2] + h);
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(i, j, n + j, i, n + j, n + i); }
      const tris = ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p[0], p[1])), []);
      for (const [a, b, c] of tris) idx.push(a, c, b, n + a, n + b, n + c);
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, fill);
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), edge);
      const holder = new THREE.Group(); holder.add(mesh, lines);
      holder.applyMatrix4(levelMats[v.level] || new THREE.Matrix4());
      holder.userData.volume = v;
      g.add(holder);
    }
    const on = /player_instakill/.test(t);
    g.visible = on;
    overlayGroup.add(g); S.overlayObjs[t] = { obj: g, color, on, count: list.length };
  }
}

// ---------------------------------------------------------------- side panel
function buildLayersUI() {
  const box = $('#tab-layers'); box.innerHTML = '';
  const m = S.manifest;
  const chk = (label, on, onchange, extra, color) => {
    const i = el('input', { type: 'checkbox' }); i.checked = on; i.onchange = () => onchange(i.checked);
    return el('label', {}, i, color != null ? el('span', { class: 'sw', style: `background:#${color.toString(16).padStart(6, '0')}` }) : null, label, extra != null ? el('small', {}, extra) : null);
  };
  box.append(el('h4', {}, 'Gameplay objects'));
  for (const [name, o] of Object.entries(S.overlayObjs)) if (o.poi) {
    box.append(chk(name, o.on, (v) => { o.on = v; o.obj.visible = v; }, o.count, o.color));
  }
  box.append(el('h4', {}, 'Route and volumes'));
  for (const [name, o] of Object.entries(S.overlayObjs)) if (!o.poi) {
    box.append(chk(name.replace(/_/g, ' '), o.on, (v) => { o.on = v; o.obj.visible = v; }, o.count, o.color));
  }
  const groups = {};
  m.levels.forEach((l, i) => (groups[l.group] ||= []).push([l, i]));
  for (const [gname, list] of Object.entries(groups)) {
    box.append(el('h4', {}, gname === 'world' ? 'Level sections' : gname.replace('theme:', 'Theme: ')));
    if (gname.startsWith('theme:') || list.length > 1) {
      box.append(el('div', { class: 'rowbtn' },
        el('button', { onclick: () => { list.forEach(([, i]) => (S.levelOn[i] = true)); buildLayersUI(); applyVisibility(); } }, 'All'),
        el('button', { onclick: () => { list.forEach(([, i]) => (S.levelOn[i] = false)); buildLayersUI(); applyVisibility(); } }, 'None')));
    }
    for (const [l, i] of list) {
      const short = l.path.replace(/^content\/levels\//, '').replace(/\/world$/, '');
      box.append(chk(short, S.levelOn[i], (v) => { S.levelOn[i] = v; applyVisibility(); }, fmt(l.units)));
    }
  }
  box.append(el('h4', {}, 'Material families'));
  const famCount = {};
  for (const r of m.materials) famCount[r.family] = (famCount[r.family] || 0) + 1;
  for (const [f, label] of Object.entries(FAMILIES)) {
    const cnt = f === 'sky' ? S.meshes.filter((e) => e.rec.sky).length : famCount[f] || 0;
    box.append(chk(label, S.familyOn[f], (v) => { S.familyOn[f] = v; applyFamilies(); if (f === 'sky' || f === 'helper') applyVisibility(); }, cnt));
  }
  box.append(el('h4', {}, 'Objects'));
  box.append(chk('Hide character models (cinematic actors)', S.hideCharacters, (v) => { S.hideCharacters = v; applyVisibility(); }));
  if (S.hiddenUnits.size) box.append(el('button', { onclick: () => { S.hiddenUnits.clear(); buildLayersUI(); applyVisibility(); } }, `Show ${S.hiddenUnits.size} hidden unit type(s)`));
}

function buildGfxUI() {
  const box = $('#tab-gfx'); box.innerHTML = '';
  const slider = (label, min, max, step, val, fn) => {
    const i = el('input', { type: 'range', min, max, step, value: val });
    const out = el('small', {}, String(val));
    i.oninput = () => { out.textContent = i.value; fn(+i.value); };
    return el('label', {}, label, i, out);
  };
  const chk = (label, on, fn) => { const i = el('input', { type: 'checkbox' }); i.checked = on; i.onchange = () => fn(i.checked); return el('label', {}, i, label); };
  box.append(el('h4', {}, 'Performance (lower = less GPU)'),
    slider('Render scale', 0.4, 2, 0.05, PERF.scale, (v) => { PERF.scale = v; savePerf(); renderer.setPixelRatio(v); resize(); }),
    slider('FPS cap (0 = none)', 0, 144, 6, PERF.fps, (v) => { PERF.fps = v; savePerf(); }),
    slider('Skip objects smaller than (px)', 0, 12, 0.5, PERF.minPx, (v) => { PERF.minPx = v; savePerf(); applyVisibility(); }),
    slider('Small-object draw distance (m, 0 = off)', 0, 600, 10, PERF.dist, (v) => { PERF.dist = v; savePerf(); applyVisibility(); }),
    slider('Texture anisotropy', 1, 16, 1, PERF.aniso, (v) => { PERF.aniso = v; savePerf(); for (const t of S.texCache.values()) { t.anisotropy = v; t.needsUpdate = true; } }),
    el('h4', {}, 'Lighting'),
    slider('Exposure', 0.2, 3, 0.05, renderer.toneMappingExposure, (v) => (renderer.toneMappingExposure = v)),
    slider('Ambient', 0, 3, 0.05, hemi.intensity, (v) => (hemi.intensity = v)),
    slider('Reflections', 0, 2, 0.05, scene.environmentIntensity, (v) => (scene.environmentIntensity = v)),
    slider('Sun', 0, 6, 0.1, sun.intensity, (v) => (sun.intensity = v)),
    slider('Sun azimuth', 0, 360, 1, S.sunAz, (v) => { S.sunAz = v; updateSun(); }),
    slider('Sun elevation', 5, 90, 1, S.sunEl, (v) => { S.sunEl = v; updateSun(); }),
    chk('Sun shadows (slower)', renderer.shadowMap.enabled, (v) => setShadows(v)),
    el('h4', {}, 'View'),
    slider('Field of view', 40, 110, 1, camera.fov, (v) => { camera.fov = v; camera.updateProjectionMatrix(); }),
    chk('Distance haze', !!scene.fog, (v) => (scene.fog = v ? new THREE.FogExp2(0x1a1e1f, 0.0025) : null)),
    chk('Textures', true, (v) => setTextures(v)),
    chk('Wireframe', false, (v) => S.materials.forEach((m) => (m.wireframe = v))),
    chk('Flip normal-map green', false, (v) => S.materials.forEach((m) => m.normalScale.set(1, v ? -1 : 1))),
    chk('Path labels', true, (v) => { S.showLabels = v; }));
}
function setShadows(on) {
  renderer.shadowMap.enabled = on; sun.castShadow = on;
  for (const e of S.meshes) for (const im of e.objs) { im.castShadow = on; im.receiveShadow = on; }
  S.materials.forEach((m) => (m.needsUpdate = true));
}
function setTextures(on) {
  for (const m of S.materials) {
    const r = m.userData.rec;
    if (on) { if (r.albedo) m.map = tex(r.albedo, true); if (r.normal) m.normalMap = tex(r.normal, false); }
    else { m.map = null; m.normalMap = null; }
    m.needsUpdate = true;
  }
}
function updateSun() {
  const az = THREE.MathUtils.degToRad(S.sunAz), elv = THREE.MathUtils.degToRad(S.sunEl);
  const dir = stingrayToThree(Math.cos(elv) * Math.cos(az), Math.cos(elv) * Math.sin(az), Math.sin(elv));
  sun.position.copy(camera.position).addScaledVector(dir, 600);
  sun.target.position.copy(camera.position);
}

document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  for (const t of ['layers', 'search', 'gfx', 'pins', 'strike']) $('#tab-' + t).hidden = t !== b.dataset.tab;
  if (b.dataset.tab === 'pins') buildPinsUI();
  if (b.dataset.tab === 'strike') buildStrikeUI();
}));

// ---------------------------------------------------------------- search
$('#q').oninput = () => {
  const q = $('#q').value.trim().toLowerCase();
  const res = $('#results'); res.innerHTML = '';
  if (q.length < 2) return;
  const units = S.manifest.units;
  let n = 0;
  // gameplay categories first ("chest", "grimoire", "medicae", ...)
  const labels = S.overlays.poi_labels || {};
  const byCat = {};
  for (const p of S.overlays.pois || []) (byCat[p.cat] ||= []).push(p);
  for (const [cat, list] of Object.entries(byCat)) {
    const lab = labels[cat] || cat;
    if (!lab.toLowerCase().includes(q) && !cat.includes(q)) continue;
    n++;
    res.append(el('div', { onclick: () => cyclePoi(cat, list) }, '◆ ' + lab, el('br'), el('small', {}, `${list.length} in this map · click again for the next one`)));
  }
  units.forEach((u, i) => {
    if (n > 200) return;
    if (u.name.toLowerCase().includes(q) || u.hash.includes(q)) {
      n++;
      res.append(el('div', { onclick: () => cycleUnit(i) }, u.name, el('br'), el('small', {}, `${u.count} placed · ${u.meshes} mesh(es)${u.error ? ' · ' + u.error : ''}`)));
    }
  });
  if (!n) res.append(el('small', {}, 'no match'));
};
const cyc = new Map();
function cyclePoi(cat, list) {
  const k = ((cyc.get('poi:' + cat) ?? -1) + 1) % list.length; cyc.set('poi:' + cat, k);
  const p = list[k];
  flyTo(p.pos);
  selectInstance(p.inst, null, p);
  const o = Object.values(S.overlayObjs).find((x) => x.obj.name === cat);
  if (o && !o.on) { o.on = true; o.obj.visible = true; buildLayersUI(); }
}
function cycleUnit(ui) {
  const list = [];
  S.instUnit.forEach((u, i) => { if (u === ui) list.push(i); });
  if (!list.length) return;
  const k = ((cyc.get(ui) ?? -1) + 1) % list.length; cyc.set(ui, k);
  const ii = list[k];
  const p = S.manifest.instances.pos[ii];
  flyTo(p);
  selectInstance(ii);
}

// ---------------------------------------------------------------- picking / info
const ray = new THREE.Raycaster();
const selBox = new THREE.Box3Helper(new THREE.Box3(), 0xffd740); selBox.visible = false; scene.add(selBox);
function pick(ev) {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, S.mapMode ? ortho : camera);
  // POI icons first (screen-space sprites)
  ray.params.Points = { threshold: 0.5 };
  const sp = ray.intersectObjects((S.poiSprites || []).filter((x) => x.parent.visible), false)[0];
  if (sp) { selectInstance(sp.object.userData.poi.inst, null, sp.object.userData.poi); return; }
  const objs = worldGroup.children.filter((o) => o.visible);
  const hits = ray.intersectObjects(objs, false);
  const h = hits.find((x) => x.instanceId != null && (!S.mapMode || x.point.y < S.mapCeil));
  if (!h) { select(null); return; }
  const { entry, vis } = h.object.userData;
  selectInstance(entry.ids[vis[h.instanceId]], h.point);
}
function selectInstance(ii, point, poi) {
  const m = S.manifest;
  const ui = S.instUnit[ii], u = m.units[ui], lv = m.levels[S.instLevel[ii]];
  // bounds of all meshes of this instance
  const box = new THREE.Box3(); const tmp = new THREE.Box3(); const mm = new THREE.Matrix4();
  const mats = new Set();
  for (const e of S.meshes) {
    if (e.unit !== ui) continue;
    for (let k = 0; k < e.ids.length; k++) if (e.ids[k] === ii) {
      mm.fromArray(e.all, k * 16).premultiply(root.matrixWorld);
      tmp.copy(e.geom.boundingBox).applyMatrix4(mm); box.union(tmp);
      e.mats.forEach((x) => mats.add(x.userData.rec?.name || x.userData.rec?.hash || '-'));
    }
  }
  selBox.box.copy(box); selBox.visible = !box.isEmpty();
  S.selected = { ii, ui, box };
  const p = m.instances.pos[ii];
  const info = $('#info'); info.hidden = false; info.innerHTML = '';
  const row = (k, v) => el('tr', {}, el('td', {}, k), el('td', {}, v));
  info.append(el('b', {}, u.name), el('table', {},
    poi ? row('category', (S.overlays.poi_labels || {})[poi.cat] + (poi.node ? ' (node ' + poi.node + ')' : '')) : null,
    u.cats ? row('gameplay', u.cats.map((c) => (S.overlays.poi_labels || {})[c] || c).join(', ')) : null,
    row('unit hash', u.hash),
    row('position', p.map((x) => x.toFixed(2)).join(', ')),
    point ? row('hit point', threeToStingray(point).map((x) => x.toFixed(2)).join(', ')) : null,
    row('level', lv.path),
    row('placed', `${u.count}× in this map · ${u.meshes} render mesh(es)`),
    row('materials', [...mats].slice(0, 6).join(', '))),
    el('div', { class: 'rowbtn' },
      el('button', { onclick: () => focusSel() }, 'Focus (F)'),
      el('button', { onclick: () => { S.hiddenUnits.add(ui); applyVisibility(); buildLayersUI(); select(null); } }, 'Hide this unit type'),
      el('button', { onclick: () => { navigator.clipboard?.writeText(u.hash); } }, 'Copy hash'),
      el('button', { onclick: () => select(null) }, 'Close')));
}
function select(s) { if (!s) { S.selected = null; selBox.visible = false; $('#info').hidden = true; } }
function focusSel() {
  if (!S.selected) return;
  const c = S.selected.box.getCenter(new THREE.Vector3()), r = S.selected.box.getSize(new THREE.Vector3()).length();
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  camera.position.copy(c).addScaledVector(dir, -Math.max(2, r * 1.2));
}
function flyTo(p) {
  const t = stingrayToThree(...p);
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  camera.position.copy(t).addScaledVector(dir, -8).add(new THREE.Vector3(0, 2, 0));
  if (S.mapMode) setMap(false);
}

// ---------------------------------------------------------------- camera & controls
function homeCamera() {
  const mp = S.overlays.main_path;
  const first = mp?.path_markers?.slice().sort((a, b) => a.order - b.order)[0];
  if (first) {
    const p = first.position; camera.position.copy(stingrayToThree(p[0], p[1], p[2] + 1.8));
    const second = mp.path_markers.slice().sort((a, b) => a.order - b.order)[1];
    if (second) { const t = stingrayToThree(...second.position); const d = t.sub(camera.position); camera.rotation.set(0, Math.atan2(-d.x, -d.z), 0); }
  } else {
    const [lo, hi] = S.manifest.bounds;
    const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2] + 20];
    camera.position.copy(stingrayToThree(...c)); camera.rotation.set(-0.6, 0, 0);
  }
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2 && !e.altKey) { S.look = true; try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch (_) {} }
  if (e.button === 0 && S.mapMode && !(S.strike && S.drawOn)) { S.drag = { x: e.clientX, y: e.clientY, moved: false }; }
});
addEventListener('mouseup', (e) => {
  if (e.button === 2) { S.look = false; document.exitPointerLock?.(); }
  if (e.button === 0 && S.mapMode && S.drag) {
    if (!S.drag.moved && !e.altKey) { clearTimeout(S.clickT); const ev = { clientX: e.clientX, clientY: e.clientY }; S.clickT = setTimeout(() => mapClick(ev), 280); }
    S.drag = null;
  }
});
addEventListener('mousemove', (e) => {
  if (S.look && !S.mapMode) {
    camera.rotation.y -= e.movementX * 0.0025;
    camera.rotation.x = Math.max(-1.55, Math.min(1.55, camera.rotation.x - e.movementY * 0.0025));
  }
  if (S.mapMode && S.drag) {
    const dx = e.clientX - S.drag.x, dy = e.clientY - S.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) S.drag.moved = true;
    const k = (ortho.right - ortho.left) / innerWidth / ortho.zoom;
    if (S.iso) {
      const az = THREE.MathUtils.degToRad(S.isoAz), s = 1 / Math.sin(THREE.MathUtils.degToRad(35.264));
      S.mapCenter.x += -Math.cos(az) * dx * k - Math.sin(az) * dy * k * s;
      S.mapCenter.z += Math.sin(az) * dx * k - Math.cos(az) * dy * k * s;
    } else { S.mapCenter.x -= dx * k; S.mapCenter.z -= dy * k; }
    S.drag.x = e.clientX; S.drag.y = e.clientY; updateOrtho();
  }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (S.mapMode) { ortho.zoom = Math.max(0.05, Math.min(50, ortho.zoom * (e.deltaY > 0 ? 0.88 : 1.14))); ortho.updateProjectionMatrix(); }
  else S.speed = Math.max(0.5, Math.min(200, S.speed * (e.deltaY > 0 ? 0.85 : 1.18)));
}, { passive: false });
canvas.addEventListener('dblclick', (e) => { clearTimeout(S.clickT); pick(e); });

// ---------------------------------------------------------------- ruler: Alt+click adds points, Alt+right-click clears
const ruler = { pts: [], line: null, dots: new THREE.Group(), labels: [] };
scene.add(ruler.dots);
function surfaceAt(e) {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, S.mapMode ? ortho : camera);
  const hits = ray.intersectObjects(worldGroup.children.filter((o) => o.visible), false)
    .filter((h) => !S.mapMode || h.point.y < S.mapCeil);
  return hits[0]?.point;
}
function redrawRuler() {
  if (ruler.line) { scene.remove(ruler.line); ruler.line.geometry.dispose(); }
  ruler.dots.clear(); ruler.labels.forEach((l) => l.el.remove()); ruler.labels = [];
  if (!ruler.pts.length) { $('#ruler').hidden = true; return; }
  ruler.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ruler.pts),
    new THREE.LineBasicMaterial({ color: 0x00e5ff, depthTest: false }));
  ruler.line.renderOrder = 30; scene.add(ruler.line);
  let total = 0;
  ruler.pts.forEach((p, i) => {
    const d = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: 0x00e5ff, depthTest: false }));
    d.position.copy(p); d.renderOrder = 31; ruler.dots.add(d);
    if (i) {
      const seg = p.distanceTo(ruler.pts[i - 1]); total += seg;
      const mid = p.clone().add(ruler.pts[i - 1]).multiplyScalar(0.5);
      const L = { pos: mid, world: true, text: seg.toFixed(1) + ' m', group: ruler.dots, el: el('div', { class: 'label3d' }, seg.toFixed(1) + ' m') };
      ruler.labels.push(L);
    }
  });
  const a = ruler.pts[0], b = ruler.pts[ruler.pts.length - 1];
  $('#ruler').hidden = false;
  $('#ruler').textContent = `Ruler: ${total.toFixed(1)} m along ${ruler.pts.length - 1} segment(s) · straight ${a.distanceTo(b).toFixed(1)} m · height change ${(b.y - a.y).toFixed(1)} m  (Alt+right-click clears)`;
}
canvas.addEventListener('click', (e) => {
  if (!e.altKey) return;
  const p = surfaceAt(e); if (!p) return;
  ruler.pts.push(p.clone()); redrawRuler();
});
canvas.addEventListener('mousedown', (e) => { if (e.altKey && e.button === 2) { ruler.pts = []; redrawRuler(); } });
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  S.keys.add(e.code);
  if ($('#hud').hidden) return;
  if (e.code === 'KeyM') { if (S.mapMode && S.iso) setIso(false); else setMap(!S.mapMode); }
  if (e.code === 'KeyI') { if (S.mapMode && S.iso) setMap(false); else setIso(true); }
  if (e.code === 'KeyR' && S.mapMode && S.iso) { S.isoAz = (S.isoAz + 90) % 360; updateOrtho(); invalidate(); }
  if (S.mapMode && (e.code === 'KeyE' || e.code === 'PageUp')) setCeil(S.mapCeil + 1);
  if (S.mapMode && (e.code === 'KeyQ' || e.code === 'PageDown')) setCeil(S.mapCeil - 1);
  if (e.code === 'KeyT') setStrike(!S.strike);
  if (e.code === 'KeyP') screenshot();
  if (e.code === 'KeyF') focusSel();
  if (e.code === 'KeyH') $('#help').hidden = !$('#help').hidden;
  if (S.strike && e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) strikeUndo();
  if (e.code === 'Escape' && (S.abilTool || S.drawOn)) { S.abilTool = null; S.drawOn = false; canvas.style.cursor = ''; buildStrikeUI(); return; }
  if (e.code === 'Escape') { if (S.selected) select(null); else if (!$('#help').hidden) $('#help').hidden = true; else if (S.mapMode) setMap(false); }
});
addEventListener('keyup', (e) => S.keys.delete(e.code));
addEventListener('blur', () => S.keys.clear());

const ceilPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
function setCeil(y) {
  S.mapCeil = y; ceilPlane.constant = y;
  if (S.strikeMat) S.strikeMat.uniforms.uCeil.value = y;
  const r = $('#ceil'); if (r) { r.value = threeToStingray(new THREE.Vector3(0, y, 0))[2].toFixed(0); r.nextSibling.textContent = r.value + ' m'; }
}
function setMap(on) {
  S.mapMode = on;
  if (!on && S.strike) setStrike(false);
  if (!on) { S.iso = false; $('#btn-iso').classList.remove('primary'); }
  $('#btn-map').textContent = on ? 'Fly view' : 'Map view';
  renderer.clippingPlanes = on ? [ceilPlane] : [];
  $('#mapbar').hidden = !on;
  if (on) {
    setCeil(camera.position.y + 3);
    S.mapCenter = camera.position.clone();
    // frame the playable route when there is one (backdrops make the full bounds far too large)
    const pts = (S.overlays.main_path?.main_path_segments || []).flatMap((sg) => sg.nodes || []);
    let span;
    if (pts.length) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.2 + 40;
      S.mapCenter = stingrayToThree((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, 0);
    } else {
      const [lo, hi] = S.manifest.bounds; span = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
    }
    ortho.zoom = Math.min(8, Math.max(0.02, 400 / span));
    updateOrtho();
  }
}
function updateOrtho() {
  const a = innerWidth / innerHeight, h = 200;
  ortho.left = -h * a; ortho.right = h * a; ortho.top = h; ortho.bottom = -h;
  if (S.mapCenter && S.iso) {
    // isometric: 35.264 degrees elevation, azimuth S.isoAz (R turns it 90 degrees); looks at the map centre
    const az = THREE.MathUtils.degToRad(S.isoAz), ev = THREE.MathUtils.degToRad(35.264);
    const c = new THREE.Vector3(S.mapCenter.x, (S.mapCeil ?? S.mapCenter.y) - 20, S.mapCenter.z); // target follows the height slice
    ortho.up.set(0, 1, 0);
    ortho.position.copy(c).add(new THREE.Vector3(Math.cos(ev) * Math.sin(az), Math.sin(ev), Math.cos(ev) * Math.cos(az)).multiplyScalar(4000));
    ortho.lookAt(c);
  } else if (S.mapCenter) { ortho.position.set(S.mapCenter.x, (S.manifest?.bounds?.[1]?.[2] ?? 100) + 100, S.mapCenter.z); ortho.lookAt(S.mapCenter.x, -1e4, S.mapCenter.z); ortho.rotation.z = 0; }
  ortho.near = 0; ortho.far = 20000; ortho.updateProjectionMatrix();
}
function mapClick(e) {
  if (S.pinTool) { const pt = surfaceAt(e); if (pt) placePin(pt); return; } // Pins tab: place instead of jumping
  if (S.strike) { strikeClick(e); return; } // Strikemap: click a marker to tick it off, never jump into the map
  // jump the fly camera to the clicked spot, standing on the first surface hit from above
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, ortho);
  const hits = ray.intersectObjects(worldGroup.children.filter((o) => o.visible), false).filter((h) => h.point.y < S.mapCeil);
  const p = hits[0]?.point || ray.ray.origin.clone().setY(camera.position.y);
  camera.position.set(p.x, p.y + 1.8, p.z);
  setMap(false);
}
function screenshot() {
  render();
  const a = el('a', { download: `${S.pack}_${Date.now()}.png`, href: canvas.toDataURL('image/png') }); a.click();
}
$('#btn-map').onclick = () => { if (S.mapMode && S.iso) setIso(false); else setMap(!S.mapMode); };
$('#btn-iso').onclick = () => { if (S.mapMode && S.iso) setMap(false); else setIso(true); };
$('#ceil').oninput = (e) => { const z = +e.target.value; setCeil(z); e.target.nextSibling.textContent = z + ' m'; };
$('#btn-shot').onclick = screenshot;
$('#btn-help').onclick = () => ($('#help').hidden = !$('#help').hidden);
$('#btn-back').onclick = () => { history.replaceState(null, '', location.pathname); showMenu(); };

// URL state: #pack=key&cam=x,y,z,yaw,pitch (Darktide coordinates)
function writeHash() {
  if (!S.ready || !S.pack || $('#hud').hidden) return;
  const p = threeToStingray(camera.position).map((v) => v.toFixed(2));
  const h = `#pack=${S.pack}&cam=${p.join(',')},${camera.rotation.y.toFixed(3)},${camera.rotation.x.toFixed(3)}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const c = q.get('cam'); if (!c || q.get('pack') !== S.pack) return false;
  const v = c.split(',').map(Number); if (v.length < 5 || v.some(isNaN)) return false;
  camera.position.copy(stingrayToThree(v[0], v[1], v[2])); camera.rotation.set(v[4], v[3], 0);
  return true;
}
setInterval(writeHash, 1000);

// ---------------------------------------------------------------- pins
// Main path pins (numbered, in order) and triggers (a circle with a radius) placed on the map; saved by serve.py to
// packs/<pack>/pins.json. Coordinates: Darktide world.
S.pins = []; S.pinTool = null; S.iso = false; S.isoAz = 45; S.pinLabels = [];
const PIN_TRIGGER_DEFAULTS = { radius: 12, count: 6, breeds: 'renegade_melee,renegade_assault', waves: 1, wave_delay: 20 };
const PICKUPS = ['large_ammunition_crate', 'small_clip', 'large_clip', 'small_grenade', 'ammo_cache_pocketable', 'ammo_cache_deployable',
  'medical_crate_pocketable', 'medical_crate_deployable', 'syringe_power_boost_pocketable', 'syringe_speed_boost_pocketable',
  'syringe_ability_boost_pocketable', 'syringe_corruption_pocketable', 'grimoire', 'tome', 'small_metal', 'large_metal', 'small_platinum',
  'large_platinum', 'skulls_01_pickup', 'stolen_rations_01_pickup_small', 'container_01_luggable', 'battery_01_luggable', 'prismata_case_01_luggable',
  'breach_charge_pocketable', 'motion_detection_mine_explosive_pocketable', 'motion_detection_mine_shock_pocketable', 'motion_detection_mine_fire_pocketable'];
const POLY_TOOLS = { gas: ['#76ff03', 0x76ff03, 'Pox gas'], kill: ['#ff1744', 0xff1744, 'Instakill box'] };
S.gasDraft = [];
const pinTex = new Map();
function pinSprite(color, text) {
  const k = color + text;
  if (!pinTex.has(k)) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const c2 = cv.getContext('2d');
    c2.fillStyle = '#000b'; c2.beginPath(); c2.arc(32, 32, 28, 0, 7); c2.fill();
    c2.lineWidth = 6; c2.strokeStyle = color; c2.stroke();
    c2.fillStyle = color; c2.font = 'bold 28px Segoe UI, sans-serif'; c2.textAlign = 'center'; c2.textBaseline = 'middle'; c2.fillText(text, 32, 34);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    pinTex.set(k, new THREE.SpriteMaterial({ map: t, depthTest: false, sizeAttenuation: false, transparent: true }));
  }
  return pinTex.get(k);
}
function redrawPins() {
  const g = S.pinGroup; if (!g) return;
  for (const c of [...g.children]) { g.remove(c); c.geometry?.dispose?.(); }
  for (const l of S.pinLabels) { l.el.remove(); const i = S.labels.indexOf(l); if (i >= 0) S.labels.splice(i, 1); }
  S.pinLabels = [];
  const label = (pos, text) => {
    const L = { pos: new THREE.Vector3(pos[0], pos[1], pos[2] + 1.5), text, group: g, el: el('div', { class: 'label3d' }, text) };
    S.labels.push(L); S.pinLabels.push(L);
  };
  const path = S.pins.filter((p) => p.type === 'path');
  if (path.length > 1) {
    const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.map((p) => new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2] + 0.4))),
      new THREE.LineBasicMaterial({ color: 0xffd740, depthTest: false, transparent: true }));
    ln.renderOrder = 40; g.add(ln);
  }
  path.forEach((p, i) => {
    const sp = new THREE.Sprite(pinSprite('#ffd740', String(i + 1)));
    sp.position.set(p.pos[0], p.pos[1], p.pos[2] + 0.6); sp.scale.set(0.034, 0.034, 1); sp.renderOrder = 41; g.add(sp);
  });
  S.pins.filter((p) => p.type === 'trigger').forEach((p) => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.2, p.radius - 0.6), p.radius, 48),
      new THREE.MeshBasicMaterial({ color: 0xff5252, depthTest: false, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(p.radius, 48),
      new THREE.MeshBasicMaterial({ color: 0xff5252, depthTest: false, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
    for (const m of [ring, disc]) { m.position.set(p.pos[0], p.pos[1], p.pos[2] + 0.3); m.renderOrder = 38; g.add(m); }
    const sp = new THREE.Sprite(pinSprite('#ff5252', 'T'));
    sp.position.set(p.pos[0], p.pos[1], p.pos[2] + 0.6); sp.scale.set(0.034, 0.034, 1); sp.renderOrder = 41; g.add(sp);
    label(p.pos, `${p.name || 'trigger'} · r ${p.radius} · ${p.count}x`);
  });
  const drawPoly = (pts, closed, opacity, col = 0x76ff03, css = '#76ff03') => {
    const zAvg = pts.reduce((a, q) => a + q[2], 0) / pts.length + 0.3;
    const lp = pts.map((q) => new THREE.Vector3(q[0], q[1], zAvg));
    if (closed) lp.push(lp[0].clone());
    const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(lp), new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true }));
    ln.renderOrder = 39; g.add(ln);
    if (closed && pts.length >= 3) {
      const fill = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(pts.map((q) => new THREE.Vector2(q[0], q[1])))),
        new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity, side: THREE.DoubleSide }));
      fill.position.z = zAvg; fill.renderOrder = 37; g.add(fill);
    }
    pts.forEach((q, i) => {
      const sp = new THREE.Sprite(pinSprite(css, String(i + 1)));
      sp.position.set(q[0], q[1], q[2] + 0.6); sp.scale.set(0.026, 0.026, 1); sp.renderOrder = 41; g.add(sp);
    });
  };
  S.pins.filter((p) => p.type === 'gas' && p.pts).forEach((p) => {
    drawPoly(p.pts, true, 0.16);
    const c = p.pts.reduce((a, q) => [a[0] + q[0] / p.pts.length, a[1] + q[1] / p.pts.length, a[2] + q[2] / p.pts.length], [0, 0, 0]);
    label(c, `${p.name || 'gas'} · ${p.pts.length} pts`);
  });
  S.pins.filter((p) => p.type === 'kill' && p.pts).forEach((p) => {
    drawPoly(p.pts, true, 0.22, 0xff1744, '#ff1744');
    const c = p.pts.reduce((a, q) => [a[0] + q[0] / p.pts.length, a[1] + q[1] / p.pts.length, a[2] + q[2] / p.pts.length], [0, 0, 0]);
    label(c, `${p.name || 'kill'} - instakill`);
  });
  S.pins.filter((p) => p.type === 'pickup' || p.type === 'prop').forEach((p) => {
    const pk = p.type === 'pickup';
    const sp = new THREE.Sprite(pinSprite(pk ? '#29b6f6' : '#ba68c8', pk ? 'P' : 'O'));
    sp.position.set(p.pos[0], p.pos[1], p.pos[2] + 0.6); sp.scale.set(0.034, 0.034, 1); sp.renderOrder = 41; g.add(sp);
    label(p.pos, pk ? p.pickup : `${(p.unit || 'prop').split('/').pop()}${p.opens_on ? ' - opens on ' + p.opens_on : ''}`);
  });
  if (S.gasDraft && S.gasDraft.length) { const pt = POLY_TOOLS[S.pinTool] || POLY_TOOLS.gas; drawPoly(S.gasDraft, S.gasDraft.length >= 3, 0.08, pt[1], pt[0]); }
  invalidate();
}
let pinSaveT = 0;
async function savePins() {
  let msg;
  try { localStorage.setItem('mv_pins_' + S.pack, JSON.stringify(S.pins)); } catch (_) {} // browser backup, restored on load
  try {
    const r = await api('/api/pins', { pack: S.pack, pins: S.pins });
    msg = r.error ? 'save failed: ' + r.error : `saved ${r.saved} pin(s)${r.mod_file ? ' · ' + r.mod_file + ' written to the mod' : ''}`;
  } catch (e) { msg = 'save failed: ' + e.message; }
  S.pinStatus = msg; const s = $('#pin-status'); if (s) s.textContent = msg;
}
function pinsChanged(rebuildUI = true) {
  redrawPins(); if (rebuildUI) buildPinsUI();
  clearTimeout(pinSaveT); pinSaveT = setTimeout(savePins, 500);
}
async function loadPins() {
  S.pins = [];
  try { const r = await fetch(S.base + 'pins.json'); if (r.ok) S.pins = await r.json(); } catch (_) {}
  if (!S.pins.length) { // the server has none (e.g. an earlier save failed): restore the browser backup and save it
    try {
      const b = JSON.parse(localStorage.getItem('mv_pins_' + S.pack) || '[]');
      if (b.length) { S.pins = b; pinsChanged(false); }
    } catch (_) {}
  }
  S.pins = S.pins.map((p) => { // 0.6.2 circle gas pins become 16-sided polygons
    if (p.type === 'gas' && !p.pts && p.pos) {
      const pts = []; for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; pts.push([p.pos[0] + Math.cos(a) * p.radius, p.pos[1] + Math.sin(a) * p.radius, p.pos[2]]); }
      return { type: 'gas', name: p.name, pts };
    }
    return p;
  });
  redrawPins(); buildPinsUI();
}
function setPinTool(t) { S.pinTool = t; buildPinsUI(); canvas.style.cursor = t ? 'crosshair' : ''; }
function placePin(pt) {
  const p = threeToStingray(pt).map((v) => Math.round(v * 100) / 100);
  const n = S.pins.filter((x) => x.type === S.pinTool).length + 1;
  if (POLY_TOOLS[S.pinTool]) { S.gasDraft.push(p); redrawPins(); buildPinsUI(); return; }
  S.pins.push(S.pinTool === 'path' ? { type: 'path', pos: p }
    : S.pinTool === 'pickup' ? { type: 'pickup', pos: p, pickup: 'large_ammunition_crate', yaw: 0, name: 'pickup ' + n }
    : S.pinTool === 'boss' ? { type: 'trigger', pos: p, name: 'boss ' + n, radius: 30, count: 1, breeds: 'chaos_beast_of_nurgle', waves: 1, wave_delay: 20 }
    : S.pinTool === 'prop' ? { type: 'prop', pos: p, unit: '', yaw: 0, scale: 1, opens_on: '', name: 'prop ' + n }
    : { type: 'trigger', pos: p, name: 'trigger ' + n, ...PIN_TRIGGER_DEFAULTS });
  pinsChanged();
}
function finishGas() {
  if (S.gasDraft.length < 3 || !POLY_TOOLS[S.pinTool]) return;
  const kind = S.pinTool;
  const n = S.pins.filter((x) => x.type === kind).length + 1;
  S.pins.push({ type: kind, name: kind + ' ' + n, pts: S.gasDraft }); S.gasDraft = [];
  pinsChanged();
}
function cancelGas() { S.gasDraft = []; redrawPins(); buildPinsUI(); }
window.addEventListener('keydown', (e) => {
  if (!POLY_TOOLS[S.pinTool] || /INPUT|TEXTAREA/.test((e.target && e.target.tagName) || '')) return;
  if (e.key === 'Enter') finishGas(); else if (e.key === 'Escape') cancelGas();
});
function buildPinsUI() {
  const box = $('#tab-pins'); if (!box) return; box.innerHTML = '';
  const btn = (label, fn, on) => el('button', { class: on ? 'primary' : '', onclick: fn }, label);
  box.append(el('h4', {}, 'Place pins'),
    el('div', { class: 'rowbtn' }, btn('Main path pin', () => setPinTool('path'), S.pinTool === 'path'),
      btn('Enemy spawner', () => setPinTool('trigger'), S.pinTool === 'trigger'),
      btn('Boss spawner', () => setPinTool('boss'), S.pinTool === 'boss'),
      btn('Pox gas', () => setPinTool('gas'), S.pinTool === 'gas'), btn('Instakill box', () => setPinTool('kill'), S.pinTool === 'kill'),
      btn('Pickup / chest', () => setPinTool('pickup'), S.pinTool === 'pickup'), btn('Prop / gate', () => setPinTool('prop'), S.pinTool === 'prop'),
      btn('Off', () => setPinTool(null), !S.pinTool)),
    el('small', {}, POLY_TOOLS[S.pinTool] ? POLY_TOOLS[S.pinTool][2] + ': click each corner of the area in order, then Finish polygon (Enter). Esc cancels.'
      : S.pinTool ? 'Map (M) or Isometric (I): click the map. Fly view: Shift+click a surface.' : 'Pick a tool, then click in Map (M) or Isometric (I) view.'),
    POLY_TOOLS[S.pinTool] ? el('div', { class: 'rowbtn' }, btn(`Finish polygon (${S.gasDraft.length})`, finishGas, S.gasDraft.length >= 3), btn('Cancel polygon', cancelGas)) : el('span', {}),
    el('div', { class: 'rowbtn' },
      btn('Save now', () => { clearTimeout(pinSaveT); savePins(); }),
      btn('Undo last', () => { if (S.gasDraft.length) { S.gasDraft.pop(); redrawPins(); buildPinsUI(); } else { S.pins.pop(); pinsChanged(); } }),
      btn('Clear all', () => { if (S.pins.length && confirm('Remove every pin?')) { S.pins = []; pinsChanged(); } })),
    el('small', { id: 'pin-status' }, S.pinStatus || ''));
  const path = S.pins.map((p, i) => [p, i]).filter(([p]) => p.type === 'path');
  box.append(el('h4', {}, `Main path (${path.length})`));
  path.forEach(([p, i], n) => {
    const swap = (d) => { const m = path[n + d]; if (!m) return; [S.pins[i], S.pins[m[1]]] = [S.pins[m[1]], S.pins[i]]; pinsChanged(); };
    box.append(el('div', { class: 'rowbtn' }, el('span', {}, `${n + 1}  ${p.pos.map((v) => v.toFixed(1)).join(', ')}`),
      btn('↑', () => swap(-1)), btn('↓', () => swap(1)),
      btn('Go', () => { setPinTool(S.pinTool); S.mapCenter && (S.mapCenter.x = p.pos[0], S.mapCenter.z = -p.pos[1], updateOrtho(), invalidate()); }),
      btn('✕', () => { S.pins.splice(i, 1); pinsChanged(); })));
  });
  const trig = S.pins.map((p, i) => [p, i]).filter(([p]) => p.type === 'trigger');
  box.append(el('h4', {}, `Triggers (${trig.length})`));
  for (const [p, i] of trig) {
    const name = el('input', { type: 'text', value: p.name || '' }); name.onchange = () => { p.name = name.value; pinsChanged(false); };
    const rad = el('input', { type: 'range', min: 3, max: 80, step: 1, value: p.radius });
    const radOut = el('small', {}, `r ${p.radius} m`);
    rad.oninput = () => { p.radius = +rad.value; radOut.textContent = `r ${p.radius} m`; pinsChanged(false); };
    const cnt = el('input', { type: 'number', min: 1, max: 40, value: p.count }); cnt.onchange = () => { p.count = Math.max(1, +cnt.value || 1); pinsChanged(false); };
    const br = el('input', { type: 'text', value: p.breeds || '' }); br.onchange = () => { p.breeds = br.value; pinsChanged(false); };
    const sp = el('input', { type: 'number', min: 0, max: 200, value: p.spawn_radius || 0 }); sp.onchange = () => { p.spawn_radius = Math.max(0, +sp.value || 0) || undefined; pinsChanged(false); };
    const wv = el('input', { type: 'number', min: 1, max: 20, value: p.waves || 1 }); wv.onchange = () => { p.waves = Math.max(1, +wv.value || 1); pinsChanged(false); };
    const wd = el('input', { type: 'number', min: 0, max: 600, value: p.wave_delay == null ? 20 : p.wave_delay }); wd.onchange = () => { p.wave_delay = Math.max(0, +wd.value || 0); pinsChanged(false); };
    box.append(el('div', { class: 'pincard' }, name, el('label', {}, 'Radius', rad, radOut), el('label', {}, 'Enemies', cnt),
      el('label', {}, 'Breeds', br), el('label', {}, 'Spawn spread (m, 0 = half the radius)', sp), el('label', {}, 'Waves', wv), el('label', {}, 'Seconds between waves', wd), el('small', {}, p.pos.map((v) => v.toFixed(1)).join(', ')),
      el('div', { class: 'rowbtn' }, btn('Go', () => { S.mapCenter && (S.mapCenter.x = p.pos[0], S.mapCenter.z = -p.pos[1], updateOrtho(), invalidate()); }),
        btn('Delete', () => { S.pins.splice(i, 1); pinsChanged(); }))));
  }
  buildGasUI(box);
  buildMoreUI(box);
}
function buildGasUI(box) {
  const btn = (label, fn) => el('button', { onclick: fn }, label);
  const gas = S.pins.map((p, i) => [p, i]).filter(([p]) => p.type === 'gas');
  box.append(el('h4', {}, `Pox gas (${gas.length})`));
  for (const [p, i] of gas) {
    const name = el('input', { type: 'text', value: p.name || '' }); name.onchange = () => { p.name = name.value; pinsChanged(false); };
    const c = p.pts.reduce((a, q) => [a[0] + q[0] / p.pts.length, a[1] + q[1] / p.pts.length], [0, 0]);
    box.append(el('div', { class: 'pincard' }, name, el('small', {}, `${p.pts.length} corners, centre ${c.map((v) => v.toFixed(0)).join(', ')}`),
      el('div', { class: 'rowbtn' }, btn('Go', () => { S.mapCenter && (S.mapCenter.x = c[0], S.mapCenter.z = -c[1], updateOrtho(), invalidate()); }),
        btn('Delete', () => { S.pins.splice(i, 1); pinsChanged(); }))));
  }
}
function buildMoreUI(box) {
  const btn = (label, fn) => el('button', { onclick: fn }, label);
  const goto = (p) => () => { S.mapCenter && (S.mapCenter.x = p.pos[0], S.mapCenter.z = -p.pos[1], updateOrtho(), invalidate()); };
  const names = S.pins.filter((p) => p.type === 'trigger').map((p) => p.name);
  const kills = S.pins.map((p, i) => [p, i]).filter(([p]) => p.type === 'kill');
  box.append(el('h4', {}, `Instakill boxes (${kills.length})`));
  for (const [p, i] of kills) {
    const name = el('input', { type: 'text', value: p.name || '' }); name.onchange = () => { p.name = name.value; pinsChanged(false); };
    const c = p.pts.reduce((a, q) => [a[0] + q[0] / p.pts.length, a[1] + q[1] / p.pts.length], [0, 0]);
    box.append(el('div', { class: 'pincard' }, name, el('small', {}, `${p.pts.length} corners; kills a player inside, from 5 m below to 12 m above the corners`),
      el('div', { class: 'rowbtn' }, btn('Go', () => { S.mapCenter && (S.mapCenter.x = c[0], S.mapCenter.z = -c[1], updateOrtho(), invalidate()); }),
        btn('Delete', () => { S.pins.splice(i, 1); pinsChanged(); }))));
  }
  const pk = S.pins.map((p, i) => [p, i]).filter(([p]) => p.type === 'pickup');
  box.append(el('h4', {}, `Pickups / chests (${pk.length})`));
  for (const [p, i] of pk) {
    const sel = el('select', {}, ...PICKUPS.map((n) => el('option', { value: n, ...(n === p.pickup ? { selected: 'selected' } : {}) }, n)));
    sel.onchange = () => { p.pickup = sel.value; pinsChanged(false); redrawPins(); };
    const yaw = el('input', { type: 'number', min: 0, max: 359, value: p.yaw || 0 }); yaw.onchange = () => { p.yaw = +yaw.value || 0; pinsChanged(false); };
    box.append(el('div', { class: 'pincard' }, sel, el('label', {}, 'Facing (deg)', yaw), el('small', {}, p.pos.map((v) => v.toFixed(1)).join(', ')),
      el('div', { class: 'rowbtn' }, btn('Go', goto(p)), btn('Delete', () => { S.pins.splice(i, 1); pinsChanged(); }))));
  }
  const pr = S.pins.map((p, i) => [p, i]).filter(([p]) => p.type === 'prop');
  box.append(el('h4', {}, `Props / gates (${pr.length})`));
  for (const [p, i] of pr) {
    const unit = el('input', { type: 'text', value: p.unit || '', placeholder: 'unit path, e.g. content/props/...' }); unit.onchange = () => { p.unit = unit.value.trim(); pinsChanged(false); };
    const yaw = el('input', { type: 'number', min: 0, max: 359, value: p.yaw || 0 }); yaw.onchange = () => { p.yaw = +yaw.value || 0; pinsChanged(false); };
    const sc = el('input', { type: 'number', min: 0.1, max: 20, step: 0.1, value: p.scale || 1 }); sc.onchange = () => { p.scale = +sc.value || 1; pinsChanged(false); };
    const op = el('select', {}, el('option', { value: '' }, 'never (decoration)'), ...names.map((n) => el('option', { value: n, ...(n === p.opens_on ? { selected: 'selected' } : {}) }, 'gate: removed when ' + n + ' is cleared')));
    op.onchange = () => { p.opens_on = op.value; pinsChanged(false); redrawPins(); };
    box.append(el('div', { class: 'pincard' }, unit, el('label', {}, 'Facing (deg)', yaw), el('label', {}, 'Scale', sc), op, el('small', {}, p.pos.map((v) => v.toFixed(1)).join(', ')),
      el('div', { class: 'rowbtn' }, btn('Go', goto(p)), btn('Delete', () => { S.pins.splice(i, 1); pinsChanged(); }))));
  }
}
function setIso(on) {
  S.iso = on;
  if (on && !S.mapMode) setMap(true);
  updateOrtho(); invalidate();
  $('#btn-iso').classList.toggle('primary', on);
}
canvas.addEventListener('click', (e) => {
  if (S.pinTool && e.shiftKey && !S.mapMode && !e.altKey) { const p = surfaceAt(e); if (p) placePin(p); }
});

// ---------------------------------------------------------------- strikemap
// A flat, tactical-map look (dark floor plan, light wall outlines, tinted by height) with a MapGenie-style sidebar:
// gameplay markers grouped by category, chest / collectible spawns you can tick off as found (kept in this browser,
// per mission). Top-down by default; isometric (I) works too. Nothing is rebuilt: it re-skins the loaded pack.
S.strike = false; S.found = new Set(); S.strikeCats = {}; S.hideFound = false;
const STRIKE_GROUPS = [
  ['Loot and collectibles', ['chest', 'grimoire', 'scripture', 'martyr_skull', 'side_mission']],
  ['Supplies', ['medicae', 'pickup']],
  ['Mission', ['objective', 'luggable', 'player_spawn']],
  ['Hazards and enemies', ['hazard', 'enemy_gate', 'door']],
];
const STRIKE_DEFAULT_ON = new Set(['chest', 'grimoire', 'scripture', 'martyr_skull', 'side_mission', 'medicae']);
const foundKey = () => 'mv_found_' + S.pack;
const poiKey = (p) => p.cat + ':' + p.inst;
function loadFound() {
  S.found = new Set();
  try { for (const k of JSON.parse(localStorage.getItem(foundKey()) || '[]')) S.found.add(k); } catch (_) {}
}
function saveFound() { try { localStorage.setItem(foundKey(), JSON.stringify([...S.found])); } catch (_) {} }
function strikeMaterial() {
  if (S.strikeMat) return S.strikeMat;
  const [lo, hi] = strikeHeightRange();
  S.strikeMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uCeil: { value: S.mapCeil ?? 1e4 }, uLo: { value: lo }, uHi: { value: hi },
      uMask: { value: null }, uBox: { value: new THREE.Vector4(0, 0, 1, 1) }, uMaskOn: { value: 0 } },
    vertexShader: `varying vec3 vW; varying vec3 vN;
      void main() {
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
          m = m * instanceMatrix;
        #endif
        vec4 w = m * vec4(position, 1.0);
        vW = w.xyz; vN = normalize(mat3(m) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `uniform float uCeil, uLo, uHi, uMaskOn; uniform vec4 uBox; uniform sampler2D uMask; varying vec3 vW; varying vec3 vN;
      void main() {
        if (vW.y > uCeil) discard;
        if (uMaskOn > 0.5) {
          vec2 uv = (vW.xz - uBox.xy) / uBox.zw;
          if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
          if (texture2D(uMask, vec2(uv.x, 1.0 - uv.y)).r < 0.5) discard;
        }
        float t = clamp((vW.y - uLo) / max(1.0, uHi - uLo), 0.0, 1.0);
        vec3 floorC = mix(vec3(0.16, 0.18, 0.21), vec3(0.50, 0.53, 0.58), t);
        vec3 wallC = vec3(0.82, 0.86, 0.92);
        gl_FragColor = vec4(abs(vN.y) > 0.6 ? floorC : wallC, 1.0);
      }`,
  });
  S.strikeHidden = new THREE.MeshBasicMaterial({ visible: false });
  return S.strikeMat;
}
// "Playable area only": keep geometry within R metres (map plan view) of the main path, so the flat map shows the
// route's corridor instead of every backdrop and platform the level places around it.
S.strikeMask = { on: true, r: 45 };
function strikeBuildMask() {
  const m = S.strikeMask, u = strikeMaterial().uniforms;
  const segs = (S.overlays?.main_path?.main_path_segments || []).map((sg) => sg.nodes || []).filter((n) => n.length);
  if (!m.on || !segs.length) { u.uMaskOn.value = 0; return; }
  const all = segs.flat();
  const pad = m.r + 10;
  const minx = Math.min(...all.map((p) => p[0])) - pad, maxx = Math.max(...all.map((p) => p[0])) + pad;
  const minz = Math.min(...all.map((p) => -p[1])) - pad, maxz = Math.max(...all.map((p) => -p[1])) + pad;
  const sx = maxx - minx, sz = maxz - minz, k = 1024 / Math.max(sx, sz);
  const cv = document.createElement('canvas'); cv.width = Math.ceil(sx * k); cv.height = Math.ceil(sz * k);
  const c = cv.getContext('2d'); c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, cv.height);
  c.strokeStyle = c.fillStyle = '#fff'; c.lineWidth = 2 * m.r * k; c.lineCap = c.lineJoin = 'round';
  for (const nodes of segs) {
    c.beginPath();
    nodes.forEach((p, i) => { const x = (p[0] - minx) * k, y = (-p[1] - minz) * k; i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.stroke();
    if (nodes.length === 1) { c.beginPath(); c.arc((nodes[0][0] - minx) * k, (-nodes[0][1] - minz) * k, m.r * k, 0, 7); c.fill(); }
  }
  u.uMask.value?.dispose?.();
  u.uMask.value = new THREE.CanvasTexture(cv);
  u.uBox.value.set(minx, minz, sx, sz); u.uMaskOn.value = 1;
}
function strikeHeightRange() {
  const pts = (S.overlays?.main_path?.main_path_segments || []).flatMap((sg) => sg.nodes || []);
  if (pts.length) { const zs = pts.map((p) => p[2]); return [Math.min(...zs) - 10, Math.max(...zs) + 25]; }
  const b = S.manifest?.bounds; return b ? [b[0][2], b[1][2]] : [-50, 60];
}
function strikeApplyMaterials() {
  // surfaces only; light cards, decals, helpers and sky stay out of the flat map
  const flat = strikeMaterial();
  for (const e of S.meshes) {
    const mats = e.mats.map((m) => (m.userData.rec?.family || 'surface') === 'surface' && m.visible ? flat : S.strikeHidden);
    for (const im of e.objs) im.material = mats;
  }
}
function strikeRestoreMaterials() { for (const e of S.meshes) for (const im of e.objs) im.material = e.mats; }
function setStrike(on) {
  if (on === S.strike) return;
  if (on) {
    if (!S.ready) return;
    if (!S.mapMode) setMap(true);
    S.strike = true;
    loadFound();
    // remember the layer state, show only the strike categories
    S.strikeSaved = Object.entries(S.overlayObjs).map(([n, o]) => [o, o.on]);
    S.strikeBg = scene.background.getHex();
    scene.background.set(0x0a0b0d);
    const pts = (S.overlays?.main_path?.main_path_segments || []).flatMap((sg) => sg.nodes || []);
    if (pts.length) setCeil(Math.max(...pts.map((p) => p[2])) + 3);
    const lo = strikeHeightRange(); strikeMaterial().uniforms.uLo.value = lo[0]; S.strikeMat.uniforms.uHi.value = lo[1];
    S.strikeMat.uniforms.uCeil.value = S.mapCeil;
    strikeBuildMask();
    strikeApplyMaterials();
    for (const o of Object.values(S.overlayObjs)) { o.on = false; o.obj.visible = false; }
    const poiByCat = Object.fromEntries(Object.values(S.overlayObjs).filter((o) => o.poi).map((o) => [o.obj.name, o]));
    S.strikeCats = {};
    for (const cat of Object.keys(poiByCat)) S.strikeCats[cat] = STRIKE_DEFAULT_ON.has(cat);
    strikeApplyCats();
    loadStk(); stkRebuildAbil(); stkRebuildStrokes();
    const main = S.overlayObjs['Main path']; if (main) { main.on = true; main.obj.visible = true; }
    S.showLabels = true;
    document.querySelector('.tabs button[data-tab="strike"]').click();
  } else {
    S.strike = false;
    stkClear(); S.abilTool = null; S.drawOn = false; canvas.style.cursor = '';
    strikeRestoreMaterials();
    scene.background.set(S.strikeBg ?? 0x1a1e1f);
    for (const [o, was] of S.strikeSaved || []) { o.on = was; o.obj.visible = was; }
    for (const sp of S.poiSprites || []) { sp.material = S.poiMats[sp.userData.poi.cat].on; sp.visible = true; sp.scale.set(0.028, 0.028, 1); }
    S.strikeSpriteScale = 0;
    buildLayersUI();
    document.querySelector('.tabs button[data-tab="layers"]').click();
  }
  $('#btn-strike').classList.toggle('primary', S.strike);
  invalidate();
}
function strikeApplyCats() {
  for (const o of Object.values(S.overlayObjs)) if (o.poi) {
    const cat = o.obj.name, show = !!S.strikeCats[cat];
    o.on = show; o.obj.visible = show;
    for (const sp of o.obj.children) {
      const p = sp.userData.poi, found = S.found.has(poiKey(p));
      sp.visible = !(found && S.hideFound);
      sp.material = found ? S.poiMats[cat].off : S.poiMats[cat].on;
    }
  }
  invalidate();
}
// sprites ignore size attenuation in an orthographic camera, so size them in metres for a constant ~22 px on screen
function strikeScaleSprites() {
  const px = ortho.zoom * innerHeight / (ortho.top - ortho.bottom);
  const s = 22 / Math.max(1e-3, px);
  if (Math.abs(s - (S.strikeSpriteScale || 0)) < 1e-4) return;
  S.strikeSpriteScale = s;
  for (const sp of S.poiSprites || []) sp.scale.set(s, s, 1);
  for (const sp of S.abilSprites || []) sp.scale.set(s * 2.2, s * 2.2, 1);
}
function toggleFound(p) {
  const k = poiKey(p);
  if (S.found.has(k)) S.found.delete(k); else S.found.add(k);
  saveFound(); strikeApplyCats(); buildStrikeUI();
}
function strikeClick(e) {
  if (S.abilTool) {
    const p = stkWorldPoint(e);
    if (p) { S.abil.push({ k: S.abilTool, pos: p }); saveStk(); stkRebuildAbil(); buildStrikeUI(); }
    return;
  }
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, ortho);
  ray.params.Points = { threshold: 0.5 };
  const hit = ray.intersectObjects((S.poiSprites || []).filter((x) => x.parent.visible && x.visible), false)[0];
  if (hit) toggleFound(hit.object.userData.poi);
}
function strikeGo(p) {
  S.mapCenter.x = p.pos[0]; S.mapCenter.z = -p.pos[1]; updateOrtho();
  ortho.zoom = Math.max(ortho.zoom, 1.5); ortho.updateProjectionMatrix(); invalidate();
}
function buildStrikeUI() {
  const box = $('#tab-strike'); if (!box) return;
  const keep = box.scrollTop; box.innerHTML = '';
  if (!S.strike) {
    box.append(el('p', {}, 'Flat tactical map with chest and collectible spawns you can tick off as you find them.'),
      el('button', { class: 'primary', onclick: () => setStrike(true) }, 'Turn on Strikemap (T)'));
    return;
  }
  const labels = S.overlays.poi_labels || {};
  const byCat = {};
  for (const p of S.overlays.pois || []) (byCat[p.cat] ||= []).push(p);
  let total = 0, done = 0;
  for (const [cat, list] of Object.entries(byCat)) if (S.strikeCats[cat]) { total += list.length; done += list.filter((p) => S.found.has(poiKey(p))).length; }
  box.append(el('div', { class: 'stk-progress' }, el('b', {}, `${done} / ${total}`), ' found in the shown categories',
    el('div', { class: 'bar' }, el('i', { style: `width:${total ? (100 * done / total) : 0}%` }))));
  const hf = el('input', { type: 'checkbox' }); hf.checked = S.hideFound; hf.onchange = () => { S.hideFound = hf.checked; strikeApplyCats(); };
  const pa = el('input', { type: 'checkbox' }); pa.checked = S.strikeMask.on; pa.onchange = () => { S.strikeMask.on = pa.checked; strikeBuildMask(); invalidate(); };
  const pr = el('input', { type: 'range', min: 15, max: 150, step: 5, value: S.strikeMask.r });
  pr.onchange = () => { S.strikeMask.r = +pr.value; strikeBuildMask(); invalidate(); };
  box.append(el('label', {}, hf, 'Hide found markers'),
    el('label', {}, pa, 'Playable area only', el('small', {}, 'range (m)'), pr),
    el('div', { class: 'rowbtn' },
      el('button', { onclick: () => { if (confirm('Clear every found tick on this mission?')) { S.found.clear(); saveFound(); strikeApplyCats(); buildStrikeUI(); } } }, 'Reset found'),
      el('button', { onclick: screenshot }, 'Save PNG (P)')),
    el('small', {}, 'Click a marker on the map to tick it off. Slide the map slice (Q / E) to change floor.'));
  box.append(...stkToolsUI());
  const used = new Set();
  const section = (title, cats) => {
    const present = cats.filter((c) => byCat[c]); if (!present.length) return;
    box.append(el('h4', {}, title));
    for (const cat of present) {
      used.add(cat);
      const list = byCat[cat], f = list.filter((p) => S.found.has(poiKey(p))).length;
      const cb = el('input', { type: 'checkbox' }); cb.checked = !!S.strikeCats[cat];
      cb.onchange = () => { S.strikeCats[cat] = cb.checked; strikeApplyCats(); buildStrikeUI(); };
      const col = (Object.values(S.overlayObjs).find((o) => o.obj?.name === cat) || {}).color;
      const head = el('label', {}, cb, col != null ? el('span', { class: 'sw', style: `background:#${col.toString(16).padStart(6, '0')}` }) : null,
        labels[cat] || cat, el('small', {}, `${f} / ${list.length}`));
      box.append(head);
      if (S.strikeCats[cat] && list.length <= 80) {
        const d = el('details', { class: 'stk-list' }, el('summary', {}, 'list'));
        list.forEach((p, i) => {
          const c2 = el('input', { type: 'checkbox' }); c2.checked = S.found.has(poiKey(p)); c2.onchange = () => toggleFound(p);
          d.append(el('div', { class: 'stk-row' }, c2, el('span', {}, `#${i + 1}`), el('small', {}, p.pos.slice(0, 2).map((x) => x.toFixed(0)).join(', ')),
            el('button', { onclick: () => strikeGo(p) }, 'Go')));
        });
        box.append(d);
      }
    }
  };
  for (const [title, cats] of STRIKE_GROUPS) section(title, cats);
  section('Other', Object.keys(byCat).filter((c) => !STRIKE_GROUPS.some(([, cs]) => cs.includes(c))));
  box.scrollTop = keep;
}
// ---- Strikemap tools: ability radius circles and free drawing for pathing
// Radii are the game's own numbers (source file in each note). Circles and drawings are stored per mission in this
// browser (mv_abil_<pack>, mv_draw_<pack>) in Darktide world coordinates (x, y, z metres).
const ICON_URL = (n) => `/packs/_icons/${n}.png`;
const ABILITIES = {
  veteran_shout: { label: 'Veteran shout (Voice of Command)', cls: 'veteran', icon: 'veteran_ability_voice_of_command', color: '#4fc3f7', glyph: 'V',
    rings: [{ r: 9, label: '9 m' }],
    note: 'radius 9 m. talent_settings_veteran.lua veteran_3.combat_ability.radius' },
  psyker_shout: { label: 'Psyker shout (vent warp charge)', cls: 'psyker', icon: 'psyker_shout_vent_warp_charge', color: '#ba68c8', glyph: 'P',
    rings: [{ r: 30, label: '30 m' }],
    note: 'range 30 m. talent_settings_psyker.lua psyker_2.combat_ability.shout_range' },
  ogryn_taunt: { label: 'Ogryn taunt', cls: 'ogryn', icon: 'ogryn_ability_taunt', color: '#ffb74d', glyph: 'O',
    rings: [{ r: 12, label: '12 m' }],
    note: 'radius 12 m. ability_templates/ogryn_taunt_shout.lua RADIUS' },
  adamant_shout: { label: 'Adamant shout', cls: 'adamant', icon: 'adamant_ability_shout', color: '#81c784', glyph: 'A',
    rings: [{ r: 6, label: 'near 6 m' }, { r: 12, label: 'far 12 m', dashed: true }],
    note: 'range 6 m, far range 12 m (16 m improved). talent_settings_adamant.lua combat_ability.shout' },
  zealot_relic: { label: 'Zealot relic pulse (Bolstering Prayer)', cls: 'zealot', icon: 'zealot_ability_bolstering_prayer', color: '#ff8a65', glyph: 'Z',
    rings: [1, 2, 3, 4, 5].map((t) => ({ r: +(10 + 0.1 * t).toFixed(1), label: t === 5 ? 'pulse 5 s: 10.5 m' : 't=' + t + ' s: ' + (10 + 0.1 * t).toFixed(1) + ' m' })),
    note: 'channel lasts 5.5 s, pulses every 0.8 s. Radius is 10 m + 0.1 m per second of channel (time capped at 5 s): rings show t = 1 to 5 s. zealot_relic.lua action_zealot_channel, action_zealot_channel.lua, talent_settings_zealot.lua bolstering_prayer.tick_rate' },
};
const DRAW_COLORS = ['#ff5252', '#ffd740', '#69f0ae', '#40c4ff', '#e040fb', '#ffffff'];
S.abil = []; S.strokes = []; S.abilTool = null; S.drawOn = false; S.drawColor = DRAW_COLORS[0]; S.drawWidth = 4;
S.showCircles = true; S.showDraw = true; S.abilSprites = [];
const stkMats = [];
const abilKey = () => 'mv_abil_' + S.pack, drawKey = () => 'mv_draw_' + S.pack;
function loadStk() {
  for (const [k, key] of [['abil', abilKey()], ['strokes', drawKey()]]) {
    try { S[k] = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_) { S[k] = []; }
  }
}
function saveStk() {
  try { localStorage.setItem(abilKey(), JSON.stringify(S.abil)); localStorage.setItem(drawKey(), JSON.stringify(S.strokes)); } catch (_) {}
}
function stkWorldPoint(e) {
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), ortho);
  const h = (S.mapCeil ?? 0) - 3, p = new THREE.Vector3();
  if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -h), p)) return null;
  return threeToStingray(p).map((v) => +v.toFixed(2));
}
function stkEnsure() {
  if (S.stkGroup && S.stkGroup.parent === overlayGroup) return;
  S.stkGroup = new THREE.Group(); S.stkGroup.name = 'Strike tools';
  S.abilGroup = new THREE.Group(); S.strokeGroup = new THREE.Group();
  S.stkGroup.add(S.abilGroup, S.strokeGroup); overlayGroup.add(S.stkGroup);
}
function stkClear() {
  if (S.stkGroup) { overlayGroup.remove(S.stkGroup); S.stkGroup.traverse((o) => o.geometry?.dispose?.()); S.stkGroup = null; }
  S.labels = S.labels.filter((l) => { if (l.stk) { l.el.remove(); return false; } return true; });
  stkMats.length = 0; S.abilSprites = [];
}
function fatLine(pts, color, width, dashed) {
  const m = new LineMaterial({ color: new THREE.Color(color), linewidth: width, transparent: true, depthTest: false, dashed: !!dashed, dashSize: 2, gapSize: 1.5 });
  m.resolution.set(innerWidth, innerHeight); stkMats.push(m);
  const g = new LineGeometry(); g.setPositions(pts.flat());
  const l = new Line2(g, m); l.frustumCulled = false; l.renderOrder = 40; if (dashed) l.computeLineDistances();
  return l;
}
const iconCache = new Map();
const loadImg = (url) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = url; });
async function abilityTexture(a) {
  if (iconCache.has(a.icon)) return iconCache.get(a.icon);
  const [ab, cl] = await Promise.all([loadImg(ICON_URL(a.icon)), loadImg(ICON_URL('class_' + a.cls))]);
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = '#101214'; c.beginPath(); c.arc(64, 64, 60, 0, 7); c.fill();
  if (ab) { // ability icon, cover-fitted into the disc
    c.save(); c.beginPath(); c.arc(64, 64, 56, 0, 7); c.clip();
    const k = Math.max(112 / ab.width, 112 / ab.height); c.drawImage(ab, 64 - ab.width * k / 2, 64 - ab.height * k / 2, ab.width * k, ab.height * k); c.restore();
  } else { c.fillStyle = a.color; c.font = 'bold 64px Segoe UI, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(a.glyph, 64, 68); }
  c.lineWidth = 8; c.strokeStyle = a.color; c.beginPath(); c.arc(64, 64, 60, 0, 7); c.stroke();
  if (cl) { // class badge, bottom right
    c.fillStyle = '#101214'; c.beginPath(); c.arc(100, 100, 24, 0, 7); c.fill();
    c.lineWidth = 4; c.stroke();
    c.drawImage(cl, 82, 82, 36, 36);
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  iconCache.set(a.icon, t); return t;
}
function stkRebuildAbil() {
  if (!S.strike) return;
  stkEnsure();
  const g = S.abilGroup;
  for (const c of [...g.children]) { g.remove(c); c.geometry?.dispose?.(); }
  S.labels = S.labels.filter((l) => { if (l.stk === 'abil') { l.el.remove(); return false; } return true; });
  S.abilSprites = [];
  g.visible = S.showCircles;
  const N = 96;
  S.abil.forEach((it) => {
    const a = ABILITIES[it.k]; if (!a) return;
    const [x, y, z] = it.pos;
    a.rings.forEach((rg, j) => {
      const pts = []; for (let i = 0; i <= N; i++) { const t = i / N * Math.PI * 2; pts.push([x + rg.r * Math.cos(t), y + rg.r * Math.sin(t), z]); }
      g.add(fatLine(pts, a.color, 3, rg.dashed));
      if (j === a.rings.length - 1 || a.rings.length < 3) {
        const fill = new THREE.Mesh(new THREE.CircleGeometry(rg.r, 64), new THREE.MeshBasicMaterial({ color: a.color, transparent: true, opacity: 0.08, depthTest: false, depthWrite: false }));
        fill.position.set(x, y, z - 0.05); fill.renderOrder = 38; g.add(fill);
      }
      const ang = 0.5 + j * 0.45;
      S.labels.push({ pos: new THREE.Vector3(x + rg.r * Math.cos(ang), y + rg.r * Math.sin(ang), z), text: rg.label, group: g, stk: 'abil',
        el: el('div', { class: 'label3d' }, rg.label) });
    });
    const mat = new THREE.SpriteMaterial({ depthTest: false, sizeAttenuation: false, transparent: true });
    abilityTexture(a).then((t) => { mat.map = t; mat.needsUpdate = true; invalidate(); });
    const sp = new THREE.Sprite(mat); sp.position.set(x, y, z + 0.5); sp.renderOrder = 45; g.add(sp); S.abilSprites.push(sp);
  });
  S.strikeSpriteScale = 0; invalidate();
}
function stkRebuildStrokes() {
  if (!S.strike) return;
  stkEnsure();
  const g = S.strokeGroup;
  for (const c of [...g.children]) { g.remove(c); c.geometry?.dispose?.(); }
  g.visible = S.showDraw;
  for (const st of S.strokes) if (st.pts.length > 1) g.add(fatLine(st.pts.map((p) => [p[0], p[1], p[2] + 0.2]), st.c, st.w));
  invalidate();
}
function strikeUndo() {
  if (S.strokes.length) { S.strokes.pop(); saveStk(); stkRebuildStrokes(); }
  else if (S.abil.length) { S.abil.pop(); saveStk(); stkRebuildAbil(); buildStrikeUI(); }
}
let stkCur = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!S.strike || !S.drawOn || e.button !== 0 || e.altKey) return;
  const p = stkWorldPoint(e); if (!p) return;
  stkCur = { c: S.drawColor, w: S.drawWidth, pts: [p] }; S.strokes.push(stkCur);
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
});
canvas.addEventListener('pointermove', (e) => {
  if (!stkCur) return;
  const p = stkWorldPoint(e); if (!p) return;
  const l = stkCur.pts[stkCur.pts.length - 1];
  if (Math.hypot(p[0] - l[0], p[1] - l[1]) < 0.6 / Math.max(0.2, ortho.zoom)) return;
  stkCur.pts.push(p); stkRebuildStrokes();
});
addEventListener('pointerup', () => {
  if (!stkCur) return;
  if (stkCur.pts.length < 2) S.strokes.pop();
  stkCur = null; saveStk(); stkRebuildStrokes(); buildStrikeUI();
});
function stkToolsUI() {
  const out = [];
  const chk = (label, on, fn) => { const i = el('input', { type: 'checkbox' }); i.checked = on; i.onchange = () => fn(i.checked); return el('label', {}, i, label); };
  out.push(el('h4', {}, 'Ability radius circles'));
  out.push(el('small', {}, 'Pick an ability, then click the map to place its circle. Esc stops placing.'));
  for (const [k, a] of Object.entries(ABILITIES)) {
    const img = el('img', { src: ICON_URL(a.icon), width: 28, height: 28, style: 'border-radius:50%;border:2px solid ' + a.color + ';object-fit:cover;background:#101214' });
    img.onerror = () => { img.style.visibility = 'hidden'; };
    const cl = el('img', { src: ICON_URL('class_' + a.cls), width: 18, height: 18, style: 'background:#101214;border-radius:50%;margin-left:-10px;margin-top:14px' });
    cl.onerror = () => { cl.style.display = 'none'; };
    const b = el('button', { class: S.abilTool === k ? 'primary' : '', title: a.note, style: 'display:flex;align-items:center;gap:6px;width:100%;text-align:left;margin:2px 0',
      onclick: () => { S.abilTool = S.abilTool === k ? null : k; S.drawOn = false; canvas.style.cursor = S.abilTool ? 'crosshair' : ''; buildStrikeUI(); } },
      img, cl, el('span', {}, a.label, el('br'), el('small', {}, a.rings.length > 1 ? a.rings.map((r) => r.label).join(' / ') : a.rings[0].label)));
    out.push(b);
  }
  if (S.abilTool) out.push(el('small', {}, ABILITIES[S.abilTool].note));
  if (S.abil.length) {
    out.push(chk('Show circles', S.showCircles, (v) => { S.showCircles = v; stkRebuildAbil(); }));
    S.abil.forEach((it, i) => {
      const a = ABILITIES[it.k]; if (!a) return;
      out.push(el('div', { class: 'stk-row' }, el('span', { class: 'sw', style: 'background:' + a.color }), el('span', {}, a.label.split(' (')[0]),
        el('small', {}, it.pos.slice(0, 2).map((v) => v.toFixed(0)).join(', ')),
        el('button', { onclick: () => strikeGo({ pos: it.pos }) }, 'Go'),
        el('button', { onclick: () => { S.abil.splice(i, 1); saveStk(); stkRebuildAbil(); buildStrikeUI(); } }, 'x')));
    });
  }
  out.push(el('h4', {}, 'Draw a path'));
  out.push(el('button', { class: S.drawOn ? 'primary' : '', onclick: () => { S.drawOn = !S.drawOn; S.abilTool = null; canvas.style.cursor = S.drawOn ? 'crosshair' : ''; buildStrikeUI(); } },
    S.drawOn ? 'Drawing: drag on the map (Esc to stop)' : 'Draw on the map'));
  const sw = el('div', { class: 'rowbtn' });
  for (const c of DRAW_COLORS) sw.append(el('button', { style: `background:${c};width:22px;height:22px;padding:0;${S.drawColor === c ? 'outline:2px solid #fff' : ''}`, title: c,
    onclick: () => { S.drawColor = c; buildStrikeUI(); } }));
  out.push(sw);
  const wr = el('input', { type: 'range', min: 2, max: 12, step: 1, value: S.drawWidth });
  wr.onchange = () => { S.drawWidth = +wr.value; };
  out.push(el('label', {}, 'Width', wr));
  out.push(el('div', { class: 'rowbtn' },
    el('button', { onclick: () => { S.strokes.pop(); saveStk(); stkRebuildStrokes(); } }, 'Undo stroke (Ctrl+Z)'),
    el('button', { onclick: () => { if (S.strokes.length && confirm('Clear all drawings on this mission?')) { S.strokes = []; saveStk(); stkRebuildStrokes(); } } }, 'Clear drawings')));
  out.push(chk('Show drawings', S.showDraw, (v) => { S.showDraw = v; stkRebuildStrokes(); }));
  out.push(el('small', {}, `${S.strokes.length} stroke(s). Drawings and circles are saved in this browser per mission and appear in the PNG export.`));
  return out;
}
$('#btn-strike').onclick = () => setStrike(!S.strike);

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let fpsT = 0, fpsN = 0, fps = 0, lastRender = 0, lastCull = 0, dirty = true;
function invalidate() { dirty = true; }
function camKey() {
  const c = S.mapMode ? ortho : camera;
  return [c.position.x, c.position.y, c.position.z, c.rotation.x, c.rotation.y, c.zoom, S.mapCeil, S.mapMode].map((v) => (+v || 0).toFixed(2)).join(',');
}
for (const ev of ['pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'change', 'click']) addEventListener(ev, invalidate, true);
addEventListener('pointermove', () => { if (S.look || S.drag) invalidate(); }, true);
function render() {
  if (S.strike) { strikeScaleSprites(); for (const m of stkMats) m.resolution.set(innerWidth, innerHeight); }
  renderer.render(scene, S.mapMode ? ortho : camera);
}
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, clock.getDelta());
  if (!$('#hud').hidden) {
    if (!S.mapMode) {
      const k = S.keys, f = new THREE.Vector3(), rgt = new THREE.Vector3();
      camera.getWorldDirection(f); rgt.crossVectors(f, camera.up).normalize();
      let sp = S.speed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1) * (k.has('ControlLeft') ? 0.25 : 1) * dt;
      if (k.has('KeyW')) camera.position.addScaledVector(f, sp);
      if (k.has('KeyS')) camera.position.addScaledVector(f, -sp);
      if (k.has('KeyD')) camera.position.addScaledVector(rgt, sp);
      if (k.has('KeyA')) camera.position.addScaledVector(rgt, -sp);
      if (k.has('KeyE') || k.has('Space')) camera.position.y += sp;
      if (k.has('KeyQ')) camera.position.y -= sp;
      if (sun.castShadow) updateSun();
    }
    // draw only when something changed, at most PERF.fps times a second; idle = no GPU work
    const now = performance.now();
    const key = camKey();
    if (key !== S.lastKey) { S.lastKey = key; dirty = true; }
    if (key !== S.cullKey && now - lastCull > 120 && S.meshes.length) { lastCull = now; applyVisibility(); }
    if (!dirty || (PERF.fps && now - lastRender < 1000 / PERF.fps - 2)) return;
    dirty = false; lastRender = now;
    render();
    // labels
    const cam = S.mapMode ? ortho : camera;
    const v = new THREE.Vector3();
    for (const L of [...S.labels, ...ruler.labels]) {
      const show = S.showLabels !== false && L.group.visible;
      if (!show) { L.el.hidden = true; continue; }
      v.copy(L.pos); if (!L.world) root.localToWorld(v);
      const d = v.distanceTo(camera.position);
      v.project(cam);
      if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || (!S.mapMode && d > 150)) { L.el.hidden = true; continue; }
      if (!L.el.isConnected) document.body.append(L.el);
      L.el.hidden = false;
      L.el.style.left = ((v.x + 1) / 2 * innerWidth) + 'px'; L.el.style.top = ((1 - v.y) / 2 * innerHeight) + 'px';
    }
    const p = threeToStingray(camera.position);
    fpsN++; const t = now / 1000; if (!S.fpsT0) S.fpsT0 = t; if (t - S.fpsT0 > 0.5) { fps = Math.round(fpsN / (t - S.fpsT0)); fpsN = 0; S.fpsT0 = t; }
    $('#coords').textContent = `x ${p[0].toFixed(1)}  y ${p[1].toFixed(1)}  z ${p[2].toFixed(1)}   speed ${S.speed.toFixed(1)} m/s   ${fps} fps (idle = 0)   ${renderer.info.render.calls} draws   ${fmt(S.drawnInstances || 0)} objects drawn`;
  }
}

window.MV = { S, scene, camera, ortho, root, THREE, selectInstance, applyVisibility }; // console debugging
resize();
tick();
const q = new URLSearchParams(location.hash.slice(1));
if (q.get('pack')) openPack(q.get('pack')).catch((e) => { alert('Could not open pack: ' + e.message); showMenu(); });
else showMenu();
