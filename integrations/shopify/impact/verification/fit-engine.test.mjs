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
