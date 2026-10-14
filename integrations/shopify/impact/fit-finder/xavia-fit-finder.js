// Xavia fit finder: the "Find your size" dialog (3D body on the left, steps on the right), the size hint under the
// size option and the add-to-cart check. The inline boot in snippets/xavia-fit-finder.liquid loads this module on the
// first click, or at idle time when this device has a saved fit profile. build.mjs joins it with the engine, texts,
// 3D body and viewer code and the CSS into one theme asset; the two body shapes are separate assets, loaded on open.
import { estimateBody, measuredBody, combineBody, pickChart, chartsForProduct, recommend, validateInputs, verdictFor, normalizeSize, LIMITS } from './xavia-fit-engine.js';
import { TEXT } from './xavia-fit-i18n.js';
import { createViewer } from './xavia-fit-viewer.js';

const STYLES = '__XFF_CSS__';
const STORE = 'xavia-fit-profile';
const TORSO = ['chest', 'waist', 'hips'];
const FIT_LABEL = { tooTight: 'tooTight', snug: 'snugFit', right: 'right', loose: 'loose', tooLoose: 'tooLoose' };
const FIT_TONE = { tooTight: 'bad', snug: 'warn', right: 'ok', loose: 'warn', tooLoose: 'bad' };
const FIT_EN = { tooTight: 'too tight', snug: 'close fit', right: 'just right', loose: 'roomy', tooLoose: 'too loose' };
const HOW = { chest: 'howChest', waist: 'howWaist', hips: 'howHips', inseam: 'howInseam', hand: 'howHand', handLength: 'howHandLength' };
const CM_PER_IN = 2.54, KG_PER_LB = 0.45359237;

let lang = 'en';
const t = (key, vars = {}) => String(TEXT[lang]?.[key] ?? TEXT.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const pickLang = locale => (TEXT[String(locale || '').slice(0, 2).toLowerCase()] ? String(locale).slice(0, 2).toLowerCase() : 'en');

// ---------------------------------------------------------------- small DOM helpers (never innerHTML with data)
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid) el.append(kid);
  return el;
}
let uid = 0;
const nextId = name => `xff-${name}-${++uid}`;

// ---------------------------------------------------------------- numbers and units
const parseNum = value => { const text = String(value ?? '').trim().replace(',', '.'); const n = Number(text); return text === '' || !Number.isFinite(n) ? null : n; };
const fmt = (n, digits = 0) => new Intl.NumberFormat(lang, { maximumFractionDigits: digits }).format(n);
const toUnit = (cm, unit) => (unit === 'in' ? cm / CM_PER_IN : cm);
const lengthText = (cm, unit) => `${fmt(toUnit(cm, unit), unit === 'in' ? 1 : 1)} ${unit}`;
const rangeText = ([lo, hi], unit) => `${fmt(toUnit(lo, unit), 1)}–${fmt(toUnit(hi, unit), 1)} ${unit}`;
const imperialCountry = country => ['US', 'GB', 'LR', 'MM'].includes(String(country || '').toUpperCase());

// ---------------------------------------------------------------- the saved profile (this device only)
function loadProfile() { try { const p = JSON.parse(localStorage.getItem(STORE) || 'null'); return p && p.v === 1 ? p : null; } catch { return null; } }
function saveProfile(p) { try { localStorage.setItem(STORE, JSON.stringify({ ...p, v: 1 })); } catch { /* private mode: works for this visit only */ } }
function forgetProfile() { try { localStorage.removeItem(STORE); } catch { /* nothing stored */ } }

// ---------------------------------------------------------------- product config from the snippet
function readConfig(root) {
  const el = root.querySelector('script[data-xff-config]');
  if (!el) return null;
  let cfg;
  try { cfg = JSON.parse(el.textContent); } catch { return null; }
  const names = new Set(cfg.values.map(v => normalizeSize(v.name)));
  const charts = chartsForProduct({ override: cfg.override, defaults: cfg.defaults, kind: cfg.kind, audience: cfg.audience });
  // Only the sizes this product sells; a chart size the product lacks cannot be recommended.
  cfg.charts = Object.fromEntries(Object.entries(charts)
    .map(([cut, chart]) => [cut, { ...chart, sizes: chart.sizes.filter(size => names.has(normalizeSize(size.name))) }])
    .filter(([, chart]) => chart.sizes.length));
  return cfg;
}

const tapeOnly = p => Object.fromEntries(Object.entries(p.tape ?? {}).filter(([, v]) => Number.isFinite(v)));
function bodyFrom(p) {
  const tape = measuredBody(tapeOnly(p));
  if (!(p.heightCm && p.weightKg)) return tape;
  return combineBody(estimateBody({ sex: p.sex, heightCm: p.heightCm, weightKg: p.weightKg, age: p.age, shape: p.shape }), tape);
}
function evaluate(cfg, p) {
  const chart = pickChart(cfg.charts, p.sex);
  if (!chart) return null;
  const body = bodyFrom(p);
  const available = Object.fromEntries(cfg.values.map(v => [normalizeSize(v.name), v.available]));
  const result = recommend(chart, body, { fit: p.fit, layers: chart.measures.includes('chest') ? p.layers : 'none', material: cfg.material, available });
  return result.missing ? null : { chart, body, result };
}

// ---------------------------------------------------------------- the product page: read and set the size
const sizeInputs = cfg => Array.from(document.querySelectorAll(`input[data-option-position="${cfg.optionPosition}"][form="${CSS.escape(cfg.formId)}"]`));
function selectedSize(cfg) {
  const checked = sizeInputs(cfg).find(input => input.checked);
  const value = checked && cfg.values.find(v => String(v.id) === checked.value);
  if (value) return value.name;
  try {
    const variant = JSON.parse(document.querySelector(`variant-picker[form-id="${CSS.escape(cfg.formId)}"] script[data-variant]`)?.textContent || 'null');
    return variant?.options?.[cfg.optionPosition - 1] ?? null;
  } catch { return null; }
}
function selectSize(cfg, name) {
  const value = cfg.values.find(v => normalizeSize(v.name) === normalizeSize(name));
  const input = value && sizeInputs(cfg).find(el => el.value === String(value.id));
  if (!input) return false;
  if (!input.checked) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
  return true;
}

// Impact re-renders the size option after a change, which replaces the button the dialog came from. Tell screen
// readers through the theme's own status line, and put focus on the new button once it exists.
function afterSizeChange(cfg, message) {
  const status = document.getElementById('status-announcement');
  if (status) status.textContent = message;
  const refocus = () => document.querySelector(`[data-xff][data-xff-form="${CSS.escape(cfg.formId)}"] [data-xff-open]`)?.focus();
  const done = () => { document.removeEventListener('variant:change', onChange); clearTimeout(timer); };
  const onChange = () => { done(); requestAnimationFrame(refocus); };
  const timer = setTimeout(done, 5000);
  document.addEventListener('variant:change', onChange);
}

const worstRegion = verdict => verdict.regions.find(r => r.fit === 'tooTight') ?? verdict.regions.find(r => r.fit === 'tooLoose') ?? verdict.regions.find(r => r.fit !== 'right');
const lowerFit = fit => (fit === 'tooTight' ? t('tooTightLower') : fit === 'tooLoose' ? t('tooLooseLower') : t(FIT_LABEL[fit]).toLowerCase());

/** Updates the button under the size option: "Your size: L" and a warning when the chosen size will not fit. */
function decorate(root) {
  const cfg = readConfig(root);
  if (!cfg) return;
  lang = pickLang(cfg.locale);
  if (!Object.keys(cfg.charts).length) { root.hidden = true; return; }
  const p = loadProfile(), ev = p && evaluate(cfg, p);
  const label = root.querySelector('[data-xff-label]'), hint = root.querySelector('[data-xff-hint]');
  if (label) label.textContent = ev ? t('yourSize', { size: ev.result.best }) : t('trigger');
  if (!hint) return;
  const chosen = ev && selectedSize(cfg), verdict = chosen && verdictFor(ev.result, chosen);
  hint.textContent = verdict && verdict.verdict === 'no' ? t('notForYou', { size: chosen, fit: lowerFit(worstRegion(verdict).fit) }) : '';
  hint.hidden = !hint.textContent;
}
const decorateAll = () => document.querySelectorAll('[data-xff]').forEach(decorate);

// ---------------------------------------------------------------- order note and add-to-cart check
function noteFor(ev, chosen, verdict) {
  const r = ev.result, parts = [`suggested ${r.best} ${r.confidence}% (${ev.body.mode === 'estimate' ? 'height and weight' : ev.body.mode === 'measured' ? 'tape' : 'height, weight and tape'})`];
  if (chosen) parts.push(`chosen ${chosen}`);
  if (verdict && verdict.verdict !== 'best') parts.push(verdict.regions.filter(x => x.fit !== 'right').map(x => `${x.measure} ${FIT_EN[x.fit]}`).join(', ') || 'also fits');
  if (r.outOfRange) parts.push(`outside chart (${r.outOfRange})`);
  return parts.join(' | ');
}
// Impact's product form has an input named "id", so form.id is that input: read the form's id attribute instead.
const formId = form => form.getAttribute('id');
function writeNote(form, ev, chosen, verdict) {
  let input = Array.from(form.elements).find(el => el.name === 'properties[_Fit check]');
  if (!input) { input = h('input', { type: 'hidden', name: 'properties[_Fit check]', form: formId(form) }); form.append(input); }
  input.value = noteFor(ev, chosen, verdict);
}
function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !formId(form)) return;
  const root = Array.from(document.querySelectorAll('[data-xff]')).find(el => el.dataset.xffForm === formId(form));
  const cfg = root && readConfig(root), p = cfg && loadProfile(), ev = p && evaluate(cfg, p);
  if (!ev) return;
  const chosen = selectedSize(cfg), verdict = chosen && verdictFor(ev.result, chosen);
  writeNote(form, ev, chosen, verdict);
  if (form.dataset.xffBypass) { delete form.dataset.xffBypass; return; }
  if (verdict?.verdict === 'no' && !ev.result.outOfRange) {
    event.preventDefault();
    event.stopImmediatePropagation();
    openDialog(root, { mode: 'guard', chosen, submitter: event.submitter, opener: event.submitter });
  }
}

// ---------------------------------------------------------------- the flat body figure (only without WebGL)
// Smooth closed outline through points (Catmull-Rom turned into cubic Bézier curves).
function smoothPath(points) {
  const n = points.length, p = i => points[(i + n) % n];
  let d = `M${p(0)[0].toFixed(1)},${p(0)[1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return `${d}Z`;
}
const halfWidth = cm => (cm / (2 * Math.PI)) * 1.12 * 2.3;
/** bands: [{ measure, tone, dashed }] drawn round the chest, waist and hips. */
function figure(sex, values = {}, bands = []) {
  const female = sex === 'female', cx = 110;
  const chest = halfWidth(values.chest ?? (female ? 92 : 100)), waist = halfWidth(values.waist ?? (female ? 76 : 88)), hips = halfWidth(values.hips ?? (female ? 100 : 98));
  const shoulder = chest + (female ? 4 : 9), neck = female ? 8 : 10, waistY = female ? 168 : 176, y = { chest: female ? 122 : 116, waist: waistY, hips: 218 };
  const left = [[cx - neck, 60], [cx - neck, 72], [cx - shoulder + 7, 82], [cx - shoulder, 94], [cx - chest, y.chest], [cx - (chest + waist) / 2, (y.chest + waistY) / 2],
    [cx - waist, waistY], [cx - hips, 218], [cx - hips * 0.93, 262], [cx - hips * 0.72, 340], [cx - hips * 0.5, 424], [cx - hips * 0.56, 446], [cx - 9, 446], [cx - 8, 424], [cx - 10, 340], [cx - 4, 262]];
  const outline = [...left, [cx, 254], ...left.slice().reverse().map(([x, yy]) => [2 * cx - x, yy])];
  const arm = side => {
    const top = cx + side * (shoulder - 5), out = side * 1;
    return smoothPath([[top, 86], [top + out * 12, 104], [top + out * 16, 170], [top + out * 18, 238], [top + out * 13, 262], [top + out * 4, 258], [top + out * 4, 236], [top + out * 1, 170], [cx + side * (chest - 1), 126]]);
  };
  const svgEl = s('svg', { viewBox: '0 0 220 460', class: 'xff-figure', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d: arm(-1), class: 'xff-figure__body' }), s('path', { d: arm(1), class: 'xff-figure__body' }),
    s('circle', { cx, cy: 36, r: female ? 20 : 22, class: 'xff-figure__body' }), s('path', { d: smoothPath(outline), class: 'xff-figure__body' }));
  const widths = { chest, waist, hips };
  for (const band of bands) {
    if (!TORSO.includes(band.measure)) continue;
    const rx = widths[band.measure] + 4, cy = y[band.measure], cls = `xff-band xff-band--${band.tone}${band.dashed ? ' xff-band--dashed' : ''}`;
    svgEl.append(s('path', { d: `M${cx - rx},${cy} A${rx},6 0 0 1 ${cx + rx},${cy}`, class: `${cls} xff-band--back` }),
      s('path', { d: `M${cx - rx},${cy} A${rx},6 0 0 0 ${cx + rx},${cy}`, class: cls }));
  }
  return svgEl;
}

// ---------------------------------------------------------------- icons (stroke drawings, currentColor)
const ICON = {
  tight: 'M3 12h6M6.5 9.5 9 12l-2.5 2.5M21 12h-6M17.5 9.5 15 12l2.5 2.5',
  loose: 'M9 12H3M5.5 9.5 3 12l2.5 2.5M15 12h6M18.5 9.5 21 12l-2.5 2.5',
  right: 'M5 12.5 9.5 17 19 7.5',
  close: 'M6 6l12 12M18 6 6 18',
  prev: 'M15 6l-6 6 6 6',
  next: 'M9 6l6 6-6 6',
  turn: 'M20 12a8 8 0 0 1-13.6 5.7M4 12a8 8 0 0 1 13.6-5.7M18 3v4h-4M6 21v-4h4',
  minus: 'M6 12h12',
  plus: 'M12 6v12M6 12h12',
  tshirt: 'M9 3.5 4 6l2 4.5 2-1V20h8V9.5l2 1L20 6l-5-2.5c-.4 1.5-1.6 2.5-3 2.5s-2.6-1-3-2.5z',
  hoodie: 'M8.5 4 4 6.5l1.8 4.5 2.2-1V20h8v-9.9l2.2 1L20 6.5 15.5 4M8.5 4c0 3 1.5 5.5 3.5 5.5S15.5 7 15.5 4M8.5 4a3.5 3.5 0 0 1 7 0M12 13v4',
  vest: 'M8.5 3.5 5 6v14h5.5v-7h3v7H19V6l-3.5-2.5L13.5 8h-3z',
};
const icon = (name, size = 20) => s('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: 'xff-icon' },
  s('path', { d: ICON[name], fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
const FIT_ICON = { tooTight: 'tight', snug: 'tight', right: 'right', loose: 'loose', tooLoose: 'loose' };
const SKIN_SWATCHES = ['#dcdcde', '#efc6ad', '#d9a07c', '#b77c56', '#8f5d3e', '#64412b', '#3b271b'];

// ---------------------------------------------------------------- the dialog
let current = null;
function ensureStyles() {
  if (document.getElementById('xff-styles')) return;
  document.head.append(h('style', { id: 'xff-styles', text: STYLES }));
}

function openDialog(root, options = {}) {
  const cfg = readConfig(root);
  if (!cfg) return;
  lang = pickLang(cfg.locale);
  ensureStyles();
  current?.close();
  const saved = loadProfile();
  const country = imperialCountry(cfg.country);
  const onlyWomen = cfg.charts.women && !cfg.charts.men && !cfg.charts.unisex;
  const state = {
    tab: 'finder', step: saved ? 'result' : 'you', mode: options.mode ?? 'finder', chosen: options.chosen, compare: null,
    errors: [], errorFields: [], draft: {}, chartCut: null, tapeOpen: null, pendingTape: {},
    p: saved ? { skin: 0, ...saved, tape: { ...saved.tape }, shape: { ...saved.shape } } : {
      sex: onlyWomen ? 'female' : 'male', heightCm: null, weightKg: null, age: null, shape: {}, tape: {}, fit: 'regular', layers: 'none', skin: 0,
      units: country ? { height: 'ft', weight: 'lb', length: 'in' } : { height: 'cm', weight: 'kg', length: 'cm' },
    },
  };
  if (!evaluate(cfg, state.p) && state.step === 'result') state.step = 'you';
  const opener = options.opener ?? document.activeElement;
  const titleId = nextId('title'), live = h('p', { class: 'xff-sr', 'aria-live': 'polite' });
  const dialog = h('dialog', { class: 'xff-dialog', 'aria-labelledby': titleId, lang });
  const view = h('div', { class: 'xff-stage__view' }, h('p', { class: 'xff-stage__loading', text: t('loadingBody') }));
  const stageTop = h('div', { class: 'xff-stage__top' }), stageBottom = h('div', { class: 'xff-stage__bottom' });
  const stage = h('section', { class: 'xff-stage' }, view, stageTop, stageBottom);
  const pane = h('section', { class: 'xff-pane' });
  dialog.append(h('div', { class: 'xff-shell' }, stage, pane), live);
  document.body.append(dialog);
  const scrollLock = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  let viewer = null;
  const close = () => { if (dialog.open) dialog.close(); };
  dialog.addEventListener('close', () => {
    document.documentElement.style.overflow = scrollLock;
    viewer?.destroy();
    dialog.remove();
    if (current?.dialog === dialog) current = null;
    decorateAll();
    if (opener && opener.isConnected) opener.focus();
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  current = { dialog, close };

  const chart = () => pickChart(cfg.charts, state.p.sex);
  const torsoMeasures = () => (chart()?.measures ?? []).filter(m => TORSO.includes(m));
  const steps = () => {
    const list = ['you'];
    const tapeAll = torsoMeasures().every(m => Number.isFinite(state.p.tape[m]));
    // Shape tunes the height-and-weight estimate: skipped when every torso measure came from a tape, or when the
    // shopper gave only tape values (no estimate to tune). Before step 1 is answered, count it in.
    const tapeOnlyAnswer = state.step !== 'you' && !state.p.heightCm;
    if (torsoMeasures().length && !tapeAll && !tapeOnlyAnswer) list.push('shape');
    list.push('ride');
    return list;
  };
  const save = () => saveProfile(state.p);
  const announce = text => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); };

  // ------------------------------------------------ the stage: the 3D body (or the flat drawing without WebGL)
  viewer = createViewer(view, { urls: cfg.bodies, label: t('stage3d'), onFail: () => { viewer?.destroy(); viewer = null; stage.classList.add('is-flat'); updateStage(); } });
  if (!viewer) stage.classList.add('is-flat');

  // What the body on screen shows right now: the answers so far, including numbers typed but not yet confirmed.
  function previewProfile() {
    const p = { ...state.p, tape: { ...state.p.tape }, shape: { ...state.p.shape } };
    if (state.tab === 'finder' && state.step === 'you') readDraft(p, state.draft, false);
    if (!(p.heightCm >= LIMITS.height[0] && p.heightCm <= LIMITS.height[1])) p.heightCm = null;
    if (!(p.weightKg >= LIMITS.weight[0] && p.weightKg <= LIMITS.weight[1])) p.weightKg = null;
    return p;
  }
  function stageRings(ev, name) {
    const size = ev.result.sizes.find(x => x.name === name) ?? ev.result.sizes.find(x => x.name === ev.result.best);
    return size.regions.filter(r => TORSO.includes(r.measure))
      .map(r => ({ measure: r.measure, tone: FIT_TONE[r.fit], text: `${t(r.measure)} · ${t(FIT_LABEL[r.fit])}`, icon: icon(FIT_ICON[r.fit], 14) }));
  }
  let stageTimer = 0;
  const updateStageSoon = () => { clearTimeout(stageTimer); stageTimer = setTimeout(updateStage, 180); };
  function updateStage() {
    const p = previewProfile(), ev = evaluate(cfg, p), b = bodyFrom(p);
    const resultLike = state.mode === 'guard' || (state.tab === 'finder' && state.step === 'result');
    let frame = 'full', rings = [], bottom = null, top = null;
    if (resultLike && ev) {
      const name = state.mode === 'guard' ? state.chosen : (state.compare ?? ev.result.best);
      frame = 'torso'; rings = stageRings(ev, name);
      top = h('p', { class: 'xff-stage__badge' }, name === ev.result.best ? t('yourSize', { size: name }) : t('showing', { size: name }));
      if (state.mode !== 'guard') bottom = sizeSwitcher(ev, name);
    } else if (state.tab === 'measure') {
      frame = 'torso';
      rings = torsoMeasures().map((m, i) => ({ measure: m, tone: 'guide', dashed: true, text: t('guideLabel', { n: i + 1, part: t(m) }) }));
    }
    if (!top && viewer) top = h('p', { class: 'xff-stage__hint' }, icon('turn', 16), t('dragToTurn'));
    if (!bottom && !resultLike) bottom = skinPicker();
    stage.dataset.frame = frame;
    stageTop.replaceChildren(...[top].filter(Boolean));
    stageBottom.replaceChildren(...[bottom].filter(Boolean));
    if (viewer) {
      viewer.setBody({ sex: p.sex, values: { height: p.heightCm ?? undefined, chest: b.values.chest, waist: b.values.waist, hips: b.values.hips }, weightKg: p.weightKg ?? undefined });
      viewer.setFrame(frame);
      viewer.setRings(rings);
      viewer.setSkin(state.p.skin ?? 0);
    } else {
      view.replaceChildren(figure(p.sex, b.values, rings.map(r => ({ measure: r.measure, tone: r.tone === 'guide' ? 'ok' : r.tone, dashed: r.dashed }))));
    }
  }

  function skinPicker() {
    return h('fieldset', { class: 'xff-skins' },
      h('legend', { class: 'xff-sr', text: t('skins') }),
      SKIN_SWATCHES.map((colour, i) => h('label', { class: 'xff-skin', style: `--xff-swatch:${colour}`, title: i ? t('skinTone', { n: i }) : t('skinMannequin') },
        h('input', { type: 'radio', name: 'xff-skin', id: `xff-skin-${i}`, value: i, checked: (state.p.skin ?? 0) === i, 'aria-label': i ? t('skinTone', { n: i }) : t('skinMannequin'),
          onchange: () => { state.p.skin = i; if (state.step === 'result') save(); viewer?.setSkin(i); } }))));
  }

  function sizeSwitcher(ev, name) {
    const sizes = ev.result.sizes, i = Math.max(0, sizes.findIndex(x => x.name === name));
    const go = j => { state.compare = sizes[j].name; render(`xff-size-${normalizeSize(sizes[j].name)}`); };
    const from = Math.max(0, Math.min(i - 1, sizes.length - 3));
    return h('div', { class: 'xff-sizebar', role: 'group', 'aria-label': t('trySizes') },
      h('button', { type: 'button', class: 'xff-sizebar__arrow', id: 'xff-size-prev', 'aria-label': t('smaller'), disabled: i === 0, onclick: () => go(i - 1) }, icon('prev', 18)),
      sizes.slice(from, from + 3).map(size => h('button', {
        type: 'button', id: `xff-size-${normalizeSize(size.name)}`, class: `xff-sizebar__size xff-sizebar__size--${size.verdict}${size.available === false ? ' is-sold' : ''}`,
        'aria-pressed': String(size.name === name), onclick: () => go(sizes.indexOf(size)),
      }, h('span', { text: size.name }), size.verdict === 'best' ? icon('right', 14) : size.verdict === 'no' ? icon('close', 12) : null,
      h('span', { class: 'xff-sr', text: `${size.verdict === 'best' ? t('bestTitle') : size.verdict === 'fits' ? t('alsoFits') : t('notRecommended')}${size.available === false ? `, ${t('soldOut')}` : ''}` }))),
      h('button', { type: 'button', class: 'xff-sizebar__arrow', id: 'xff-size-next', 'aria-label': t('larger'), disabled: i === sizes.length - 1, onclick: () => go(i + 1) }, icon('next', 18)));
  }

  // ------------------------------------------------ the pane
  let shownView = '';
  function render(focusId) {
    const active = focusId ?? document.activeElement?.id;
    dialog.dataset.view = state.mode === 'guard' ? 'guard' : state.tab === 'finder' && state.step === 'result' ? 'result' : 'steps';
    const parts = state.mode === 'guard' ? [header(), guardView()] : [header(), tabs(), panel()];
    pane.replaceChildren(...parts);
    updateStage();
    // A new step or tab starts at the top; an update in place (units, compare, shape) keeps the scroll position.
    const viewKey = `${state.mode}/${state.tab}/${state.step}`;
    const scroller = pane.querySelector('.xff-pane__body');
    if (viewKey !== shownView) { if (scroller) scroller.scrollTop = 0; shownView = viewKey; }
    const target = active ? dialog.querySelector(`#${CSS.escape(active)}`) : null;
    (target ?? pane.querySelector('[data-xff-focus]') ?? pane.querySelector('.xff-close'))?.focus({ preventScroll: true });
  }

  function header() {
    return h('div', { class: 'xff-header' },
      h('div', { class: 'xff-header__text' },
        h('h2', { id: titleId, class: 'xff-title', text: state.mode === 'guard' ? t('guardTitle') : t('title') }),
        h('p', { class: 'xff-muted', text: cfg.product.title })),
      h('button', { type: 'button', class: 'xff-close', 'aria-label': t('close'), onclick: close }, icon('close', 20)));
  }

  function tabs() {
    const list = [['finder', 'tabFinder'], ['chart', 'tabChart'], ['measure', 'tabMeasure']];
    return h('div', { class: 'xff-tabs', role: 'tablist' }, list.map(([key, label]) => h('button', {
      type: 'button', role: 'tab', id: `xff-tab-${key}`, class: 'xff-tab', 'aria-selected': String(state.tab === key), tabindex: state.tab === key ? '0' : '-1', 'aria-controls': 'xff-panel',
      text: t(label), onclick: () => { state.tab = key; render(`xff-tab-${key}`); },
      onkeydown: event => {
        const i = list.findIndex(([k]) => k === key), step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        state.tab = list[(i + step + list.length) % list.length][0];
        render(`xff-tab-${state.tab}`);
      },
    })));
  }

  function panel() {
    const view_ = state.tab === 'chart' ? [h('div', { class: 'xff-pane__body' }, chartView())] : state.tab === 'measure' ? [h('div', { class: 'xff-pane__body' }, measureView())] : finderView();
    return h('div', { class: 'xff-panel', id: 'xff-panel', role: 'tabpanel', 'aria-labelledby': `xff-tab-${state.tab}` }, view_);
  }

  // ------------------------------------------------ finder steps
  function finderView() {
    if (!chart()) return [h('div', { class: 'xff-pane__body' }, h('p', { class: 'xff-callout', text: t('noChart') }))];
    if (state.step === 'result') return resultView();
    const list = steps(), index = Math.max(0, list.indexOf(state.step)), total = list.length;
    const stepBody = state.step === 'shape' ? shapeStep() : state.step === 'ride' ? rideStep() : youStep();
    const names = { you: 'stepYou', shape: 'stepShape', ride: 'stepRide' };
    return [h('form', { class: 'xff-form', novalidate: true, onsubmit: event => { event.preventDefault(); goNext(); } },
      h('div', { class: 'xff-pane__body' },
        h('ol', { class: 'xff-stepper', 'aria-label': t('stepOf', { n: index + 1, total }) }, list.map((key, i) => h('li', {
          class: `xff-stepper__item${i < index ? ' is-done' : i === index ? ' is-current' : ''}`, 'aria-current': i === index ? 'step' : null,
        }, h('span', { class: 'xff-stepper__dot', 'aria-hidden': 'true' }, i < index ? icon('right', 12) : String(i + 1)), h('span', { class: 'xff-stepper__name', text: t(names[key]) })))),
        h('h3', { class: 'xff-heading', tabindex: '-1', 'data-xff-focus': true, text: t(names[state.step]) }),
        state.errors.length ? h('div', { class: 'xff-errors', role: 'alert' }, state.errors.map(e => h('p', { text: e }))) : null,
        stepBody),
      h('div', { class: 'xff-footer' },
        index > 0 ? h('button', { type: 'button', class: 'xff-button xff-button--secondary', id: 'xff-back', text: t('back'), onclick: () => { state.errors = []; state.step = list[index - 1]; render(); } }) : h('span'),
        h('button', { type: 'submit', class: 'xff-button', id: 'xff-next', text: index === total - 1 ? t('seeSize') : t('next') })))];
  }

  function radioGroup({ legend, name, value, options, onChange, hiddenLegend, className = 'xff-segments' }) {
    return h('fieldset', { class: `xff-field ${className}` },
      h('legend', { class: hiddenLegend ? 'xff-sr' : 'xff-label', text: legend }),
      h('div', { class: 'xff-segments__row' }, options.map(([key, label, extra, iconName]) => {
        const id = `xff-${name}-${key}`;
        return h('label', { class: 'xff-segment', for: id },
          h('input', { type: 'radio', id, name: `xff-${name}`, value: key, checked: String(value) === String(key), onchange: () => onChange(key) }),
          h('span', { class: 'xff-segment__text' }, iconName ? icon(iconName, 26) : null, h('span', { class: 'xff-segment__title', text: label }), extra ? h('small', { text: extra }) : null));
      })));
  }

  function numberField({ id, label, value, unit, onInput, describedBy, invalid, units }) {
    return h('div', { class: 'xff-field' },
      h('label', { class: 'xff-label', for: id, text: label }),
      h('div', { class: 'xff-input-row' },
        h('span', { class: 'xff-input-group' },
          h('input', { id, class: 'xff-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: value ?? '', 'aria-describedby': describedBy, 'aria-invalid': invalid ? 'true' : null, oninput: event => onInput(event.target.value) }),
          unit ? h('span', { class: 'xff-unit', text: unit }) : null),
        units ?? null));
  }

  function unitSwitch(name, value, options, onChange) {
    return h('div', { class: 'xff-units', role: 'group', 'aria-label': options.map(o => o[1]).join(' / ') }, options.map(([key, label]) =>
      h('button', { type: 'button', id: `xff-unit-${name}-${key}`, class: 'xff-unit-button', 'aria-pressed': String(value === key), text: label, onclick: () => { onChange(key); render(`xff-unit-${name}-${key}`); } })));
  }

  function youStep() {
    const p = state.p, d = state.draft, errs = new Set(state.errorFields ?? []);
    const typed = key => value => { d[key] = value; updateStageSoon(); };
    const heightUnits = unitSwitch('height', p.units.height, [['cm', 'cm'], ['ft', `${t('feet')}/${t('inches')}`]], u => { readDraft(state.p, state.draft); p.units.height = u; });
    const weightUnits = unitSwitch('weight', p.units.weight, [['kg', 'kg'], ['lb', 'lb']], u => { readDraft(state.p, state.draft); p.units.weight = u; });
    const heightField = p.units.height === 'ft'
      ? h('div', { class: 'xff-field' }, h('span', { class: 'xff-label', id: 'xff-height-label', text: t('height') }),
        h('div', { class: 'xff-input-row' },
          h('span', { class: 'xff-input-group' },
            h('input', { id: 'xff-height-ft', class: 'xff-input xff-input--short', type: 'text', inputmode: 'numeric', 'aria-labelledby': 'xff-height-label xff-height-ft-unit', value: d.ft ?? (p.heightCm ? Math.floor(p.heightCm / CM_PER_IN / 12) : ''), 'aria-invalid': errs.has('height') ? 'true' : null, oninput: e => typed('ft')(e.target.value) }),
            h('span', { class: 'xff-unit', id: 'xff-height-ft-unit', text: t('feet') })),
          h('span', { class: 'xff-input-group' },
            h('input', { id: 'xff-height-in', class: 'xff-input xff-input--short', type: 'text', inputmode: 'decimal', 'aria-labelledby': 'xff-height-label xff-height-in-unit', value: d.in ?? (p.heightCm ? Math.round((p.heightCm / CM_PER_IN) % 12) : ''), 'aria-invalid': errs.has('height') ? 'true' : null, oninput: e => typed('in')(e.target.value) }),
            h('span', { class: 'xff-unit', id: 'xff-height-in-unit', text: t('inches') })), heightUnits))
      : numberField({ id: 'xff-height', label: t('height'), value: d.height ?? (p.heightCm ? fmt(p.heightCm) : ''), unit: 'cm', invalid: errs.has('height'), onInput: typed('height'), units: heightUnits });
    const weightValue = d.weight ?? (p.weightKg ? fmt(p.units.weight === 'lb' ? p.weightKg / KG_PER_LB : p.weightKg) : '');
    const tapeMeasures = chart().measures.filter(m => m !== 'height');
    const lengthUnits = unitSwitch('length', p.units.length, [['cm', 'cm'], ['in', 'in']], u => { readDraft(state.p, state.draft); p.units.length = u; });
    d.tape ??= {};
    const hintId = 'xff-tape-hint';
    const tapeOpen = state.tapeOpen ?? tapeMeasures.some(m => Number.isFinite(p.tape[m]));
    return h('div', { class: 'xff-stack' },
      radioGroup({ legend: t('body'), name: 'sex', value: p.sex, hiddenLegend: true, className: 'xff-segments xff-segments--big', options: [['male', t('man')], ['female', t('woman')]], onChange: v => { readDraft(state.p, state.draft); p.sex = v; render(`xff-sex-${v}`); } }),
      h('div', { class: 'xff-pair' },
        heightField,
        numberField({ id: 'xff-weight', label: t('weight'), value: weightValue, unit: p.units.weight, invalid: errs.has('weight'), onInput: typed('weight'), units: weightUnits })),
      numberField({ id: 'xff-age', label: t('age'), value: d.age ?? (p.age ?? ''), unit: t('years'), invalid: errs.has('age'), onInput: typed('age') }),
      h('details', { class: 'xff-details', open: tapeOpen, ontoggle: e => { state.tapeOpen = e.target.open; } },
        h('summary', { class: 'xff-summary', id: 'xff-tape-toggle' }, h('span', { text: t('tape') })),
        h('p', { class: 'xff-muted', id: hintId, text: t('tapeHint') }),
        h('div', { class: 'xff-grid' }, tapeMeasures.map(m => numberField({
          id: `xff-tape-${m}`, label: t(m), unit: p.units.length, describedBy: hintId, invalid: errs.has(m),
          value: d.tape[m] ?? (Number.isFinite(p.tape[m]) ? fmt(toUnit(p.tape[m], p.units.length), 1) : ''), onInput: v => { d.tape[m] = v; updateStageSoon(); },
        }))),
        h('div', { class: 'xff-row' }, lengthUnits, h('button', { type: 'button', class: 'xff-link', text: t('tabMeasure'), onclick: () => { state.tab = 'measure'; render('xff-tab-measure'); } }))));
  }

  // Moves what was typed (in the units on screen) into a profile, in cm and kg. clear: empty the draft afterwards.
  function readDraft(p, d, clear = true) {
    if (d.height !== undefined) p.heightCm = parseNum(d.height);
    if (d.ft !== undefined || d.in !== undefined) {
      const ft = parseNum(d.ft ?? (p.heightCm ? Math.floor(p.heightCm / CM_PER_IN / 12) : null)), inch = parseNum(d.in ?? 0) ?? 0;
      p.heightCm = ft == null ? null : Math.round((ft * 12 + inch) * CM_PER_IN);
    }
    if (d.weight !== undefined) { const w = parseNum(d.weight); p.weightKg = w == null ? null : Math.round((p.units.weight === 'lb' ? w * KG_PER_LB : w) * 10) / 10; }
    if (d.age !== undefined) p.age = parseNum(d.age);
    for (const [m, v] of Object.entries(d.tape ?? {})) { const n = parseNum(v); p.tape[m] = n == null ? null : Math.round((p.units.length === 'in' ? n * CM_PER_IN : n) * 10) / 10; }
    if (clear) state.draft = {};
  }

  // Reads step 1 into the profile. Returns false (with messages) when the answers cannot work.
  function commitYou() {
    readDraft(state.p, state.draft);
    const p = state.p, errors = [], fields = [];
    const needed = chart().measures.filter(m => m !== 'height');
    const tapeAll = needed.every(m => Number.isFinite(p.tape[m]) && p.tape[m] > 0);
    const hasBasics = p.heightCm != null || p.weightKg != null;
    if (hasBasics || !tapeAll) {
      const problems = validateInputs({ heightCm: p.heightCm, weightKg: p.weightKg, age: p.age });
      const hr = p.units.height === 'ft' ? ["4'0\"", "7'6\""] : [`${LIMITS.height[0]} cm`, `${LIMITS.height[1]} cm`];
      const wr = p.units.weight === 'lb' ? [`${Math.round(LIMITS.weight[0] / KG_PER_LB)} lb`, `${Math.round(LIMITS.weight[1] / KG_PER_LB)} lb`] : [`${LIMITS.weight[0]} kg`, `${LIMITS.weight[1]} kg`];
      if (problems.includes('height')) { errors.push(t('errHeight', { min: hr[0], max: hr[1] })); fields.push('height'); }
      if (problems.includes('weight')) { errors.push(t('errWeight', { min: wr[0], max: wr[1] })); fields.push('weight'); }
      if (problems.includes('age')) { errors.push(t('errAge')); fields.push('age'); }
      if (!hasBasics && !tapeAll) { errors.length = 0; fields.length = 0; errors.push(t('errNeed')); fields.push('height', 'weight'); }
    } else if (p.age != null && validateInputs({ heightCm: 170, weightKg: 70, age: p.age }).includes('age')) { errors.push(t('errAge')); fields.push('age'); }
    for (const m of needed) if (p.tape[m] != null && !(p.tape[m] >= 10 && p.tape[m] <= 250)) { errors.push(`${t(m)}: ${t('errNeed')}`); fields.push(m); }
    state.errors = errors; state.errorFields = fields;
    return !errors.length;
  }

  function shapeStep() {
    const p = state.p, names = TEXT[lang]?.shapeSteps ?? TEXT.en.shapeSteps;
    const rows = torsoMeasures().filter(m => !Number.isFinite(p.tape[m])).map(m => {
      const value = Number(p.shape[m] ?? 0), id = `xff-shape-${m}`, valueId = `${id}-value`;
      const set = (next, focus) => {
        const v = Math.max(-2, Math.min(2, next));
        p.shape[m] = v;
        const range = pane.querySelector(`#${id}`), out = pane.querySelector(`#${valueId}`);
        if (range) { range.value = String(v); range.setAttribute('aria-valuetext', names[v + 2]); range.style.setProperty('--xff-fill', `${((v + 2) / 4) * 100}%`); }
        if (out) out.textContent = names[v + 2];
        if (focus) pane.querySelector(`#${focus}`)?.focus();
        updateStage();
      };
      return h('div', { class: 'xff-field xff-shape' },
        h('div', { class: 'xff-shape__head' }, h('label', { class: 'xff-label', for: id, text: t(m) }), h('span', { class: 'xff-shape__value', id: valueId, 'aria-hidden': 'true', text: names[value + 2] })),
        h('div', { class: 'xff-shape__row' },
          h('button', { type: 'button', class: 'xff-round', id: `${id}-less`, 'aria-label': `${t(m)}: ${t('narrower')}`, onclick: () => set(Number(p.shape[m] ?? 0) - 1, `${id}-less`) }, icon('minus', 18)),
          h('input', { type: 'range', class: 'xff-range', id, min: -2, max: 2, step: 1, value, 'aria-valuetext': names[value + 2], style: `--xff-fill:${((value + 2) / 4) * 100}%`, oninput: e => set(Number(e.target.value)) }),
          h('button', { type: 'button', class: 'xff-round', id: `${id}-more`, 'aria-label': `${t(m)}: ${t('broader')}`, onclick: () => set(Number(p.shape[m] ?? 0) + 1, `${id}-more`) }, icon('plus', 18))),
        h('div', { class: 'xff-shape__ends', 'aria-hidden': 'true' }, h('span', { text: t('narrower') }), h('span', { text: t('broader') })));
    });
    return h('div', { class: 'xff-stack' }, h('p', { class: 'xff-muted', text: t('shapeIntro') }), rows);
  }

  function rideStep() {
    const p = state.p;
    return h('div', { class: 'xff-stack' },
      radioGroup({ legend: t('fitQuestion'), name: 'fit', value: p.fit, className: 'xff-cards', options: [['snug', t('snug'), t('snugText')], ['regular', t('regular'), t('regularText')], ['relaxed', t('relaxed'), t('relaxedText')]], onChange: v => { p.fit = v; } }),
      chart().measures.includes('chest') ? radioGroup({ legend: t('layersQuestion'), name: 'layers', value: p.layers, className: 'xff-cards xff-cards--icons', options: [['none', t('none'), null, 'tshirt'], ['hoodie', t('hoodie'), null, 'hoodie'], ['protector', t('protector'), null, 'vest']], onChange: v => { p.layers = v; } }) : null);
  }

  function goNext() {
    if (state.step === 'you' && !commitYou()) { render('xff-next'); return; }
    state.errors = [];
    const fresh = steps(), i = fresh.indexOf(state.step);
    if (i < fresh.length - 1 && i >= 0) { state.step = fresh[i + 1]; render(); return; }
    if (i < 0) { state.step = fresh[fresh.length - 1]; render(); return; }
    save();
    state.step = 'result'; state.compare = null;
    render();
    const ev = evaluate(cfg, state.p);
    if (ev) announce(`${t('bestTitle')}: ${ev.result.best}. ${t('match', { n: ev.result.confidence })}.`);
  }

  // ------------------------------------------------ result
  function gauge(n) {
    const r = 26, c = 2 * Math.PI * r;
    return h('div', { class: 'xff-gauge', role: 'img', 'aria-label': t('match', { n }) },
      s('svg', { viewBox: '0 0 64 64', width: 64, height: 64, 'aria-hidden': 'true' },
        s('circle', { cx: 32, cy: 32, r, class: 'xff-gauge__track' }),
        s('circle', { cx: 32, cy: 32, r, class: 'xff-gauge__fill', 'stroke-dasharray': `${(c * n) / 100} ${c}`, transform: 'rotate(-90 32 32)' })),
      h('span', { class: 'xff-gauge__value', 'aria-hidden': 'true', text: `${n}%` }));
  }

  function resultView() {
    const ev = evaluate(cfg, state.p);
    if (!ev) { state.step = 'you'; return finderView(); }
    const { result, body, chart: c } = ev, unit = state.p.units.length;
    const shown = result.sizes.find(x => x.name === (state.compare ?? result.best)) ?? result.sizes.find(x => x.name === result.best);
    const best = result.sizes.find(x => x.name === result.best);
    const estimated = body.mode !== 'measured';
    const needsTape = estimated && result.confidence < 85;
    const ctaSize = shown.verdict === 'no' ? best : shown;
    const soldOut = ctaSize.available === false;
    const regions = h('ul', { class: 'xff-regions', 'aria-label': `${t('size')} ${shown.name}` }, shown.regions.map(r => h('li', { class: `xff-region xff-region--${FIT_TONE[r.fit]}` },
      h('span', { class: 'xff-region__icon' }, icon(FIT_ICON[r.fit], 16)),
      h('span', { class: 'xff-region__name', text: t(r.measure) }),
      h('strong', { class: 'xff-region__fit', text: t(FIT_LABEL[r.fit]) }),
      h('span', { class: 'xff-region__detail', text: `${estimated && !Number.isFinite(state.p.tape[r.measure]) ? t('youAbout', { v: lengthText(r.value, unit) }) : `${t('you')} ${lengthText(r.value, unit)}`} · ${t('sizeRange', { size: shown.name, range: rangeText(r.range, unit) })}` }))));
    const callouts = [];
    if (result.outOfRange) callouts.push(h('div', { class: 'xff-callout xff-callout--bad', role: 'note' }, h('p', { text: t(result.outOfRange) }), h('a', { class: 'xff-link', href: cfg.contactUrl, text: t('contact') })));
    if (best.available === false) callouts.push(h('p', { class: 'xff-callout', text: t('bestSoldOut', { size: best.name }) }));
    if (body.warnings.includes('outsideModel')) callouts.push(h('p', { class: 'xff-callout xff-callout--warn', text: t('outsideModel') }));
    if (needsTape) callouts.push(tapeCallout(c));
    return [
      h('div', { class: 'xff-pane__body' },
        h('div', { class: 'xff-verdict' },
          h('div', { class: 'xff-verdict__size' }, h('span', { text: t('bestTitle') }), h('strong', { tabindex: '-1', 'data-xff-focus': true, text: result.best })),
          gauge(result.confidence),
          h('div', { class: 'xff-verdict__text' },
            h('strong', { text: t('match', { n: result.confidence }) }),
            h('span', { class: 'xff-muted', text: result.runnerUp && result.runnerUp.share >= 25 ? t('between', { a: result.best, b: result.runnerUp.name }) : result.confidence >= 85 ? t('verdictSure') : '' }))),
        cutNote(c),
        shown.name !== result.best ? h('p', { class: 'xff-showing', text: t('showing', { size: shown.name }) }) : null,
        regions,
        callouts,
        h('p', { class: 'xff-muted xff-privacy' }, t('privacy'), ' ', h('button', { type: 'button', class: 'xff-link', id: 'xff-forget', text: t('forget'), onclick: forget }))),
      h('div', { class: 'xff-footer xff-footer--result' },
        h('button', { type: 'button', class: 'xff-button xff-button--wide', id: 'xff-add', disabled: soldOut, text: soldOut ? `${ctaSize.name} · ${t('soldOut')}` : t('addToCart', { size: ctaSize.name }), onclick: () => addToCart(ctaSize.name) }),
        h('div', { class: 'xff-footer__row' },
          h('button', { type: 'button', class: 'xff-button xff-button--secondary', id: 'xff-choose', disabled: soldOut, text: t('select', { size: ctaSize.name }), onclick: () => choose(ctaSize.name) }),
          h('button', { type: 'button', class: 'xff-link', id: 'xff-edit', text: t('edit'), onclick: () => { state.step = 'you'; state.errors = []; render(); } }))),
    ];
  }

  function cutNote(c) {
    const one = Object.keys(cfg.charts).length === 1;
    if (!one || !c.cut || (c.cut === 'men' && state.p.sex === 'male') || (c.cut === 'women' && state.p.sex === 'female')) return null;
    return h('p', { class: 'xff-muted', text: t('cutNote', { cut: t(c.cut === 'women' ? 'women' : 'men') }) });
  }

  function tapeCallout(c) {
    const p = state.p, unit = p.units.length, missing = c.measures.filter(m => m !== 'height' && !Number.isFinite(p.tape[m]));
    const apply = () => {
      for (const [m, v] of Object.entries(state.pendingTape ?? {})) { const n = parseNum(v); if (n != null && n > 0) p.tape[m] = Math.round((unit === 'in' ? n * CM_PER_IN : n) * 10) / 10; }
      state.pendingTape = {}; state.compare = null; save(); render('xff-tape-apply');
      const ev = evaluate(cfg, p); if (ev) announce(`${t('bestTitle')}: ${ev.result.best}. ${t('match', { n: ev.result.confidence })}.`);
    };
    return h('form', { class: 'xff-callout xff-callout--tape', novalidate: true, onsubmit: event => { event.preventDefault(); apply(); } },
      h('p', { text: t('measureToBeSure') }),
      h('div', { class: 'xff-grid' }, missing.map(m => numberField({
        id: `xff-result-tape-${m}`, label: t(m), unit, value: '',
        onInput: v => { state.pendingTape = { ...state.pendingTape, [m]: v }; },
      }))),
      h('div', { class: 'xff-row' },
        h('button', { type: 'submit', class: 'xff-button xff-button--secondary', id: 'xff-tape-apply', text: t('seeSize') }),
        h('button', { type: 'button', class: 'xff-link', text: t('tabMeasure'), onclick: () => { state.tab = 'measure'; render('xff-tab-measure'); } })));
  }

  function choose(name) {
    save();
    const picked = selectSize(cfg, name);
    close();
    if (picked) afterSizeChange(cfg, t('chosen', { size: name }));
  }

  // Select the size, wait for Impact to load that variant, then send the product form (the check is skipped:
  // this is the size the finder recommends or one that also fits).
  function addToCart(name) {
    save();
    const before = selectedSize(cfg), change = normalizeSize(before) !== normalizeSize(name);
    const submit = () => {
      const form = document.getElementById(cfg.formId);
      if (!form) return;
      form.dataset.xffBypass = '1';
      form.requestSubmit();
    };
    close();
    if (!change) { submit(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; document.removeEventListener('variant:change', finish); clearTimeout(timer); requestAnimationFrame(submit); };
    const timer = setTimeout(finish, 4000);
    document.addEventListener('variant:change', finish);
    if (!selectSize(cfg, name)) finish();
  }

  function forget() {
    forgetProfile();
    state.p = { ...state.p, heightCm: null, weightKg: null, age: null, shape: {}, tape: {} };
    state.step = 'you'; state.draft = {};
    render();
    announce(t('forgotten'));
  }

  // ------------------------------------------------ size chart and how to measure
  function chartView() {
    const cuts = Object.keys(cfg.charts), unit = state.p.units.length;
    const cut = state.chartCut ?? (cfg.charts[state.p.sex === 'female' ? 'women' : 'men'] ? (state.p.sex === 'female' ? 'women' : 'men') : cuts[0]);
    const c = cfg.charts[cut], ev = evaluate(cfg, state.p), bestName = ev && pickChart(cfg.charts, state.p.sex) === c ? ev.result.best : null;
    return h('div', { class: 'xff-stack' },
      h('div', { class: 'xff-row' },
        cuts.length > 1 ? unitSwitch('cut', cut, cuts.map(k => [k, t(k === 'women' ? 'women' : 'men')]), k => { state.chartCut = k; }) : h('span'),
        unitSwitch('chart-length', unit, [['cm', 'cm'], ['in', 'in']], u => { state.p.units.length = u; })),
      h('div', { class: 'xff-table-wrap', tabindex: '0', role: 'region', 'aria-label': t('tabChart') },
        h('table', { class: 'xff-table' },
          h('caption', { class: 'xff-muted', text: t('bodyNote', { unit }) }),
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: t('size') }), c.measures.map(m => h('th', { scope: 'col', text: t(m) })))),
          h('tbody', {}, c.sizes.map(size => h('tr', { class: size.name === bestName ? 'xff-table__best' : null, 'aria-current': size.name === bestName ? 'true' : null },
            h('th', { scope: 'row' }, size.name, size.name === bestName ? h('span', { class: 'xff-badge', text: t('bestTitle') }) : null),
            c.measures.map(m => h('td', { text: rangeText(size[m], unit).replace(` ${unit}`, '') }))))))));
  }

  function measureView() {
    const c = chart(), measures = (c?.measures ?? ['chest', 'waist']).filter(m => HOW[m]);
    return h('div', { class: 'xff-stack' },
      h('ol', { class: 'xff-how' }, measures.map(m => h('li', {}, h('strong', { text: t(m) }), h('p', { text: t(HOW[m]) })))),
      h('p', { class: 'xff-callout', text: t('measureTips') }));
  }

  // ------------------------------------------------ add-to-cart check
  function guardView() {
    const ev = evaluate(cfg, state.p), verdict = ev && verdictFor(ev.result, state.chosen);
    if (!ev || !verdict) return h('div', { class: 'xff-pane__body' }, h('p', { text: t('noChart') }));
    const worst = worstRegion(verdict);
    return h('div', { class: 'xff-pane__body xff-guard' },
      h('p', { class: 'xff-guard__text', 'data-xff-focus': true, tabindex: '-1', text: t('guardText', { chosen: state.chosen, fit: lowerFit(worst.fit), part: t(worst.measure).toLowerCase(), best: ev.result.best }) }),
      h('div', { class: 'xff-footer xff-footer--result' },
        h('button', { type: 'button', class: 'xff-button xff-button--wide', id: 'xff-switch', text: t('switchTo', { best: ev.result.best }), onclick: () => {
          const picked = selectSize(cfg, ev.result.best);
          close();
          if (picked) afterSizeChange(cfg, t('chosen', { size: ev.result.best }));
        } }),
        h('div', { class: 'xff-footer__row' },
          h('button', { type: 'button', class: 'xff-button xff-button--secondary', id: 'xff-keep', text: t('keep', { chosen: state.chosen }), onclick: () => {
            const form = document.getElementById(cfg.formId);
            close();
            if (form) { form.dataset.xffBypass = '1'; form.requestSubmit(options.submitter && options.submitter.form === form ? options.submitter : undefined); }
          } }),
          h('button', { type: 'button', class: 'xff-link', id: 'xff-why', text: t('edit'), onclick: () => { state.mode = 'finder'; state.step = 'result'; state.compare = state.chosen; render(); } }))));
  }

  render();
  dialog.showModal();
  (pane.querySelector('[data-xff-focus]') ?? pane.querySelector('.xff-close'))?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- entry points used by the boot script
let started = false;
/** Shows "Your size" on every size option and arms the add-to-cart check. Safe to call more than once. */
export function init() {
  if (started) { decorateAll(); return; }
  started = true;
  decorateAll();
  document.addEventListener('submit', onSubmit, true);
  // Impact re-renders the variant picker after each choice: decorate the new copy, and react to size changes.
  document.addEventListener('variant:change', decorateAll);
  new MutationObserver(records => {
    if (records.some(r => Array.from(r.addedNodes).some(n => n.nodeType === 1 && (n.matches?.('[data-xff]') || n.querySelector?.('[data-xff]'))))) decorateAll();
  }).observe(document.body, { childList: true, subtree: true });
}
/** Opens the dialog for the size option this button belongs to. */
export function open(button) {
  init();
  const root = button.closest('[data-xff]');
  if (root) openDialog(root, { opener: button });
}
