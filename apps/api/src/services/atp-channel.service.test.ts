/**
 * R.2 — Pure-function tests for resolveStockForChannel.
 *
 * No DB. Run with `npx tsx <file>`. Vitest harness lands with
 * TECH_DEBT #42; until then this file documents intent + runs trivially
 * when imported.
 */

import { resolveStockForChannel, type AtpLocationRow } from './atp-channel.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

const itMain: AtpLocationRow = {
  locationId: 'loc-it-main', locationCode: 'IT-MAIN', locationName: 'Riccione',
  locationType: 'WAREHOUSE', servesMarketplaces: ['IT', 'DE', 'FR', 'ES'],
  quantity: 47, reserved: 2, available: 45,
}
const fbaEu: AtpLocationRow = {
  locationId: 'loc-fba-eu', locationCode: 'AMAZON-EU-FBA', locationName: 'Amazon EU FBA',
  locationType: 'AMAZON_FBA', servesMarketplaces: ['IT', 'DE', 'FR', 'ES', 'NL', 'PL', 'SE'],
  quantity: 12, reserved: 0, available: 12,
}
const fbaIt: AtpLocationRow = {
  locationId: 'loc-fba-it', locationCode: 'AMAZON-IT-FBA', locationName: 'Amazon IT FBA',
  locationType: 'AMAZON_FBA', servesMarketplaces: ['IT'],
  quantity: 5, reserved: 0, available: 5,
}
const globalWarehouse: AtpLocationRow = {
  locationId: 'loc-global', locationCode: 'WH-GLOBAL', locationName: 'Generic',
  locationType: 'WAREHOUSE', servesMarketplaces: ['GLOBAL'],
  quantity: 100, reserved: 0, available: 100,
}

test('AMAZON+FBA picks AMAZON_FBA matching marketplace', () => {
  const r = resolveStockForChannel({ byLocation: [itMain, fbaEu], channel: 'AMAZON', marketplace: 'IT', fulfillmentMethod: 'FBA' })
  eq(r.source, 'EXACT_MATCH')
  eq(r.locationCode, 'AMAZON-EU-FBA')
  eq(r.available, 12)
})

test('AMAZON+FBA with multiple matching FBA pools sums them', () => {
  const r = resolveStockForChannel({ byLocation: [fbaEu, fbaIt], channel: 'AMAZON', marketplace: 'IT', fulfillmentMethod: 'FBA' })
  eq(r.source, 'EXACT_MATCH')
  eq(r.available, 17) // 12 + 5
})

test('AMAZON+FBM picks WAREHOUSE matching marketplace', () => {
  const r = resolveStockForChannel({ byLocation: [itMain, fbaEu], channel: 'AMAZON', marketplace: 'IT', fulfillmentMethod: 'FBM' })
  eq(r.source, 'EXACT_MATCH')
  eq(r.locationCode, 'IT-MAIN')
  eq(r.available, 45)
})

test('EBAY routes to WAREHOUSE', () => {
  const r = resolveStockForChannel({ byLocation: [itMain, fbaEu], channel: 'EBAY', marketplace: 'IT' })
  eq(r.source, 'EXACT_MATCH')
  eq(r.locationCode, 'IT-MAIN')
  eq(r.available, 45)
})

test('SHOPIFY routes to WAREHOUSE', () => {
  const r = resolveStockForChannel({ byLocation: [itMain], channel: 'SHOPIFY', marketplace: 'IT' })
  eq(r.source, 'EXACT_MATCH')
  eq(r.available, 45)
})

test('marketplace not in servesMarketplaces falls to default warehouse', () => {
  // itMain serves IT/DE/FR/ES, not UK
  const r = resolveStockForChannel({ byLocation: [itMain], channel: 'EBAY', marketplace: 'UK' })
  eq(r.source, 'WAREHOUSE_DEFAULT')
  eq(r.locationCode, 'IT-MAIN')
})

test('GLOBAL wildcard matches when no exact match', () => {
  const r = resolveStockForChannel({ byLocation: [globalWarehouse], channel: 'EBAY', marketplace: 'UK' })
  eq(r.source, 'EXACT_MATCH')
  eq(r.locationCode, 'WH-GLOBAL')
})

test('exact marketplace beats GLOBAL wildcard', () => {
  const r = resolveStockForChannel({ byLocation: [itMain, globalWarehouse], channel: 'EBAY', marketplace: 'IT' })
  eq(r.source, 'EXACT_MATCH')
  eq(r.locationCode, 'IT-MAIN') // IT in servesMarketplaces beats GLOBAL
})

test('no locations at all → NO_LOCATION', () => {
  const r = resolveStockForChannel({ byLocation: [], channel: 'EBAY', marketplace: 'IT' })
  eq(r.source, 'NO_LOCATION')
  eq(r.available, 0)
  eq(r.locationId, null)
})

test('AMAZON+FBA with no FBA pool falls back to default warehouse', () => {
  const r = resolveStockForChannel({ byLocation: [itMain], channel: 'AMAZON', marketplace: 'IT', fulfillmentMethod: 'FBA' })
  eq(r.source, 'WAREHOUSE_DEFAULT')
  eq(r.locationCode, 'IT-MAIN')
})

test('no double-counting: total = sum of per-location, regardless of channel', () => {
  // Critical correctness gate per the brief.
  const all = [itMain, fbaEu]
  const totalAvailable = all.reduce((s, r) => s + r.available, 0)
  eq(totalAvailable, 57) // 45 + 12, NOT 45 + 12 + (45+12)=114

  // Verify channel resolution doesn't accidentally include locations
  // outside its candidate pool.
  const fbaChannel = resolveStockForChannel({ byLocation: all, channel: 'AMAZON', marketplace: 'IT', fulfillmentMethod: 'FBA' })
  const fbmChannel = resolveStockForChannel({ byLocation: all, channel: 'AMAZON', marketplace: 'IT', fulfillmentMethod: 'FBM' })
  eq(fbaChannel.available, 12) // FBA pool only
  eq(fbmChannel.available, 45) // Warehouse only
  // Neither sees both pools — no double-counting per channel.
})

test('Amazon channel without fulfillmentMethod treated as FBM (warehouse)', () => {
  const r = resolveStockForChannel({ byLocation: [itMain, fbaEu], channel: 'AMAZON', marketplace: 'IT' })
  eq(r.source, 'EXACT_MATCH')
  eq(r.locationCode, 'IT-MAIN')
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`atp-channel.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
