// Xavia fit finder: the "Find your size" dialog, the size hint under the size option and the add-to-cart check.
// The inline boot in snippets/xavia-fit-finder.liquid loads this module on the first click, or at idle time when
// this device has a saved fit profile. build.mjs joins it with the engine, the texts and the CSS into one theme asset.
import { estimateBody, measuredBody, combineBody, pickChart, chartsForProduct, recommend, validateInputs, verdictFor, normalizeSize, LIMITS } from './xavia-fit-engine.js';
import { TEXT } from './xavia-fit-i18n.js';

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

// ---------------------------------------------------------------- the body figure (front view, inline SVG)
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
    tab: 'finder', step: saved ? 'result' : 'you', mode: options.mode ?? 'finder', chosen: options.chosen, compare: null, errors: [], notice: '',
    p: saved ? { ...saved, tape: { ...saved.tape }, shape: { ...saved.shape } } : {
      sex: onlyWomen ? 'female' : 'male', heightCm: null, weightKg: null, age: null, shape: {}, tape: {}, fit: 'regular', layers: 'none',
      units: country ? { height: 'ft', weight: 'lb', length: 'in' } : { height: 'cm', weight: 'kg', length: 'cm' },
    },
    draft: {}, chartCut: null,
  };
  if (!evaluate(cfg, state.p) && state.step === 'result') state.step = 'you';
  const opener = options.opener ?? document.activeElement;
  const titleId = nextId('title'), live = h('p', { class: 'xff-sr', 'aria-live': 'polite' });
  const dialog = h('dialog', { class: 'xff-dialog', 'aria-labelledby': titleId, lang });
  const body = h('div', { class: 'xff-body' });
  dialog.append(body, live);
  document.body.append(dialog);
  const scrollLock = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  const close = () => { if (dialog.open) dialog.close(); };
  dialog.addEventListener('close', () => {
    document.documentElement.style.overflow = scrollLock;
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

  let shownView = '';
  function render(focusId) {
    const active = focusId ?? document.activeElement?.id;
    body.replaceChildren(...(state.mode === 'guard' ? [header(), guardView()] : [header(), tabs(), panel()]));
    // A new step or tab starts at the top; an update in place (units, compare, shape) keeps the scroll position.
    const view = `${state.mode}/${state.tab}/${state.step}`;
    if (view !== shownView) { body.scrollTop = 0; shownView = view; }
    const target = active ? dialog.querySelector(`#${CSS.escape(active)}`) : null;
    (target ?? dialog.querySelector('[data-xff-focus]') ?? dialog.querySelector('.xff-close'))?.focus({ preventScroll: true });
  }

  function header() {
    return h('div', { class: 'xff-header' },
      cfg.product.image ? h('img', { class: 'xff-header__image', src: cfg.product.image, alt: '', width: 56, height: 56, loading: 'lazy' }) : null,
      h('div', { class: 'xff-header__text' }, h('h2', { id: titleId, class: 'xff-title', text: state.mode === 'guard' ? t('guardTitle') : t('title') }), h('p', { class: 'xff-muted', text: cfg.product.title })),
      h('button', { type: 'button', class: 'xff-close', 'aria-label': t('close'), onclick: close }, s('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': 'true' }, s('path', { d: 'M6 6l12 12M18 6L6 18', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }))));
  }

  function tabs() {
    const list = [['finder', 'tabFinder'], ['chart', 'tabChart'], ['measure', 'tabMeasure']];
    const bar = h('div', { class: 'xff-tabs', role: 'tablist' });
    for (const [key, label] of list) {
      bar.append(h('button', {
        type: 'button', role: 'tab', id: `xff-tab-${key}`, class: 'xff-tab', 'aria-selected': String(state.tab === key), tabindex: state.tab === key ? '0' : '-1', 'aria-controls': 'xff-panel',
        text: t(label), onclick: () => { state.tab = key; render(`xff-tab-${key}`); },
        onkeydown: event => {
          const i = list.findIndex(([k]) => k === key), step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!step) return;
          event.preventDefault();
          state.tab = list[(i + step + list.length) % list.length][0];
          render(`xff-tab-${state.tab}`);
        },
      }));
    }
    return bar;
  }

  function panel() {
    const view = state.tab === 'chart' ? chartView() : state.tab === 'measure' ? measureView() : finderView();
    return h('div', { class: 'xff-panel', id: 'xff-panel', role: 'tabpanel', 'aria-labelledby': `xff-tab-${state.tab}` }, view);
  }

  // ------------------------------------------------ finder steps
  function finderView() {
    if (!chart()) return h('p', { class: 'xff-callout', text: t('noChart') });
    if (state.step === 'result') return resultView();
    const list = steps(), index = Math.max(0, list.indexOf(state.step)), total = list.length;
    const stepBody = state.step === 'shape' ? shapeStep() : state.step === 'ride' ? rideStep() : youStep();
    const showFigure = state.step === 'shape' || (state.step === 'you' && !cfg.product.image);
    const aside = showFigure && torsoMeasures().length ? h('div', { class: 'xff-aside' }, figure(state.p.sex, previewValues())) :
      cfg.product.image ? h('div', { class: 'xff-aside xff-aside--image' }, h('img', { src: cfg.product.image, alt: '', loading: 'lazy' })) : null;
    return h('form', { class: 'xff-layout', novalidate: true, onsubmit: event => { event.preventDefault(); goNext(); } },
      aside,
      h('div', { class: 'xff-main' },
        h('p', { class: 'xff-step', text: t('stepOf', { n: index + 1, total }) }),
        h('h3', { class: 'xff-heading', tabindex: '-1', 'data-xff-focus': true, text: t(state.step === 'shape' ? 'stepShape' : state.step === 'ride' ? 'stepRide' : 'stepYou') }),
        state.errors.length ? h('div', { class: 'xff-errors', role: 'alert' }, state.errors.map(e => h('p', { text: e }))) : null,
        stepBody,
        h('div', { class: 'xff-nav' },
          index > 0 ? h('button', { type: 'button', class: 'xff-button xff-button--secondary', id: 'xff-back', text: t('back'), onclick: () => { state.errors = []; state.step = list[index - 1]; render(); } }) : h('span'),
          h('button', { type: 'submit', class: 'xff-button', id: 'xff-next', text: index === total - 1 ? t('seeSize') : t('next') }))));
  }

  function previewValues() {
    const p = state.p;
    if (p.heightCm && p.weightKg) return bodyFrom(p).values;
    return tapeOnly(p);
  }

  function radioGroup({ legend, name, value, options, onChange, hiddenLegend, className = 'xff-segments' }) {
    return h('fieldset', { class: `xff-field ${className}` },
      h('legend', { class: hiddenLegend ? 'xff-sr' : 'xff-label', text: legend }),
      h('div', { class: 'xff-segments__row' }, options.map(([key, label, extra]) => {
        const id = `xff-${name}-${key}`;
        return h('label', { class: 'xff-segment', for: id },
          h('input', { type: 'radio', id, name: `xff-${name}`, value: key, checked: String(value) === String(key), onchange: () => onChange(key) }),
          h('span', { class: 'xff-segment__text' }, h('span', { text: label }), extra ? h('small', { text: extra }) : null));
      })));
  }

  function numberField({ id, label, value, unit, onInput, describedBy, invalid, units }) {
    return h('div', { class: 'xff-field' },
      h('label', { class: 'xff-label', for: id, text: label }),
      h('div', { class: 'xff-input-row' },
        h('input', { id, class: 'xff-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: value ?? '', 'aria-describedby': describedBy, 'aria-invalid': invalid ? 'true' : null, oninput: event => onInput(event.target.value) }),
        unit ? h('span', { class: 'xff-unit', text: unit }) : null,
        units ?? null));
  }

  function unitSwitch(name, value, options, onChange) {
    return h('div', { class: 'xff-units', role: 'group', 'aria-label': options.map(o => o[1]).join(' / ') }, options.map(([key, label]) =>
      h('button', { type: 'button', id: `xff-unit-${name}-${key}`, class: 'xff-unit-button', 'aria-pressed': String(value === key), text: label, onclick: () => { onChange(key); render(`xff-unit-${name}-${key}`); } })));
  }

  function youStep() {
    const p = state.p, d = state.draft, errs = new Set(state.errorFields ?? []);
    const heightUnits = unitSwitch('height', p.units.height, [['cm', 'cm'], ['ft', `${t('feet')}/${t('inches')}`]], u => { readDraft(); p.units.height = u; });
    const weightUnits = unitSwitch('weight', p.units.weight, [['kg', 'kg'], ['lb', 'lb']], u => { readDraft(); p.units.weight = u; });
    const heightField = p.units.height === 'ft'
      ? h('div', { class: 'xff-field' }, h('span', { class: 'xff-label', id: 'xff-height-label', text: t('height') }),
        h('div', { class: 'xff-input-row' },
          h('input', { id: 'xff-height-ft', class: 'xff-input xff-input--short', type: 'text', inputmode: 'numeric', 'aria-labelledby': 'xff-height-label xff-height-ft-unit', value: d.ft ?? (p.heightCm ? Math.floor(p.heightCm / CM_PER_IN / 12) : ''), 'aria-invalid': errs.has('height') ? 'true' : null, oninput: e => { d.ft = e.target.value; } }),
          h('span', { class: 'xff-unit', id: 'xff-height-ft-unit', text: t('feet') }),
          h('input', { id: 'xff-height-in', class: 'xff-input xff-input--short', type: 'text', inputmode: 'decimal', 'aria-labelledby': 'xff-height-label xff-height-in-unit', value: d.in ?? (p.heightCm ? Math.round((p.heightCm / CM_PER_IN) % 12) : ''), 'aria-invalid': errs.has('height') ? 'true' : null, oninput: e => { d.in = e.target.value; } }),
          h('span', { class: 'xff-unit', id: 'xff-height-in-unit', text: t('inches') }), heightUnits))
      : numberField({ id: 'xff-height', label: t('height'), value: d.height ?? (p.heightCm ? fmt(p.heightCm) : ''), unit: 'cm', invalid: errs.has('height'), onInput: v => { d.height = v; }, units: heightUnits });
    const weightValue = d.weight ?? (p.weightKg ? fmt(p.units.weight === 'lb' ? p.weightKg / KG_PER_LB : p.weightKg) : '');
    const tapeMeasures = chart().measures.filter(m => m !== 'height');
    const lengthUnits = unitSwitch('length', p.units.length, [['cm', 'cm'], ['in', 'in']], u => { readDraft(); p.units.length = u; });
    d.tape ??= {};
    const hintId = 'xff-tape-hint';
    const tapeOpen = state.tapeOpen ?? tapeMeasures.some(m => Number.isFinite(p.tape[m]));
    return h('div', { class: 'xff-stack' },
      radioGroup({ legend: t('body'), name: 'sex', value: p.sex, hiddenLegend: true, options: [['male', t('man')], ['female', t('woman')]], onChange: v => { p.sex = v; render(`xff-sex-${v}`); } }),
      heightField,
      numberField({ id: 'xff-weight', label: t('weight'), value: weightValue, unit: p.units.weight, invalid: errs.has('weight'), onInput: v => { d.weight = v; }, units: weightUnits }),
      numberField({ id: 'xff-age', label: t('age'), value: d.age ?? (p.age ?? ''), unit: t('years'), invalid: errs.has('age'), onInput: v => { d.age = v; } }),
      h('details', { class: 'xff-details', open: tapeOpen, ontoggle: e => { state.tapeOpen = e.target.open; } },
        h('summary', { class: 'xff-summary', id: 'xff-tape-toggle', text: t('tape') }),
        h('p', { class: 'xff-muted', id: hintId, text: t('tapeHint') }),
        h('div', { class: 'xff-grid' }, tapeMeasures.map(m => numberField({
          id: `xff-tape-${m}`, label: t(m), unit: p.units.length, describedBy: hintId, invalid: errs.has(m),
          value: d.tape[m] ?? (Number.isFinite(p.tape[m]) ? fmt(toUnit(p.tape[m], p.units.length), 1) : ''), onInput: v => { d.tape[m] = v; },
        }))),
        h('div', { class: 'xff-row' }, lengthUnits, h('button', { type: 'button', class: 'xff-link', text: t('tabMeasure'), onclick: () => { state.tab = 'measure'; render('xff-tab-measure'); } }))));
  }

  // Moves what was typed (in the units on screen) into the profile, in cm and kg.
  function readDraft() {
    const p = state.p, d = state.draft;
    if (d.height !== undefined) p.heightCm = parseNum(d.height);
    if (d.ft !== undefined || d.in !== undefined) {
      const ft = parseNum(d.ft ?? (p.heightCm ? Math.floor(p.heightCm / CM_PER_IN / 12) : null)), inch = parseNum(d.in ?? 0) ?? 0;
      p.heightCm = ft == null ? null : Math.round((ft * 12 + inch) * CM_PER_IN);
    }
    if (d.weight !== undefined) { const w = parseNum(d.weight); p.weightKg = w == null ? null : Math.round((p.units.weight === 'lb' ? w * KG_PER_LB : w) * 10) / 10; }
    if (d.age !== undefined) p.age = parseNum(d.age);
    for (const [m, v] of Object.entries(d.tape ?? {})) { const n = parseNum(v); p.tape[m] = n == null ? null : Math.round((p.units.length === 'in' ? n * CM_PER_IN : n) * 10) / 10; }
    state.draft = {};
  }

  // Reads step 1 into the profile. Returns false (with messages) when the answers cannot work.
  function commitYou() {
    readDraft();
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
    const p = state.p;
    const rows = torsoMeasures().filter(m => !Number.isFinite(p.tape[m])).map(m => {
      const value = Number(p.shape[m] ?? 0), steps = TEXT[lang]?.shapeSteps ?? TEXT.en.shapeSteps;
      return h('fieldset', { class: 'xff-field xff-shape' },
        h('legend', { class: 'xff-label', text: t(m) }),
        h('div', { class: 'xff-shape__row' },
          h('span', { class: 'xff-muted xff-shape__end', 'aria-hidden': 'true', text: t('narrower') }),
          h('div', { class: 'xff-shape__steps' }, [-2, -1, 0, 1, 2].map((step, i) => {
            const id = `xff-shape-${m}-${step + 2}`;
            return h('label', { class: 'xff-dot', for: id, title: steps[i] },
              h('input', { type: 'radio', id, name: `xff-shape-${m}`, value: step, checked: value === step, 'aria-label': steps[i], onchange: () => { p.shape[m] = step; render(id); } }),
              h('span', { class: 'xff-dot__mark', 'aria-hidden': 'true' }));
          })),
          h('span', { class: 'xff-muted xff-shape__end', 'aria-hidden': 'true', text: t('broader') })));
    });
    return h('div', { class: 'xff-stack' }, h('p', { class: 'xff-muted', text: t('shapeIntro') }), rows);
  }

  function rideStep() {
    const p = state.p;
    return h('div', { class: 'xff-stack' },
      radioGroup({ legend: t('fitQuestion'), name: 'fit', value: p.fit, className: 'xff-cards', options: [['snug', t('snug'), t('snugText')], ['regular', t('regular'), t('regularText')], ['relaxed', t('relaxed'), t('relaxedText')]], onChange: v => { p.fit = v; } }),
      chart().measures.includes('chest') ? radioGroup({ legend: t('layersQuestion'), name: 'layers', value: p.layers, className: 'xff-cards xff-cards--compact', options: [['none', t('none')], ['hoodie', t('hoodie')], ['protector', t('protector')]], onChange: v => { p.layers = v; } }) : null);
  }

  function goNext() {
    if (state.step === 'you' && !commitYou()) { render('xff-next'); dialog.querySelector('.xff-errors')?.focus?.(); return; }
    state.errors = [];
    const fresh = steps(), i = fresh.indexOf(state.step);
    if (i < fresh.length - 1 && i >= 0) { state.step = fresh[i + 1]; render(); return; }
    if (i < 0) { state.step = fresh[fresh.length - 1]; render(); return; }
    save();
    state.step = 'result'; state.compare = null;
    render();
    const ev = evaluate(cfg, state.p);
    if (ev) announce(`${t('bestTitle')}: ${ev.result.best}. ${t('sure', { n: ev.result.confidence })}.`);
  }

  // ------------------------------------------------ result
  function resultView() {
    const ev = evaluate(cfg, state.p);
    if (!ev) { state.step = 'you'; return finderView(); }
    const { result, body, chart: c } = ev, unit = state.p.units.length;
    const shown = result.sizes.find(x => x.name === (state.compare ?? result.best)) ?? result.sizes.find(x => x.name === result.best);
    const best = result.sizes.find(x => x.name === result.best);
    const estimated = body.mode !== 'measured';
    const needsTape = estimated && result.confidence < 85;
    const regionRows = shown.regions.map(r => h('li', { class: `xff-region xff-region--${FIT_TONE[r.fit]}` },
      h('span', { class: 'xff-region__dot', 'aria-hidden': 'true' }),
      h('span', { class: 'xff-region__name', text: t(r.measure) }),
      h('strong', { class: 'xff-region__fit', text: t(FIT_LABEL[r.fit]) }),
      h('span', { class: 'xff-region__detail xff-muted', text: `${(estimated && !Number.isFinite(state.p.tape[r.measure]) ? t('youAbout', { v: lengthText(r.value, unit) }) : `${t('you')} ${lengthText(r.value, unit)}`)} · ${t('sizeRange', { size: shown.name, range: rangeText(r.range, unit) })}` })));
    const chips = h('fieldset', { class: 'xff-field xff-chips' },
      h('legend', { class: 'xff-label', text: t('compare') }),
      h('div', { class: 'xff-chips__row' }, result.sizes.map(size => {
        const id = `xff-compare-${normalizeSize(size.name)}`;
        const mark = size.verdict === 'best' ? '✓' : size.verdict === 'fits' ? '' : '×';
        const note = size.verdict === 'best' ? t('bestTitle') : size.verdict === 'fits' ? t('alsoFits') : t('notRecommended');
        return h('label', { class: `xff-chip xff-chip--${size.verdict}${size.available === false ? ' xff-chip--sold' : ''}`, for: id },
          h('input', { type: 'radio', id, name: 'xff-compare', value: size.name, checked: size.name === shown.name, onchange: () => { state.compare = size.name; render(id); } }),
          h('span', { class: 'xff-chip__name', text: size.name }), mark ? h('span', { class: 'xff-chip__mark', 'aria-hidden': 'true', text: mark }) : null,
          h('span', { class: 'xff-sr', text: `${note}${size.available === false ? `, ${t('soldOut')}` : ''}` }));
      })));
    const ctaSize = shown.verdict === 'no' ? best : shown;
    const soldOut = ctaSize.available === false;
    const callouts = [];
    if (result.outOfRange) callouts.push(h('div', { class: 'xff-callout xff-callout--bad', role: 'note' }, h('p', { text: t(result.outOfRange) }), h('a', { class: 'xff-link', href: cfg.contactUrl, text: t('contact') })));
    if (best.available === false) callouts.push(h('p', { class: 'xff-callout', text: t('bestSoldOut', { size: best.name }) }));
    if (body.warnings.includes('outsideModel')) callouts.push(h('p', { class: 'xff-callout xff-callout--warn', text: t('outsideModel') }));
    if (needsTape) callouts.push(tapeCallout(c));
    return h('div', { class: 'xff-layout xff-layout--result' },
      c.measures.some(m => TORSO.includes(m)) ? h('div', { class: 'xff-aside' }, figure(state.p.sex, body.values, shown.regions.map(r => ({ measure: r.measure, tone: FIT_TONE[r.fit] })))) : null,
      h('div', { class: 'xff-main' },
        h('div', { class: 'xff-result' },
          h('div', { class: 'xff-result__size' }, h('span', { class: 'xff-muted', text: t('bestTitle') }), h('strong', { class: 'xff-result__name', tabindex: '-1', 'data-xff-focus': true, text: result.best })),
          h('div', { class: 'xff-result__confidence' },
            h('span', { text: t('sure', { n: result.confidence }) }),
            h('span', { class: 'xff-meter', role: 'img', 'aria-label': t('sure', { n: result.confidence }) }, h('span', { class: 'xff-meter__fill', style: `inline-size:${result.confidence}%` })),
            result.runnerUp && result.runnerUp.share >= 25 ? h('span', { class: 'xff-muted', text: t('between', { a: result.best, b: result.runnerUp.name }) }) : null)),
        cutNote(c),
        h('ul', { class: 'xff-regions', 'aria-label': `${t('size')} ${shown.name}` }, regionRows),
        chips,
        callouts,
        h('div', { class: 'xff-actions' },
          h('button', { type: 'button', class: 'xff-button', id: 'xff-choose', disabled: soldOut, text: soldOut ? `${ctaSize.name} · ${t('soldOut')}` : t('choose', { size: ctaSize.name }), onclick: () => choose(ctaSize.name) }),
          h('button', { type: 'button', class: 'xff-button xff-button--secondary', id: 'xff-edit', text: t('edit'), onclick: () => { state.step = 'you'; state.errors = []; render(); } })),
        h('p', { class: 'xff-muted xff-privacy' }, t('privacy'), ' ', h('button', { type: 'button', class: 'xff-link', id: 'xff-forget', text: t('forget'), onclick: forget }))));
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
      const ev = evaluate(cfg, p); if (ev) announce(`${t('bestTitle')}: ${ev.result.best}. ${t('sure', { n: ev.result.confidence })}.`);
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
    return h('div', { class: 'xff-layout' },
      measures.some(m => TORSO.includes(m)) ? h('div', { class: 'xff-aside' }, figure(state.p.sex, {}, measures.map(m => ({ measure: m, tone: 'ok', dashed: true })))) : null,
      h('div', { class: 'xff-main xff-stack' },
        h('ol', { class: 'xff-how' }, measures.map(m => h('li', {}, h('strong', { text: t(m) }), h('p', { text: t(HOW[m]) })))),
        h('p', { class: 'xff-callout', text: t('measureTips') })));
  }

  // ------------------------------------------------ add-to-cart check
  function guardView() {
    const ev = evaluate(cfg, state.p), verdict = ev && verdictFor(ev.result, state.chosen);
    if (!ev || !verdict) return h('p', { text: t('noChart') });
    const worst = worstRegion(verdict);
    return h('div', { class: 'xff-stack xff-guard' },
      ev.chart.measures.some(m => TORSO.includes(m)) ? h('div', { class: 'xff-guard__figure' }, figure(state.p.sex, ev.body.values, verdict.regions.map(r => ({ measure: r.measure, tone: FIT_TONE[r.fit] })))) : null,
      h('p', { 'data-xff-focus': true, tabindex: '-1', text: t('guardText', { chosen: state.chosen, fit: lowerFit(worst.fit), part: t(worst.measure).toLowerCase(), best: ev.result.best }) }),
      h('div', { class: 'xff-actions' },
        h('button', { type: 'button', class: 'xff-button', id: 'xff-switch', text: t('switchTo', { best: ev.result.best }), onclick: () => {
          const picked = selectSize(cfg, ev.result.best);
          close();
          if (picked) afterSizeChange(cfg, t('chosen', { size: ev.result.best }));
        } }),
        h('button', { type: 'button', class: 'xff-button xff-button--secondary', id: 'xff-keep', text: t('keep', { chosen: state.chosen }), onclick: () => {
          const form = document.getElementById(cfg.formId);
          close();
          if (form) { form.dataset.xffBypass = '1'; form.requestSubmit(options.submitter && options.submitter.form === form ? options.submitter : undefined); }
        } })),
      h('button', { type: 'button', class: 'xff-link', id: 'xff-why', text: t('edit'), onclick: () => { state.mode = 'finder'; state.step = 'result'; state.compare = state.chosen; render(); } }));
  }

  render();
  dialog.showModal();
  (dialog.querySelector('[data-xff-focus]') ?? dialog.querySelector('.xff-close'))?.focus({ preventScroll: true });
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
