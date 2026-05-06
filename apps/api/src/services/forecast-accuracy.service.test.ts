/**
 * R.1 — pure-function tests for forecast accuracy math.
 *
 * No DB, no mocks. Run with `node --test` or whatever harness lands
 * in TECH_DEBT #42's Vitest setup. Until then this file documents
 * intended behavior and runs trivially when imported.
 */

import { computeAccuracyRow, regimeFromGenerationTag } from './forecast-accuracy.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(actual: unknown, expected: unknown, msg = '') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg} expected=${e} actual=${a}`)
}

test('MAPE = 0 when forecast = actual', () => {
  const r = computeAccuracyRow({ forecastUnits: 10, forecastLower80: 8, forecastUpper80: 12, actualUnits: 10 })
  eq(r.absoluteError, 0)
  eq(r.percentError, 0)
  eq(r.withinBand, true)
})

test('percentError = NULL when actual = 0', () => {
  const r = computeAccuracyRow({ forecastUnits: 5, forecastLower80: 3, forecastUpper80: 8, actualUnits: 0 })
  eq(r.percentError, null)
  eq(r.absoluteError, 5) // |5 - 0| = 5
})

test('MAE / absoluteError always set even when actual=0', () => {
  const r = computeAccuracyRow({ forecastUnits: 7, forecastLower80: null, forecastUpper80: null, actualUnits: 0 })
  eq(r.absoluteError, 7)
  eq(r.percentError, null)
  eq(r.withinBand, false) // no bands → can't be inside
})

test('withinBand true when actual within [lower, upper]', () => {
  const r = computeAccuracyRow({ forecastUnits: 10, forecastLower80: 5, forecastUpper80: 15, actualUnits: 12 })
  eq(r.withinBand, true)
})

test('withinBand false when actual exceeds upper', () => {
  const r = computeAccuracyRow({ forecastUnits: 10, forecastLower80: 5, forecastUpper80: 15, actualUnits: 20 })
  eq(r.withinBand, false)
})

test('withinBand false when actual below lower', () => {
  const r = computeAccuracyRow({ forecastUnits: 10, forecastLower80: 5, forecastUpper80: 15, actualUnits: 2 })
  eq(r.withinBand, false)
})

test('withinBand false when bands missing', () => {
  const r = computeAccuracyRow({ forecastUnits: 10, forecastLower80: null, forecastUpper80: null, actualUnits: 10 })
  eq(r.withinBand, false)
})

test('negative forecast clamps to zero before comparison', () => {
  const r = computeAccuracyRow({ forecastUnits: -3, forecastLower80: null, forecastUpper80: null, actualUnits: 5 })
  // Treated as forecast=0; absError = |0 - 5| = 5
  eq(r.forecastUnits, 0)
  eq(r.absoluteError, 5)
  eq(r.percentError, 100)
})

test('percentError rounded to 2 decimals', () => {
  const r = computeAccuracyRow({ forecastUnits: 7, forecastLower80: null, forecastUpper80: null, actualUnits: 3 })
  // |7 - 3| / 3 * 100 = 133.333...
  eq(r.percentError, 133.33)
})

test('regimeFromGenerationTag mapping', () => {
  eq(regimeFromGenerationTag('COLD_START'), 'COLD_START')
  eq(regimeFromGenerationTag('TRAILING_MEAN_FALLBACK'), 'TRAILING_MEAN_FALLBACK')
  eq(regimeFromGenerationTag('HOLT_LINEAR'), 'HOLT_LINEAR')
  eq(regimeFromGenerationTag(null), 'HOLT_WINTERS')
  eq(regimeFromGenerationTag(undefined), 'HOLT_WINTERS')
  eq(regimeFromGenerationTag('UNKNOWN_TAG'), 'HOLT_WINTERS')
})

// Auto-run when imported in dev. CI-grade harness lands with TECH_DEBT #42.
let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`forecast-accuracy.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
