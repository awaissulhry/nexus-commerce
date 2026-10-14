// Xavia fit finder: the 3D mannequin on screen. Plain WebGL 1 (no library), drawn only when something changes.
// Turn it by dragging, by touch or with the arrow keys. Rings show how a size fits at the chest, waist and hips.
import { decodeBody, shapeFor, applyShape, shadingNormals, ring } from './xavia-fit-body.js';

// Body colours as shown on the swatches (sRGB 0-255): mannequin white first, then six skin tones.
export const SWATCHES = [[226, 226, 226], [237, 234, 213], [216, 171, 140], [201, 146, 111], [178, 134, 103], [145, 84, 61], [54, 30, 30]];
const linear = c => ((c / 255) <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const SKINS = SWATCHES.map(rgb => rgb.map(linear));
const RING_COLOUR = { ok: [76, 175, 80], bad: [229, 57, 53], guide: [255, 122, 0] };
for (const k of Object.keys(RING_COLOUR)) RING_COLOUR[k] = RING_COLOUR[k].map(linear);
// Camera per screen, measured against the reference fit finder: lo/hi = part of the body height in view (0 = floor,
// 1 = top of the head), yaw = turn of the body (radians), x = where the body sits across the stage (-1 left .. 1 right).
const FRAMES = {
  full: { lo: -0.04, hi: 1.03, yaw: 0.5, pitch: 0.06, x: 0 },
  shape: { lo: 0.346, hi: 1.02, yaw: 0.55, pitch: 0.08, x: -0.26 },
  result: { lo: 0.346, hi: 1.01, yaw: 0.38, pitch: 0.2, x: -0.226 },
  shapePhone: { lo: -0.051, hi: 1.155, yaw: 0.5, pitch: 0.08, x: -0.63 },
  resultPhone: { lo: 0.001, hi: 1.15, yaw: 0.5, pitch: 0.2, x: -0.04 },
  guide: { lo: 0.33, hi: 0.975, yaw: 0.12, pitch: 0.2, x: -0.1 },
};
const LEVEL_SHIFT = { chest: 0, waist: 0, hips: 0 };

const bodies = new Map();
/** Loads and decodes a body module once per page (url → Promise<body>). */
export function loadBody(url) {
  if (!bodies.has(url)) bodies.set(url, import(url).then(decodeBody).catch(error => { bodies.delete(url); throw error; }));
  return bodies.get(url);
}

const VERTEX = `
attribute vec3 aPos; attribute vec3 aNormal; attribute float aAo;
uniform mat4 uProj; uniform mat4 uView; uniform mat4 uModel;
varying vec3 vNormal; varying float vAo; varying vec3 vWorld;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz; vNormal = mat3(uModel) * aNormal; vAo = aAo;
  gl_Position = uProj * uView * world;
}`;
const FRAGMENT = `
precision mediump float;
uniform vec3 uColour; uniform vec3 uEye;
varying vec3 vNormal; varying float vAo; varying vec3 vWorld;
void main() {
  vec3 n = normalize(vNormal), v = normalize(uEye - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  // A white store mannequin in a soft studio: wrapped key light from the front left, a large fill, satin highlights,
  // and grey towards the silhouette so the white body reads on a white page.
  vec3 key = normalize(vec3(-0.45, 0.55, 0.7)), fill = normalize(vec3(0.75, 0.15, 0.65));
  float ndv = max(dot(n, v), 0.0);
  float k = dot(n, key) * 0.5 + 0.5; k = k * k;
  float f = max(dot(n, fill), 0.0);
  float hemi = mix(0.62, 1.0, n.y * 0.5 + 0.5);
  float spec = pow(max(dot(n, normalize(key + v)), 0.0), 10.0) * 0.2 + pow(max(dot(n, normalize(fill + v)), 0.0), 30.0) * 0.05;
  float ao = mix(0.55, 1.0, vAo);
  float edge = mix(0.76, 1.0, pow(ndv, 0.6));
  vec3 c = uColour * (0.36 * hemi + 0.7 * k + 0.16 * f) * ao * edge + spec * ao;
  gl_FragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`;
const RING_VERTEX = `
attribute vec3 aPos; attribute float aAlong;
uniform mat4 uProj; uniform mat4 uView; uniform mat4 uModel;
varying float vAlong;
void main() { vAlong = aAlong; gl_Position = uProj * uView * uModel * vec4(aPos, 1.0); }`;
const RING_FRAGMENT = `
precision mediump float;
uniform vec3 uColour; uniform float uAlpha; uniform float uDash;
varying float vAlong;
void main() {
  if (uDash > 0.5 && fract(vAlong * 48.0) > 0.55) discard;
  gl_FragColor = vec4(pow(uColour, vec3(1.0 / 2.2)) * uAlpha, uAlpha);
}`;

const perspective = (fovy, aspect, near, far) => {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
};
const multiply = (a, b) => {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k];
  return o;
};
const rotateY = a => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
const rotateX = a => [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1];
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const loc = name => (name.startsWith('a') ? gl.getAttribLocation(p, name) : gl.getUniformLocation(p, name));
  return { p, loc };
}

/**
 * Puts a mannequin into host. Returns null when WebGL is missing (the dialog then shows its flat drawing).
 * options: { urls: { male, female }, label: aria label, onFail(error) }
 */
export function createViewer(host, { urls, label, onFail } = {}) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: true }) || canvas.getContext('experimental-webgl');
  if (!gl) return null;
  canvas.className = 'xff-3d';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label || '');
  const labels = document.createElement('div');
  labels.className = 'xff-3d-labels';
  labels.setAttribute('aria-hidden', 'true');
  host.append(canvas, labels);

  let body, sex, positions, normals, from = null, to = null, tweenStart = 0, animating = false;
  let halfWidth = 40, yaw = FRAMES.full.yaw, userYaw = 0, yawFrom = yaw, pitch = 0.08, spin = 0, dragging = null, frame = 'full', framing = FRAMES.full, framingFrom = null, framingStart = 0;
  let rings = [], ringMeshes = [], skin = SKINS[0], destroyed = false, requested = false, ready = false;
  const want = { values: {}, weightKg: null };

  let shaders, buffers;
  try {
    shaders = { body: program(gl, VERTEX, FRAGMENT), ring: program(gl, RING_VERTEX, RING_FRAGMENT) };
    buffers = { pos: gl.createBuffer(), normal: gl.createBuffer(), ao: gl.createBuffer(), index: gl.createBuffer(), ring: gl.createBuffer() };
  } catch (error) { canvas.remove(); labels.remove(); onFail?.(error); return null; }

  const draw = () => {
    requested = false;
    if (destroyed || !body) return;
    const now = performance.now();
    if (to) {
      const t = animating ? Math.min(1, (now - tweenStart) / 450) : 1, e = ease(t);
      const shape = { scale: from.scale + (to.scale - from.scale) * e, weights: {} };
      for (const k of new Set([...Object.keys(from.weights), ...Object.keys(to.weights)])) shape.weights[k] = (from.weights[k] ?? 0) + ((to.weights[k] ?? 0) - (from.weights[k] ?? 0)) * e;
      applyShape(body, shape, positions);
      shadingNormals(body, positions, normals);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.pos); gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normal); gl.bufferData(gl.ARRAY_BUFFER, normals, gl.DYNAMIC_DRAW);
      halfWidth = 0;
      for (let i = 0; i < positions.length; i += 3) halfWidth = Math.max(halfWidth, Math.abs(positions[i]), Math.abs(positions[i + 2]));
      if (t >= 1) { animating = false; from = to; to = null; buildRings(); }
      else requestRender();
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.max(1, Math.round(host.clientWidth * dpr)), hgt = Math.max(1, Math.round(host.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
    gl.viewport(0, 0, w, hgt);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (Math.abs(spin) > 0.0005 && !dragging) { yaw += spin; userYaw += spin; spin *= 0.92; requestRender(); }
    // Frame the whole body, or the torso on the result; a change of frame glides.
    const height = (from ?? to).scale * body.top, target = FRAMES[frame] ?? FRAMES.full;
    let f = target;
    if (framingFrom) {
      const t = Math.min(1, (now - framingStart) / 500), e = ease(t);
      f = Object.fromEntries(['lo', 'hi', 'x', 'pitch'].map(k => [k, framingFrom[k] + (target[k] - framingFrom[k]) * e]));
      yaw = yawFrom + (target.yaw + userYaw - yawFrom) * e;
      if (t < 1) requestRender(); else framingFrom = null;
    }
    framing = f;
    // Far enough back that the height span and the width (arms included) both fit, with a small margin.
    const fov = 0.42, aspect = w / hgt, span = (f.hi - f.lo) * height, centre = ((f.lo + f.hi) / 2) * height, tan = Math.tan(fov / 2);
    // The whole body fits on 'full'; the close frames fill the height and let the arms run off the sides.
    const fit = frame === 'full' ? Math.max(span / 2 / tan, (halfWidth * 1.05) / (tan * aspect)) * 1.08 : span / 2 / tan;
    const proj = perspective(fov, aspect, 10, 5000);
    proj[8] -= f.x ?? 0;
    // Orbit: tilt round the framed centre, then step back (the camera looks a little down at the body).
    const tilt = pitch + (f.pitch ?? 0.08) - 0.08;
    const view = multiply(translate(0, 0, -fit), multiply(rotateX(tilt), translate(0, -centre, 0)));
    const model = rotateY(yaw);
    const { p, loc } = shaders.body;
    gl.useProgram(p);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    gl.uniformMatrix4fv(loc('uProj'), false, proj); gl.uniformMatrix4fv(loc('uView'), false, view); gl.uniformMatrix4fv(loc('uModel'), false, model);
    gl.uniform3fv(loc('uColour'), skin); gl.uniform3fv(loc('uEye'), [0, centre + Math.sin(tilt) * fit, Math.cos(tilt) * fit]);
    for (const [name, buffer, size] of [['aPos', buffers.pos, 3], ['aNormal', buffers.normal, 3], ['aAo', buffers.ao, 1]]) {
      const a = loc(name); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, size, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
    gl.drawElements(gl.TRIANGLES, body.indices.length, gl.UNSIGNED_SHORT, 0);
    for (const name of ['aPos', 'aNormal', 'aAo']) gl.disableVertexAttribArray(loc(name));
    if (!to && ringMeshes.length) drawRings(proj, view, model);
    placeLabels(proj, view, model, w / dpr, hgt / dpr);
  };

  function drawRings(proj, view, model) {
    const { p, loc } = shaders.ring;
    gl.useProgram(p);
    gl.uniformMatrix4fv(loc('uProj'), false, proj); gl.uniformMatrix4fv(loc('uView'), false, view); gl.uniformMatrix4fv(loc('uModel'), false, model);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    const aPos = loc('aPos'), aAlong = loc('aAlong');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.ring);
    gl.enableVertexAttribArray(aPos); gl.enableVertexAttribArray(aAlong);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 16, 0); gl.vertexAttribPointer(aAlong, 1, gl.FLOAT, false, 16, 12);
    // The band is hidden where it passes behind the body.
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    for (const r of ringMeshes) {
      gl.uniform3fv(loc('uColour'), RING_COLOUR[r.tone] ?? RING_COLOUR.guide); gl.uniform1f(loc('uDash'), r.dashed ? 1 : 0);
      for (const strip of r.strips) {
        gl.uniform1f(loc('uAlpha'), strip.alpha);
        gl.drawArrays(gl.TRIANGLE_STRIP, strip.first, strip.count);
      }
    }
    gl.disableVertexAttribArray(aPos); gl.disableVertexAttribArray(aAlong);
    gl.depthMask(true); gl.disable(gl.BLEND); gl.depthFunc(gl.LESS);
  }

  function buildRings() {
    ringMeshes = [];
    if (!body || !from || !rings.length) return;
    const data = [];
    const scale = from.scale;
    for (const r of rings) {
      const y = (body.meta.levels[r.measure] + LEVEL_SHIFT[r.measure]) * scale;
      const contour = ring(positions, body.torso, y, { band: 2 * scale, samples: 96 });
      if (!contour) continue;
      const [cx, cz] = contour.centre, strips = [];
      // A solid band with fading stripes above and below it, as fit finders draw a tape line.
      for (const [offset, half, alpha, dy] of [[0.6, 0.6, 1, 0], [0.5, 0.35, 0.38, 1.6], [0.5, 0.35, 0.38, -1.6], [0.45, 0.32, 0.16, 3.1], [0.45, 0.32, 0.16, -3.1], [0.8, 3.4, 0.07, 0]]) {
        const first = data.length / 4;
        const n = contour.points.length;
        for (let k = 0; k <= n; k++) {
          const [x, z] = contour.points[k % n], d = Math.hypot(x - cx, z - cz) || 1, s = (d + offset) / d;
          const px = cx + (x - cx) * s, pz = cz + (z - cz) * s;
          data.push(px, y + dy * scale - half, pz, k / n, px, y + dy * scale + half, pz, k / n);
        }
        strips.push({ first, count: (n + 1) * 2, alpha });
      }
      ringMeshes.push({ ...r, strips, y, points: contour.points.filter((_, k) => k % 3 === 0).map(([x, z]) => [x, y, z]) });
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.ring);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  }

  function placeLabels(proj, view, model, cssW, cssH) {
    const mvp = multiply(proj, multiply(view, model));
    const items = [];
    for (const r of ringMeshes) {
      if (!r.text || to) continue;
      // The ring point farthest right on screen, at this turn of the body.
      let best = null;
      for (const p of r.points) {
        const c = [0, 1, 2, 3].map(i => mvp[i] * p[0] + mvp[4 + i] * p[1] + mvp[8 + i] * p[2] + mvp[12 + i]);
        const sx = (c[0] / c[3] * 0.5 + 0.5) * cssW, sy = (1 - (c[1] / c[3] * 0.5 + 0.5)) * cssH;
        if (!best || sx > best[0]) best = [sx, sy];
      }
      if (best) items.push({ r, x: best[0], y: best[1] });
    }
    // One column to the right of the body, each label level with its ring.
    items.sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) items[i].ly = Math.max(items[i].y, (items[i - 1].ly ?? items[i - 1].y) + 52);
    // Where the labels go comes from the page's CSS: a fixed column --xff-label-column px from the right edge, or
    // --xff-label-gap px right of the rings (22 px by default).
    const css = getComputedStyle(labels), fixed = parseFloat(css.getPropertyValue('--xff-label-column'));
    const column = Number.isFinite(fixed) ? cssW - fixed : Math.max(...items.map(i => i.x), 0) + (parseFloat(css.getPropertyValue('--xff-label-gap')) || 22);
    labels.replaceChildren(...items.map(({ r, y, ly = y }) => {
      const el = document.createElement('div');
      el.className = `xff-3d-label xff-3d-label--${r.tone}`;
      const badge = document.createElement('span');
      badge.className = 'xff-3d-label__icon';
      if (r.icon) badge.append(r.icon.cloneNode(true));
      const text = document.createElement('span');
      text.className = 'xff-3d-label__text';
      text.textContent = r.text;
      el.append(badge, text);
      el.style.top = `${ly}px`;
      return el;
    }));
    // Keep each label inside the stage (its width comes from the page's CSS).
    for (const el of labels.children) el.style.left = `${Math.max(0, Math.min(column, cssW - el.offsetWidth - 4))}px`;
  }

  function requestRender() {
    if (requested || destroyed) return;
    requested = true;
    requestAnimationFrame(draw);
  }

  async function setBody(next) {
    Object.assign(want, next);
    const url = urls?.[want.sex === 'female' ? 'female' : 'male'];
    if (!url) return;
    let b;
    try { b = await loadBody(url); } catch (error) { onFail?.(error); return; }
    if (destroyed) return;
    const target = shapeFor(b, { values: want.values, weightKg: want.weightKg });
    if (b !== body) {
      // A new body type: swap meshes at once, then keep morphing as usual.
      body = b; sex = want.sex;
      positions = new Float32Array(b.base.length); normals = new Float32Array(b.base.length);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.ao); gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from(b.ao, v => v / 255), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, b.indices, gl.STATIC_DRAW);
      from = target; to = target; animating = false;
      if (!ready) { ready = true; host.classList.add('is-ready'); }
    } else {
      const now = currentShape();
      // Same body as on screen (a tab or step change): keep it, so rings appear at once.
      if (!animating && sameShape(now, target)) { requestRender(); return; }
      from = now; to = target; tweenStart = performance.now(); animating = !reduceMotion();
    }
    ringMeshes = [];
    requestRender();
  }
  function sameShape(a, b) {
    if (!a || !b || Math.abs(a.scale - b.scale) > 1e-4) return false;
    const keys = new Set([...Object.keys(a.weights), ...Object.keys(b.weights)]);
    for (const k of keys) if (Math.abs((a.weights[k] ?? 0) - (b.weights[k] ?? 0)) > 1e-4) return false;
    return true;
  }
  function currentShape() {
    if (!to || !animating) return from ?? to;
    const e = ease(Math.min(1, (performance.now() - tweenStart) / 450)), shape = { scale: from.scale + (to.scale - from.scale) * e, weights: {} };
    for (const k of new Set([...Object.keys(from.weights), ...Object.keys(to.weights)])) shape.weights[k] = (from.weights[k] ?? 0) + ((to.weights[k] ?? 0) - (from.weights[k] ?? 0)) * e;
    return shape;
  }

  // Turning: drag with mouse or finger (vertical scrolling stays free on phones), arrows, Home to face front.
  canvas.addEventListener('pointerdown', event => { dragging = { x: event.clientX, y: event.clientY, yaw, pitch, t: performance.now() }; canvas.setPointerCapture(event.pointerId); spin = 0; });
  canvas.addEventListener('pointermove', event => {
    if (!dragging) return;
    const dx = event.clientX - dragging.x, dy = event.clientY - dragging.y;
    const next = dragging.yaw + dx * 0.012;
    spin = next - yaw; userYaw += next - yaw; yaw = next;
    pitch = Math.max(-0.2, Math.min(0.3, dragging.pitch + dy * 0.004));
    requestRender();
  });
  const release = () => { dragging = null; requestRender(); };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('keydown', event => {
    const step = { ArrowLeft: -0.26, ArrowRight: 0.26 }[event.key];
    if (step) { event.preventDefault(); spin = 0; yaw += step; userYaw += step; requestRender(); }
    if (event.key === 'Home') { event.preventDefault(); spin = 0; userYaw = 0; yaw = (FRAMES[frame] ?? FRAMES.full).yaw; pitch = 0.08; requestRender(); }
  });
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); onFail?.(new Error('WebGL context lost')); });
  const resize = new ResizeObserver(() => requestRender());
  resize.observe(host);

  return {
    setBody,
    /** rings: [{ measure: 'chest'|'waist'|'hips', tone: 'ok'|'warn'|'bad'|'guide', text, dashed }] */
    setRings(next) { rings = next ?? []; if (!to || !animating) buildRings(); requestRender(); },
    setSkin(index) { skin = SKINS[index] ?? SKINS[0]; requestRender(); },
    /** Re-measure the stage (after the layout around it changed). */
    refresh() { requestRender(); },
    /** Camera preset: 'full', 'shape', 'result' or 'guide' (FRAMES). A new preset also turns the body to its angle. */
    setFrame(next) {
      if (next === frame) return;
      framingFrom = framing; yawFrom = yaw; userYaw = 0; framingStart = performance.now(); frame = next;
      if (reduceMotion() || !body) { framingFrom = null; framing = FRAMES[next] ?? FRAMES.full; yaw = framing.yaw; }
      requestRender();
    },
    get sex() { return sex; },
    destroy() { destroyed = true; resize.disconnect(); canvas.remove(); labels.remove(); gl.getExtension('WEBGL_lose_context')?.loseContext(); },
  };
}
