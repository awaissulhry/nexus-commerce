/**
 * FCF.2 — Pure-function tests for available-to-publish per fulfillment pool.
 */

import { computeAvailableToPublish } from './available-to-publish.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

// FBM draws from the own-warehouse pool and ignores FBA stock.
test('FBM uses warehouseAvailable, ignores fbaSellable', () => {
  const r = computeAvailableToPublish({ fulfillmentMethod: 'FBM', warehouseAvailable: 12, fbaSellable: 999, stockBuffer: 0 })
  eq(r, { available: 12, pool: 'FBM_WAREHOUSE', poolQuantity: 12, bufferApplied: 0 })
})

// FBA draws from FBA SELLABLE and ignores the warehouse pool.
test('FBA uses fbaSellable, ignores warehouseAvailable', () => {
  const r = computeAvailableToPublish({ fulfillmentMethod: 'FBA', warehouseAvailable: 999, fbaSellable: 7, stockBuffer: 0 })
  eq(r, { available: 7, pool: 'FBA', poolQuantity: 7, bufferApplied: 0 })
})

// Buffer is subtracted from whichever pool feeds the listing.
test('buffer subtracts from the feeding pool (FBM)', () => {
  const r = computeAvailableToPublish({ fulfillmentMethod: 'FBM', warehouseAvailable: 10, fbaSellable: 0, stockBuffer: 3 })
  eq(r.available, 7); eq(r.bufferApplied, 3)
})

// Never publish negative — clamp at 0 when buffer exceeds the pool.
test('clamps at 0 when buffer exceeds pool', () => {
  const r = computeAvailableToPublish({ fulfillmentMethod: 'FBM', warehouseAvailable: 2, fbaSellable: 0, stockBuffer: 5 })
  eq(r.available, 0)
})

// FBA product with no FBM stock → eBay (FBM) publishes 0 (the core risk).
test('FBM listing with empty warehouse but full FBA → 0 (no oversell)', () => {
  const r = computeAvailableToPublish({ fulfillmentMethod: 'FBM', warehouseAvailable: 0, fbaSellable: 500, stockBuffer: 0 })
  eq(r.available, 0); eq(r.pool, 'FBM_WAREHOUSE')
})

// Negative buffer is treated as 0 (defensive).
test('negative buffer treated as 0', () => {
  const r = computeAvailableToPublish({ fulfillmentMethod: 'FBA', warehouseAvailable: 0, fbaSellable: 9, stockBuffer: -4 })
  eq(r.available, 9); eq(r.bufferApplied, 0)
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`available-to-publish.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
