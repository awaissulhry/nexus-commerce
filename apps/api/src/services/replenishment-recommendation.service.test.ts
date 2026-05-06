/**
 * R.3 — pure-function tests for recommendationChanged().
 *
 * No DB. Run with `npx tsx <file>`. Vitest harness lands with
 * TECH_DEBT #42; until then this file documents intent + runs
 * trivially when imported.
 */

import { recommendationChanged } from './replenishment-recommendation.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

const baseInput = {
  productId: 'p1',
  sku: 'SKU-1',
  velocity: 1.5,
  velocitySource: 'FORECAST' as const,
  leadTimeDays: 14,
  leadTimeSource: 'SUPPLIER_DEFAULT',
  safetyDays: 7,
  totalAvailable: 50,
  inboundWithinLeadTime: 0,
  effectiveStock: 50,
  reorderPoint: 30,
  reorderQuantity: 100,
  daysOfStockLeft: 33,
  urgency: 'LOW' as const,
  needsReorder: false,
  preferredSupplierId: null,
  isManufactured: false,
}

const baseActive = {
  id: 'rec-existing',
  productId: 'p1',
  urgency: 'LOW',
  reorderQuantity: 100,
  effectiveStock: 50,
  needsReorder: false,
}

test('returns true when prev is null (first recommendation)', () => {
  eq(recommendationChanged(null, baseInput), true)
})

test('returns false when relevant fields all match', () => {
  eq(recommendationChanged(baseActive, baseInput), false)
})

test('returns true on urgency change', () => {
  eq(
    recommendationChanged(baseActive, { ...baseInput, urgency: 'CRITICAL' }),
    true,
  )
})

test('returns true on reorderQuantity change', () => {
  eq(
    recommendationChanged(baseActive, { ...baseInput, reorderQuantity: 120 }),
    true,
  )
})

test('returns true on effectiveStock change ≥ 1', () => {
  eq(
    recommendationChanged(baseActive, { ...baseInput, effectiveStock: 51 }),
    true,
  )
  eq(
    recommendationChanged(baseActive, { ...baseInput, effectiveStock: 49 }),
    true,
  )
})

test('returns false on effectiveStock change of 0 (no-op equality)', () => {
  // The tolerance is "≥ 1 unit" — exact match must be false.
  eq(
    recommendationChanged(baseActive, { ...baseInput, effectiveStock: 50 }),
    false,
  )
})

test('returns true on needsReorder flip (false → true)', () => {
  eq(
    recommendationChanged(baseActive, { ...baseInput, needsReorder: true }),
    true,
  )
})

test('returns true on needsReorder flip (true → false)', () => {
  const prev = { ...baseActive, needsReorder: true }
  eq(
    recommendationChanged(prev, { ...baseInput, needsReorder: false }),
    true,
  )
})

test('ignores non-tracked fields (velocity, daysOfStockLeft) for diff', () => {
  // velocity / daysOfStockLeft drift continuously; we don't want every
  // 0.001 fluctuation to write a new row. Diff only triggers on the
  // four operationally-meaningful fields.
  eq(
    recommendationChanged(baseActive, {
      ...baseInput,
      velocity: 1.501,
      daysOfStockLeft: 32,
    }),
    false,
  )
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`replenishment-recommendation.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
