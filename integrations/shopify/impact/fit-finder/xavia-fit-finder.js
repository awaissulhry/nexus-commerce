// Xavia fit finder: the size guide dialog (size chart, then height / weight / age, body shape and the result on a 3D
// mannequin), the size warning under the size option, and the add-to-cart check. The layout follows the fit finders
// shoppers know from big motorcycle-gear stores. The inline boot in snippets/xavia-fit-finder.liquid loads this module
// on the first click, or at idle time when this device has a saved fit profile. build.mjs joins it with the engine,
// texts, 3D body and viewer code and the CSS into one theme asset; the two bodies are separate assets, loaded on open.
import { estimateBody, measuredBody, combineBody, pickChart, chartsForProduct, recommend, validateInputs, verdictFor, normalizeSize, LIMITS } from './xavia-fit-engine.js';
import { TEXT } from './xavia-fit-i18n.js';
import { createViewer, SWATCHES } from './xavia-fit-viewer.js';

const STYLES = '__XFF_CSS__';
const STORE = 'xavia-fit-profile';
const TORSO = ['chest', 'waist', 'hips'];
const FIT_TEXT = { tooTight: 'fitTooTight', snug: 'fitSnug', right: 'fitRight', loose: 'fitLoose', tooLoose: 'fitTooLoose' };
const FIT_TONE = { tooTight: 'bad', snug: 'ok', right: 'ok', loose: 'ok', tooLoose: 'bad' };
const FIT_ICON = { tooTight: 'tight', snug: 'tight', right: 'right', loose: 'loose', tooLoose: 'loose' };
const FIT_EN = { tooTight: 'too tight', snug: 'slightly tight', right: 'just right', loose: 'slightly loose', tooLoose: 'too loose' };
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
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
// replaceChildren with the same rules as h(): nested lists are opened, null and false are left out.
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(kid => kid != null && kid !== false));
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
const fmt = (n, digits = 0, least = 0) => new Intl.NumberFormat(lang, { maximumFractionDigits: digits, minimumFractionDigits: least }).format(n);
// Ranges with an en dash; inches always with one decimal, so a column lines up.
const rangeText = ([lo, hi], unit) => (unit === 'in' ? `${fmt(lo / CM_PER_IN, 1, 1)} – ${fmt(hi / CM_PER_IN, 1, 1)}` : `${fmt(lo, 1)} – ${fmt(hi, 1)}`);
// Height in feet and inches (whole inches).
const feetInches = cm => { const total = Math.round(cm / CM_PER_IN); return [Math.floor(total / 12), total % 12]; };
const imperialCountry = country => ['US', 'GB', 'LR', 'MM'].includes(String(country || '').toUpperCase());

// ---------------------------------------------------------------- saved profiles (this device only)
// { v: 2, active: id, profiles: [{ id, name, sex, heightCm, weightKg, age, shape, tape, fit, layers, skin, units }] }
// Version 1 (one profile, earlier releases) is read as a list of one.
function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (raw?.v === 1) return { v: 2, active: 'p1', profiles: [{ ...raw, v: undefined, id: 'p1', name: '' }] };
    return raw?.v === 2 && Array.isArray(raw.profiles) ? raw : null;
  } catch { return null; }
}
function writeStore(store) {
  try { if (store.profiles.length) localStorage.setItem(STORE, JSON.stringify(store)); else localStorage.removeItem(STORE); } catch { /* private mode */ }
}
function loadProfile() { const store = loadStore(); return store?.profiles.find(p => p.id === store.active) ?? null; }
function saveProfile(p) {
  const store = loadStore() ?? { v: 2, active: p.id, profiles: [] };
  const i = store.profiles.findIndex(x => x.id === p.id);
  if (i >= 0) store.profiles[i] = p; else store.profiles.push(p);
  store.active = p.id;
  writeStore(store);
}
function deleteProfile(id) {
  const store = loadStore();
  if (!store) return;
  store.profiles = store.profiles.filter(p => p.id !== id);
  store.active = store.profiles[0]?.id ?? null;
  writeStore(store);
}
const newProfile = (cfg, sex) => ({
  id: `p${Date.now().toString(36)}`, name: '', sex, heightCm: null, weightKg: null, age: null, shape: {}, tape: {}, fit: 'regular', layers: 'none', skin: 0,
  units: imperialCountry(cfg.country) ? { height: 'ft', weight: 'lb', length: 'in' } : { height: 'cm', weight: 'kg', length: 'cm' },
});

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

const worstRegion = verdict => verdict.regions.find(r => r.fit === 'tooTight') ?? verdict.regions.find(r => r.fit === 'tooLoose') ?? verdict.regions.find(r => r.fit !== 'right');
const lowerFit = fit => (fit === 'tooTight' ? t('tooTightLower') : fit === 'tooLoose' ? t('tooLooseLower') : t(FIT_TEXT[fit]));

/** The warning under the size buttons when the chosen size will not fit this device's shopper. */
function decorate(root) {
  const cfg = readConfig(root);
  if (!cfg) return;
  lang = pickLang(cfg.locale);
  if (!Object.keys(cfg.charts).length) { root.hidden = true; return; }
  const fieldset = root.closest('fieldset') ?? root.parentElement;
  let hint = fieldset?.querySelector(':scope > [data-xff-hint]');
  const p = loadProfile(), ev = p && evaluate(cfg, p);
  const chosen = ev && selectedSize(cfg), verdict = chosen && verdictFor(ev.result, chosen);
  const text = verdict && verdict.verdict === 'no' ? t('notForYou', { size: chosen, fit: lowerFit(worstRegion(verdict).fit) }) : '';
  if (!text) { hint?.remove(); return; }
  if (!hint && fieldset) { hint = h('p', { class: 'xff-page-hint', 'data-xff-hint': true, role: 'status' }); fieldset.append(hint); }
  if (hint) hint.textContent = text;
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
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  menu: 'M3 6h18M3 12h18M3 18h18',
  cart: 'M3 4h2.5l2.2 10.2a1.5 1.5 0 0 0 1.5 1.2h7.9a1.5 1.5 0 0 0 1.4-1l1.9-6.4H6.4M10 20.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1zM17 20.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z',
  warn: 'M12 6.5v7M12 17v.5',
  tape: 'M2.5 12.5a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0M6.5 12.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M8 18h14v-4h-8.6M17 18v-1.8M20 18v-1.8',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
};
const icon = (name, size = 20, width = 1.8) => s('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: 'xff-icon' },
  s('path', { d: ICON[name], fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));

// ---------------------------------------------------------------- the dialog
let current = null;
function ensureStyles(cfg) {
  if (document.getElementById('xff-styles')) return;
  document.head.append(h('style', { id: 'xff-styles', text: STYLES }));
  // The dialog's own copy of Inter (theme asset), under its own name so the theme's fonts stay as they are.
  if (cfg.font && 'FontFace' in window) {
    const face = new FontFace('Xavia Fit Inter', `url(${JSON.stringify(cfg.font)}) format('woff2')`, { weight: '100 900', display: 'swap' });
    document.fonts.add(face);
    face.load().catch(() => { /* the system font stands in */ });
  }
}
// The full-screen layout, with 44 px touch targets: phones, tablets, any touch screen, and any window too narrow or too
// low for the 907 x 500 modal (also browser zoom).
const PHONE_LAYOUT = '(max-width: 899px), (max-height: 559px), (pointer: coarse)';
const phone = () => window.matchMedia?.(PHONE_LAYOUT).matches ?? false;
const HEADING = '\u0000heading';   // render(HEADING): focus the new screen's heading

/**
 * options.screen: 'chart' (the size guide, the default from the product page) or 'finder' (first step, or the
 * result when this device has a profile); options.mode 'guard' = the add-to-cart check for options.chosen.
 */
function openDialog(root, options = {}) {
  const cfg = readConfig(root);
  if (!cfg) return;
  lang = pickLang(cfg.locale);
  ensureStyles(cfg);
  current?.close();
  const saved = loadProfile();
  const onlyWomen = cfg.charts.women && !cfg.charts.men && !cfg.charts.unisex;
  const state = {
    screen: options.mode === 'guard' ? 'guard' : 'chart', chosen: options.chosen, compare: null, panel: null,
    errors: {}, draft: {}, chartCut: null, showSkins: false, ageTip: false, confirmDelete: false, returnTo: null,
    p: saved ? { skin: 0, ...saved, tape: { ...saved.tape }, shape: { ...saved.shape }, units: { ...saved.units } } : newProfile(cfg, onlyWomen ? 'female' : 'male'),
  };
  if (state.p.units.height === 'in') state.p.units.height = 'ft';   // earlier releases: decimal inches
  const opener = options.opener ?? document.activeElement;
  const titleId = nextId('title'), live = h('p', { class: 'xff-sr', 'aria-live': 'polite' });

  // Fixed parts of the modal; each screen fills .xff-content and the CSS shows what the screen uses.
  const dialog = h('dialog', { class: 'xff-dialog', 'aria-label': t('sizeGuide'), lang });
  const view = h('div', { class: 'xff-stage__view' });
  const stage = h('div', { class: 'xff-stage' }, view);
  const media = h('div', { class: 'xff-media' }, cfg.product.image ? h('img', { src: cfg.product.image, alt: '', loading: 'lazy' }) : null);
  const logo = h('div', { class: 'xff-logo' }, cfg.logo ? h('img', { src: cfg.logo, alt: cfg.shop || '' }) : h('span', { text: cfg.shop || '' }));
  const sideTab = h('button', { type: 'button', class: 'xff-sidetab', id: 'xff-sidetab', onclick: () => togglePanel(state.screen === 'chart' ? 'measure' : 'body') });
  const sidePanel = h('aside', { class: 'xff-sidepanel', tabindex: '-1' });
  const skins = h('fieldset', { class: 'xff-skins' });
  const avatar = h('div', { class: 'xff-avatar' });
  const content = h('section', { class: 'xff-content' });
  const topbar = h('div', { class: 'xff-topbar' },
    h('button', { type: 'button', class: 'xff-topbar__menu', id: 'xff-profiles-button', 'aria-label': t('profiles'), onclick: () => togglePanel('profiles') }, icon('user', 26, 1.6)),
    h('button', { type: 'button', class: 'xff-topbar__close', 'aria-label': t('close'), onclick: () => close() }, icon('close', 32, 1.5)));
  const modal = h('div', { class: 'xff-modal' }, topbar, logo, media, stage, skins, sideTab, sidePanel, content, avatar);
  const closeButton = h('button', { type: 'button', class: 'xff-close', 'aria-label': t('close'), onclick: () => close() }, h('span', { 'aria-hidden': 'true', text: '×' }));
  const legal = h('p', { class: 'xff-legal' }, cfg.privacyUrl ? h('a', { href: cfg.privacyUrl, text: t('privacyLink') }) : null);
  dialog.append(modal, closeButton, legal, live);
  document.body.append(dialog);

  const scrollLock = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  let viewer = null;
  const close = () => { if (dialog.open) dialog.close(); };
  // Phone and desktop layouts swap when the window is resized or the phone turned; the screen is drawn again.
  const layout = window.matchMedia?.(PHONE_LAYOUT);
  const onLayout = () => { render(); viewer?.refresh(); };
  const onResize = () => viewer?.refresh();
  layout?.addEventListener?.('change', onLayout);
  window.addEventListener('resize', onResize, { passive: true });
  dialog.addEventListener('close', () => {
    document.documentElement.style.overflow = scrollLock;
    layout?.removeEventListener?.('change', onLayout);
    window.removeEventListener('resize', onResize);
    viewer?.destroy();
    dialog.remove();
    if (current?.dialog === dialog) current = null;
    decorateAll();
    if (opener && opener.isConnected) opener.focus();
  });
  // A click on the backdrop closes; not the second click of a double click on the link that opened the dialog.
  const openedAt = performance.now();
  dialog.addEventListener('click', event => { if (event.target === dialog && performance.now() - openedAt > 400) close(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape' && state.panel) { event.preventDefault(); togglePanel(null); } });
  current = { dialog, close };

  const chart = () => pickChart(cfg.charts, state.p.sex);
  const steps = () => (phone() ? ['gender', 'body', 'shape'] : ['body', 'shape']);
  const save = () => saveProfile(state.p);
  const announce = text => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); };
  const go = (screen, focusId) => { state.screen = screen; state.panel = null; state.errors = {}; state.ageTip = false; render(focusId ?? HEADING); };
  const startFinder = () => go(evaluate(cfg, state.p) && loadProfile() ? 'result' : steps()[0]);
  // Back from the first step: to the result when the shopper came from there to edit, else to the size table.
  const backFromStart = () => go(state.returnTo ?? 'chart');

  viewer = createViewer(view, { urls: cfg.bodies, label: t('stage3d'), onFail: () => { viewer?.destroy(); viewer = null; stage.classList.add('is-flat'); updateStage(); } });
  if (!viewer) stage.classList.add('is-flat');

  // ------------------------------------------------ the 3D stage
  function previewProfile() {
    const p = { ...state.p, tape: { ...state.p.tape }, shape: { ...state.p.shape } };
    readDraft(p, state.draft, false);
    if (!(p.heightCm >= LIMITS.height[0] && p.heightCm <= LIMITS.height[1])) p.heightCm = null;
    if (!(p.weightKg >= LIMITS.weight[0] && p.weightKg <= LIMITS.weight[1])) p.weightKg = null;
    return p;
  }
  function stageRings(ev, name) {
    const size = ev.result.sizes.find(x => x.name === name) ?? ev.result.sizes.find(x => x.name === ev.result.best);
    return size.regions.filter(r => TORSO.includes(r.measure))
      .map(r => ({ measure: r.measure, tone: FIT_TONE[r.fit], text: t(FIT_TEXT[r.fit]), icon: icon(FIT_ICON[r.fit], 14, 2.4) }));
  }
  let stageTimer = 0;
  const updateStageSoon = () => { clearTimeout(stageTimer); stageTimer = setTimeout(updateStage, 160); };
  function updateStage() {
    const p = previewProfile(), ev = evaluate(cfg, p), b = bodyFrom(p);
    let frame = phone() ? 'shapePhone' : 'shape', rings = [];
    if ((state.screen === 'result' || state.screen === 'guard') && ev) {
      frame = phone() ? 'resultPhone' : 'result';
      rings = stageRings(ev, state.screen === 'guard' ? state.chosen : (state.compare ?? ev.result.best));
    }
    if (state.panel === 'measure') {
      frame = 'guide';
      rings = (chart()?.measures ?? []).filter(m => TORSO.includes(m)).map((m, i) => ({ measure: m, tone: 'guide', dashed: true, text: `${i + 1}. ${t(m)}` }));
    }
    if (viewer) {
      viewer.setBody({ sex: p.sex, values: { height: p.heightCm ?? undefined, chest: b.values.chest, waist: b.values.waist, hips: b.values.hips }, weightKg: p.weightKg ?? undefined });
      viewer.setFrame(frame);
      viewer.setRings(rings);
      viewer.setSkin(state.p.skin ?? 0);
    } else {
      // The flat drawing says each part's fit in words too, as the 3D labels do.
      view.replaceChildren(figure(p.sex, b.values, rings.map(r => ({ measure: r.measure, tone: r.tone === 'bad' ? 'bad' : 'ok', dashed: r.dashed }))),
        rings.length ? h('ul', { class: 'xff-flat-labels' }, rings.map(r => h('li', { class: `xff-3d-label xff-3d-label--${r.tone}` },
          r.icon ? h('span', { class: 'xff-3d-label__icon' }, r.icon) : null,
          h('span', { class: 'xff-3d-label__text', text: r.tone === 'guide' ? r.text : `${t(r.measure)}: ${r.text}` })))) : null);
    }
  }

  function renderSkins() {
    skins.replaceChildren(h('legend', { class: 'xff-sr', text: t('skins') }), ...SWATCHES.map((rgb, i) => h('label', {
      class: 'xff-swatch', style: `--xff-swatch:rgb(${rgb.join(' ')})`, title: i ? t('skinTone', { n: i }) : t('skinMannequin'),
    }, h('input', {
      type: 'radio', name: 'xff-skin', id: `xff-skin-${i}`, value: i, checked: (state.p.skin ?? 0) === i, 'aria-label': i ? t('skinTone', { n: i }) : t('skinMannequin'),
      onchange: () => { state.p.skin = i; viewer?.setSkin(i); },
    }))));
  }

  // ------------------------------------------------ render
  let shownScreen = '';
  function render(focusId) {
    const active = focusId === HEADING ? null : focusId ?? document.activeElement?.id;
    dialog.dataset.screen = state.screen;
    dialog.dataset.panel = state.panel ?? '';
    dialog.toggleAttribute('data-skins', state.showSkins);
    fill(content, screen());
    sideTab.hidden = !(state.screen === 'chart' || state.screen === 'result');
    fill(sideTab, state.screen === 'chart' ? [icon('tape', 34, 1.3), h('span', { class: 'xff-sr', text: t('howToMeasure') })] : [h('span', { text: t('bodyMeasures') })]);
    sideTab.setAttribute('aria-expanded', String(Boolean(state.panel && state.panel !== 'profiles')));
    renderPanel();
    renderAvatar();
    renderSkins();
    updateStage();
    // An open panel is the only thing Tab can reach (besides the buttons that close it).
    for (const el of [content, stage, skins, media, logo]) el.inert = Boolean(state.panel);
    if (state.screen === 'chart') fitTable();
    if (state.screen !== shownScreen) { content.scrollTop = 0; dialog.scrollTop = 0; shownScreen = state.screen; }
    const target = active ? dialog.querySelector(`#${CSS.escape(active)}`) : null;
    (target && target.offsetParent !== null ? target : content.querySelector('[data-xff-focus]') ?? content.querySelector('button, input'))?.focus({ preventScroll: true });
  }

  // Every size of the table in view on the desktop modal: the rows shrink (not under 26 px) to the room there is.
  function fitTable() {
    const wrap = content.querySelector('.xff-table-wrap'), foot = content.querySelector('.xff-chart__foot'), rows = wrap?.querySelectorAll('tr').length;
    if (!wrap || !foot || !rows) return;
    wrap.style.removeProperty('--xff-row'); wrap.style.removeProperty('max-block-size');
    if (phone()) return;
    const room = foot.getBoundingClientRect().top - wrap.getBoundingClientRect().top - 10;
    if (!dialog.open || room <= 0) return;   // not laid out yet: the call after showModal() does it
    wrap.style.setProperty('--xff-row', `${Math.max(26, Math.min(44, Math.floor(room / rows)))}px`);
    wrap.style.setProperty('max-block-size', `${room}px`);
  }

  function screen() {
    if (!chart()) return [h('p', { class: 'xff-note xff-note--empty', id: titleId, text: t('noChart') })];
    switch (state.screen) {
      case 'chart': return chartScreen();
      case 'gender': return genderScreen();
      case 'body': return bodyScreen();
      case 'shape': return shapeScreen();
      case 'guard': return guardScreen();
      default: return resultScreen();
    }
  }

  function pills(name, value, options, onChange, className = '') {
    return h('div', { class: `xff-pills ${className}`, role: 'group' }, options.map(([key, label]) => h('button', {
      type: 'button', id: `xff-${name}-${key}`, class: 'xff-pill', 'aria-pressed': String(value === key), text: label,
      onclick: () => { onChange(key); render(`xff-${name}-${key}`); },
    })));
  }

  function dots() {
    const list = steps(), i = list.indexOf(state.screen);
    return h('div', { class: 'xff-dots', 'aria-hidden': 'true' }, list.map((_, j) => h('span', { class: j === i ? 'is-on' : null })));
  }

  // ------------------------------------------------ size chart (the first screen)
  function chartScreen() {
    // Women before men, as the body type choice shows them.
    const cuts = Object.keys(cfg.charts).sort((a, b) => (b === 'women') - (a === 'women')), unit = state.p.units.length;
    const cut = state.chartCut ?? (cfg.charts[state.p.sex === 'female' ? 'women' : 'men'] ? (state.p.sex === 'female' ? 'women' : 'men') : cuts[0]);
    const c = cfg.charts[cut], ev = loadProfile() && evaluate(cfg, state.p), bestName = ev && pickChart(cfg.charts, state.p.sex) === c ? ev.result.best : null;
    return [h('div', { class: 'xff-chart' },
      h('h2', { class: 'xff-chart__title', id: titleId, tabindex: '-1', 'data-xff-focus': true, text: t('chartTitle') }),
      h('p', { class: 'xff-chart__sub', text: t('chartSub') }),
      phone() ? h('button', { type: 'button', class: 'xff-link xff-how-link', id: 'xff-how-link', text: t('howToMeasure'), onclick: () => togglePanel('measure') }) : null,
      cuts.length > 1 ? pills('cut', cut, cuts.map(k => [k, t(k === 'women' ? 'women' : 'men')]), k => { state.chartCut = k; }, 'xff-pills--small') : null,
      h('div', { class: 'xff-table-wrap', tabindex: '0', role: 'region', 'aria-label': t('chartTitle') },
        h('table', { class: 'xff-table' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: t('international') }), c.measures.map(m => h('th', { scope: 'col', text: t(m).toUpperCase() })))),
          h('tbody', {}, c.sizes.map(size => h('tr', { class: size.name === bestName ? 'is-best' : null, 'aria-current': size.name === bestName ? 'true' : null },
            h('th', { scope: 'row', text: size.name }),
            c.measures.map(m => h('td', { text: rangeText(size[m], unit) }))))))),
      h('div', { class: 'xff-chart__foot' },
        h('span', { class: 'xff-chart__unit-label', text: t('measurements') }),
        pills('chart-unit', unit, [['cm', 'cm'], ['in', 'in']], u => { state.p.units.length = u; }),
        h('button', { type: 'button', class: 'xff-btn xff-btn--black', id: 'xff-find', text: t('findSize'), onclick: startFinder })))];
  }

  // ------------------------------------------------ step: body type (phone only)
  function genderScreen() {
    return [
      h('div', { class: 'xff-step' },
        h('h2', { class: 'xff-h1', id: titleId, tabindex: '-1', 'data-xff-focus': true, text: t('findSize') }),
        h('p', { class: 'xff-lead', text: t('fillDetails') }),
        genderPills()),
      footer([h('button', { type: 'button', class: 'xff-btn xff-btn--outline', id: 'xff-back', text: t('back'), onclick: backFromStart }),
        h('button', { type: 'button', class: 'xff-btn xff-btn--black', id: 'xff-next', text: t('next'), onclick: () => go('body') })], true),
    ];
  }
  function genderPills() {
    return pills('sex', state.p.sex, [['female', t('woman')], ['male', t('man')]], v => { readDraft(state.p, state.draft); state.p.sex = v; }, 'xff-pills--gender');
  }

  // ------------------------------------------------ step: height, weight, age
  function bodyScreen() {
    const p = state.p, d = state.draft, e = state.errors;
    const errorOf = key => (key === 'heightIn' ? 'height' : key);
    // Typing clears that field's message at once; what was typed stays as typed.
    const typed = key => event => {
      d[key] = event.target.value;
      const k = errorOf(key);
      if (state.errors[k]) {
        delete state.errors[k];
        content.querySelector(`#xff-${k}-error`)?.remove();
        for (const el of content.querySelectorAll(`#xff-${k}, #xff-${k}In`)) { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
      }
      refreshNext(); updateStageSoon();
    };
    const enter = event => { if (event.key === 'Enter') { event.preventDefault(); goNext(); } };
    const box = (key, value, extra = {}) => h('input', {
      id: `xff-${key}`, class: 'xff-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: value ?? '',
      'aria-invalid': e[errorOf(key)] ? 'true' : null, 'aria-describedby': e[errorOf(key)] ? `xff-${errorOf(key)}-error` : null,
      oninput: typed(key), onkeydown: enter, ...extra,
    });
    const field = (key, label, controls, after) => h('div', { class: 'xff-field' },
      h('label', { class: 'xff-label', for: `xff-${key}` }, label),
      h('div', { class: 'xff-field__row' }, controls),
      e[key] ? h('p', { class: 'xff-error', id: `xff-${key}-error`, text: e[key] }) : null,
      after);
    const unitSwitch = (name, unit, options, set) => pills(name, unit, options, u => { readDraft(state.p, state.draft); set(u); });
    const ft = p.units.height === 'ft', [feet, inches] = p.heightCm ? feetInches(p.heightCm) : [null, null];
    const height = ft
      ? [box('height', d.height ?? feet, { class: 'xff-input xff-input--short', 'aria-label': `${t('height')}, ${t('feet')}` }), h('span', { class: 'xff-field__unit xff-field__unit--short', 'aria-hidden': 'true', text: 'ft' }),
        box('heightIn', d.heightIn ?? inches, { class: 'xff-input xff-input--short', 'aria-label': `${t('height')}, ${t('inches')}` }), h('span', { class: 'xff-field__unit xff-field__unit--short', 'aria-hidden': 'true', text: 'in' })]
      : [box('height', d.height ?? (p.heightCm ? fmt(p.heightCm, 1) : ''))];
    const weightValue = d.weight ?? (p.weightKg ? fmt(p.units.weight === 'lb' ? p.weightKg / KG_PER_LB : p.weightKg, 1) : '');
    const nextButton = h('button', { type: 'button', class: 'xff-btn xff-btn--black', id: 'xff-next', text: t('next'), onclick: () => goNext() });
    refreshNext = () => { nextButton.classList.toggle('is-muted', !basicsLookValid()); };
    refreshNext();
    return [
      h('div', { class: 'xff-step' },
        h('h2', { class: 'xff-h1', id: titleId, tabindex: '-1', 'data-xff-focus': true, text: t('findSize') }),
        h('p', { class: 'xff-lead', text: t('fillDetails') }),
        phone() ? null : genderPills(),
        field('height', t('height'), [height, unitSwitch('unit-height', p.units.height, [['cm', 'cm'], ['ft', 'ft / in']], u => { p.units.height = u; })]),
        field('weight', t('weight'), [box('weight', weightValue), unitSwitch('unit-weight', p.units.weight, [['kg', 'kg'], ['lb', 'lb']], u => { p.units.weight = u; })]),
        field('age', [t('age'), h('span', { class: 'xff-optional', text: ` (${t('optional')})` })], [box('age', d.age ?? (p.age ?? ''), { inputmode: 'numeric' }),
          h('span', { class: 'xff-field__unit', text: t('years') }),
          // A help button that works by tap, click or keyboard (not only on hover).
          h('button', { type: 'button', class: 'xff-info', id: 'xff-age-info', 'aria-label': t('ageInfo'), 'aria-expanded': String(state.ageTip), onclick: () => { state.ageTip = !state.ageTip; render('xff-age-info'); } }, 'i')],
          state.ageTip ? h('p', { class: 'xff-tipnote', role: 'note', text: t('ageInfo') }) : null)),
      footer([h('button', { type: 'button', class: 'xff-btn xff-btn--outline', id: 'xff-back', text: t('back'), onclick: () => { readDraft(state.p, state.draft); if (phone()) go('gender'); else backFromStart(); } }), nextButton], true),
    ];
  }
  let refreshNext = () => {};
  function basicsLookValid() {
    const p = { ...state.p, tape: {} };
    readDraft(p, state.draft, false);
    return validateInputs({ heightCm: p.heightCm, weightKg: p.weightKg, age: p.age }).length === 0;
  }

  // Moves what was typed (in the units on screen) into a profile, in cm and kg (kept to 0.01, so 180 lb stays 180 lb).
  // A height of 1.2 to 2.3 in cm mode is read as metres ("1,80"). clear: empty the draft afterwards.
  function readDraft(p, d, clear = true) {
    if (d.height !== undefined || d.heightIn !== undefined) {
      if (p.units.height === 'ft') {
        const [f0, i0] = p.heightCm ? feetInches(p.heightCm) : [null, 0];
        const f = d.height !== undefined ? parseNum(d.height) : f0, i = d.heightIn !== undefined ? parseNum(d.heightIn) ?? 0 : i0;
        p.heightCm = f == null ? null : Math.round((f * 12 + i) * CM_PER_IN * 100) / 100;
      } else {
        let v = parseNum(d.height);
        if (v != null && v >= 1.2 && v <= 2.3) v *= 100;
        p.heightCm = v == null ? null : Math.round(v * 100) / 100;
      }
    }
    if (d.weight !== undefined) { const w = parseNum(d.weight); p.weightKg = w == null ? null : Math.round((p.units.weight === 'lb' ? w * KG_PER_LB : w) * 100) / 100; }
    if (d.age !== undefined) p.age = parseNum(d.age);
    if (clear) state.draft = {};
  }

  // Reads the body step into the profile. Returns false (with messages next to the fields, and the typed text kept)
  // when it cannot work.
  function commitBody() {
    const p = { ...state.p };
    readDraft(p, state.draft, false);
    const problems = validateInputs({ heightCm: p.heightCm, weightKg: p.weightKg, age: p.age }), errors = {};
    const ftIn = cm => { const [f, i] = feetInches(cm); return `${f} ft ${i} in`; };
    const hr = p.units.height === 'ft' ? [ftIn(LIMITS.height[0]), ftIn(LIMITS.height[1])] : [`${LIMITS.height[0]} cm`, `${LIMITS.height[1]} cm`];
    const wr = p.units.weight === 'lb' ? [`${Math.round(LIMITS.weight[0] / KG_PER_LB)} lb`, `${Math.round(LIMITS.weight[1] / KG_PER_LB)} lb`] : [`${LIMITS.weight[0]} kg`, `${LIMITS.weight[1]} kg`];
    if (problems.includes('height')) errors.height = t('errHeight', { min: hr[0], max: hr[1] });
    if (problems.includes('weight')) errors.weight = t('errWeight', { min: wr[0], max: wr[1] });
    if (problems.includes('age')) errors.age = t('errAge');
    state.errors = errors;
    if (Object.keys(errors).length) return false;
    readDraft(state.p, state.draft);
    return true;
  }

  // ------------------------------------------------ step: body shape
  function shapeScreen() {
    const p = state.p, names = TEXT[lang]?.shapeSteps ?? TEXT.en.shapeSteps;
    const rows = TORSO.map(m => {
      const value = Number(p.shape[m] ?? 0), id = `xff-shape-${m}`;
      const set = (next, focus) => {
        const v = Math.max(-2, Math.min(2, next));
        p.shape[m] = v;
        const range = content.querySelector(`#${id}`);
        if (range) { range.value = String(v); range.setAttribute('aria-valuetext', names[v + 2]); }
        if (focus) content.querySelector(`#${focus}`)?.focus();
        updateStage();
      };
      return h('div', { class: 'xff-slider' },
        h('label', { class: 'xff-slider__label', for: id, text: t(m) }),
        h('div', { class: 'xff-slider__row' },
          h('button', { type: 'button', class: 'xff-round', id: `${id}-less`, 'aria-label': `${t(m)}: ${t('narrower')}`, onclick: () => set(Number(p.shape[m] ?? 0) - 1, `${id}-less`) }, icon('minus', 22, 1.6)),
          h('span', { class: 'xff-slider__track' },
            h('span', { class: 'xff-slider__ticks', 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map(() => h('i'))),
            h('input', { type: 'range', class: 'xff-range', id, min: -2, max: 2, step: 1, value, 'aria-valuetext': names[value + 2], oninput: event => set(Number(event.target.value)) })),
          h('button', { type: 'button', class: 'xff-round', id: `${id}-more`, 'aria-label': `${t(m)}: ${t('broader')}`, onclick: () => set(Number(p.shape[m] ?? 0) + 1, `${id}-more`) }, icon('plus', 22, 1.6))));
    });
    return [
      h('div', { class: 'xff-step xff-step--shape' },
        h('h2', { class: 'xff-h1', id: titleId, tabindex: '-1', 'data-xff-focus': true, text: t('shapeTitle') }),
        h('p', { class: 'xff-lead xff-lead--dark', text: t('shapeIntro') }),
        h('div', { class: 'xff-sliders' }, rows),
        h('button', { type: 'button', class: 'xff-link xff-skins-toggle', id: 'xff-skins-toggle', 'aria-expanded': String(state.showSkins), text: t('changeSkin'), onclick: () => { state.showSkins = !state.showSkins; render('xff-skins-toggle'); } })),
      footer([h('button', { type: 'button', class: 'xff-btn xff-btn--outline', id: 'xff-back', text: t('back'), onclick: () => go(steps()[steps().length - 2]) }),
        h('button', { type: 'button', class: 'xff-btn xff-btn--black', id: 'xff-next', text: t('next'), onclick: () => goNext() })], true),
    ];
  }

  function footer(buttons, withDots = false) {
    return h('div', { class: 'xff-footer' }, withDots ? dots() : null, h('div', { class: 'xff-footer__buttons' }, buttons));
  }

  function goNext() {
    if (state.screen === 'body' && !commitBody()) { render('xff-next'); content.querySelector('[aria-invalid="true"]')?.focus(); return; }
    const list = steps(), i = list.indexOf(state.screen);
    if (i >= 0 && i < list.length - 1) { go(list[i + 1]); return; }
    save();
    state.compare = null;
    state.returnTo = null;
    go('result');   // focus on the result's heading reads the size out
  }

  // ------------------------------------------------ result
  // The heading says the verdict and the size (the card shows the same, for the eye only).
  function card(label, name, badge) {
    return h('div', { class: 'xff-pick' },
      h('h2', { class: 'xff-pick__label', id: titleId, tabindex: '-1', 'data-xff-focus': true }, label, h('span', { class: 'xff-sr', text: `: ${name}` })),
      h('div', { class: 'xff-card', 'aria-hidden': 'true' },
        h('span', { class: 'xff-card__size', text: name }),
        badge ? h('span', { class: `xff-badge xff-badge--${badge}` }, icon(badge === 'no' ? 'close' : badge === 'warn' ? 'warn' : 'right', 14, 2.6)) : null));
  }
  const badFit = r => r.fit === 'tooTight' || r.fit === 'tooLoose';
  const partName = m => (lang === 'de' ? t(m) : t(m).toLowerCase());   // German nouns keep their capital
  const listParts = names => (names.length > 1 ? `${names.slice(0, -1).join(', ')} ${t('and')} ${names.at(-1)}` : names[0]);

  function resultScreen() {
    const ev = evaluate(cfg, state.p);
    if (!ev) { state.screen = steps()[0]; return screen(); }
    const { result, body } = ev, sizes = result.sizes;
    const best = sizes.find(x => x.name === result.best);
    const shown = sizes.find(x => x.name === (state.compare ?? result.best)) ?? best;
    // The best size of the chart can still be too tight or too loose somewhere: then it is the closest size, said so.
    const closest = best.regions.some(badFit);
    const label = shown.verdict === 'best' ? t(closest ? 'closest' : 'bestOption') : shown.verdict === 'fits' ? t('mayAlsoFit') : t('notRecommendedUpper');
    const badge = shown.verdict === 'no' ? 'no' : shown.verdict === 'best' ? (closest ? 'warn' : 'best') : 'fits';
    // The button adds the size on screen when it fits and is in stock; else the best size in stock (best first).
    const inStock = x => x.available !== false;
    const fallback = [best, ...sizes.filter(x => x.verdict === 'fits')].find(inStock) ?? null;
    const target = shown.verdict !== 'no' && inStock(shown) ? shown : fallback;
    const notes = [];
    if (result.outOfRange) notes.push(h('p', { class: 'xff-note xff-note--bad' }, t(result.outOfRange), ' ', h('a', { href: cfg.contactUrl, text: t('contact') })));
    else if (closest) { const r = worstRegion(best); notes.push(h('p', { class: 'xff-note', text: t('closestNote', { size: best.name, part: t(r.measure), fit: t(FIT_TEXT[r.fit]) }) })); }
    if (!inStock(best)) notes.push(h('p', { class: 'xff-note', text: [t('bestSoldOut', { size: best.name }), target ? t('altFits', { size: target.name }) : ''].join(' ').trim() }));
    if (body.warnings.includes('outsideModel')) notes.push(h('p', { class: 'xff-note', text: t('outsideModel') }));
    const i = Math.max(0, sizes.indexOf(shown)), from = Math.max(0, Math.min(i - 1, sizes.length - 3));
    const compare = j => { state.compare = sizes[j].name; render(`xff-size-${normalizeSize(sizes[j].name)}`); };
    const edit = () => { state.returnTo = 'result'; go(steps()[0]); };
    const verdictText = size => `${size.verdict === 'best' ? t(closest ? 'closest' : 'bestOption') : size.verdict === 'fits' ? t('mayAlsoFit') : t('notRecommended')}${inStock(size) ? '' : `, ${t('soldOut')}`}`;
    return [
      h('div', { class: 'xff-result' },
        card(label, shown.name, badge),
        h('button', { type: 'button', class: 'xff-btn xff-btn--outline xff-btn--small', id: 'xff-edit', text: t('editMeasures'), onclick: edit }),
        phone() ? h('button', { type: 'button', class: 'xff-link xff-measures-link', id: 'xff-measures-link', text: t('bodyMeasures'), onclick: () => togglePanel('body') }) : null),
      notes.length ? h('div', { class: 'xff-notes' }, notes) : null,
      h('div', { class: 'xff-try' },
        h('p', { class: 'xff-try__label', text: t('alsoTry') }),
        h('div', { class: 'xff-try__row', role: 'group', 'aria-label': t('alsoTry') },
          h('button', { type: 'button', class: 'xff-try__arrow', id: 'xff-size-prev', 'aria-label': t('smaller'), disabled: i === 0, onclick: () => compare(i - 1) }, icon('prev', 18, 2.4)),
          sizes.slice(from, from + 3).map(size => h('button', {
            type: 'button', id: `xff-size-${normalizeSize(size.name)}`, class: `xff-chip${inStock(size) ? '' : ' is-sold'}`, 'aria-pressed': String(size === shown),
            onclick: () => compare(sizes.indexOf(size)),
          }, h('span', { class: 'xff-chip__name', text: size.name }),
          h('span', { class: `xff-badge xff-badge--${size.verdict === 'no' ? 'no' : size.verdict === 'best' ? (closest ? 'warn' : 'best') : 'fits'}`, 'aria-hidden': 'true' },
            icon(size.verdict === 'no' ? 'close' : size.verdict === 'best' && closest ? 'warn' : 'right', 11, 2.8)),
          h('span', { class: 'xff-sr', text: `, ${verdictText(size)}` }))),
          h('button', { type: 'button', class: 'xff-try__arrow', id: 'xff-size-next', 'aria-label': t('larger'), disabled: i === sizes.length - 1, onclick: () => compare(i + 1) }, icon('next', 18, 2.4)))),
      h('div', { class: 'xff-actions' },
        phone() ? h('button', { type: 'button', class: 'xff-btn xff-btn--outline', id: 'xff-edit-phone', text: t('editMeasures'), onclick: edit }) : null,
        shown.verdict === 'no' && inStock(shown) ? h('button', { type: 'button', class: 'xff-link xff-anyway', id: 'xff-anyway', text: t('keep', { chosen: shown.name }), onclick: () => addToCart(shown.name) }) : null,
        target
          ? h('button', { type: 'button', class: 'xff-btn xff-btn--black xff-btn--cart', id: 'xff-add', onclick: () => addToCart(target.name) }, icon('cart', 13, 2.4), h('span', { text: t('addSize', { size: target.name }) }))
          : h('button', { type: 'button', class: 'xff-btn xff-btn--black xff-btn--cart', id: 'xff-add', disabled: true, text: `${best.name} · ${t('soldOut')}` })),
    ];
  }

  // Select the size, wait for Impact to load that variant, then send the product form. The add-to-cart check is
  // skipped: the shopper chose this size here, seeing how it fits.
  function addToCart(name) {
    save();
    const change = normalizeSize(selectedSize(cfg)) !== normalizeSize(name);
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

  // ------------------------------------------------ add-to-cart check
  function guardScreen() {
    const ev = evaluate(cfg, state.p), verdict = ev && verdictFor(ev.result, state.chosen);
    if (!ev || !verdict) return [h('p', { class: 'xff-note xff-note--empty', id: titleId, text: t('noChart') })];
    const worst = worstRegion(verdict);
    const parts = listParts(verdict.regions.filter(badFit).map(r => partName(r.measure)).concat(verdict.regions.some(badFit) ? [] : [partName(worst.measure)]));
    return [
      h('div', { class: 'xff-result' }, card(t('notRecommendedUpper'), state.chosen, 'no')),
      h('div', { class: 'xff-notes xff-notes--guard' }, h('p', { class: 'xff-guard-text', text: t('guardText', { chosen: state.chosen, fit: lowerFit(worst.fit), parts, best: ev.result.best }) })),
      h('div', { class: 'xff-actions xff-actions--guard' },
        h('button', { type: 'button', class: 'xff-btn xff-btn--outline', id: 'xff-keep', text: t('keep', { chosen: state.chosen }), onclick: () => {
          const form = document.getElementById(cfg.formId);
          close();
          if (form) { form.dataset.xffBypass = '1'; form.requestSubmit(options.submitter && options.submitter.form === form ? options.submitter : undefined); }
        } }),
        h('button', { type: 'button', class: 'xff-btn xff-btn--black', id: 'xff-switch', text: t('switchTo', { best: ev.result.best }), onclick: () => addToCart(ev.result.best) })),
    ];
  }

  // ------------------------------------------------ side panels: how to measure, body measurements, profiles
  // Opening a panel remembers what opened it; closing puts focus back there.
  function togglePanel(name) {
    const opening = Boolean(name) && state.panel !== name;
    if (opening) state.panelOpener = document.activeElement?.id || null;
    state.panel = opening ? name : null;
    state.confirmDelete = false;
    render(state.panel ? null : state.panelOpener);
    if (state.panel) sidePanel.focus({ preventScroll: true });
  }
  function renderPanel() {
    sidePanel.hidden = !state.panel;
    if (!state.panel) { sidePanel.replaceChildren(); return; }
    const closePanel = h('button', { type: 'button', class: 'xff-panel-close', 'aria-label': t('close'), onclick: () => togglePanel(null) }, icon('close', 20, 2));
    if (state.panel === 'measure') {
      const measures = (chart()?.measures ?? ['chest', 'waist']).filter(m => HOW[m]);
      fill(sidePanel, closePanel, h('h2', { class: 'xff-panel-title', text: t('howToMeasure') }),
        h('ol', { class: 'xff-how' }, measures.map(m => h('li', {}, h('strong', { text: t(m) }), h('p', { text: t(HOW[m]) })))),
        h('p', { class: 'xff-panel-note', text: t('measureTips') }));
    } else if (state.panel === 'body') {
      const ev = evaluate(cfg, state.p), shownName = state.compare ?? ev?.result.best, size = chart()?.sizes.find(x => x.name === shownName), unit = state.p.units.length;
      fill(sidePanel, closePanel, h('h2', { class: 'xff-panel-title', text: t('bodyMeasures') }),
        size ? h('dl', { class: 'xff-measures' }, chart().measures.flatMap(m => [h('dt', { text: t(m) }), h('dd', { text: `${rangeText(size[m], unit)} ${unit}` })])) : null,
        h('button', { type: 'button', class: 'xff-btn xff-btn--grey', id: 'xff-to-chart', text: t('sizeGuide'), onclick: () => go('chart', 'xff-find') }));
    } else {
      const saved = loadStore()?.profiles ?? [], isSaved = saved.some(x => x.id === state.p.id);
      const use = o => { saveProfile(o); state.p = { ...o, tape: { ...o.tape }, shape: { ...o.shape }, units: { ...o.units } }; state.compare = null; go(evaluate(cfg, state.p) ? 'result' : steps()[0]); };
      fill(sidePanel, closePanel, h('h2', { class: 'xff-panel-title', text: t('profiles') }),
        h('label', { class: 'xff-label', for: 'xff-profile-name', text: t('profileName') }),
        h('input', { id: 'xff-profile-name', class: 'xff-input xff-input--wide', type: 'text', value: state.p.name ?? '', placeholder: t('profileNamePlaceholder'), oninput: event => { state.p.name = event.target.value; if (loadStore()?.profiles.some(x => x.id === state.p.id)) save(); } }),
        saved.length ? h('ul', { class: 'xff-profiles' }, saved.map(o => h('li', {}, h('button', {
          type: 'button', class: 'xff-profile', 'aria-current': o.id === state.p.id ? 'true' : null, onclick: () => (o.id === state.p.id ? togglePanel(null) : use(o)),
        }, icon('user', 20), h('span', { class: 'xff-profile__name', text: o.name || t('unnamedProfile') }), o.id === state.p.id ? h('span', { class: 'xff-profile__current', text: t('currentProfile') }) : null)))) : null,
        h('button', { type: 'button', class: 'xff-profile', id: 'xff-add-profile', onclick: () => { state.p = newProfile(cfg, state.p.sex); state.draft = {}; state.returnTo = null; go(steps()[0]); } }, icon('plus', 20), h('span', { text: t('addProfile') })),
        // Deleting asks once more (the same button), so a slip does not lose a profile.
        isSaved ? h('button', { type: 'button', class: `xff-profile xff-profile--danger${state.confirmDelete ? ' is-confirm' : ''}`, id: 'xff-delete-profile', onclick: () => {
          if (!state.confirmDelete) { state.confirmDelete = true; renderPanel(); sidePanel.querySelector('#xff-delete-profile')?.focus(); return; }
          deleteProfile(state.p.id);
          const next = loadProfile();
          state.p = next ? { ...next, tape: { ...next.tape }, shape: { ...next.shape }, units: { ...next.units } } : newProfile(cfg, state.p.sex);
          state.draft = {};
          announce(t('forgotten'));
          go(next && evaluate(cfg, state.p) ? 'result' : steps()[0]);
        } }, icon('close', 18), h('span', { text: t(state.confirmDelete ? 'deleteConfirm' : 'deleteProfile') })) : null,
        h('p', { class: 'xff-panel-note', text: t('privacy') }),
        cfg.privacyUrl ? h('a', { class: 'xff-link xff-privacy-link', href: cfg.privacyUrl, text: t('privacyLink') }) : null);
    }
  }

  // The profiles button names the profile in use, so the shopper always sees whose measurements these are.
  function renderAvatar() {
    fill(avatar, h('button', { type: 'button', class: 'xff-avatar__button', id: 'xff-avatar-button', 'aria-expanded': String(state.panel === 'profiles'), onclick: () => togglePanel('profiles') },
      h('span', { class: 'xff-avatar__icon', 'aria-hidden': 'true' }, icon('user', 18, 1.6)),
      state.p.name ? h('span', { class: 'xff-sr', text: `${t('profiles')}: ` }) : null,
      h('span', { class: 'xff-avatar__name', text: state.p.name || t('profiles') })));
  }

  // ------------------------------------------------ open
  if (options.mode !== 'guard' && options.screen === 'finder') state.screen = evaluate(cfg, state.p) && saved ? 'result' : steps()[0];
  render();
  dialog.showModal();
  if (state.screen === 'chart') fitTable();
  (content.querySelector('[data-xff-focus]') ?? content.querySelector('button'))?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- entry points used by the boot script
let started = false;
/** Arms the add-to-cart check and the size warning on every size option. Safe to call more than once. */
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
/** Opens the size guide for the size option this link belongs to. */
export function open(button) {
  init();
  const root = button.closest('[data-xff]');
  if (root) openDialog(root, { opener: button, screen: button.dataset.xffScreen || 'chart' });
}
