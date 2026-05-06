/**
 * R.4 — Pure-function tests for replenishment-math.service.
 *
 * No DB. Run with `npx tsx <file>`. Vitest harness lands with
 * TECH_DEBT #42; until then this file documents intent + runs
 * trivially when imported.
 */

import {
  zForServiceLevel,
  safetyStock,
  eoq,
  applyMoqAndCasePack,
  reorderPoint,
  dailyDemandStdDev,
  computeRecommendation,
} from './replenishment-math.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}
function near(actual: number, expected: number, tolerance: number, msg = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg} expected≈${expected}±${tolerance}, got ${actual}`)
  }
}

// ─── zForServiceLevel ───
test('z(95) = 1.645', () => eq(zForServiceLevel(95), 1.645))
test('z(99) = 2.326', () => eq(zForServiceLevel(99), 2.326))
test('z(97.5) = 1.960', () => eq(zForServiceLevel(97.5), 1.960))
test('z(92) interpolates between 90 and 92.5', () => {
  // z(90)=1.282, z(92.5)=1.440. At 92: t=(92-90)/(92.5-90)=0.8 → 1.282+0.8*(1.440-1.282)=1.408
  near(zForServiceLevel(92), 1.408, 0.01)
})
test('z clamps below table', () => eq(zForServiceLevel(40), 0))
test('z clamps above table', () => eq(zForServiceLevel(99.999), 3.719))

// ─── safetyStock ───
test('safetyStock 95% z=1.645 σ=2 LT=14 → 13', () => {
  // 1.645 * 2 * sqrt(14) = 1.645 * 2 * 3.742 = 12.31 → ceil = 13
  eq(safetyStock({ velocity: 5, demandStdDev: 2, leadTimeDays: 14, servicePercent: 95 }), 13)
})
test('safetyStock σ=0 → 0 (no demand variance, no buffer)', () => {
  eq(safetyStock({ velocity: 5, demandStdDev: 0, leadTimeDays: 14, servicePercent: 95 }), 0)
})
test('safetyStock leadTime=0 → 0 (instant lead time)', () => {
  eq(safetyStock({ velocity: 5, demandStdDev: 2, leadTimeDays: 0, servicePercent: 95 }), 0)
})

// ─── eoq (Wilson) ───
test('eoq textbook D=1000 K=1000c h=25% C=2000c → 64', () => {
  // EOQ = sqrt(2 * 1000 * 1000 / (0.25 * 2000)) = sqrt(4000) = 63.25 → ceil = 64
  eq(eoq({ annualDemand: 1000, orderingCostCents: 1000, unitCostCents: 2000, carryingCostPctYear: 25 }), 64)
})
test('eoq D=0 → 0 (no demand)', () => {
  eq(eoq({ annualDemand: 0, orderingCostCents: 1500, unitCostCents: 1000, carryingCostPctYear: 25 }), 0)
})
test('eoq h=0 → 0 (degenerate, no carrying cost)', () => {
  eq(eoq({ annualDemand: 1000, orderingCostCents: 1500, unitCostCents: 1000, carryingCostPctYear: 0 }), 0)
})
test('eoq unitCost=0 → 0 (degenerate, no cost basis)', () => {
  eq(eoq({ annualDemand: 1000, orderingCostCents: 1500, unitCostCents: 0, carryingCostPctYear: 25 }), 0)
})

// ─── applyMoqAndCasePack ───
test('moq raises low qty', () => {
  const r = applyMoqAndCasePack({ recommendedQty: 10, moq: 50, casePack: null })
  eq(r.qty, 50)
  eq(r.constraintsApplied, ['MOQ_APPLIED'])
})
test('case pack rounds up', () => {
  const r = applyMoqAndCasePack({ recommendedQty: 110, moq: 1, casePack: 12 })
  eq(r.qty, 120) // ceil(110/12) * 12 = 10 * 12 = 120
  eq(r.constraintsApplied, ['CASE_PACK_ROUNDED_UP'])
})
test('moq + case pack stack', () => {
  const r = applyMoqAndCasePack({ recommendedQty: 10, moq: 50, casePack: 12 })
  eq(r.qty, 60) // moq=50, then ceil(50/12)*12 = 5*12 = 60
  eq(r.constraintsApplied, ['MOQ_APPLIED', 'CASE_PACK_ROUNDED_UP'])
})
test('already aligned qty has no constraints', () => {
  const r = applyMoqAndCasePack({ recommendedQty: 120, moq: 50, casePack: 12 })
  eq(r.qty, 120)
  eq(r.constraintsApplied, [])
})
test('zero recommended → zero with no constraints', () => {
  const r = applyMoqAndCasePack({ recommendedQty: 0, moq: 50, casePack: 12 })
  eq(r.qty, 0)
  eq(r.constraintsApplied, [])
})
test('null case pack is no-op', () => {
  const r = applyMoqAndCasePack({ recommendedQty: 17, moq: 1, casePack: null })
  eq(r.qty, 17)
  eq(r.constraintsApplied, [])
})

// ─── reorderPoint ───
test('reorderPoint v=2 LT=14 safety=10 → 38', () => {
  eq(reorderPoint({ velocity: 2, leadTimeDays: 14, safetyStock: 10 }), 38)
})
test('reorderPoint negative velocity clamps to safety only', () => {
  eq(reorderPoint({ velocity: -5, leadTimeDays: 14, safetyStock: 10 }), 10)
})

// ─── dailyDemandStdDev ───
test('stdDev [1,2,3,4,5] ≈ 1.5811', () => {
  // mean=3, variance = ((4+1+0+1+4)/4) = 2.5, sqrt = 1.5811
  near(dailyDemandStdDev([1, 2, 3, 4, 5]), 1.5811, 0.001)
})
test('stdDev empty → 0', () => eq(dailyDemandStdDev([]), 0))
test('stdDev single point → 0', () => eq(dailyDemandStdDev([5]), 0))
test('stdDev all-equal → 0', () => eq(dailyDemandStdDev([5, 5, 5, 5, 5]), 0))

// ─── computeRecommendation (composer) ───
test('composer: defaults applied when configs are null', () => {
  const r = computeRecommendation({
    velocity: 2,
    demandStdDev: 1,
    leadTimeDays: 14,
    unitCostCents: 1000,
    servicePercent: null,
    orderingCostCents: null,
    carryingCostPctYear: null,
    moq: 50,
    casePack: null,
  })
  eq(r.servicePercent, 95)
  eq(r.orderingCostCents, 1500)
  eq(r.carryingCostPctYear, 25)
})
test('composer: rule override beats EOQ for qty', () => {
  const r = computeRecommendation({
    velocity: 2,
    demandStdDev: 1,
    leadTimeDays: 14,
    unitCostCents: 1000,
    servicePercent: 95,
    orderingCostCents: 1500,
    carryingCostPctYear: 25,
    moq: 1,
    casePack: null,
    ruleReorderQuantity: 200, // explicit override
  })
  eq(r.reorderQuantity, 200)
})
test('composer: EOQ used when no rule override + cost basis present', () => {
  const r = computeRecommendation({
    velocity: 10,                  // 3650/yr
    demandStdDev: 2,
    leadTimeDays: 14,
    unitCostCents: 2000,           // €20
    servicePercent: 95,
    orderingCostCents: 1500,
    carryingCostPctYear: 25,
    moq: 1,
    casePack: null,
  })
  // EOQ = sqrt(2 * 3650 * 1500 / (0.25 * 2000)) = sqrt(21900) = 147.99 → 148
  eq(r.eoqUnits, 148)
  eq(r.reorderQuantity, 148)
})
test('composer: MOQ raised below EOQ flags EOQ_BELOW_MOQ', () => {
  const r = computeRecommendation({
    velocity: 0.5,                 // tiny demand
    demandStdDev: 0.1,
    leadTimeDays: 14,
    unitCostCents: 1000,
    servicePercent: 95,
    orderingCostCents: 1500,
    carryingCostPctYear: 25,
    moq: 100,                      // big MOQ
    casePack: null,
  })
  // EOQ on tiny demand will be small; moq forces 100
  if (!r.constraintsApplied.includes('MOQ_APPLIED')) throw new Error('expected MOQ_APPLIED')
  if (!r.constraintsApplied.includes('EOQ_BELOW_MOQ')) throw new Error('expected EOQ_BELOW_MOQ')
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`replenishment-math.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
