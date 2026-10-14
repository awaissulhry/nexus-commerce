# Stage 1 of the mannequin build, run in Blender headless (see README.md here). MakeHuman 1.1 CC0 assets:
# sex base + muscle tone + shape targets -> store-mannequin treatment (smooth face keeping skull, jaw and chin; simple
# ears; smoothed crotch; the chest faired into one smooth surface; fingers closed; arms lowered) -> measurement heights
# and baked ambient occlusion -> numpy files for pack-body.mjs.
#   blender -b --factory-startup --python build_body.py -- <assets dir> <out dir> [arm angle, default 38]
import bpy, sys, os, json, math, numpy as np
argv = sys.argv[sys.argv.index('--') + 1:]
MH, OUT, ARM_DEG = argv[0], argv[1], float(argv[2]) if len(argv) > 2 else 38
os.makedirs(OUT, exist_ok=True)
MUSCLE = {'male': 0.45, 'female': 0.3}     # lean, athletic store mannequins
# A store mannequin's figure (MakeHuman targets, weights): ideal proportions (blended by muscle like the build), a flat
# toned stomach, a longer neck and a slightly smaller head.
FIGURE = {'idealproportions': 0.6, 'stomach-pregnant-decr': 1.0, 'stomach-tone-incr': 0.5, 'measure-neck-height-incr': 0.8,
          'neck-scale-horiz-decr': 0.25, 'head-scale-vert-decr': 0.25, 'head-scale-horiz-decr': 0.25, 'head-scale-depth-decr': 0.25}
SKIN_SMOOTH = int(os.environ.get('XFF_SKIN', 25))   # smoothing passes over the body (mannequin skin)
FINGER_CLOSE = 0.95                        # share of the gap to the middle finger that the other fingers close
THUMB_CLOSE = 0.8                          # share of the gap to the index finger that the thumb closes
CURL = (8, 15, 10)                         # relaxed hand: degrees each finger bends at its three joints
ELBOW = 12                                 # natural elbow bend left after straightening MakeHuman's forward forearm
HAND_GAP = 0.15                            # dm: the arm angle drops until the hands keep this far from thighs and hips

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

V, F = read_obj(f'{MH}/base.obj'); N = N_MAKEHUMAN = len(V)
skel = json.load(open(f'{MH}/rig/default.mhskel')); W = json.load(open(f'{MH}/rig/default_weights.mhw'))['weights']
bones = skel['bones']; kids = {}
for b, v in bones.items(): kids.setdefault(v['parent'], []).append(b)
def subtree(b): return [b] + [x for c in kids.get(b, []) for x in subtree(c)]
def bone_weight(names):
    w = np.zeros(N_MAKEHUMAN)
    for b in names:
        for v, x in W.get(b, []): w[v] += x
    return np.clip(w, 0, 1)
joint = lambda P, name: P[skel['joints'][name]].mean(0)

def face_mask(P_ref, head_w):
    # Eyes to chin, between the ears (0..1), plus the lips: the part of the head a store mannequin has smooth.
    hc = joint(P_ref, 'head____head')
    eyes = (joint(P_ref, 'eye.L____head') + joint(P_ref, 'eye.R____head')) / 2
    centre = eyes - np.array([0, 0.38, 0])
    d = (P_ref - centre) * np.array([1 / 0.6, 1 / 1.05, 1 / 0.9])
    face = np.clip(1.25 - np.linalg.norm(d * np.array([1, 1, 0.6]), axis=1), 0, 1) * (P_ref[:, 2] > hc[2] - 0.15) * (head_w > 0.5)
    band = (head_w > 0.5) & (np.abs(P_ref[:, 0] - hc[0]) < 0.3) & (P_ref[:, 1] < eyes[1] - 0.5) & (P_ref[:, 1] > eyes[1] - 1.05)
    lips = np.where(band)[0]; lips = lips[np.argsort(P_ref[lips, 2])[-12:]]
    mouth = P_ref[lips].mean(0)
    mm = np.clip(1.4 - np.linalg.norm((P_ref - mouth) * np.array([1 / 0.42, 1 / 0.26, 1 / 0.7]), axis=1), 0, 1) * (head_w > 0.3)
    return np.maximum(face, mm)
def head_shell(P_ref, head_w):
    # Ellipsoid fitted to the head without the ears (finds the ear flaps).
    hc = joint(P_ref, 'head____head')
    core = P_ref[(head_w > 0.97) & (np.abs(P_ref[:, 0] - hc[0]) < 0.62)]
    lo, hi = np.percentile(core, 1, axis=0), np.percentile(core, 99, axis=0)
    c, ax = (lo + hi) / 2, (hi - lo) / 2
    return c - np.array([0, 0, ax[2] * 0.08]), ax

# Mannequin face, step 1 (shape of the mesh): cut out the eye sockets and the inside of the mouth (the parts that
# lie well inside the head's smooth shell), and close each opening with a fan of new triangles round a new vertex.
# New vertices take the average of their opening's rim for every shape, weight and flag.
# A pocket point is one the outside cannot see: of 64 rays cast from it over the whole sphere, almost all hit the head.
from mathutils import Vector
from mathutils.bvhtree import BVHTree
head_w0 = bone_weight(subtree('head'))
tree = BVHTree.FromPolygons([tuple(v) for v in V], F)
golden = np.pi * (3 - np.sqrt(5))
rays = [Vector((math.cos(golden * i) * math.sqrt(1 - (1 - 2 * (i + 0.5) / 64) ** 2), 1 - 2 * (i + 0.5) / 64, math.sin(golden * i) * math.sqrt(1 - (1 - 2 * (i + 0.5) / 64) ** 2))) for i in range(64)]
region = np.where(face_mask(V, head_w0) > 0.05)[0]
escape = np.ones(len(V))
for v in region:
    o = Vector(V[v]); free = 0
    for r in rays:
        hit = tree.ray_cast(o + r * 0.004, r, 3.0)
        if hit[0] is None: free += 1
    escape[v] = free / 64
pocket = escape < float(os.environ.get('XFF_POCKET', 0.12))
print('escape quantiles in the face', np.round(np.percentile(escape[region], [1, 5, 10, 25, 50]), 3))
F = [f for f in F if not any(pocket[i] for i in f)]
directed = {(f[i], f[(i + 1) % len(f)]) for f in F for i in range(len(f))}
following = {a: b for a, b in directed if (b, a) not in directed}
loops, seen = [], set()
for start in following:
    if start in seen: continue
    loop, v = [], start
    while v not in seen:
        seen.add(v); loop.append(v); v = following[v]
    loops.append(loop)
# Each opening is filled with rings of small quads (2 rings) and a small fan in the middle, so the patch stays smooth
# under the face smoothing. A new vertex = a fixed mix of one rim vertex and the opening's centre.
blends = []   # per new vertex: (rim index or None, share of the centre)
RINGS_IN = (1 / 3, 2 / 3)
for loop in loops:
    k = len(loop)
    ring_ids = [loop]
    for t in RINGS_IN:
        ring_ids.append([N + len(blends) + i for i in range(k)])
        blends += [(loop[i], t, tuple(loop)) for i in range(k)]
    centre = N + len(blends); blends.append((None, 1.0, tuple(loop)))
    for outer, inner in zip(ring_ids, ring_ids[1:]):
        F += [[outer[(i + 1) % k], outer[i], inner[i], inner[(i + 1) % k]] for i in range(k)]
    F += [[ring_ids[-1][(i + 1) % k], ring_ids[-1][i], centre] for i in range(k)]
print('face pockets: vertices', int(pocket.sum()), 'openings closed', len(loops), [len(l) for l in loops], 'new vertices', len(blends))
def extend(a):
    rows = [(1 - t) * a[rim] + t * a[list(loop)].mean(0) if rim is not None else a[list(loop)].mean(0) for rim, t, loop in blends]
    return np.concatenate([a, np.array(rows)]) if rows else a
_bone_weight, _read_target = bone_weight, read_target
bone_weight = lambda names: extend(_bone_weight(names))
read_target = lambda name, n: extend(_read_target(name, N_MAKEHUMAN))
V = extend(V); N = len(V)

used = sorted({i for f in F for i in f}); remap = {v: i for i, v in enumerate(used)}
tris = []
for f in F:
    f = [remap[i] for i in f]
    tris += [[f[0], f[1], f[2]]] + ([[f[0], f[2], f[3]]] if len(f) == 4 else [])
tris = np.array(tris, np.int32)
nbr = [set() for _ in range(N)]
for f in F:
    for i in range(len(f)): nbr[f[i]].update((f[i - 1], f[(i + 1) % len(f)]))
nbr_idx = [np.array(sorted(s), np.int64) for s in nbr]

def smooth(P, strength, iterations, lam=0.5, mu=None):
    # Laplacian smoothing (mu=None) or Taubin smoothing (lam, mu): keeps volume, removes detail.
    active = np.array([i for i in np.where(strength > 0)[0] if len(nbr_idx[i])], np.int64)
    P = P.copy()
    for k in range(iterations * (2 if mu else 1)):
        f = lam if (mu is None or k % 2 == 0) else mu
        avg = np.array([P[nbr_idx[i]].mean(0) for i in active])
        P[active] += (strength[active] * f)[:, None] * (avg - P[active])
    return P

head_w = bone_weight(subtree('head'))
breast_w = bone_weight(['breast.L', 'breast.R'])
arm_w = {s: bone_weight(subtree(f'upperarm01.{s}')) + 0.4 * bone_weight([f'shoulder01.{s}']) for s in 'LR'}
arm_side = {s: np.clip(arm_w[s], 0, 1) for s in 'LR'}   # share of each vertex in each arm's turn
arm_only = np.clip(bone_weight(subtree('upperarm01.L') + subtree('upperarm01.R')), 0, 1)
torso = arm_only < 0.3   # arms (shoulder joint down) are left out of every tape ring

def face_frame(P_ref):
    # Face landmarks: head joint, eye midpoint, half the distance between the eyes, mouth (most forward lip points).
    hc = joint(P_ref, 'head____head')
    eL, eR = joint(P_ref, 'eye.L____head'), joint(P_ref, 'eye.R____head')
    eyes = (eL + eR) / 2
    band = (head_w > 0.5) & (np.abs(P_ref[:, 0] - hc[0]) < 0.3) & (P_ref[:, 1] < eyes[1] - 0.5) & (P_ref[:, 1] > eyes[1] - 1.05)
    lips = np.where(band)[0]; lips = lips[np.argsort(P_ref[lips, 2])[-12:]]
    return hc, eyes, abs(eL[0] - eR[0]) / 2, P_ref[lips].mean(0)
def inner_face(P_ref):
    # Brow to under the lower lip, temple to temple, front of the head only: eyes, nose and mouth (units: dm).
    hc, eyes, half, mouth = face_frame(P_ref)
    top, bottom = eyes[1] + 0.45, mouth[1] - 0.3
    u = (P_ref[:, 0] - eyes[0]) / (half + 0.35); v = (P_ref[:, 1] - (top + bottom) / 2) / ((top - bottom) / 2)
    return (u ** 4 + v ** 4 < 1) & (P_ref[:, 2] > hc[2] + 0.1) & (head_w > 0.5)
_fill = {}
def fill_face(P, P_ref):
    # The inner face gets a new smooth surface, in coordinates on a cylinder round the head's vertical axis (s = arc
    # length, y = height, r = distance from the axis). r over (s, y) is a thin-plate spline fitted to the mesh in a
    # band of 4 edge rings round the region, so the new surface meets the cheeks, brow and chin with their slope.
    # The region's points are spread evenly over (s, y) (Tutte layout: each point at the mean of its neighbours).
    if not _fill:
        hc = joint(P_ref, 'head____head')
        I = np.array([v for v in np.where(inner_face(P_ref))[0] if len(nbr_idx[v])])
        seen, front, bands = set(I.tolist()), set(I.tolist()), []
        for _ in range(4):
            front = {int(n) for v in front for n in nbr_idx[v]} - seen
            seen |= front; bands.append(front)
        rim, band = np.array(sorted(bands[0])), np.array(sorted(set().union(*bands)))
        col, rcol = {v: i for i, v in enumerate(I)}, {v: i for i, v in enumerate(rim)}
        L, Lr = np.eye(len(I)), np.zeros((len(I), len(rim)))
        for i, v in enumerate(I):
            for n in nbr_idx[v]:
                n = int(n)
                if n in col: L[i, col[n]] -= 1 / len(nbr_idx[v])
                else: Lr[i, rcol[n]] += 1 / len(nbr_idx[v])
        axis = np.array([hc[0], hc[2]])
        _fill.update(I=I, rim=rim, band=band, layout=np.linalg.solve(L, Lr), axis=axis, r0=np.linalg.norm(P_ref[I][:, [0, 2]] - axis, axis=1).mean())
    f = _fill
    s = np.arctan2(P[:, 0] - f['axis'][0], P[:, 2] - f['axis'][1]) * f['r0']
    r = np.linalg.norm(P[:, [0, 2]] - f['axis'], axis=1)
    tps = lambda a, b: (lambda d: np.where(d > 0, d * d * np.log(np.maximum(d, 1e-12)), 0))(np.linalg.norm(a[:, None] - b[None], axis=2))
    pts = np.stack([s[f['band']], P[f['band'], 1]], 1); n = len(pts)
    A = np.zeros((n + 3, n + 3)); A[:n, :n] = tps(pts, pts) + np.eye(n) * 1e-3
    A[:n, n:] = np.concatenate([np.ones((n, 1)), pts], 1); A[n:, :n] = A[:n, n:].T
    sol = np.linalg.solve(A, np.concatenate([r[f['band']], np.zeros(3)]))
    uv = f['layout'] @ np.stack([s[f['rim']], P[f['rim'], 1]], 1)
    rq = tps(uv, pts) @ sol[:n] + sol[n] + uv @ sol[n + 1:]
    P = P.copy(); th = uv[:, 0] / f['r0']
    P[f['I'], 0] = f['axis'][0] + rq * np.sin(th); P[f['I'], 1] = uv[:, 1]; P[f['I'], 2] = f['axis'][1] + rq * np.cos(th)
    return P
def ears(P_ref):
    # The ear flaps (head points well outside the head's smooth shell, at the sides), with a soft ball round each.
    c, ax = head_shell(P_ref, head_w)
    flap = (np.linalg.norm((P_ref - c) / ax, axis=1) > 1.04) & (np.abs(P_ref[:, 0] - c[0]) > ax[0] * 0.7) & (head_w > 0.5)
    out = np.zeros(len(P_ref))
    for side in (flap & (P_ref[:, 0] > c[0]), flap & (P_ref[:, 0] < c[0])):
        if side.any(): out = np.maximum(out, np.clip(1.3 - np.linalg.norm(P_ref - P_ref[side].mean(0), axis=1) / 0.42, 0, 1))
    return np.clip(out, 0, 1) * (head_w > 0.3)
def mannequin_face(P, P_ref):
    # Store-mannequin head: eyes, nose and mouth give way to one smooth surface (skull, jaw and chin keep their own
    # shape), the chin is rounded, the ears become simple smooth shells, the head is smoothed, and it is widened a little, more at the
    # jaw (a store mannequin's head is broader than a real one), fading out down the neck.
    P = fill_face(P, P_ref)
    # The chin's own cleft and the fill's lower edge meet in the chin: a soft ball of smoothing there.
    _, eyes, _, mouth = face_frame(P_ref)
    near = (head_w > 0.5) & (np.abs(P_ref[:, 0] - eyes[0]) < 0.15) & (P_ref[:, 1] < mouth[1] - 0.25) & (P_ref[:, 1] > mouth[1] - 0.7)
    chin = P_ref[np.where(near)[0][np.argmax(P_ref[near, 2])]] * [0, 1, 1] + [eyes[0], 0, 0]
    ball = np.clip(1.2 - np.linalg.norm((P_ref - chin) * [1, 1, 0.7], axis=1) / 0.4, 0, 1) * (head_w > 0.3)
    P = smooth(P, ball, 60, 0.5, -0.53)
    P = smooth(P, ears(P_ref) * 0.9, 40, 0.5)
    P = smooth(P, np.clip(head_w * 1.2 - 0.2, 0, 1) * 0.7, 30, 0.5, -0.53)
    hc = joint(P_ref, 'head____head')
    wide = np.clip((head_w - 0.2) / 0.6, 0, 1) * (1 + 1.2 * np.clip((hc[1] + 0.3 - P_ref[:, 1]) / 0.8, 0, 1))
    P = P.copy(); P[:, 0] = hc[0] + (P[:, 0] - hc[0]) * (1 + 0.06 * wide)
    return P

navel = np.where(np.abs(read_target('stomach-navel-in', N)).sum(1) > 0)[0]
def feather(mask, passes):
    # Blurs a 0..1 mask over the mesh, so smoothing fades out gently instead of leaving a crease at its edge.
    for _ in range(passes):
        mask = np.array([0.5 * mask[i] + 0.5 * mask[nbr_idx[i]].mean() if len(nbr_idx[i]) else mask[i] for i in range(len(mask))])
    return mask
chest_mask = feather(np.clip(breast_w * 3, 0, 1), 30)
TRI = np.array([[f[0], f[1], f[2]] for f in F] + [[f[0], f[2], f[3]] for f in F if len(f) == 4])
has_nbr = np.array([len(n) > 0 for n in nbr_idx])
def chest_region(P_ref):
    # The male chest: between the armpits, from the neck to 13 cm under the nipples (a rounded box), front only, arms and
    # head left out.
    nl, nr = joint(P_ref, 'breast.L____tail'), joint(P_ref, 'breast.R____tail')
    c = (nl + nr) / 2; hx = abs(nl[0] - nr[0]) / 2
    top, bot = joint(P_ref, 'neck01____head')[1] + 0.1, c[1] - 1.3
    e = np.abs((P_ref[:, 0] - c[0]) / (2 * hx)) ** 3 + np.abs((P_ref[:, 1] - (top + bot) / 2) / ((top - bot) / 2)) ** 3
    return (e < 1) & (P_ref[:, 2] > joint(P_ref, 'spine03____head')[2]) & (arm_only < 0.25) & (head_w < 0.01) & has_nbr
def breast_tips(P_ref):
    # The female breast tips: 5.5 cm round each nipple, front only.
    d = np.min([np.linalg.norm(P_ref - joint(P_ref, f'breast.{s}____tail'), axis=1) for s in 'LR'], 0)
    return (d < 0.55) & (P_ref[:, 2] > joint(P_ref, 'spine03____head')[2]) & has_nbr
def fair_op(R, P):
    # Bi-Laplacian fairing with cotangent weights (so small dense patches like the nipples do not become spikes): the
    # points in R become the smoothest surface that meets the fixed points round them in place and slope. Returns the
    # region, the fixed points, M (region = M @ fixed points) and the region's cotangent matrix and areas (for blur()).
    p0, p1, p2 = P[TRI[:, 0]], P[TRI[:, 1]], P[TRI[:, 2]]
    cot = lambda u, v: (u * v).sum(1) / np.maximum(np.linalg.norm(np.cross(u, v), axis=1), 1e-12)
    mass = np.zeros(len(P)); np.add.at(mass, TRI.ravel(), np.repeat(np.linalg.norm(np.cross(p1 - p0, p2 - p0), axis=1) / 6, 3))
    C = {}
    for ii, jj, w in ((TRI[:, 1], TRI[:, 2], cot(p1 - p0, p2 - p0)), (TRI[:, 0], TRI[:, 2], cot(p0 - p1, p2 - p1)),
                      (TRI[:, 0], TRI[:, 1], cot(p0 - p2, p1 - p2))):
        for i, j, x in zip(ii.tolist(), jj.tolist(), (w / 2).tolist()):
            for u, v, y in ((i, j, x), (j, i, x), (i, i, -x), (j, j, -x)):
                d = C.setdefault(u, {}); d[v] = d.get(v, 0) + y
    idx = np.where(R)[0]; pos = {int(v): k for k, v in enumerate(idx)}
    A, CR, ext = np.zeros((len(idx), len(idx))), np.zeros((len(idx), len(idx))), {}
    for r, i in enumerate(idx):
        row = {}
        for j, a in C[int(i)].items():
            if j in pos: CR[r, pos[j]] = a
            for k, b in C[j].items(): row[k] = row.get(k, 0) + a * b / mass[j]
        for k, val in row.items():
            if k in pos: A[r, pos[k]] += val
            else: ext.setdefault(k, []).append((r, val))
    fixed = np.array(sorted(ext)); Ex = np.zeros((len(idx), len(fixed)))
    for c, k in enumerate(fixed):
        for r, val in ext[k]: Ex[r, c] += val
    return idx, fixed, -np.linalg.solve(A, Ex), CR, mass[idx]
def chest_fill(P, idx, fixed, M, blur=None):
    # The region becomes the fair surface. With blur (a matrix), the chest's outward form above that surface (along its
    # normal) comes back blurred: the pecs stay, their edges and the creases and valleys round them go.
    Pf = P.copy(); Pf[idx] = M @ P[fixed]
    if blur is None: return Pf
    fn = np.cross(Pf[TRI[:, 1]] - Pf[TRI[:, 0]], Pf[TRI[:, 2]] - Pf[TRI[:, 0]]); vn = np.zeros_like(P)
    for c in range(3): np.add.at(vn, TRI[:, c], fn)
    vn = vn[idx] / np.maximum(np.linalg.norm(vn[idx], axis=1, keepdims=True), 1e-12)
    Pf[idx] += blur @ (np.maximum(((P[idx] - Pf[idx]) * vn).sum(1), 0)[:, None] * vn)
    return Pf
hands_feet = np.clip(bone_weight(subtree('wrist.L') + subtree('wrist.R') + subtree('foot.L') + subtree('foot.R')) * 2, 0, 1)
def mannequin(P, P_ref):
    # A mannequin's skin is smoother than a person's: a light pass over the body (not hands, feet or head), then the face,
    # chest and crotch.
    P = smooth(P, (1 - hands_feet) * (1 - np.clip(head_w * 2, 0, 1)) * 0.8, SKIN_SMOOTH, 0.5, -0.53)
    # The navel: a soft shallow dimple, as on store mannequins (the points MakeHuman's navel target moves, and round them).
    ball = np.clip(1.3 - np.linalg.norm(P_ref - P_ref[navel].mean(0), axis=1) / 0.3, 0, 1)
    P = smooth(P, ball, 40, 0.5, -0.53)
    P = mannequin_face(P, P_ref)
    P = smooth(P, chest_mask, 60, 0.5, -0.53)
    crotch = np.array([0, joint(P_ref, 'upperleg01.L____head')[1], 0])
    d = np.linalg.norm((P_ref - crotch) * np.array([1.0, 0.8, 1.2]), axis=1)
    return smooth(P, np.clip(1 - d / 1.6, 0, 1) * (P_ref[:, 2] > -0.2), 30, 0.5, -0.53)

def rotate_about(P, pivot, axis, angles):
    # Rodrigues rotation of every vertex about axis through pivot, by its own angle (radians, per vertex).
    axis = axis / np.linalg.norm(axis); v = P - pivot
    c, s = np.cos(angles)[:, None], np.sin(angles)[:, None]
    return pivot + v * c + np.cross(axis, v) * s + axis * (v @ axis)[:, None] * (1 - c)

def pose(P, arm_deg=ARM_DEG):
    P = P.copy()
    for side, sign in (('L', 1), ('R', -1)):
        # A relaxed hand: each finger bends a little at its three joints, towards the palm. The palm side is the
        # side of the knuckle line the thumb is on.
        knuckles = joint(P, f'finger2-1.{side}____head') - joint(P, f'finger5-1.{side}____head')
        mid = (joint(P, f'finger2-1.{side}____head') + joint(P, f'finger5-1.{side}____head')) / 2
        palm = np.cross(joint(P, f'finger3-3.{side}____tail') - joint(P, f'finger3-1.{side}____head'), knuckles)
        if (joint(P, f'finger1-3.{side}____tail') - mid) @ palm < 0: palm = -palm
        for k in (2, 3, 4, 5):
            for j, deg in zip((1, 2, 3), CURL):
                pivot, tip = joint(P, f'finger{k}-{j}.{side}____head'), joint(P, f'finger{k}-3.{side}____tail')
                axis = knuckles / np.linalg.norm(knuckles)
                if (rotate_about(tip[None], pivot, axis, np.array([0.05]))[0] - tip) @ palm < 0: axis = -axis
                P = rotate_about(P, pivot, axis, bone_weight(subtree(f'finger{k}-{j}.{side}')) * math.radians(deg))
        # MakeHuman's rest forearm points about 45 degrees forward: straighten the elbow to a natural slight bend, so
        # the hands hang beside the thighs, not in front of the hips.
        el = joint(P, f'lowerarm01.{side}____head')
        u, f = el - joint(P, f'upperarm01.{side}____head'), joint(P, f'wrist.{side}____head') - el
        ang = math.acos(np.clip(u @ f / np.linalg.norm(u) / np.linalg.norm(f), -1, 1))
        P = rotate_about(P, el, np.cross(f, u), bone_weight(subtree(f'lowerarm01.{side}')) * max(0.0, ang - math.radians(ELBOW)))
        # Fingers together: each finger turns towards the middle finger about its own knuckle.
        tip = lambda k: joint(P, f'finger{k}-3.{side}____tail') - joint(P, f'finger{k}-1.{side}____head')
        middle = tip(3)
        for k in (2, 4, 5):
            base, direction = joint(P, f'finger{k}-1.{side}____head'), tip(k)
            axis = np.cross(direction, middle)
            if np.linalg.norm(axis) < 1e-6: continue
            gap = math.acos(np.clip(direction @ middle / np.linalg.norm(direction) / np.linalg.norm(middle), -1, 1))
            P = rotate_about(P, base, axis, bone_weight(subtree(f'finger{k}-1.{side}')) * gap * FINGER_CLOSE)
        # The thumb in, along the index finger (MakeHuman's rest hand holds it out at a right angle).
        base, thumb, index = joint(P, f'finger1-1.{side}____head'), tip(1), tip(2)
        axis = np.cross(thumb, index)
        gap = math.acos(np.clip(thumb @ index / np.linalg.norm(thumb) / np.linalg.norm(index), -1, 1))
        P = rotate_about(P, base, axis, bone_weight(subtree(f'finger1-1.{side}')) * gap * THUMB_CLOSE)
        # Arms down from MakeHuman's A pose, about the shoulder joint, in the front plane.
        pivot = joint(P, f'upperarm01.{side}____head')
        a = arm_side[side] * math.radians(arm_deg) * -sign
        x, y = P[:, 0] - pivot[0], P[:, 1] - pivot[1]
        c, sn = np.cos(a), np.sin(a)
        P[:, 0] = pivot[0] + c * x - sn * y; P[:, 1] = pivot[1] + sn * x + c * y
    return P

def arm_depth(P):
    # How far the arm or hand point closest to the skin of the torso, hips or thighs is under that skin (dm; minus =
    # still outside by that much). The nearest body point's normal says which side of the skin an arm point is on.
    Q = P[used]; t = torso[used]
    a, b, c = Q[tris[:, 0]], Q[tris[:, 1]], Q[tris[:, 2]]
    vn = np.zeros_like(Q)
    for i in range(3): np.add.at(vn, tris[:, i], np.cross(b - a, c - a))
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
    lo, hi = Q[:, 1].min(), Q[:, 1].max()
    body = np.where(t & (Q[:, 1] > lo + 0.35 * (hi - lo)) & (Q[:, 1] < lo + 0.62 * (hi - lo)))[0]
    worst = -0.4
    for part in np.array_split(np.where(~t)[0], 24):
        d = np.linalg.norm(Q[part][:, None] - Q[body][None], axis=2)
        j = body[np.argmin(d, axis=1)]
        depth = np.einsum('ij,ij->i', Q[part] - Q[j], vn[j])
        close = d.min(axis=1) < 0.4
        if close.any(): worst = max(worst, -depth[close].min())
    return worst

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
def circ(P, y, band=0.2):
    sel = torso & (np.abs(P[:, 1] - y) < band)
    return hull_perimeter(P[sel][:, [0, 2]]) * 10  # dm -> cm

MORPHS = {'weightMinus': 'universal-{s}-young-averagemuscle-minweight', 'weightPlus': 'universal-{s}-young-averagemuscle-maxweight',
          'bustIncr': 'measure-bust-circ-incr', 'bustDecr': 'measure-bust-circ-decr', 'waistIncr': 'measure-waist-circ-incr',
          'waistDecr': 'measure-waist-circ-decr', 'hipsIncr': 'measure-hips-circ-incr', 'hipsDecr': 'measure-hips-circ-decr'}
meta = {'source': 'MakeHuman 1.1 base mesh hm08 and targets, CC0 1.0 (makehumancommunity/makehuman)', 'units': 'cm', 'sexes': {}}
for sex in ('male', 'female'):
    P0 = V.copy()
    for race in ('african', 'asian', 'caucasian'): P0 += read_target(f'{race}-{sex}-young', N) / 3
    P0 += read_target(f'universal-{sex}-young-maxmuscle-averageweight', N) * MUSCLE[sex]
    for name, w in FIGURE.items():
        if name == 'idealproportions':
            P0 += w * ((1 - MUSCLE[sex]) * read_target(f'{sex}-young-averagemuscle-averageweight-idealproportions', N)
                       + MUSCLE[sex] * read_target(f'{sex}-young-maxmuscle-averageweight-idealproportions', N))
        else:
            P0 += w * read_target(name, N)
    shapes = {'base': P0}
    for k, name in MORPHS.items(): shapes[k] = P0 + read_target(name.format(s=sex), N)
    smooth_shapes = {k: mannequin(P, P0) for k, P in shapes.items()}
    # The chest becomes one smooth surface: MakeHuman's pec edges and the crease under them read as a dented chest on the
    # web body. Men keep their pecs' outward form, softly; women's breast tips are rounded. Every shape gets the same
    # treatment, so the morphs keep their own chest change.
    idx, fixed, M, CR, mR = fair_op(chest_region(P0) if sex == 'male' else breast_tips(P0), smooth_shapes['base'])
    blur = np.linalg.inv(np.diag(mR) - 0.08 * CR) * mR if sex == 'male' else None   # one implicit heat step: a blur in real distance
    smooth_shapes = {k: chest_fill(P, idx, fixed, M, blur) for k, P in smooth_shapes.items()}
    # The arm angle: ARM_DEG, or less when the hands would come closer than HAND_GAP to the thighs or hips.
    arm_deg = ARM_DEG
    while arm_deg > 20 and arm_depth(pose(smooth_shapes['base'], arm_deg)) > -HAND_GAP: arm_deg -= 0.5
    out = {k: pose(P, arm_deg) for k, P in smooth_shapes.items()}
    # A morph that widens the body also turns the arms out, by its own extra angle. The web body does that turn itself
    # (xavia-fit-body.js applyShape: about the shoulder joints, by the mix of the morphs' angles), so the morphs stay
    # small; turn_arms() here is the same calculation. Every mix of the widening morphs at their strongest use
    # (weight 1.4, circumferences 2.5) must keep every arm point at least 3 mm outside the torso (the simplified web
    # body differs a little): while a mix fails, each morph in it turns the arms out a quarter degree more.
    pivot = {k: {s: joint(P, f'upperarm01.{s}____head')[:2] for s in 'LR'} for k, P in smooth_shapes.items()}
    def turn_arms(P, weights, turn):
        total = math.radians(sum(w * turn.get(k, 0) for k, w in weights.items()))
        if not total: return P
        P = P.copy()
        for s, sign in (('L', 1), ('R', -1)):
            piv = pivot['base'][s] + sum(w * (pivot[k][s] - pivot['base'][s]) for k, w in weights.items())
            a = arm_side[s] * total * -sign
            x, y = P[:, 0] - piv[0], P[:, 1] - piv[1]; c, sn = np.cos(a), np.sin(a)
            P[:, 0] = piv[0] + c * x - sn * y; P[:, 1] = piv[1] + sn * x + c * y
        return P
    mix = lambda weights, turn: turn_arms(out['base'] + sum(w * (out[k] - out['base']) for k, w in weights.items()), weights, turn)
    from itertools import combinations
    STRONGEST = {'weightPlus': 1.4, 'bustIncr': 2.5, 'waistIncr': 2.5, 'hipsIncr': 2.5}
    turn = {k: 0.0 for k in STRONGEST}
    mixes = [m for n in range(1, 5) for m in combinations(STRONGEST, n)]
    for _ in range(80):
        failing = [m for m in mixes if arm_depth(mix({k: STRONGEST[k] for k in m}, turn)) > -0.03]
        if not failing: break
        for k in set().union(*failing): turn[k] -= 0.25
    else:
        raise SystemExit(f'{sex}: arms still inside the body for {failing}')
    print(sex, 'arm angle', arm_deg, '| extra arm turn (degrees)', turn, '| base body: arm clearance (cm)', round(-10 * arm_depth(out['base']), 2))
    floor = out['base'][used][:, 1].min()
    for k in out: out[k] = out[k] - np.array([0, floor, 0])
    B = out['base']
    # Chest = the height of the most forward point of the chest (the bust on a woman, the pectorals on a man):
    # a tape goes round the fullest part there, not at the armpits.
    front = np.where(torso & (breast_w > 0.25))[0]
    chest_y = float(B[front[np.argmax(B[front, 2])], 1])
    hipj = joint(B, 'upperleg01.L____head')[1]
    ys = np.linspace(hipj + 0.6, chest_y - 1.2, 40); waist_y = float(ys[np.argmin([circ(B, y) for y in ys])])
    ys = np.linspace(hipj - 0.9, hipj + 0.6, 30); hips_y = float(ys[np.argmax([circ(B, y) for y in ys])])
    levels = {'chest': chest_y, 'waist': waist_y, 'hips': hips_y}
    circs = {k: {m: round(circ(P, levels[m]), 2) for m in levels} for k, P in out.items()}
    height = float((B[used][:, 1].max() - B[used][:, 1].min()) * 10)
    print(sex, 'height cm', round(height, 1), 'levels', {k: round(v * 10, 1) for k, v in levels.items()}, 'base circ', circs['base'])
    np.save(f'{OUT}/{sex}-shapes.npy', np.stack([out[k][used] for k in ['base'] + list(MORPHS)]).astype(np.float32))
    # Smooth normals of the full-detail body: the web body is simplified, and keeps these for its shading.
    Bu = B[used]; a, b, c = Bu[tris[:, 0]], Bu[tris[:, 1]], Bu[tris[:, 2]]
    fn = np.cross(b - a, c - a); vn = np.zeros_like(Bu)
    for i in range(3): np.add.at(vn, tris[:, i], fn)
    np.save(f'{OUT}/{sex}-normals.npy', (vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)).astype(np.float32))
    meta['sexes'][sex] = {'height': height, 'levels': {k: v * 10 for k, v in levels.items()}, 'circ': circs, 'order': ['base'] + list(MORPHS),
                          'arm': {'turn': turn, 'pivot': {k: {sd: [float(v[0]) * 10, float(v[1] - floor) * 10] for sd, v in pv.items()} for k, pv in pivot.items()}}}
    # Ambient occlusion baked on the base body.
    mesh = bpy.data.meshes.new(sex); mesh.from_pydata([tuple(p) for p in B[used]], [], tris.tolist()); mesh.update()
    for p in mesh.polygons: p.use_smooth = True
    ob = bpy.data.objects.new(sex, mesh); bpy.context.scene.collection.objects.link(ob)
    attr = mesh.color_attributes.new('ao', 'FLOAT_COLOR', 'POINT'); mesh.color_attributes.active_color = attr
    for o in bpy.context.scene.objects: o.select_set(False)
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    for o in list(bpy.context.scene.objects):
        if o.type == 'MESH' and o is not ob: bpy.data.objects.remove(o)
    sc = bpy.context.scene; sc.render.engine = 'CYCLES'; sc.cycles.samples = 96; sc.cycles.device = 'CPU'
    if sc.world is None: sc.world = bpy.data.worlds.new('w')
    sc.world.light_settings.distance = 2.5
    bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    ao = np.array([c.color[0] for c in attr.data], np.float32)
    np.save(f'{OUT}/{sex}-ao.npy', ao.astype(np.float32))
    bpy.data.objects.remove(ob)
np.save(f'{OUT}/tris.npy', tris)
np.save(f'{OUT}/torso.npy', torso[used].astype(np.uint8))
np.save(f'{OUT}/arm.npy', np.stack([arm_side['L'][used], arm_side['R'][used]]).astype(np.float32))
json.dump(meta, open(f'{OUT}/meta.json', 'w'), indent=1)
