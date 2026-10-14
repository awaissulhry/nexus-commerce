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
   (young adult), with some muscle; morphs = MakeHuman's own min/max weight and bust/waist/hips circumference targets.
   Every shape gets the same store-mannequin treatment:
   - **Face**: the eye sockets and the inside of the mouth are cut out and closed. Then eyes, nose and mouth (brow to
     under the lower lip, temple to temple) give way to one smooth surface: a thin-plate spline fitted, on a cylinder
     round the head, to a band of 4 edge rings round that area, so it meets cheeks, brow and chin with their own slope.
     Skull, jaw and chin keep MakeHuman's shape; the chin gets a soft ball of smoothing (no cleft).
   - **Ears**: smoothed into simple shells. **Head**: smoothed, and 6% broader across (more at the jaw), as store
     mannequins are.
   - Chest and crotch smoothed, fingers closed, arms lowered 38° with the skeleton's weights.
   - **Arms never in the body**: a morph that widens the body also turns the arms out by its own small angle (male
     about 1°, female up to 3.75°). The angles are the smallest at which every mix of the widening morphs at their
     strongest use leaves every arm point at least 3 mm outside the torso. The web body does that turn itself
     (`applyShape`), so the morphs stay small.
   It finds the chest (fullest point of the bust area), waist (narrowest) and hips (widest) heights, and bakes ambient
   occlusion with Cycles.
2. `pack-body.mjs` (Node): simplifies with meshoptimizer to about 6,300 vertices and 12,500 triangles. The simplifier
   keeps original vertices, so every morph stays valid; it is told to keep the shading (normals) and the head's shape.
   Then it quantises and writes one module per body type (about 175 kB gzip each).

```sh
# assets: base.obj, t/*.target, rig/default.mhskel, rig/default_weights.mhw (downloaded from the repository above)
blender -b --factory-startup --python build_body.py -- <assets dir> <out dir>
MESHOPT=/path/to/meshoptimizer/index.module.js node pack-body.mjs <out dir> 0.5   # meshoptimizer 0.22
node --test ../../verification/fit-body.test.mjs
```
