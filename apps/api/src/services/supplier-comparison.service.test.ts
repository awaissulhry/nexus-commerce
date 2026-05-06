/**
 * R.9 — pure-function tests for rankSuppliers.
 */

import { rankSuppliers, type SupplierCandidate } from './supplier-comparison.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

function s(overrides: Partial<SupplierCandidate>): SupplierCandidate {
  return {
    supplierId: 'X',
    supplierName: 'X',
    unitCostCentsEur: 1000,
    leadTimeDays: 14,
    moq: 50,
    casePack: 12,
    currencyCode: 'EUR',
    leadTimeStdDevDays: null,
    leadTimeSampleCount: 0,
    paymentTerms: 'Net 30',
    isCurrentlyPreferred: false,
    ...overrides,
  }
}

test('empty list → []', () => {
  eq(rankSuppliers({ candidates: [] }), [])
})

test('single candidate → rank 1, notes "best overall"', () => {
  const r = rankSuppliers({ candidates: [s({ supplierId: 'A', supplierName: 'A' })] })
  eq(r.length, 1)
  eq(r[0].rank, 1)
  if (!r[0].notes.includes('best overall match')) throw new Error('expected best-overall note')
})

test('two candidates: cheaper wins on default weights', () => {
  const r = rankSuppliers({
    candidates: [
      s({ supplierId: 'cheap', supplierName: 'CHEAP', unitCostCentsEur: 800 }),
      s({ supplierId: 'pricy', supplierName: 'PRICY', unitCostCentsEur: 2000 }),
    ],
  })
  eq(r[0].supplierId, 'cheap')
  eq(r[1].supplierId, 'pricy')
})

test('CRITICAL urgency: speed beats price even at 3× cost', () => {
  // cheap is 14d, fast is 5d at 3× price.
  // Default weights: cheap wins (cost 0.4 dominates with 3× gap).
  // Critical weights: fast wins (speed 0.5 dominates).
  const candidates = [
    s({ supplierId: 'cheap', supplierName: 'CHEAP', unitCostCentsEur: 1000, leadTimeDays: 14 }),
    s({ supplierId: 'fast', supplierName: 'FAST', unitCostCentsEur: 3000, leadTimeDays: 5 }),
  ]
  const def = rankSuppliers({ candidates })
  eq(def[0].supplierId, 'cheap')
  const crit = rankSuppliers({ candidates, urgency: 'CRITICAL' })
  eq(crit[0].supplierId, 'fast')
})

test('null cost ranks last on cost dimension', () => {
  const r = rankSuppliers({
    candidates: [
      s({ supplierId: 'priced', supplierName: 'PRICED', unitCostCentsEur: 1000 }),
      s({ supplierId: 'unknown', supplierName: 'UNKNOWN', unitCostCentsEur: null }),
    ],
  })
  eq(r[0].supplierId, 'priced')
  eq(r[1].supplierId, 'unknown')
})

test('lower MOQ wins on flex dimension', () => {
  const r = rankSuppliers({
    candidates: [
      s({ supplierId: 'small', supplierName: 'SMALL', moq: 10 }),
      s({ supplierId: 'big', supplierName: 'BIG', moq: 100 }),
    ],
  })
  // Same cost + leadtime; flex ties to MOQ. Small should win.
  eq(r[0].supplierId, 'small')
})

test('reliability: low σ_LT with samples beats high σ_LT', () => {
  // Same cost + leadtime + MOQ. Reliability differs.
  const r = rankSuppliers({
    candidates: [
      s({
        supplierId: 'reliable',
        supplierName: 'RELIABLE',
        leadTimeStdDevDays: 1,
        leadTimeSampleCount: 20,
      }),
      s({
        supplierId: 'volatile',
        supplierName: 'VOLATILE',
        leadTimeStdDevDays: 6,
        leadTimeSampleCount: 20,
      }),
    ],
  })
  eq(r[0].supplierId, 'reliable')
})

test('reliability: low sample count discounts σ_LT advantage', () => {
  // 'reliable' has σ_LT=1 but only 1 sample (low confidence).
  // 'volatile' has σ_LT=6 with 1 sample — same confidence.
  // With samples=1, both reliability scores collapse toward 0.5.
  const r = rankSuppliers({
    candidates: [
      s({
        supplierId: 'reliable',
        supplierName: 'RELIABLE',
        leadTimeStdDevDays: 1,
        leadTimeSampleCount: 1,
      }),
      s({
        supplierId: 'volatile',
        supplierName: 'VOLATILE',
        leadTimeStdDevDays: 6,
        leadTimeSampleCount: 1,
      }),
    ],
  })
  // The reliability gap is heavily discounted; both end near 0.5.
  // Reliable still wins by a small margin (low-σ side of 0.5 anchor).
  eq(r[0].supplierId, 'reliable')
  // Margin should be small — within 0.05 composite delta.
  const margin = r[0].compositeScore - r[1].compositeScore
  if (margin > 0.05) throw new Error(`expected small margin, got ${margin}`)
})

test('notes: cheaper alternative carries cost diff', () => {
  const r = rankSuppliers({
    candidates: [
      s({ supplierId: 'A', supplierName: 'ACME', unitCostCentsEur: 1000 }),
      s({ supplierId: 'B', supplierName: 'BUDGET', unitCostCentsEur: 800 }),
    ],
  })
  // BUDGET wins; ACME's notes should mention +€2.00/unit vs BUDGET
  const acme = r.find((x) => x.supplierId === 'A')!
  const noteText = acme.notes.join(' | ')
  if (!noteText.includes('+€2.00')) throw new Error(`expected cost-diff note, got: ${noteText}`)
})

test('notes: faster alternative annotated', () => {
  const r = rankSuppliers({
    candidates: [
      s({ supplierId: 'fast', supplierName: 'FAST', unitCostCentsEur: 1000, leadTimeDays: 5 }),
      s({ supplierId: 'slow', supplierName: 'SLOW', unitCostCentsEur: 1000, leadTimeDays: 14 }),
    ],
  })
  // FAST should win on speed (cost equal); SLOW gets "9d slower"
  const slow = r.find((x) => x.supplierId === 'slow')!
  if (!slow.notes.some((n) => n.includes('9d slower'))) {
    throw new Error(`expected "9d slower" note, got: ${slow.notes.join(' | ')}`)
  }
})

test('compositeScore is in [0, 1]', () => {
  const r = rankSuppliers({
    candidates: [
      s({ supplierId: 'A', supplierName: 'A', unitCostCentsEur: 1000, leadTimeDays: 14 }),
      s({ supplierId: 'B', supplierName: 'B', unitCostCentsEur: 1500, leadTimeDays: 7 }),
    ],
  })
  for (const x of r) {
    if (x.compositeScore < 0 || x.compositeScore > 1) {
      throw new Error(`composite ${x.compositeScore} out of [0,1]`)
    }
  }
})

test('currently-preferred annotation propagates to notes', () => {
  const r = rankSuppliers({
    candidates: [
      s({ supplierId: 'A', supplierName: 'A', isCurrentlyPreferred: true }),
      s({ supplierId: 'B', supplierName: 'B' }),
    ],
  })
  const a = r.find((x) => x.supplierId === 'A')!
  if (!a.notes.includes('currently preferred')) throw new Error('missing preferred note')
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`supplier-comparison.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
