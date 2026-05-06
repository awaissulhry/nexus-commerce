/**
 * R.19 — pure-function tests for container/freight optimization.
 */

import {
  normalizeDimsToCm,
  normalizeWeightToGrams,
  cbmFromDims,
  chargeableWeightKg,
  freightCostForLine,
  optimizeContainerFill,
  type PackItem,
  type ShippingProfile,
} from './container-pack.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}
function near(actual: number, expected: number, tol: number, msg = '') {
  if (Math.abs(actual - expected) > tol) throw new Error(`${msg} expected≈${expected} actual=${actual}`)
}

test('normalizeDimsToCm: cm passthrough', () => {
  const r = normalizeDimsToCm({ length: 30, width: 20, height: 10, unit: 'cm' })
  eq(r, { l: 30, w: 20, h: 10 })
})

test('normalizeDimsToCm: in→cm', () => {
  const r = normalizeDimsToCm({ length: 10, width: 10, height: 10, unit: 'in' })
  near(r!.l, 25.4, 0.001)
})

test('normalizeDimsToCm: missing dim → null', () => {
  const r = normalizeDimsToCm({ length: 10, width: null, height: 10, unit: 'cm' })
  eq(r, null)
})

test('normalizeWeightToGrams: lb→g', () => {
  const r = normalizeWeightToGrams({ value: 1, unit: 'lb' })
  near(r!, 453.592, 0.001)
})

test('cbmFromDims: 100×100×100 cm = 1 m³', () => {
  near(cbmFromDims(100, 100, 100), 1.0, 0.001)
})

test('chargeableWeightKg AIR: volumetric wins', () => {
  // 1 cbm × 167 = 167 kg volumetric > 50 kg actual
  near(chargeableWeightKg({ actualKg: 50, cbm: 1, ratio: 167 }), 167, 0.01)
})

test('chargeableWeightKg AIR: actual wins for dense cargo', () => {
  near(chargeableWeightKg({ actualKg: 200, cbm: 1, ratio: 167 }), 200, 0.01)
})

test('freightCostForLine SEA_LCL: 100 units × 0.01 cbm at €120/cbm', () => {
  // 100 × 0.01 = 1 cbm, profile €12000 cents/cbm → 12000 cents
  // Volumetric kg at ratio 333 = 333 kg; if costPerKg=0 this just uses cbm
  const r = freightCostForLine({
    unitsQty: 100,
    cbmPerUnit: 0.01,
    kgPerUnit: 0.5,
    profile: {
      mode: 'SEA_LCL',
      costPerCbmCents: 12000,
      costPerKgCents: null,
      fixedCostCents: null,
      currencyCode: 'EUR',
      containerCapacityCbm: null,
      containerMaxWeightKg: null,
    },
  })
  near(r, 12000, 1)
})

test('freightCostForLine AIR: cbm × 167 vs actual kg, charged at €5/kg', () => {
  // 10 units × 0.05 cbm = 0.5 cbm → volumetric 83.5 kg
  // 10 units × 5 kg = 50 kg actual → chargeable 83.5 kg
  // 83.5 × 500 cents/kg = 41750 cents
  const r = freightCostForLine({
    unitsQty: 10,
    cbmPerUnit: 0.05,
    kgPerUnit: 5,
    profile: {
      mode: 'AIR',
      costPerCbmCents: null,
      costPerKgCents: 500,
      fixedCostCents: null,
      currencyCode: 'EUR',
      containerCapacityCbm: null,
      containerMaxWeightKg: null,
    },
  })
  near(r, 41750, 1)
})

test('optimizeContainerFill SEA_FCL_40: 50% fill → top-up suggested', () => {
  const profile: ShippingProfile = {
    mode: 'SEA_FCL_40',
    costPerCbmCents: null,
    costPerKgCents: null,
    fixedCostCents: 600000, // €6000 / container
    currencyCode: 'EUR',
    containerCapacityCbm: 76,
    containerMaxWeightKg: 28800,
  }
  const items: PackItem[] = [
    {
      productId: 'A',
      sku: 'SKU-A',
      unitsQty: 100,
      cbmPerUnit: 0.2, // 20 cbm
      kgPerUnit: 5,
      unitCostCents: 5000,
      urgency: 'CRITICAL',
      casePack: 12,
    },
    {
      productId: 'B',
      sku: 'SKU-B',
      unitsQty: 200,
      cbmPerUnit: 0.1, // 20 cbm
      kgPerUnit: 3,
      unitCostCents: 3000,
      urgency: 'HIGH',
      casePack: 24,
    },
  ]
  const r = optimizeContainerFill({ items, profile })
  near(r.totalCbm, 40, 0.01)
  near(r.fillPercentByCbm!, 52.63, 0.5)
  // Top-up should be present (under 90%)
  if (r.topUpSuggestions.length === 0) throw new Error('expected top-up suggestion')
  const total = r.perLineFreightCents.get('A')! + r.perLineFreightCents.get('B')!
  near(total, 600000, 1)
})

test('optimizeContainerFill SEA_FCL_40: 95% fill → no top-up', () => {
  const profile: ShippingProfile = {
    mode: 'SEA_FCL_40',
    costPerCbmCents: null,
    costPerKgCents: null,
    fixedCostCents: 600000,
    currencyCode: 'EUR',
    containerCapacityCbm: 76,
    containerMaxWeightKg: 28800,
  }
  const items: PackItem[] = [
    {
      productId: 'A',
      sku: 'SKU-A',
      unitsQty: 360,
      cbmPerUnit: 0.2, // 72 cbm = 94.7%
      kgPerUnit: 5,
      unitCostCents: 5000,
      urgency: 'HIGH',
      casePack: 12,
    },
  ]
  const r = optimizeContainerFill({ items, profile })
  if (r.fillPercentByCbm! < 90) throw new Error('fixture should be ≥90% fill')
  eq(r.topUpSuggestions.length, 0)
})

test('optimizeContainerFill SEA_LCL: per-line freight; no top-up', () => {
  const profile: ShippingProfile = {
    mode: 'SEA_LCL',
    costPerCbmCents: 10000,
    costPerKgCents: null,
    fixedCostCents: null,
    currencyCode: 'EUR',
    containerCapacityCbm: null,
    containerMaxWeightKg: null,
  }
  const items: PackItem[] = [
    {
      productId: 'A',
      sku: 'SKU-A',
      unitsQty: 100,
      cbmPerUnit: 0.05, // 5 cbm → 50000 cents
      kgPerUnit: 1,
      unitCostCents: 5000,
      urgency: 'HIGH',
      casePack: 12,
    },
  ]
  const r = optimizeContainerFill({ items, profile })
  near(r.freightCostCents, 50000, 1)
  // LCL: no container concept → no top-up suggestions
  eq(r.topUpSuggestions.length, 0)
})

test('top-up: ineligible LOW-urgency SKUs are skipped', () => {
  const profile: ShippingProfile = {
    mode: 'SEA_FCL_40',
    costPerCbmCents: null,
    costPerKgCents: null,
    fixedCostCents: 600000,
    currencyCode: 'EUR',
    containerCapacityCbm: 76,
    containerMaxWeightKg: 28800,
  }
  const items: PackItem[] = [
    {
      productId: 'A',
      sku: 'A',
      unitsQty: 50,
      cbmPerUnit: 0.2,
      kgPerUnit: 5,
      unitCostCents: 5000,
      urgency: 'LOW',
      casePack: 12,
    },
  ]
  const r = optimizeContainerFill({ items, profile })
  // 50×0.2=10cbm → 13% fill → headroom available, but only LOW item
  eq(r.topUpSuggestions.length, 0)
})

test('zero items → zero costs / no NaN', () => {
  const profile: ShippingProfile = {
    mode: 'SEA_FCL_40',
    costPerCbmCents: null,
    costPerKgCents: null,
    fixedCostCents: 600000,
    currencyCode: 'EUR',
    containerCapacityCbm: 76,
    containerMaxWeightKg: 28800,
  }
  const r = optimizeContainerFill({ items: [], profile })
  eq(r.totalCbm, 0)
  eq(r.perLineFreightCents.size, 0)
  eq(r.topUpSuggestions.length, 0)
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`container-pack.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
