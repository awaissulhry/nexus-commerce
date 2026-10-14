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

1. `build_body.py` (Blender, headless): body type = the three MakeHuman race targets of that sex mixed equally
   (young adult); morphs = MakeHuman's own min/max weight and bust/waist/hips circumference targets. Every shape gets
   the same mannequin treatment: the face, ears and mouth are replaced by a smooth egg head, the neck is rounded under
   it, the breasts and crotch are smoothed, and the arms are lowered 24° with the skeleton's weights. It finds the
   chest (fullest point of the bust area), waist (narrowest) and hips (widest) heights, and bakes ambient occlusion
   with Cycles.
2. `pack-body.mjs` (Node): simplifies with meshoptimizer (the simplifier keeps original vertices, so every morph stays
   valid), quantises, and writes one module per body type.

```sh
# assets: base.obj, t/*.target, rig/default.mhskel, rig/default_weights.mhw (downloaded from the repository above)
blender -b --factory-startup --python build_body.py -- <assets dir> <out dir> 24
MESHOPT=/path/to/meshoptimizer/index.module.js node pack-body.mjs <out dir> 0.45
node --test ../../verification/fit-body.test.mjs
```
