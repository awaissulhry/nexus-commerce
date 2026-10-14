// Xavia fit finder: the size math. Pure functions, no DOM, so the same file runs in the shop and in node --test.
//
// Body model: least-squares fits on the public ANSUR II survey (US Army, 2012; 4,082 men, 1,986 women;
// tools.openlab.psu.edu/publicData). Each measure in cm = c0 + c1·height cm + c2·weight kg + c3·age + c4·BMI.
// sd is the residual standard deviation: how far a real person usually is from the guess.
// The charts are BODY measurements (the Xavia charts say "misure corpo"), so the body is compared to them directly.
// A product may also carry its GARMENT measurements (the finished jacket, per size). They are never shown; they only
// check the room between the garment and the body (see ROOM).
// ANSUR columns: chest/waist/buttock circumference (chest, waist, hips), hand circumference and length, crotch height
// (inseam), sleeve outseam (sleeve: shoulder point to wrist), neck circumference at the base (neck), thigh and calf
// circumference. Head circumference and foot length are left out on purpose: height and weight explain too little of
// them (R² 0.17–0.55), so a guess would often miss a helmet or boot size. The shopper measures those.

export const BODY_MODEL = {
  male: {
    chest: { c: [23.7502, 0.1533, 0.1667, 0.1073, 1.3615], sd: 3.06 },
    waist: { c: [20.9143, 0.0112, 0.3382, 0.1948, 1.3139], sd: 4.04 },
    hips: { c: [7.4156, 0.2799, 0.1002, -0.0513, 1.3854], sd: 2.56 },
    hand: { c: [4.132, 0.0794, -0.0102, 0.0093, 0.1352], sd: 0.79 },
    handLength: { c: [1.6433, 0.0953, 0.0026, 0.0089, 0.0168], sd: 0.72 },
    inseam: { c: [-17.2862, 0.5997, -0.0181, -0.0064, -0.0613], sd: 2.34 },
    sleeve: { c: [-0.4841, 0.3414, 0.0205, 0.0008, -0.0695], sd: 1.84 },
    neck: { c: [17.3458, 0.0749, 0.0296, 0.0192, 0.3556], sd: 1.62 },
    thigh: { c: [17.9354, 0.0588, 0.1608, -0.0901, 0.8384], sd: 2.11 },
    calf: { c: [11.9528, 0.065, 0.0506, -0.0296, 0.4487], sd: 1.58 },
  },
  female: {
    chest: { c: [8.6628, 0.2139, 0.076, 0.1236, 1.6657], sd: 4.11 },
    waist: { c: [0.637, 0.136, 0.1792, 0.112, 1.8799], sd: 4.73 },
    hips: { c: [-7.8984, 0.388, 0.007, 0.0046, 1.8129], sd: 2.9 },
    hand: { c: [8.4575, 0.0485, 0.0164, 0.0015, 0.045], sd: 0.71 },
    handLength: { c: [8.416, 0.0517, 0.0576, 0.0043, -0.1084], sd: 0.75 },
    inseam: { c: [-9.8357, 0.5563, 0.0439, -0.0226, -0.1902], sd: 2.33 },
    sleeve: { c: [-4.2942, 0.3526, 0.012, -0.0079, 0.0251], sd: 1.78 },
    neck: { c: [11.6904, 0.102, 0.0164, 0.0067, 0.2944], sd: 1.34 },
    thigh: { c: [3.5146, 0.1437, 0.1091, -0.0229, 1.0971], sd: 2.25 },
    calf: { c: [9.8245, 0.0791, 0.0665, -0.0414, 0.4435], sd: 1.66 },
  },
};

// The survey covers these inputs; outside them the guess is not trusted and the shopper is asked to measure.
export const MODEL_RANGE = { height: [140, 205], weight: [38, 150], bmi: [16, 42] };
export const LIMITS = { height: [120, 230], weight: [30, 250], age: [14, 99] };
// A tape measure at home is read to about 1 cm.
const TAPE_SD = 1;
// Extra body size under the garment, in cm, for torso measures only.
export const LAYERS = { none: {}, hoodie: { chest: 3, waist: 3 }, protector: { chest: 5, waist: 4 } };
// Where the body should sit inside a size's range: -1 = bottom, 0 = middle, +1 = top.
const FIT_TARGET = { snug: 0.45, regular: 0, relaxed: -0.45 };
const MATERIAL_TARGET = { leather: 0.2 };
// Over a size's top by more than half a size step = too tight; under its bottom by about one step = too loose.
const TOO_TIGHT_CM = 3, TOO_LOOSE_CM = 5;

const round1 = v => Math.round(v * 10) / 10;
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

export function normalizeSize(name) {
  const s = String(name ?? '').toUpperCase().replace(/\s+/g, '');
  const aliases = { '2XL': 'XXL', XXXL: '3XL', XXXXL: '4XL', XXXXXL: '5XL', '2XS': 'XXS' };
  return aliases[s] ?? s;
}

/** Checks typed inputs. Returns the list of problems (empty = fine). */
export function validateInputs({ heightCm, weightKg, age }) {
  const problems = [];
  if (!(heightCm >= LIMITS.height[0] && heightCm <= LIMITS.height[1])) problems.push('height');
  if (!(weightKg >= LIMITS.weight[0] && weightKg <= LIMITS.weight[1])) problems.push('weight');
  if (age != null && !(age >= LIMITS.age[0] && age <= LIMITS.age[1])) problems.push('age');
  return problems;
}

/**
 * Guesses body measures from height, weight and age.
 * shape: { chest, waist, hips } steps from -2 (narrower) to +2 (broader); one step moves 0.8 sd.
 */
export function estimateBody({ sex, heightCm, weightKg, age, shape = {} }) {
  const model = BODY_MODEL[sex === 'female' ? 'female' : 'male'];
  const years = clamp(age == null || Number.isNaN(age) ? 35 : age, [17, 60]);
  const bmi = weightKg / (heightCm / 100) ** 2;
  const x = [1, heightCm, weightKg, years, bmi];
  const values = { height: heightCm }, sd = { height: TAPE_SD };
  for (const [measure, { c, sd: spread }] of Object.entries(model)) {
    const step = clamp(Number(shape[measure]) || 0, [-2, 2]);
    values[measure] = round1(c.reduce((sum, ci, i) => sum + ci * x[i], 0) + step * 0.8 * spread);
    sd[measure] = spread;
  }
  const warnings = [];
  if (heightCm < MODEL_RANGE.height[0] || heightCm > MODEL_RANGE.height[1] || weightKg < MODEL_RANGE.weight[0] ||
      weightKg > MODEL_RANGE.weight[1] || bmi < MODEL_RANGE.bmi[0] || bmi > MODEL_RANGE.bmi[1]) warnings.push('outsideModel');
  return { mode: 'estimate', values, sd, warnings };
}

/** Body from a tape measure. values: { chest, waist, hips, … } in cm; missing measures stay missing. */
export function measuredBody(values) {
  const clean = {}, sd = {};
  for (const [measure, value] of Object.entries(values)) {
    if (Number.isFinite(value) && value > 0) { clean[measure] = round1(value); sd[measure] = TAPE_SD; }
  }
  return { mode: 'measured', values: clean, sd, warnings: [] };
}

/** A guess where the shopper also measured some parts: each tape value replaces the guess for that part. */
export function combineBody(estimate, measured) {
  if (!estimate) return measured;
  if (!measured || !Object.keys(measured.values).length) return estimate;
  return { mode: 'mixed', values: { ...estimate.values, ...measured.values }, sd: { ...estimate.sd, ...measured.sd }, warnings: estimate.warnings };
}

/**
 * Every measure a chart may list, with the values a person can have (cm), for checking what the shopper types.
 * A measure with a BODY_MODEL entry can be guessed from height and weight; the others must be measured.
 */
export const MEASURES = {
  chest: [60, 170], waist: [45, 170], hips: [60, 180], sleeve: [40, 80], neck: [28, 56], inseam: [55, 100],
  thigh: [35, 95], calf: [25, 60], head: [48, 66], foot: [20, 33], hand: [14, 30], handLength: [14, 24], height: [120, 230],
};
/** True when the body model can guess this measure from height and weight. */
export const canEstimate = (sex, measure) => measure === 'height' || Boolean(BODY_MODEL[sex === 'female' ? 'female' : 'male'][measure]);
/** A typed measure is believable. */
export const validMeasure = (measure, cm) => Number.isFinite(cm) && cm >= MEASURES[measure][0] && cm <= MEASURES[measure][1];
const isRange = r => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[0] < r[1];

/** Measures that are lengths: over the range means the garment is too short, not too tight. */
export const LENGTHS = ['sleeve', 'inseam'];
/**
 * Room for a good fit, in cm: garment measure minus body measure (plus layers), [least, most]. Less than "least" is
 * too tight (too short for a length); more than "most" is too loose (too long). Starting values for motorcycle
 * clothing with armour; a product's garment measurements may set their own (garment.room).
 * Circumferences are the full way round (a measure taken flat counts twice); sleeve = shoulder seam to cuff,
 * compared with the arm from the shoulder point to the wrist; inseam = crotch seam to hem.
 */
export const ROOM = {
  chest: [4, 20], waist: [2, 24], hips: [2, 24], neck: [0, 10], thigh: [2, 16], calf: [1, 14], sleeve: [1, 9], inseam: [-4, 6],
};
/**
 * The product's garment measurements (the xavia.fit_garment metafield), checked: { measures, sizes: [{ name, chest… }],
 * room? }. Measures without a ROOM entry and broken values are dropped; null when nothing usable is left.
 */
export function validGarment(garment) {
  if (!garment || !Array.isArray(garment.measures) || !Array.isArray(garment.sizes)) return null;
  const own = garment.room ?? {};
  const roomOf = m => (Array.isArray(own[m]) && own[m].length === 2 && own[m].every(Number.isFinite) && own[m][0] < own[m][1] ? own[m] : ROOM[m]);
  const measures = garment.measures.filter(m => m in ROOM && garment.sizes.some(s => Number.isFinite(s?.[m]) && s[m] > 0));
  const sizes = garment.sizes.filter(s => s?.name).map(s => ({ name: s.name, ...Object.fromEntries(measures.filter(m => Number.isFinite(s[m]) && s[m] > 0).map(m => [m, s[m]])) }));
  if (!measures.length || !sizes.length) return null;
  return { measures, sizes, room: Object.fromEntries(measures.map(m => [m, roomOf(m)])) };
}
/** A chart is usable only when every size has a [from, to] range for every measure it lists. */
export function validChart(chart) {
  return Boolean(chart && Array.isArray(chart.measures) && chart.measures.length && chart.measures.every(m => m in MEASURES) &&
    Array.isArray(chart.sizes) && chart.sizes.length && chart.sizes.every(s => s?.name && chart.measures.every(m => isRange(s[m]))));
}

/**
 * The charts for one product. override = the product's xavia.fit_chart metafield (a chart, a default chart's key,
 * or { men, women } of either); otherwise kind ("jacket") and audience (["men", "women"]) pick default charts.
 */
export function chartsForProduct({ override, defaults = {}, kind, audience = [] }) {
  const resolve = value => { const chart = typeof value === 'string' ? defaults[value] : value; return validChart(chart) ? chart : undefined; };
  let charts = {};
  if (override && (typeof override === 'string' || override.sizes)) charts = { unisex: resolve(override) };
  else if (override && typeof override === 'object') charts = { men: resolve(override.men), women: resolve(override.women) };
  else if (kind) {
    const both = !audience.length || (audience.includes('men') && audience.includes('women'));
    charts = { men: both || audience.includes('men') ? resolve(`men-${kind}`) : undefined, women: both || audience.includes('women') ? resolve(`women-${kind}`) : undefined };
  }
  return Object.fromEntries(Object.entries(charts).filter(([, chart]) => chart));
}

/**
 * Picks the chart for this shopper. charts: { men?, women?, unisex? }.
 * One chart: it fits everybody (a man may buy a women's cut). Two charts: the shopper's own.
 */
export function pickChart(charts, sex) {
  const own = sex === 'female' ? charts.women : charts.men;
  return own ?? charts.unisex ?? charts.men ?? charts.women ?? null;
}

const effective = (measures, body, layers) => {
  const extra = LAYERS[layers] ?? {};
  return Object.fromEntries(measures.map(m => [m, body[m] == null ? null : body[m] + (extra[m] ?? 0)]));
};

/** How one measure sits in one size: tooTight, snug, right, loose or tooLoose, plus cm over or under the range. */
export function regionFit([lo, hi], value) {
  const quarter = (hi - lo) / 4;
  if (value > hi + TOO_TIGHT_CM) return { fit: 'tooTight', cm: round1(value - hi) };
  if (value > hi - quarter) return { fit: 'snug', cm: round1(Math.max(0, value - hi)) };
  if (value >= lo + quarter) return { fit: 'right', cm: 0 };
  if (value >= lo - TOO_LOOSE_CM) return { fit: 'loose', cm: round1(Math.max(0, lo - value)) };
  return { fit: 'tooLoose', cm: round1(lo - value) };
}

/** How the room in the garment feels, in the same words: room = garment − body, room band = [least, most]. */
export function roomFit([least, most], room) {
  const quarter = (most - least) / 4;
  if (room < least) return { fit: 'tooTight' };
  if (room < least + quarter) return { fit: 'snug' };
  if (room <= most - quarter) return { fit: 'right' };
  if (room <= most) return { fit: 'loose' };
  return { fit: 'tooLoose' };
}
const garmentSize = (garment, name) => garment?.sizes.find(s => normalizeSize(s.name) === normalizeSize(name)) ?? null;
// Less room than the least is "too tight" (or "too short"), as wrong as a body 3 cm over a size's top on the chart.
const TIGHT_COST = 8;
// More room than the most, on a garment-only measure (a sleeve the body chart does not list), costs a little.
const GARMENT_WEIGHT = 0.3;
// cm outside the room band that cost as much as half a size step on the chart.
const ROOM_STEP = 3;

// Too tight anywhere is wrong (it cannot close, armour presses). Too loose is wrong only on the main measure
// (chest for a jacket): armour that moves. A roomy waist is fine; jackets have waist adjusters.
const primaryOf = chart => chart.primary ?? chart.measures.slice(0, 1);
const wrong = (chart, region) => region.fit === 'tooTight' || (region.fit === 'tooLoose' && primaryOf(chart).includes(region.measure));

const weightsFor = chart => {
  if (chart.weights) return chart.weights;
  if (chart.measures.includes('chest') && chart.measures.includes('waist') && chart.measures.length === 2) return { chest: 0.6, waist: 0.4 };
  return Object.fromEntries(chart.measures.map(m => [m, 1 / chart.measures.length]));
};

// Lower is better. Inside the range: distance from the wished position. Outside: a steep extra cost,
// steeper when too tight (armour that cannot close) than when too loose (armour that moves).
// Room on a secondary measure (a jacket's waist) costs only a little: it has adjusters.
function sizeCost(chart, size, eff, target, garment) {
  const weights = weightsFor(chart), primary = primaryOf(chart);
  let cost = 0, used = 0;
  // The garment: a chart measure costs only when the garment leaves less than the least room (the product runs
  // small); a garment-only measure costs outside its room band. Inside the band the garment costs nothing.
  const gsize = garmentSize(garment, size.name);
  for (const m of garment?.measures ?? []) {
    if (eff[m] == null || gsize?.[m] == null) continue;
    const [least, most] = garment.room[m], room = gsize[m] - eff[m];
    if (room < least) cost += TIGHT_COST + 4 * ((least - room) / ROOM_STEP) ** 2;
    else if (room > most && !chart.measures.includes(m)) cost += GARMENT_WEIGHT * ((room - most) / ROOM_STEP) ** 2;
  }
  for (const m of chart.measures) {
    if (eff[m] == null || !size[m]) continue;
    const [lo, hi] = size[m], half = Math.max(0.5, (hi - lo) / 2), t = (eff[m] - (lo + hi) / 2) / half;
    const roomy = t < -1 && !primary.includes(m);
    let pen = roomy ? (-1 - target) ** 2 + 0.3 * (-1 - t) : (t - target) ** 2;
    if (t > 1) pen += 4 * (t - 1) ** 2;
    if (t < -1 && !roomy) pen += 2 * (-1 - t) ** 2;
    cost += (weights[m] ?? 0) * pen; used += weights[m] ?? 0;
  }
  return used ? cost / used : Infinity;
}

const bestIndex = (chart, eff, target, garment) => {
  let best = -1, low = Infinity;
  chart.sizes.forEach((size, i) => { const c = sizeCost(chart, size, eff, target, garment); if (c < low) { low = c; best = i; } });
  return best;
};

// Small seeded random generator, so one set of answers always gives the same confidence.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gaussian = next => { const u = Math.max(next(), 1e-12), v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const seedOf = values => Object.entries(values).sort().reduce((h, [k, v]) => Math.imul(h ^ (k.length * 31 + Math.round(v * 10)), 16777619), 2166136261);

/**
 * Ranks every size of the chart for this body.
 * options.fit: snug | regular | relaxed; options.layers: none | hoodie | protector;
 * options.material: leather | textile | …; options.available: { [size]: boolean } (missing = unknown);
 * options.garment: the product's garment measurements, checked by validGarment (optional).
 * Returns { missing } when the body lacks a measure the chart needs. A garment measure the body lacks is skipped.
 * A region from the garment has garment: true and no cm and range, so the garment numbers never reach the screen.
 */
export function recommend(chart, body, options = {}) {
  const missing = chart.measures.filter(m => body.values[m] == null);
  if (missing.length) return { missing };
  const target = clamp((FIT_TARGET[options.fit] ?? 0) + (MATERIAL_TARGET[options.material] ?? 0), [-0.6, 0.6]);
  const garment = options.garment ?? null;
  const extra = (garment?.measures ?? []).filter(m => !chart.measures.includes(m) && body.values[m] != null);
  const measures = [...chart.measures, ...extra];
  const eff = effective(measures, body.values, options.layers);
  const best = bestIndex(chart, eff, target, garment);
  const sizes = chart.sizes.map((size, i) => {
    const gsize = garmentSize(garment, size.name);
    const room = m => (gsize?.[m] == null ? null : gsize[m] - eff[m]);
    const regions = chart.measures.map(m => {
      const region = { measure: m, value: round1(eff[m]), range: size[m], ...regionFit(size[m], eff[m]) };
      // The body chart says how it fits; the garment can only add "too tight" when it leaves too little room.
      return garment?.room[m] && room(m) != null && room(m) < garment.room[m][0] ? { ...region, fit: 'tooTight', cm: null, garment: true } : region;
    }).concat(extra.filter(m => room(m) != null).map(m => ({ measure: m, value: round1(eff[m]), range: null, cm: null, garment: true, ...roomFit(garment.room[m], room(m)) })));
    const fits = !regions.some(r => wrong(chart, r));
    const available = options.available?.[normalizeSize(size.name)];
    return { name: size.name, index: i, regions, verdict: i === best ? 'best' : fits ? 'fits' : 'no', available: available ?? null };
  });
  // Confidence: draw 400 bodies around the guess (tape: ±1 cm; estimate: the survey spread) and count
  // how often the same size wins. Low confidence means "measure with a tape before you buy".
  const next = rng(seedOf({ ...body.values, t: target * 100 }));
  const wins = new Array(chart.sizes.length).fill(0);
  for (let n = 0; n < 400; n++) {
    const drawn = Object.fromEntries(measures.map(m => [m, eff[m] + gaussian(next) * (body.sd[m] ?? TAPE_SD)]));
    wins[bestIndex(chart, drawn, target, garment)]++;
  }
  const runnerUp = wins.map((w, i) => [w, i]).filter(([, i]) => i !== best).sort((a, b) => b[0] - a[0])[0];
  const bestSize = sizes[best];
  // Even the best size can be wrong: bigger than the largest size (above), smaller than the smallest (below),
  // or proportions the chart does not have (mixed: e.g. the chest fits one size and the waist another).
  const tight = bestSize.regions.some(r => r.fit === 'tooTight'), loose = bestSize.regions.some(r => r.fit === 'tooLoose' && wrong(chart, r));
  const last = best === chart.sizes.length - 1, first = best === 0;
  const outOfRange = !tight && !loose ? null : tight && !loose && last ? 'above' : loose && !tight && first ? 'below' : 'mixed';
  return {
    best: bestSize.name,
    confidence: Math.round((wins[best] / 400) * 100),
    runnerUp: runnerUp && runnerUp[0] > 0 ? { name: sizes[runnerUp[1]].name, share: Math.round((runnerUp[0] / 400) * 100) } : null,
    outOfRange,
    sizes,
    target,
  };
}

/** The verdict for one size name, for the add-to-cart check. */
export const verdictFor = (result, name) => result?.sizes?.find(s => normalizeSize(s.name) === normalizeSize(name)) ?? null;
