// Xavia fit finder: the 3D mannequin's data side. Decodes a packed body (body/xavia-fit-body-<sex>.js), shapes it
// to the shopper's height, weight and measurements, and finds the ring around the chest, waist or hips.
// No DOM and no WebGL here, so it runs in node --test.

/** Unpacks { meta, data } from a body module into typed arrays (cm, floor at y = 0). */
export function decodeBody({ meta, data }) {
  const binary = atob(data), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  let offset = 0;
  const take = (Type, count) => {
    const size = count * Type.BYTES_PER_ELEMENT, array = new Type(bytes.buffer.slice(offset, offset + size));
    offset += size;
    return array;
  };
  const n = meta.vertices, quantised = take(Uint16Array, n * 3), base = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) { const a = i % 3; base[i] = meta.min[a] + (quantised[i] / 65535) * (meta.max[a] - meta.min[a]); }
  const ao = take(Uint8Array, n), torso = take(Uint8Array, n), indices = take(Uint16Array, meta.triangles * 3);
  const morphs = {};
  for (const m of meta.morphs) {
    const count = take(Uint16Array, 1)[0];
    morphs[m.name] = { vertices: take(Uint16Array, count), deltas: take(Int16Array, count * 3), scale: m.scale };
  }
  if (offset !== bytes.length) throw new Error(`body data: ${bytes.length - offset} bytes left over`);
  const body = { meta, base, ao, torso, indices, morphs };
  // Measure this (simplified) body with the same tape as the rings, so shapes and rings always agree.
  body.top = 0;
  for (let i = 1; i < base.length; i += 3) body.top = Math.max(body.top, base[i]);
  body.circ = { base: measure(body, base, 1) };
  for (const name of Object.keys(morphs)) body.circ[name] = measure(body, applyShape(body, { weights: { [name]: 1 } }), 1);
  return body;
}

export const PARTS = ['chest', 'waist', 'hips'];
const BAND = 2;
/** Tape circumference (cm) of chest, waist and hips of positions shaped with this scale. */
export function measure(body, positions, scale) {
  return Object.fromEntries(PARTS.map(m => [m, ring(positions, body.torso, body.meta.levels[m] * scale, { band: BAND * scale })?.circumference ?? 0]));
}

const within = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const REFERENCE_BMI = { male: 22.5, female: 21.5 };

/**
 * Morph weights and scale that make the mannequin match a body.
 * values: { height, chest, waist, hips } in cm (any may be missing); weightKg optional.
 * Build first (from BMI: slim or heavy everywhere), then each part's own morph closes the gap to its measure.
 */
export function shapeFor(body, { values = {}, weightKg } = {}) {
  const { meta, circ } = body, height = values.height || body.top, scale = height / body.top;
  const weights = {};
  if (weightKg) {
    const bmi = weightKg / (height / 100) ** 2, reference = REFERENCE_BMI[meta.sex] ?? 22;
    if (bmi > reference) weights.weightPlus = within((bmi - reference) / 10, 0, 1.4);
    else weights.weightMinus = within((reference - bmi) / 5, 0, 1.2);
  }
  const PART = { chest: 'bust', waist: 'waist', hips: 'hips' };
  for (const [measure, morph] of Object.entries(PART)) {
    const target = values[measure];
    if (!target) continue;
    let current = circ.base[measure];
    for (const [name, w] of Object.entries(weights)) current += w * (circ[name][measure] - circ.base[measure]);
    const gap = target / scale - current;
    const up = circ[`${morph}Incr`][measure] - circ.base[measure], down = circ.base[measure] - circ[`${morph}Decr`][measure];
    if (gap > 0 && up > 0) weights[`${morph}Incr`] = within(gap / up, 0, 2.5);
    if (gap < 0 && down > 0) weights[`${morph}Decr`] = within(-gap / down, 0, 2.5);
  }
  // The morphs overlap a little (build moves every part): measure the result and correct each part twice.
  for (let pass = 0; pass < 2; pass++) {
    const got = measure(body, applyShape(body, { scale, weights }), scale);
    for (const [measure_, morph] of Object.entries(PART)) {
      const target = values[measure_];
      if (!target || !got[measure_]) continue;
      const up = circ[`${morph}Incr`][measure_] - circ.base[measure_], down = circ.base[measure_] - circ[`${morph}Decr`][measure_];
      const net = (weights[`${morph}Incr`] ?? 0) * up - (weights[`${morph}Decr`] ?? 0) * down + (target - got[measure_]) / scale;
      delete weights[`${morph}Incr`]; delete weights[`${morph}Decr`];
      if (net > 0 && up > 0) weights[`${morph}Incr`] = within(net / up, 0, 2.5);
      if (net < 0 && down > 0) weights[`${morph}Decr`] = within(-net / down, 0, 2.5);
    }
  }
  return { scale, weights };
}

/** Writes base + weighted morphs, times scale, into out (Float32Array, 3 per vertex). */
export function applyShape(body, { scale = 1, weights = {} }, out = new Float32Array(body.base.length)) {
  out.set(body.base);
  for (const [name, w] of Object.entries(weights)) {
    const m = body.morphs[name];
    if (!m || !w) continue;
    const k = w * m.scale;
    for (let j = 0; j < m.vertices.length; j++) {
      const v = m.vertices[j] * 3;
      out[v] += m.deltas[j * 3] * k; out[v + 1] += m.deltas[j * 3 + 1] * k; out[v + 2] += m.deltas[j * 3 + 2] * k;
    }
  }
  if (scale !== 1) for (let i = 0; i < out.length; i++) out[i] *= scale;
  return out;
}

/** Smooth vertex normals (area weighted) into out. */
export function computeNormals(positions, indices, out = new Float32Array(positions.length)) {
  out.fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { out[i] += nx; out[i + 1] += ny; out[i + 2] += nz; }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
  }
  return out;
}

/**
 * The tape line round the torso at height y (cm): convex hull of the torso in a thin slice, sampled at `samples`
 * angles from its centre. Returns { points: [[x, z], …], circumference } or null when the slice is empty.
 */
export function ring(positions, torso, y, { band = 1.2, samples = 72 } = {}) {
  const pts = [];
  for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
    if (torso[v] && Math.abs(positions[i + 1] - y) < band) pts.push([positions[i], positions[i + 2]]);
  }
  if (pts.length < 3) return null;
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.slice().reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let circumference = 0;
  for (let i = 0; i < hull.length; i++) circumference += Math.hypot(hull[i][0] - hull[(i + 1) % hull.length][0], hull[i][1] - hull[(i + 1) % hull.length][1]);
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length, cz = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  // Ray from the centre at each angle; the farthest hull edge it crosses gives the ring point.
  const points = [];
  for (let k = 0; k < samples; k++) {
    const a = (k / samples) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    let best = 0;
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i], q = hull[(i + 1) % hull.length];
      const ex = q[0] - p[0], ez = q[1] - p[1], det = dx * -ez - dz * -ex;
      if (Math.abs(det) < 1e-9) continue;
      const px = p[0] - cx, pz = p[1] - cz;
      const t = (px * -ez - pz * -ex) / det, u = (dx * pz - dz * px) / det;
      if (t > 0 && u >= 0 && u <= 1) best = Math.max(best, t);
    }
    points.push([cx + dx * best, cz + dz * best]);
  }
  return { points, circumference, centre: [cx, cz] };
}
