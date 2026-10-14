# The 3D mannequin bodies

`xavia-fit-body-male.js` and `xavia-fit-body-female.js` are generated. Do not edit them; rebuild them.

## Source and licence

Built from the MakeHuman 1.1 base mesh (`hm08`, `makehuman/data/3dobjs/base.obj`), its shape targets
(`targets/macrodetails/*`, `targets/measure/measure-{bust,waist,hips}-circ-{incr,decr}`) and the default skeleton and
weights (`rigs/default.mhskel`, `rigs/default_weights.mhw`) from github.com/makehumancommunity/makehuman.
The MakeHuman project released these assets under **CC0 1.0 Universal** ("anyone can do whatever they want with it";
LICENSE.md section C and LICENSE.ASSETS.md in that repository). No attribution is required; this note keeps the
source traceable.

## What the build does

1. `build_body.py` (Blender, headless). Body type = the three MakeHuman race targets of that sex mixed equally
   (young adult), lean muscle, and a store mannequin's figure from MakeHuman's own targets: ideal proportions, a flat
   toned stomach, a longer and slimmer neck, a slightly smaller head. Morphs = MakeHuman's min/max weight and
   bust/waist/hips circumference targets. Every shape gets the same treatment:
   - **Skin**: a light smoothing pass over the body (not hands, feet or head), a soft shallow navel, a feathered
     smoothing of the chest (no crease where it stops).
   - **Chest**: smoothing alone left MakeHuman's pec edges and the crease under them, which looked like a dented chest.
     So the chest is faired: the area becomes the smoothest surface (bi-Laplacian, cotangent weights) that meets the
     body round it in place and slope. Men: neck to 13 cm under the nipples, armpit to armpit; the pecs' outward form
     comes back on top, blurred over real distance (one implicit heat step), so they stay soft with no edge or crease.
     Women: 5.5 cm round each breast tip, so the breasts are round, not pointed. Each morph is faired on its own.
   - **Face**: the eye sockets and the inside of the mouth are cut out and closed. Then eyes, nose and mouth (brow to
     under the lower lip, temple to temple) give way to one smooth surface: a thin-plate spline fitted, on a cylinder
     round the head, to a band of 4 edge rings round that area, so it meets cheeks, brow and chin with their own slope.
     Skull, jaw and chin keep MakeHuman's shape; the chin gets a soft ball of smoothing (no cleft).
   - **Ears**: smoothed into simple shells. **Head**: smoothed, and 6% broader across (more at the jaw).
   - **Pose**: relaxed hands (each finger bends a little towards the palm), elbows straightened to a natural 12° bend
     (MakeHuman's rest forearm points about 45° forward), arms lowered up to 38°: less when the hands would come closer
     than 1.5 cm to the thighs or hips.
   - **Arms never in the body**: a morph that widens the body also turns the arms out by its own small angle. The
     angles are the smallest at which every mix of the widening morphs at their strongest use leaves every arm point at
     least 3 mm outside the torso. The web body does that turn itself (`applyShape`), so the morphs stay small.
   It finds the chest (fullest point of the bust area), waist (narrowest) and hips (widest) heights, and bakes ambient
   occlusion with Cycles.
2. `pack-body.mjs` (Node): simplifies with meshoptimizer to about 6,300 vertices and 12,500 triangles. The simplifier
   keeps original vertices, so every morph stays valid; it is told to keep the shading (normals) and the head's shape.
   Then it quantises and writes one module per body type (about 175 kB gzip each).

Assets (all from the repository above, `makehuman/data/`): `3dobjs/base.obj`; `rigs/default.mhskel`,
`rigs/default_weights.mhw`; into `t/` the targets `macrodetails/<race>-<sex>-young`,
`macrodetails/universal-<sex>-young-{averagemuscle-minweight,averagemuscle-maxweight,maxmuscle-averageweight}`,
`macrodetails/proportions/<sex>-young-{averagemuscle,maxmuscle}-averageweight-idealproportions`,
`measure/measure-{bust,waist,hips}-circ-{incr,decr}`, `measure/measure-neck-height-incr`,
`stomach/stomach-{pregnant-decr,tone-incr,navel-in}`, `neck/neck-scale-horiz-decr`, `head/head-scale-{vert,horiz,depth}-decr`
(file names without folders).

```sh
# assets: base.obj, t/*.target, rig/default.mhskel, rig/default_weights.mhw (downloaded from the repository above)
blender -b --factory-startup --python build_body.py -- <assets dir> <out dir>          # Blender 4 or later
MESHOPT=/path/to/meshoptimizer/index.module.js node pack-body.mjs <out dir> 0.5   # meshoptimizer 0.22
node --test ../../verification/fit-body.test.mjs
```
