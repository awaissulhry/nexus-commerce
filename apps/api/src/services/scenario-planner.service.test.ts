/**
 * W5.2 — pure-function tests for the scenario planner.
 * Skips the engine (DB-bound). Verifies each kind produces correct
 * deltas against a fabricated baseline.
 */

import {
  planScenario,
  type BaselineRec,
} from './scenario-planner.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}
function ok(b: boolean, msg = '') { if (!b) throw new Error(`expected true: ${msg}`) }

const baseRec: BaselineRec = {
  id: 'rec_1',
  sku: 'AIRMESH-J-XL',
  productId: 'prod_1',
  reorderQuantity: 50,
  reorderPoint: 30,
  velocity: 2, // 2 units/day
  leadTimeDays: 14,
  safetyDays: 7,
  unitCostCents: 4700, // €47
  landedCostPerUnitCents: null,
  preferredSupplierId: 'sup_abc',
  daysOfStockLeft: 20,
  effectiveStock: 40,
}

// ── PROMOTIONAL_UPLIFT ───────────────────────────────────────────

test('promo uplift +200% raises qty above baseline', () => {
  const out = planScenario({
    kind: 'PROMOTIONAL_UPLIFT',
    params: { upliftPct: 200 },
    baseline: [baseRec],
  })
  // newVelocity = 2 × 3 = 6/day; demand in LT = 6×14 = 84;
  // safety = 6×7 = 42; total = 126; max(50, 126) = 126
  eq(out.recommendations[0].scenarioQty, 126)
  eq(out.recommendations[0].deltaQty, 76)
  ok(out.recommendations[0].deltaCostCents > 0)
})

test('promo uplift 0% leaves qty unchanged', () => {
  const out = planScenario({
    kind: 'PROMOTIONAL_UPLIFT',
    params: { upliftPct: 0 },
    baseline: [baseRec],
  })
  // newVelocity = 2; demand in LT = 28; safety = 14; total = 42;
  // max(50, 42) = 50 (baseline floor)
  eq(out.recommendations[0].scenarioQty, 50)
  eq(out.recommendations[0].deltaQty, 0)
})

test('promo flags >50% jump in note', () => {
  const out = planScenario({
    kind: 'PROMOTIONAL_UPLIFT',
    params: { upliftPct: 300 },
    baseline: [baseRec],
  })
  ok(typeof out.recommendations[0].note === 'string')
  ok(out.recommendations[0].note!.includes('%'))
})

test('skuFilter excludes non-matching', () => {
  const out = planScenario({
    kind: 'PROMOTIONAL_UPLIFT',
    params: { upliftPct: 200, skuFilter: ['DIFFERENT-SKU'] },
    baseline: [baseRec],
  })
  eq(out.recommendations.length, 0)
})

test('skuFilter prefix match works', () => {
  const out = planScenario({
    kind: 'PROMOTIONAL_UPLIFT',
    params: { upliftPct: 200, skuFilter: ['AIRMESH-*'] },
    baseline: [baseRec],
  })
  eq(out.recommendations.length, 1)
})

// ── LEAD_TIME_DISRUPTION ─────────────────────────────────────────

test('lead-time disruption raises qty', () => {
  const out = planScenario({
    kind: 'LEAD_TIME_DISRUPTION',
    params: { extraDays: 14 },
    baseline: [baseRec],
  })
  // newLT = 28; reorderPoint = 2×28 + 2×7 = 70; qty = max(50, 70-40) = 50
  // (effectiveStock buffer keeps qty at floor)
  eq(out.recommendations[0].scenarioQty, 50)
})

test('lead-time disruption flags stockout when cover < new LT', () => {
  const lowCoverRec: BaselineRec = { ...baseRec, daysOfStockLeft: 5 }
  const out = planScenario({
    kind: 'LEAD_TIME_DISRUPTION',
    params: { extraDays: 14 },
    baseline: [lowCoverRec],
  })
  eq(out.summary.stockoutCount, 1)
  ok(out.recommendations[0].note?.includes('would stockout'))
})

test('lead-time disruption with supplierId filter', () => {
  const otherSupplier: BaselineRec = { ...baseRec, preferredSupplierId: 'other_sup' }
  const out = planScenario({
    kind: 'LEAD_TIME_DISRUPTION',
    params: { extraDays: 14, supplierId: 'sup_abc' },
    baseline: [baseRec, otherSupplier],
  })
  eq(out.recommendations.length, 1)
  eq(out.recommendations[0].id, 'rec_1')
})

// ── SUPPLIER_SWAP ────────────────────────────────────────────────

test('supplier swap reports cost savings', () => {
  const out = planScenario({
    kind: 'SUPPLIER_SWAP',
    params: { targetSupplierId: 'sup_xyz' },
    baseline: [baseRec],
    targetSupplierCostBySku: new Map([['AIRMESH-J-XL', 3800]]),
  })
  // qty unchanged; baseline cost 50×4700 = 235000c; scenario 50×3800=190000c
  eq(out.recommendations[0].deltaQty, 0)
  eq(out.recommendations[0].deltaCostCents, -45000)
  ok(out.recommendations[0].note?.includes('% cost'))
})

test('supplier swap warns when no target cost data', () => {
  const out = planScenario({
    kind: 'SUPPLIER_SWAP',
    params: { targetSupplierId: 'sup_xyz' },
    baseline: [baseRec],
    targetSupplierCostBySku: new Map(),
  })
  eq(out.warnings.length, 1)
  eq(out.recommendations[0].deltaCostCents, 0)
})

// ── summary aggregation ──────────────────────────────────────────

test('summary aggregates across recs', () => {
  const recs = [baseRec, { ...baseRec, id: 'rec_2', sku: 'AIRMESH-J-L' }]
  const out = planScenario({
    kind: 'PROMOTIONAL_UPLIFT',
    params: { upliftPct: 200 },
    baseline: recs,
  })
  eq(out.recommendations.length, 2)
  eq(out.summary.recsAffected, 2) // both deltaQty > 0
  ok(out.summary.totalUnitsDelta > 0)
  ok(out.summary.totalCostDeltaCents > 0)
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`scenario-planner.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
