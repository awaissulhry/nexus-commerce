# Stage 1 of the mannequin build, run in Blender headless (see README.md here). MakeHuman 1.1 CC0 assets:
# sex base + shape targets -> mannequin treatment (egg head, smoothed chest and crotch) -> arms lowered -> measurements
# and baked ambient occlusion -> numpy files for pack-body.mjs.
#   blender -b --factory-startup --python build_body.py -- <assets dir> <out dir> [arm angle, default 20]
import bpy, sys, os, json, math, numpy as np
argv = sys.argv[sys.argv.index('--') + 1:]
MH, OUT, ARM_DEG = argv[0], argv[1], float(argv[2]) if len(argv) > 2 else 20
os.makedirs(OUT, exist_ok=True)

def read_obj(path):
    verts, faces, group = [], [], None
    for line in open(path):
        if line.startswith('v '): verts.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('g '): group = line.split()[1]
        elif line.startswith('f ') and group == 'body': faces.append([int(p.split('/')[0]) - 1 for p in line.split()[1:]])
    return np.array(verts, np.float64), faces
def read_target(name, n):
    d = np.zeros((n, 3))
    for line in open(f'{MH}/t/{name}.target'):
        if line[0] in '#\n': continue
        p = line.split(); d[int(p[0])] = [float(p[1]), float(p[2]), float(p[3])]
    return d

V, F = read_obj(f'{MH}/base.obj'); N = len(V)
skel = json.load(open(f'{MH}/rig/default.mhskel')); W = json.load(open(f'{MH}/rig/default_weights.mhw'))['weights']
bones = skel['bones']; kids = {}
for b, v in bones.items(): kids.setdefault(v['parent'], []).append(b)
def subtree(b): return [b] + [x for c in kids.get(b, []) for x in subtree(c)]
def bone_weight(names):
    w = np.zeros(N)
    for b in names:
        for v, x in W.get(b, []): w[v] += x
    return np.clip(w, 0, 1)
joint = lambda P, name: P[skel['joints'][name]].mean(0)

used = sorted({i for f in F for i in f}); remap = {v: i for i, v in enumerate(used)}
tris = []
for f in F:
    f = [remap[i] for i in f]
    tris += [[f[0], f[1], f[2]]] + ([[f[0], f[2], f[3]]] if len(f) == 4 else [])
tris = np.array(tris, np.int32)
# neighbours (body faces only) for smoothing
nbr = [set() for _ in range(N)]
for f in F:
    for i in range(len(f)): nbr[f[i]].update((f[i - 1], f[(i + 1) % len(f)]))
nbr_idx = [np.array(sorted(s), np.int64) for s in nbr]

def taubin(P, strength, iterations, lam=0.5, mu=-0.53):
    active = np.where(strength > 0)[0]
    P = P.copy()
    for k in range(iterations * 2):
        f = lam if k % 2 == 0 else mu
        avg = np.array([P[nbr_idx[i]].mean(0) if len(nbr_idx[i]) else P[i] for i in active])
        P[active] += (strength[active] * f)[:, None] * (avg - P[active])
    return P

head_w = bone_weight(subtree('head'))
breast_w = bone_weight(['breast.L', 'breast.R'])
# Faces fully on the head are dropped (the egg replaces them); the neck below stays.
HEAD_CUT = 0.75
keep = ~(head_w[used][tris] > HEAD_CUT).all(axis=1)
arm_w = {s: bone_weight(subtree(f'upperarm01.{s}')) + 0.4 * bone_weight([f'shoulder01.{s}']) for s in 'LR'}
arm_any = np.clip(bone_weight(subtree('clavicle.L') + subtree('clavicle.R')), 0, 1)

def mannequin(P, P_ref):
    # Strengths come from the base shape only, so the operator is the same (linear) for every morph.
    # The face itself is dropped later and replaced by a smooth egg head; the jaw's underside that stays is pulled
    # into a round neck so it disappears inside the egg.
    neck_y = joint(P_ref, 'neck01____head')[1]
    ring = (np.abs(P_ref[:, 1] - (neck_y + 0.5)) < 0.25) & (head_w < 0.1) & (arm_any < 0.05)
    cx, cz = P_ref[ring, 0].mean(), P_ref[ring, 2].mean()
    rn = np.median(np.hypot(P_ref[ring, 0] - cx, P_ref[ring, 2] - cz))
    s = np.clip((head_w - 0.1) / 0.5, 0, 1)
    dx, dz = P[:, 0] - cx, P[:, 2] - cz
    r = np.hypot(dx, dz); r[r == 0] = 1
    k = 1 + s * (np.minimum(r, rn * 0.95) / r - 1)
    P = P.copy(); P[:, 0] = cx + dx * k; P[:, 2] = cz + dz * k
    P = taubin(P, np.clip((head_w - 0.05) / 0.5, 0, 1) * 0.8, 12)
    P = taubin(P, np.clip(breast_w * 4, 0, 1) * 0.95, 60)
    crotch = np.array([0, joint(P_ref, 'upperleg01.L____head')[1], 0])
    d = np.linalg.norm((P_ref - crotch) * np.array([1.0, 0.8, 1.2]), axis=1)
    P = taubin(P, np.clip(1 - d / 1.6, 0, 1) * (P_ref[:, 2] > -0.2), 30)
    return P

def pose(P, angle_deg):
    P = P.copy()
    for s, sign in (('L', 1), ('R', -1)):
        pivot = joint(P, f'upperarm01.{s}____head')
        a = np.clip(arm_w[s], 0, 1) * math.radians(angle_deg) * -sign
        x, y = P[:, 0] - pivot[0], P[:, 1] - pivot[1]
        c, sn = np.cos(a), np.sin(a)
        P[:, 0] = pivot[0] + c * x - sn * y; P[:, 1] = pivot[1] + sn * x + c * y
    return P

def hull_perimeter(pts):
    pts = sorted(map(tuple, pts))
    if len(pts) < 3: return 0.0
    cross = lambda o, a, b: (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0: hi.pop()
        hi.append(p)
    h = np.array(lo[:-1] + hi[:-1])
    return float(np.linalg.norm(h - np.roll(h, 1, 0), axis=1).sum())
# Arms (shoulder joint down) are left out of every tape ring; the chest next to the armpit stays in.
arm_only = np.clip(bone_weight(subtree('upperarm01.L') + subtree('upperarm01.R')), 0, 1)
torso = arm_only < 0.3
def circ(P, y, band=0.2):
    sel = torso & (np.abs(P[:, 1] - y) < band)
    return hull_perimeter(P[sel][:, [0, 2]]) * 10  # dm -> cm

# Mannequin head: a smooth egg (UV sphere) sized from the skull; the original face, ears and mouth are dropped.
def egg_axes(P):
    core = P[head_w > 0.97]
    lo, hi = np.percentile(core, 2, axis=0), np.percentile(core, 98, axis=0)
    return (lo + hi) / 2, (hi - lo) / 2 * np.array([0.92, 1.0, 0.9])
RINGS, SEGS = 28, 40
unit = []
for i in range(1, RINGS):
    th = math.pi * i / RINGS
    for j in range(SEGS): ph = 2 * math.pi * j / SEGS; unit.append((math.sin(th) * math.sin(ph), math.cos(th), math.sin(th) * math.cos(ph)))
unit = np.array(unit + [(0, 1, 0), (0, -1, 0)])
top, bottom = len(unit) - 2, len(unit) - 1
egg_tris = []
for i in range(RINGS - 2):
    for j in range(SEGS):
        a, b, c, d = i * SEGS + j, i * SEGS + (j + 1) % SEGS, (i + 1) * SEGS + j, (i + 1) * SEGS + (j + 1) % SEGS
        egg_tris += [[a, c, b], [b, c, d]]
for j in range(SEGS):
    egg_tris += [[top, j, (j + 1) % SEGS], [bottom, (RINGS - 2) * SEGS + (j + 1) % SEGS, (RINGS - 2) * SEGS + j]]
egg_tris = np.array(egg_tris)

MORPHS = {'weightMinus': 'universal-{s}-young-averagemuscle-minweight', 'weightPlus': 'universal-{s}-young-averagemuscle-maxweight',
          'bustIncr': 'measure-bust-circ-incr', 'bustDecr': 'measure-bust-circ-decr', 'waistIncr': 'measure-waist-circ-incr',
          'waistDecr': 'measure-waist-circ-decr', 'hipsIncr': 'measure-hips-circ-incr', 'hipsDecr': 'measure-hips-circ-decr'}
all_tris = np.vstack([tris[keep], egg_tris + len(used)]).astype(np.int32)
print('kept body tris', int(keep.sum()), 'of', len(tris), '+ egg', len(egg_tris))
meta = {'source': 'MakeHuman 1.1 base mesh hm08 and targets, CC0 1.0 (makehumancommunity/makehuman)', 'units': 'cm', 'sexes': {}}
for sex in ('male', 'female'):
    P0 = V.copy()
    for race in ('african', 'asian', 'caucasian'): P0 += read_target(f'{race}-{sex}-young', N) / 3
    shapes = {'base': P0}
    for k, name in MORPHS.items(): shapes[k] = P0 + read_target(name.format(s=sex), N)
    out = {k: pose(mannequin(P, P0), ARM_DEG) for k, P in shapes.items()}
    # The egg is sized and placed from the untouched head (the neck taper above squeezes the head vertices).
    raw = {k: pose(P, ARM_DEG) for k, P in shapes.items()}
    _, axes = egg_axes(raw['base'])
    eggs = {k: egg_axes(P)[0] + unit * axes for k, P in raw.items()}
    B = out['base']
    floor = B[used][:, 1].min()
    for k in out: out[k] = out[k] - np.array([0, floor, 0]); eggs[k] = eggs[k] - np.array([0, floor, 0])
    B = out['base']
    # measurement levels on the base body
    # Chest = the height of the most forward point of the chest (the bust on a woman, the pectorals on a man):
    # a tape goes round the fullest part there, not at the armpits.
    breast_y = (joint(B, 'breast.L____head')[1] + joint(B, 'breast.R____head')[1]) / 2
    front = torso & (breast_w > 0.25)
    idx = np.where(front)[0]; chest_y = float(B[idx[np.argmax(B[idx, 2])], 1])
    hipj = joint(B, 'upperleg01.L____head')[1]
    ys = np.linspace(hipj + 0.6, chest_y - 1.2, 40); waist_y = float(ys[np.argmin([circ(B, y) for y in ys])])
    ys = np.linspace(hipj - 0.9, hipj + 0.6, 30); hips_y = float(ys[np.argmax([circ(B, y) for y in ys])])
    levels = {'chest': float(chest_y), 'waist': waist_y, 'hips': hips_y}
    circs = {k: {m: round(circ(P, levels[m]), 2) for m in levels} for k, P in out.items()}
    height = float((B[used][:, 1].max() - B[used][:, 1].min()) * 10)
    print(sex, 'height cm', round(height, 1), 'levels', {k: round(v * 10, 1) for k, v in levels.items()}, 'base circ', circs['base'])
    for k in MORPHS: print('   ', k, {m: round(circs[k][m] - circs['base'][m], 1) for m in levels})
    np.save(f'{OUT}/{sex}-shapes.npy', np.stack([np.vstack([out[k][used], eggs[k]]) for k in ['base'] + list(MORPHS)]).astype(np.float32))
    meta['sexes'][sex] = {'height': height, 'levels': {k: v * 10 for k, v in levels.items()}, 'circ': circs, 'order': ['base'] + list(MORPHS)}
    # AO bake on the base body
    mesh = bpy.data.meshes.new(sex); mesh.from_pydata([tuple(p) for p in np.vstack([B[used], eggs['base']])], [], all_tris.tolist()); mesh.update()
    for p in mesh.polygons: p.use_smooth = True
    ob = bpy.data.objects.new(sex, mesh); bpy.context.scene.collection.objects.link(ob)
    attr = mesh.color_attributes.new('ao', 'FLOAT_COLOR', 'POINT'); mesh.color_attributes.active_color = attr
    for o in bpy.context.scene.objects: o.select_set(False)
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    sc = bpy.context.scene; sc.render.engine = 'CYCLES'; sc.cycles.samples = 96; sc.cycles.device = 'CPU'
    if sc.world is None: sc.world = bpy.data.worlds.new('w')
    sc.world.light_settings.distance = 2.5
    bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    ao = np.array([c.color[0] for c in attr.data], np.float32)
    np.save(f'{OUT}/{sex}-ao.npy', ao)
    print('   ao min/mean', ao.min(), ao.mean())
    bpy.data.objects.remove(ob)
np.save(f'{OUT}/tris.npy', all_tris)
np.save(f'{OUT}/torso.npy', np.concatenate([torso[used].astype(np.uint8), np.ones(len(unit), np.uint8)]))
json.dump(meta, open(f'{OUT}/meta.json', 'w'), indent=1)
