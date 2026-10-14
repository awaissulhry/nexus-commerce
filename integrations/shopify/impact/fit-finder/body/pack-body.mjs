// Stage 2 of the mannequin build: simplifies the Blender output (build_body.py) and packs one small JS module per
// body type, theme assets xavia-fit-body-male.js / xavia-fit-body-female.js.
//   node pack-body.mjs <blender out dir> <target triangle ratio, e.g. 0.5>
// Needs the meshoptimizer npm package (MESHOPT=/path/to/meshoptimizer/index.module.js to point at a copy).
// Layout of the base64 data (little endian), counts in meta:
//   positions  Uint16 x3 per vertex, quantised between meta.min and meta.max (cm)
//   ao         Uint8 per vertex (baked ambient occlusion, 0..255)
//   torso      Uint8 per vertex (1 = torso, legs or head; 0 = arm or hand: rings ignore arms)
//   indices    Uint16 x3 per triangle
//   per morph  Uint16 count, Uint16 vertex[count], Int16 x3 delta[count] (scale meta.morphs[i].scale cm)
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { MeshoptSimplifier, MeshoptEncoder } = await import(process.env.MESHOPT || 'meshoptimizer')
const [dir, ratioArg] = process.argv.slice(2)
const ratio = Number(ratioArg || 0.5)

function npy(path) {
  const buf = readFileSync(path)
  const headerLength = buf.readUInt16LE(8)
  const header = buf.subarray(10, 10 + headerLength).toString('latin1')
  const descr = header.match(/'descr': '([^']+)'/)[1], shape = header.match(/'shape': \(([^)]*)\)/)[1].split(',').filter(s => s.trim()).map(Number)
  const data = buf.subarray(10 + headerLength)
  const copy = new Uint8Array(data).buffer
  const array = descr === '<f4' ? new Float32Array(copy) : descr === '<i4' ? new Int32Array(copy) : descr === '|u1' ? new Uint8Array(copy) : null
  if (!array) throw new Error(`${path}: unsupported dtype ${descr}`)
  return { array, shape }
}

await MeshoptSimplifier.ready
await MeshoptEncoder.ready
const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8'))
const tris = npy(`${dir}/tris.npy`).array, torsoAll = npy(`${dir}/torso.npy`).array
const here = new URL('.', import.meta.url)

for (const sex of ['male', 'female']) {
  const shapes = npy(`${dir}/${sex}-shapes.npy`), ao = npy(`${dir}/${sex}-ao.npy`).array
  const [count, vertexCount] = shapes.shape
  const shape = k => shapes.array.subarray(k * vertexCount * 3, (k + 1) * vertexCount * 3)
  const base = shape(0)
  // Simplify on the base body; the simplifier keeps original vertices, so every morph stays valid on the subset.
  const [simplified, error] = MeshoptSimplifier.simplify(new Uint32Array(tris), base, 3, Math.floor(tris.length * ratio / 3) * 3, 0.01, ['LockBorder'])
  // Renumber the kept vertices in first-use order (better locality, smaller after gzip).
  const order = MeshoptEncoder.reorderMesh(simplified, true, true)
  const remap = order[0], kept = order[1]
  const indices = simplified
  const old = new Int32Array(kept)
  for (let v = 0; v < remap.length; v++) if (remap[v] !== 0xffffffff) old[remap[v]] = v
  const n = kept
  // Positions in cm, floor at y = 0.
  const pos = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) pos[i * 3 + a] = base[old[i] * 3 + a] * 10
  const min = [0, 1, 2].map(a => Math.min(...Array.from({ length: n }, (_, i) => pos[i * 3 + a])))
  const max = [0, 1, 2].map(a => Math.max(...Array.from({ length: n }, (_, i) => pos[i * 3 + a])))
  const parts = []
  const qpos = new Uint16Array(n * 3)
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) qpos[i * 3 + a] = Math.round((pos[i * 3 + a] - min[a]) / (max[a] - min[a]) * 65535)
  parts.push(new Uint8Array(qpos.buffer))
  parts.push(Uint8Array.from({ length: n }, (_, i) => Math.round(Math.max(0, Math.min(1, ao[old[i]])) * 255)))
  parts.push(Uint8Array.from({ length: n }, (_, i) => torsoAll[old[i]]))
  parts.push(new Uint8Array(Uint16Array.from(indices).buffer))
  const morphs = []
  for (let k = 1; k < count; k++) {
    const s = shape(k), vertices = [], deltas = []
    let peak = 0
    for (let i = 0; i < n; i++) {
      const d = [0, 1, 2].map(a => (s[old[i] * 3 + a] - base[old[i] * 3 + a]) * 10)
      if (Math.hypot(...d) > 0.02) { vertices.push(i); deltas.push(d); peak = Math.max(peak, ...d.map(Math.abs)) }
    }
    const scale = peak / 32767
    const head = new Uint16Array([vertices.length]), idx = Uint16Array.from(vertices), val = new Int16Array(deltas.length * 3)
    deltas.forEach((d, j) => d.forEach((x, a) => { val[j * 3 + a] = Math.round(x / scale) }))
    parts.push(new Uint8Array(head.buffer), new Uint8Array(idx.buffer), new Uint8Array(val.buffer))
    morphs.push({ name: meta.sexes[sex].order[k], scale, count: vertices.length })
  }
  const bytes = Buffer.concat(parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength)))
  const m = meta.sexes[sex]
  const circ = Object.fromEntries(Object.entries(m.circ).map(([k, v]) => [k, v]))
  const out = {
    sex, source: meta.source, vertices: n, triangles: indices.length / 3, min, max, morphs,
    height: Math.round(m.height * 10) / 10, levels: m.levels, circ,
  }
  const file = `// GENERATED by fit-finder/body/pack-body.mjs from MakeHuman 1.1 assets (CC0 1.0). Do not edit.\n` +
    `export const meta = ${JSON.stringify(out)};\nexport const data = '${bytes.toString('base64')}';\n`
  writeFileSync(new URL(`xavia-fit-body-${sex}.js`, here), file)
  console.log(`${sex}: ${n} vertices, ${indices.length / 3} triangles (error ${error.toFixed(4)}), ${bytes.length} bytes, module ${file.length} chars, morph vertices ${morphs.map(x => `${x.name}:${x.count}`).join(' ')}`)
}
if (process.argv[1] !== fileURLToPath(import.meta.url)) throw new Error('run as a script')
