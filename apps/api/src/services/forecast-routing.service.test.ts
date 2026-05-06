/**
 * R.16 — Pure-function tests for forecast routing.
 */

import {
  hashSkuToCohort,
  bucketAssignments,
} from './forecast-routing.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

// ─── hashSkuToCohort ───
test('hash deterministic: same SKU always maps to same bucket', () => {
  eq(hashSkuToCohort('XAV-JKT-001'), hashSkuToCohort('XAV-JKT-001'))
})

test('hash range: result is in [0, 99]', () => {
  for (const sku of ['A', 'B', 'XAV-001', 'CAR-XYZ', '123', '']) {
    const h = hashSkuToCohort(sku)
    if (h < 0 || h >= 100) throw new Error(`hash out of range: ${sku} → ${h}`)
  }
  eq(true, true)
})

test('hash distribution: 10% rollout picks ~10% of varied SKUs', () => {
  // Synthetic SKU set, ~1000 SKUs
  let inCohort = 0
  for (let i = 0; i < 1000; i++) {
    if (hashSkuToCohort(`SKU-${i}`) < 10) inCohort++
  }
  // Expected ~100, allow ±30 sampling tolerance for djb2
  if (inCohort < 70 || inCohort > 130) {
    throw new Error(`distribution off: 10% rollout selected ${inCohort}/1000 SKUs`)
  }
  eq(true, true)
})

test('hash distribution: 0% picks none', () => {
  let inCohort = 0
  for (let i = 0; i < 100; i++) {
    if (hashSkuToCohort(`SKU-${i}`) < 0) inCohort++
  }
  eq(inCohort, 0)
})

test('hash distribution: 100% picks all', () => {
  let inCohort = 0
  for (let i = 0; i < 100; i++) {
    if (hashSkuToCohort(`SKU-${i}`) < 100) inCohort++
  }
  eq(inCohort, 100)
})

// ─── bucketAssignments ───
test('bucketAssignments: single champion for all SKUs', () => {
  const rows = [
    { sku: 'A', modelId: 'HOLT_WINTERS_V1', cohort: 'champion' },
    { sku: 'B', modelId: 'HOLT_WINTERS_V1', cohort: 'champion' },
    { sku: 'C', modelId: 'HOLT_WINTERS_V1', cohort: 'champion' },
  ]
  const r = bucketAssignments(rows)
  eq(r.champion.modelId, 'HOLT_WINTERS_V1')
  eq(r.champion.skuCount, 3)
  eq(r.challengers, [])
})

test('bucketAssignments: champion + challenger rollout', () => {
  const rows = [
    { sku: 'A', modelId: 'HOLT_WINTERS_V1', cohort: 'champion' },
    { sku: 'B', modelId: 'HOLT_WINTERS_V1', cohort: 'champion' },
    { sku: 'A', modelId: 'PROPHET_V1', cohort: 'challenger' },
    { sku: 'C', modelId: 'PROPHET_V1', cohort: 'challenger' },
  ]
  const r = bucketAssignments(rows)
  eq(r.champion.modelId, 'HOLT_WINTERS_V1')
  eq(r.champion.skuCount, 2)
  eq(r.challengers.length, 1)
  eq(r.challengers[0].modelId, 'PROPHET_V1')
  eq(r.challengers[0].skuCount, 2)
})

test('bucketAssignments: empty input → fallback to default champion', () => {
  const r = bucketAssignments([])
  eq(r.champion.modelId, 'HOLT_WINTERS_V1')
  eq(r.champion.skuCount, 0)
  eq(r.challengers, [])
})

test('bucketAssignments: multiple challengers ranked by skuCount', () => {
  const rows = [
    { sku: 'A', modelId: 'PROPHET_V1', cohort: 'challenger' },
    { sku: 'B', modelId: 'PROPHET_V1', cohort: 'challenger' },
    { sku: 'C', modelId: 'PROPHET_V1', cohort: 'challenger' },
    { sku: 'D', modelId: 'NN_V1', cohort: 'challenger' },
  ]
  const r = bucketAssignments(rows)
  eq(r.challengers[0].modelId, 'PROPHET_V1') // 3 SKUs
  eq(r.challengers[1].modelId, 'NN_V1') // 1 SKU
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`forecast-routing.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
