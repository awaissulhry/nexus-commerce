import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const E = await import('../fit-finder/xavia-fit-engine.js')
// The charts the theme ships (snippets/xavia-fit-charts.liquid holds plain JSON).
const charts = JSON.parse(readFileSync(new URL('../fit-finder/xavia-fit-charts.liquid', import.meta.url), 'utf8').replace(/^\s*\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}\s*/, ''))
const men = charts['men-jacket'], women = charts['women-jacket']
const pick = (chart, body, options) => E.recommend(chart, body, options)
const index = (chart, name) => chart.sizes.findIndex(s => s.name === name)

test('the shipped charts match the Xavia chart images, size by size', () => {
  assert.deepEqual(men.sizes.map(s => s.name), ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'])
  assert.deepEqual(men.sizes.find(s => s.name === 'L'), { name: 'L', chest: [98, 104], waist: [86, 92] })
  assert.deepEqual(women.sizes.map(s => s.name), ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'])
  assert.deepEqual(women.sizes.find(s => s.name === 'M'), { name: 'M', chest: [88, 94], waist: [72, 78] })
  for (const chart of [men, women]) for (let i = 1; i < chart.sizes.length; i++) {
    assert.equal(chart.sizes[i].chest[0], chart.sizes[i - 1].chest[1], `${chart.sizes[i].name} chest starts where the size below ends`)
    assert.equal(chart.sizes[i].waist[0], chart.sizes[i - 1].waist[1], `${chart.sizes[i].name} waist starts where the size below ends`)
  }
})

test('an average man (178 cm, 80 kg, 35) gets L from height and weight alone', () => {
  const body = E.estimateBody({ sex: 'male', heightCm: 178, weightKg: 80, age: 35 })
  assert.ok(Math.abs(body.values.chest - 102.5) < 0.2, `chest ${body.values.chest}`)
  assert.ok(Math.abs(body.values.waist - 90) < 0.2, `waist ${body.values.waist}`)
  const result = pick(men, body)
  assert.equal(result.best, 'L')
  assert.equal(result.outOfRange, null)
  assert.ok(result.confidence > 0 && result.confidence < 100)
})

test('tape measures inside one size give that size with high confidence', () => {
  const result = pick(men, E.measuredBody({ chest: 96, waist: 84 }))
  assert.equal(result.best, 'M')
  assert.ok(result.confidence >= 90, `confidence ${result.confidence}`)
  assert.deepEqual(result.sizes[index(men, 'M')].regions.map(r => r.fit), ['right', 'right'])
})

test('a size far too small is "no" with too tight, the next sizes say how they fit', () => {
  const result = pick(men, E.measuredBody({ chest: 102, waist: 90 }))
  assert.equal(result.best, 'L')
  const s = result.sizes[index(men, 'S')]
  assert.equal(s.verdict, 'no')
  assert.equal(s.regions[0].fit, 'tooTight')
  assert.equal(s.regions[0].cm, 8)
  assert.equal(result.sizes[index(men, 'XXL')].regions[0].fit, 'tooLoose')
})

test('a roomy waist alone never makes a jacket wrong; a tight waist does', () => {
  const athletic = pick(men, E.measuredBody({ chest: 106, waist: 80 }))
  assert.equal(athletic.best, 'XL')
  assert.equal(athletic.sizes[index(men, 'XL')].regions[1].fit, 'tooLoose')
  assert.equal(athletic.sizes[index(men, 'XL')].verdict, 'best')
  assert.equal(athletic.outOfRange, null)
  const belly = pick(men, E.measuredBody({ chest: 100, waist: 104 }))
  assert.notEqual(belly.best, 'L', 'L would not close at the waist')
  assert.equal(belly.sizes[index(men, 'L')].verdict, 'no')
})

test('outside the whole chart is said plainly', () => {
  assert.equal(pick(men, E.measuredBody({ chest: 145, waist: 130 })).outOfRange, 'above')
  assert.equal(pick(men, E.measuredBody({ chest: 70, waist: 60 })).outOfRange, 'below')
})

test('fit wish and layers move the size the right way, never backwards', () => {
  const body = E.measuredBody({ chest: 103, waist: 91 })
  const at = fit => index(men, pick(men, body, { fit }).best)
  assert.ok(at('snug') <= at('regular') && at('regular') <= at('relaxed'))
  assert.ok(at('snug') < at('relaxed'), 'a borderline body changes size between snug and relaxed')
  const plain = index(men, pick(men, body).best), vest = index(men, pick(men, body, { layers: 'protector' }).best)
  assert.equal(vest, plain + 1, 'an airbag vest under the jacket needs one size up here')
  assert.ok(index(men, pick(men, body, { material: 'leather' }).best) <= plain, 'leather may sit closer, never bigger')
})

test('shape answers move the guess by 0.8 survey spread per step', () => {
  const base = E.estimateBody({ sex: 'female', heightCm: 165, weightKg: 62, age: 30 })
  const broad = E.estimateBody({ sex: 'female', heightCm: 165, weightKg: 62, age: 30, shape: { chest: 2, waist: -1 } })
  assert.ok(Math.abs(broad.values.chest - base.values.chest - 2 * 0.8 * E.BODY_MODEL.female.chest.sd) < 0.11)
  assert.ok(Math.abs(base.values.waist - broad.values.waist - 0.8 * E.BODY_MODEL.female.waist.sd) < 0.11)
  assert.deepEqual(E.estimateBody({ sex: 'male', heightCm: 175, weightKg: 75, age: 30, shape: { chest: 9 } }).values.chest,
    E.estimateBody({ sex: 'male', heightCm: 175, weightKg: 75, age: 30, shape: { chest: 2 } }).values.chest, 'steps stop at ±2')
})

test('a tape value replaces the guess for that part only', () => {
  const guess = E.estimateBody({ sex: 'male', heightCm: 180, weightKg: 85, age: 40 })
  const mixed = E.combineBody(guess, E.measuredBody({ chest: 99, waist: NaN }))
  assert.equal(mixed.mode, 'mixed')
  assert.equal(mixed.values.chest, 99)
  assert.equal(mixed.sd.chest, 1)
  assert.equal(mixed.values.waist, guess.values.waist)
  assert.equal(mixed.sd.waist, guess.sd.waist)
  assert.ok(pick(men, mixed).confidence >= pick(men, guess).confidence)
})

test('bodies the survey does not cover ask for a tape measure', () => {
  assert.deepEqual(E.estimateBody({ sex: 'male', heightCm: 180, weightKg: 80, age: 30 }).warnings, [])
  assert.deepEqual(E.estimateBody({ sex: 'male', heightCm: 180, weightKg: 160, age: 30 }).warnings, ['outsideModel'])
  assert.deepEqual(E.validateInputs({ heightCm: 180, weightKg: 80, age: null }), [])
  assert.deepEqual(E.validateInputs({ heightCm: 18, weightKg: 800, age: 5 }), ['height', 'weight', 'age'])
})

test('charts: one chart serves everybody, two charts give each shopper their own', () => {
  assert.equal(E.pickChart({ men }, 'female'), men)
  assert.equal(E.pickChart({ men, women }, 'female'), women)
  assert.equal(E.pickChart({ men, women }, 'male'), men)
  assert.equal(E.pickChart({}, 'male'), null)
})

test('a chart measure the body lacks is reported, not guessed', () => {
  const gloves = { measures: ['hand'], sizes: [{ name: 'M', hand: [20, 22] }] }
  assert.deepEqual(E.recommend(gloves, E.measuredBody({ chest: 100 })), { missing: ['hand'] })
})

test('the same answers always give the same confidence; size names match loosely', () => {
  const body = E.estimateBody({ sex: 'male', heightCm: 172, weightKg: 70, age: 28 })
  assert.deepEqual(pick(men, body), pick(men, body))
  assert.equal(E.normalizeSize(' xxxl '), '3XL')
  assert.equal(E.normalizeSize('2XL'), 'XXL')
  assert.equal(E.verdictFor(pick(men, body), 'xxl').name, 'XXL')
})

test('products get charts from their kind and audience; a metafield overrides; broken charts are dropped', () => {
  const defaults = charts
  assert.deepEqual(Object.keys(E.chartsForProduct({ defaults, kind: 'jacket', audience: ['men', 'women'] })), ['men', 'women'])
  assert.deepEqual(Object.keys(E.chartsForProduct({ defaults, kind: 'jacket', audience: ['women'] })), ['women'])
  assert.deepEqual(Object.keys(E.chartsForProduct({ defaults, kind: 'jacket', audience: [] })), ['men', 'women'])
  assert.deepEqual(E.chartsForProduct({ defaults, kind: 'pants', audience: ['men'] }), {}, 'no pants chart yet: no finder')
  assert.equal(E.chartsForProduct({ defaults, override: 'women-jacket', kind: 'jacket' }).unisex, women)
  const own = { measures: ['hand'], sizes: [{ name: 'M', hand: [20, 22] }] }
  assert.equal(E.chartsForProduct({ defaults, override: own }).unisex, own)
  assert.deepEqual(Object.keys(E.chartsForProduct({ defaults, override: { men: 'men-jacket', women: { measures: ['chest'], sizes: [{ name: 'S', chest: [90, 80] }] } } })), ['men'])
  assert.equal(E.validChart({ measures: ['shoe'], sizes: [{ name: '42', shoe: [26, 27] }] }), false)
})

test('a body whose chest and waist sit in different sizes is told so, not told "too big"', () => {
  const result = pick(women, E.measuredBody({ chest: 98.8, waist: 96.4 }))
  assert.equal(result.outOfRange, 'mixed')
  assert.notEqual(result.best, women.sizes.at(-1).name)
})

test('every measure a chart may list has a range; the survey guesses all but head and foot, which are measured', () => {
  for (const [m, [lo, hi]] of Object.entries(E.MEASURES)) assert.ok(lo > 0 && lo < hi, m)
  for (const sex of ['male', 'female']) {
    for (const m of ['chest', 'waist', 'hips', 'sleeve', 'neck', 'inseam', 'thigh', 'calf', 'hand', 'handLength', 'height']) assert.ok(E.canEstimate(sex, m), `${sex} ${m}`)
    for (const m of ['head', 'foot']) assert.equal(E.canEstimate(sex, m), false, `${sex} ${m}: a guess would miss a helmet or boot size`)
  }
  // An average man: a sleeve, neck, thigh and calf a tape would give (ANSUR II means near 178 cm, 80 kg).
  const v = E.estimateBody({ sex: 'male', heightCm: 178, weightKg: 80, age: 35 }).values
  assert.ok(v.sleeve > 58 && v.sleeve < 64, `sleeve ${v.sleeve}`)
  assert.ok(v.neck > 37 && v.neck < 43, `neck ${v.neck}`)
  assert.ok(v.thigh > 54 && v.thigh < 64, `thigh ${v.thigh}`)
  assert.ok(v.calf > 35 && v.calf < 42, `calf ${v.calf}`)
  assert.equal(v.head, undefined)
  assert.equal(E.validMeasure('head', 57.5), true)
  assert.equal(E.validMeasure('head', 5.75), false, 'a slip of the comma is caught')
})

test('any chart works: a jacket with sleeve length, a helmet sized by tape only, gloves', () => {
  const jacket = { measures: ['chest', 'waist', 'sleeve'], sizes: [
    { name: 'M', chest: [94, 98], waist: [82, 86], sleeve: [62, 64] }, { name: 'L', chest: [98, 104], waist: [86, 92], sleeve: [64, 66] }] }
  assert.ok(E.validChart(jacket))
  const guess = E.estimateBody({ sex: 'male', heightCm: 178, weightKg: 80, age: 35 })
  assert.equal(pick(jacket, guess).best, 'L')
  // Long arms move the size up even when chest and waist sit in M.
  assert.equal(pick(jacket, E.measuredBody({ chest: 96, waist: 84, sleeve: 63 })).best, 'M')
  assert.equal(pick(jacket, E.measuredBody({ chest: 96, waist: 84, sleeve: 67 })).best, 'L')
  const helmet = { measures: ['head'], sizes: [{ name: 'M', head: [57, 58.9] }, { name: 'L', head: [59, 60.9] }] }
  assert.ok(E.validChart(helmet))
  assert.deepEqual(pick(helmet, guess).missing, ['head'], 'no guess for a helmet: the shopper measures')
  assert.equal(pick(helmet, E.combineBody(guess, E.measuredBody({ head: 59.5 }))).best, 'L')
  const gloves = { measures: ['hand', 'handLength'], sizes: [{ name: 'M', hand: [20.5, 22], handLength: [18, 19] }, { name: 'L', hand: [22, 23.5], handLength: [19, 20] }] }
  assert.equal(pick(gloves, E.measuredBody({ hand: 21, handLength: 18.4 })).best, 'M')
  assert.equal(E.validChart({ measures: ['wingspan'], sizes: [{ name: 'M', wingspan: [1, 2] }] }), false, 'an unknown measure is refused')
})

// Garment measurements: the finished jacket per size (full circumference), 8 cm over the chart's chest top.
const garmentFor = (chart, chestRoom, sleeve) => ({ measures: ['chest', 'sleeve'], sizes: chart.sizes.map((s, i) => ({ name: s.name, chest: s.chest[1] + chestRoom, sleeve: sleeve + i * 1.5 })) })

test('without garment measurements every answer stays exactly as from the chart alone', () => {
  for (const values of [{ chest: 96, waist: 84 }, { chest: 106, waist: 80 }, { chest: 100, waist: 104 }]) {
    const body = E.measuredBody(values)
    assert.deepEqual(pick(men, body, { garment: null }), pick(men, body))
    assert.deepEqual(pick(men, body, { garment: E.validGarment(null) }), pick(men, body))
  }
  const guess = E.estimateBody({ sex: 'male', heightCm: 178, weightKg: 80, age: 35 })
  assert.deepEqual(pick(men, guess, { garment: undefined }), pick(men, guess))
})

test('a jacket cut small: the garment leaves too little chest room, so the next size up is advised', () => {
  const body = E.measuredBody({ chest: 96, waist: 84 })
  assert.equal(pick(men, body).best, 'M')
  const small = E.validGarment(garmentFor(men, 1, 62.5))
  const result = pick(men, body, { garment: small })
  assert.equal(result.best, 'L')
  const m = result.sizes[index(men, 'M')]
  assert.equal(m.verdict, 'no')
  assert.deepEqual(m.regions[0], { measure: 'chest', value: 96, range: [94, 98], fit: 'tooTight', cm: null, garment: true })
  // A normal cut (8 cm over the chart) changes nothing.
  assert.equal(pick(men, body, { garment: E.validGarment(garmentFor(men, 8, 62.5)) }).best, 'M')
})

test('a garment-only measure (sleeve) is checked against the arm and can move the size', () => {
  const garment = E.validGarment(garmentFor(men, 8, 58))   // M sleeve 62.5, L 64
  const fine = pick(men, E.measuredBody({ chest: 96, waist: 84, sleeve: 59 }), { garment })
  assert.equal(fine.best, 'M')
  assert.deepEqual(fine.sizes[index(men, 'M')].regions.map(r => [r.measure, r.fit]), [['chest', 'right'], ['waist', 'right'], ['sleeve', 'right']])
  const long = pick(men, E.measuredBody({ chest: 96, waist: 84, sleeve: 63 }), { garment })
  assert.equal(long.best, 'L', 'the M sleeve is shorter than the arm')
  assert.equal(long.sizes[index(men, 'M')].regions[2].fit, 'tooTight')
  // A body without that measure (tape only, no height) skips the check.
  assert.deepEqual(pick(men, E.measuredBody({ chest: 96, waist: 84 }), { garment }).sizes[index(men, 'M')].regions.map(r => r.measure), ['chest', 'waist'])
})

test('garment numbers never reach a result; the product may set its own room; broken data is dropped', () => {
  const garment = E.validGarment(garmentFor(men, 1, 58))
  const body = E.estimateBody({ sex: 'male', heightCm: 178, weightKg: 80, age: 35 })
  const result = pick(men, body, { garment })
  // A garment region holds the body value, the chart's own range (or none) and a fit word: no garment number, no room.
  const fromGarment = result.sizes.flatMap(size => size.regions.filter(r => r.garment).map(r => ({ size, r })))
  assert.ok(fromGarment.some(({ r }) => r.measure === 'sleeve') && fromGarment.some(({ r }) => r.measure === 'chest'))
  for (const { size, r } of fromGarment) {
    assert.deepEqual(Object.keys(r).sort(), ['cm', 'fit', 'garment', 'measure', 'range', 'value'])
    assert.equal(r.cm, null)
    assert.equal(r.value, Math.round(body.values[r.measure] * 10) / 10)
    assert.deepEqual(r.range, men.measures.includes(r.measure) ? men.sizes[size.index][r.measure] : null)
  }
  assert.deepEqual(E.validGarment({ measures: ['chest', 'wingspan', 'sleeve'], sizes: [{ name: 'M', chest: 106, wingspan: 2, sleeve: 'x' }, { size: 'L' }] }),
    { measures: ['chest'], sizes: [{ name: 'M', chest: 106 }], room: { chest: E.ROOM.chest } })
  assert.equal(E.validGarment({ measures: ['chest'], sizes: [{ name: 'M', chest: -1 }] }), null)
  assert.deepEqual(E.validGarment({ measures: ['chest'], sizes: [{ name: 'M', chest: 106 }], room: { chest: [8, 14] } }).room, { chest: [8, 14] })
  assert.deepEqual(E.validGarment({ measures: ['chest'], sizes: [{ name: 'M', chest: 106 }], room: { chest: [14, 8] } }).room, { chest: E.ROOM.chest })
  assert.deepEqual([4, 10, 18, 21, 3].map(room => E.roomFit([4, 20], room).fit), ['snug', 'right', 'loose', 'tooLoose', 'tooTight'])
})
