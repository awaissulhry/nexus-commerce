/**
 * R.12 — Pure-function tests for stockout detection.
 */

import { classifyMovement, computeLoss } from './stockout-detector.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

// ─── classifyMovement ───
test('prev > 0, next = 0 → STOCKOUT_OPENED', () => {
  eq(classifyMovement({ prevAvailable: 5, nextAvailable: 0 }), 'STOCKOUT_OPENED')
})
test('prev = 0, next > 0 → STOCKOUT_CLOSED', () => {
  eq(classifyMovement({ prevAvailable: 0, nextAvailable: 5 }), 'STOCKOUT_CLOSED')
})
test('prev = 0, next = 0 → NO_TRANSITION (already out)', () => {
  eq(classifyMovement({ prevAvailable: 0, nextAvailable: 0 }), 'NO_TRANSITION')
})
test('prev > 0, next > 0 → NO_TRANSITION (still in stock)', () => {
  eq(classifyMovement({ prevAvailable: 10, nextAvailable: 5 }), 'NO_TRANSITION')
})
test('prev > 0, next < 0 → STOCKOUT_OPENED (negative clamps to 0)', () => {
  eq(classifyMovement({ prevAvailable: 3, nextAvailable: -2 }), 'STOCKOUT_OPENED')
})
test('prev < 0, next > 0 → STOCKOUT_CLOSED (negative clamps to 0)', () => {
  eq(classifyMovement({ prevAvailable: -1, nextAvailable: 5 }), 'STOCKOUT_CLOSED')
})

// ─── computeLoss ───
test('velocity 5/d × 4d × €10 margin → 20 units, €200 margin', () => {
  // sellingPrice 1500c, cost 500c → margin 1000c = €10
  const r = computeLoss({
    velocityAtStart: 5,
    durationDays: 4,
    sellingPriceCents: 1500,
    unitCostCents: 500,
  })
  eq(r.estimatedLostUnits, 20)
  eq(r.marginCentsPerUnit, 1000)
  eq(r.estimatedLostMargin, 20000)  // 20 × 1000c = 20000c = €200
  eq(r.estimatedLostRevenue, 30000) // 20 × 1500c = 30000c = €300
  eq(r.durationDays, 4)
})

test('velocity 0 → 0 loss across all metrics', () => {
  const r = computeLoss({
    velocityAtStart: 0,
    durationDays: 7,
    sellingPriceCents: 1500,
    unitCostCents: 500,
  })
  eq(r.estimatedLostUnits, 0)
  eq(r.estimatedLostMargin, 0)
  eq(r.estimatedLostRevenue, 0)
})

test('unitCost null → margin null, revenue still computed', () => {
  const r = computeLoss({
    velocityAtStart: 3,
    durationDays: 2,
    sellingPriceCents: 2000,
    unitCostCents: null,
  })
  eq(r.estimatedLostUnits, 6)
  eq(r.marginCentsPerUnit, null)
  eq(r.estimatedLostMargin, null)
  eq(r.estimatedLostRevenue, 12000) // 6 × 2000c
})

test('sellingPrice null → revenue + margin both null', () => {
  const r = computeLoss({
    velocityAtStart: 3,
    durationDays: 2,
    sellingPriceCents: null,
    unitCostCents: 500,
  })
  eq(r.estimatedLostRevenue, null)
  eq(r.estimatedLostMargin, null)
})

test('negative duration clamps to 0 (graceful)', () => {
  const r = computeLoss({
    velocityAtStart: 5,
    durationDays: -3,
    sellingPriceCents: 1000,
    unitCostCents: 500,
  })
  eq(r.durationDays, 0)
  eq(r.estimatedLostUnits, 0)
})

test('negative velocity clamps to 0', () => {
  const r = computeLoss({
    velocityAtStart: -2,
    durationDays: 5,
    sellingPriceCents: 1000,
    unitCostCents: 500,
  })
  eq(r.estimatedLostUnits, 0)
})

test('fractional units round to nearest', () => {
  // 0.7 × 5 = 3.5 → 4
  const r = computeLoss({
    velocityAtStart: 0.7,
    durationDays: 5,
    sellingPriceCents: 1000,
    unitCostCents: 500,
  })
  eq(r.estimatedLostUnits, 4)
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`stockout-detector.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
