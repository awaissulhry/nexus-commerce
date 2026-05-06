/**
 * R.6 — Pure-function tests for auto-PO gating predicates.
 *
 * No DB. Run with `npx tsx <file>`.
 */

import { shouldAutoTriggerByRec, fitsCeilings } from './auto-po.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

const baseRec = {
  urgency: 'CRITICAL',
  needsReorder: true,
  preferredSupplierId: 'sup-1',
  isManufactured: false,
}

// ─── shouldAutoTriggerByRec ───
test('CRITICAL + needsReorder + supplier + non-manufactured → true', () => {
  eq(shouldAutoTriggerByRec(baseRec), true)
})
test('HIGH urgency also triggers (best-in-class default)', () => {
  eq(shouldAutoTriggerByRec({ ...baseRec, urgency: 'HIGH' }), true)
})
test('MEDIUM does not trigger', () => {
  eq(shouldAutoTriggerByRec({ ...baseRec, urgency: 'MEDIUM' }), false)
})
test('LOW does not trigger', () => {
  eq(shouldAutoTriggerByRec({ ...baseRec, urgency: 'LOW' }), false)
})
test('needsReorder=false blocks', () => {
  eq(shouldAutoTriggerByRec({ ...baseRec, needsReorder: false }), false)
})
test('null preferredSupplierId blocks (no PO target)', () => {
  eq(shouldAutoTriggerByRec({ ...baseRec, preferredSupplierId: null }), false)
})
test('isManufactured=true blocks (WO not PO)', () => {
  eq(shouldAutoTriggerByRec({ ...baseRec, isManufactured: true }), false)
})

// ─── fitsCeilings ───
test('within both supplier-set ceilings → ok', () => {
  eq(
    fitsCeilings({ totalQty: 100, totalCostCents: 50_000, supplierMaxQty: 1000, supplierMaxCostCents: 100_000 }),
    { ok: true },
  )
})
test('qty over supplier ceiling → reason QTY_CEILING_EXCEEDED', () => {
  const r = fitsCeilings({ totalQty: 1500, totalCostCents: 50_000, supplierMaxQty: 1000, supplierMaxCostCents: 100_000 })
  eq(r, { ok: false, reason: 'QTY_CEILING_EXCEEDED' })
})
test('cost over supplier ceiling → reason COST_CEILING_EXCEEDED', () => {
  const r = fitsCeilings({ totalQty: 100, totalCostCents: 200_000, supplierMaxQty: 1000, supplierMaxCostCents: 100_000 })
  eq(r, { ok: false, reason: 'COST_CEILING_EXCEEDED' })
})
test('null supplier ceilings → fall back to env defaults', () => {
  // Defaults are 5000 units / 2_000_000 cents (€20K). 100 + 50_000c is far under both.
  const r = fitsCeilings({ totalQty: 100, totalCostCents: 50_000, supplierMaxQty: null, supplierMaxCostCents: null })
  eq(r, { ok: true })
})
test('null ceilings + huge qty → blocked by env default', () => {
  // 6000 > 5000 default qty cap.
  const r = fitsCeilings({ totalQty: 6000, totalCostCents: 50_000, supplierMaxQty: null, supplierMaxCostCents: null })
  eq(r, { ok: false, reason: 'QTY_CEILING_EXCEEDED' })
})
test('null ceilings + huge cost → blocked by env default', () => {
  // 3_000_000c = €30K > €20K default.
  const r = fitsCeilings({ totalQty: 100, totalCostCents: 3_000_000, supplierMaxQty: null, supplierMaxCostCents: null })
  eq(r, { ok: false, reason: 'COST_CEILING_EXCEEDED' })
})
test('explicit zero supplier qty cap blocks all (deny-by-default)', () => {
  const r = fitsCeilings({ totalQty: 1, totalCostCents: 1, supplierMaxQty: 0, supplierMaxCostCents: 0 })
  eq(r, { ok: false, reason: 'QTY_CEILING_EXCEEDED' })
})
test('exact match at ceiling allowed (qty)', () => {
  const r = fitsCeilings({ totalQty: 1000, totalCostCents: 1, supplierMaxQty: 1000, supplierMaxCostCents: 100_000 })
  eq(r, { ok: true })
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`auto-po.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
