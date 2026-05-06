/**
 * R.20 — pure-function tests for the cash-flow projection.
 */

import {
  parsePaymentTermsDays,
  estimatePayableDate,
  weekStart,
  projectWeeklyCashFlow,
  type OpenPo,
  type SpeculativeRec,
} from './cash-flow.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

test('parsePaymentTermsDays: Net 30', () => eq(parsePaymentTermsDays('Net 30'), 30))
test('parsePaymentTermsDays: 30gg DF (Italian)', () => eq(parsePaymentTermsDays('30gg DF'), 30))
test('parsePaymentTermsDays: 60 days', () => eq(parsePaymentTermsDays('60 days'), 60))
test('parsePaymentTermsDays: bare 45', () => eq(parsePaymentTermsDays('45'), 45))
test('parsePaymentTermsDays: null → 30', () => eq(parsePaymentTermsDays(null), 30))
test('parsePaymentTermsDays: garbage → 30', () => eq(parsePaymentTermsDays('asap please'), 30))

test('weekStart: a Wednesday → Monday of that week', () => {
  const d = new Date('2026-05-06T12:00:00Z') // Wed
  const w = weekStart(d)
  eq(w.toISOString().slice(0, 10), '2026-05-04') // Mon
})

test('weekStart: a Sunday → previous Monday', () => {
  const d = new Date('2026-05-10T12:00:00Z') // Sun
  const w = weekStart(d)
  eq(w.toISOString().slice(0, 10), '2026-05-04')
})

test('estimatePayableDate uses expected ship + terms', () => {
  const d = estimatePayableDate({
    expectedShip: new Date('2026-06-01T00:00:00Z'),
    createdAt: new Date('2026-05-01T00:00:00Z'),
    termsDays: 30,
  })
  eq(d.toISOString().slice(0, 10), '2026-07-01')
})

test('estimatePayableDate falls back to createdAt when ship null', () => {
  const d = estimatePayableDate({
    expectedShip: null,
    createdAt: new Date('2026-05-06T00:00:00Z'),
    termsDays: 30,
  })
  eq(d.toISOString().slice(0, 10), '2026-06-05')
})

test('projection: empty inputs yields N buckets with zero everything', () => {
  const r = projectWeeklyCashFlow({
    today: new Date('2026-05-06T00:00:00Z'),
    horizonWeeks: 13,
    cashOnHandCents: null,
    dailyRevenueCents: 0,
    openPos: [],
    speculativeRecs: [],
  })
  eq(r.length, 13)
  eq(r[0].outflowCents, 0)
  eq(r[0].inflowCents, 0)
  eq(r[0].health, 'OK')
})

test('projection: single PO becomes due in correct week', () => {
  // PO created 2026-05-01, expected ship 2026-05-15, Net 30 → due 2026-06-14
  const r = projectWeeklyCashFlow({
    today: new Date('2026-05-06T00:00:00Z'),
    horizonWeeks: 13,
    cashOnHandCents: 1_000_000_00,
    dailyRevenueCents: 0,
    openPos: [
      {
        id: 'po1',
        poNumber: 'PO-001',
        supplierId: 's1',
        supplierName: 'ACME',
        totalCentsEur: 50_000_00,
        expectedDeliveryDate: new Date('2026-05-15T00:00:00Z'),
        createdAt: new Date('2026-05-01T00:00:00Z'),
        paymentTerms: 'Net 30',
      },
    ],
    speculativeRecs: [],
  })
  // 2026-06-14 is a Sunday → its weekStart is 2026-06-08
  const due = r.find((b) => b.weekStart === '2026-06-08')
  if (!due) throw new Error('expected bucket 2026-06-08')
  eq(due.outflowCents, 50_000_00)
  eq(due.items.length, 1)
  eq(due.items[0].kind, 'PO_DUE')
})

test('projection: speculative rec lands on today + termsDays', () => {
  // Today 2026-05-06; rec termsDays 30 → due 2026-06-05 (a Friday, weekStart 06-01)
  const r = projectWeeklyCashFlow({
    today: new Date('2026-05-06T00:00:00Z'),
    horizonWeeks: 13,
    cashOnHandCents: 1_000_000_00,
    dailyRevenueCents: 0,
    openPos: [],
    speculativeRecs: [
      {
        productId: 'p1',
        sku: 'SKU-1',
        unitsRecommended: 100,
        landedCostPerUnitCentsEur: 5000,
        preferredSupplierId: 's1',
        supplierName: 'ACME',
        paymentTerms: 'Net 30',
        isManufactured: false,
        leadTimeDays: 14,
      },
    ],
  })
  const due = r.find((b) => b.weekStart === '2026-06-01')
  if (!due) throw new Error('expected bucket 2026-06-01')
  eq(due.outflowCents, 100 * 5000)
  eq(due.items[0].kind, 'REC_DUE')
})

test('projection: manufactured rec is same-day outflow (week 0)', () => {
  const r = projectWeeklyCashFlow({
    today: new Date('2026-05-06T00:00:00Z'),
    horizonWeeks: 13,
    cashOnHandCents: 1_000_000_00,
    dailyRevenueCents: 0,
    openPos: [],
    speculativeRecs: [
      {
        productId: 'p1',
        sku: 'WO-1',
        unitsRecommended: 50,
        landedCostPerUnitCentsEur: 10_000,
        preferredSupplierId: null,
        supplierName: null,
        paymentTerms: null,
        isManufactured: true,
        leadTimeDays: 5,
      },
    ],
  })
  // 2026-05-06 weekStart = 2026-05-04
  const wk0 = r[0]
  eq(wk0.weekStart, '2026-05-04')
  eq(wk0.outflowCents, 50 * 10_000)
  eq(wk0.items[0].kind, 'WO_DUE')
})

test('projection: red when running balance dips below 0', () => {
  // Cash 100€; week 0 outflow 200€ → balance −100€ → RED
  const r = projectWeeklyCashFlow({
    today: new Date('2026-05-06T00:00:00Z'),
    horizonWeeks: 4,
    cashOnHandCents: 100_00,
    dailyRevenueCents: 0,
    openPos: [],
    speculativeRecs: [
      {
        productId: 'p1', sku: 'X',
        unitsRecommended: 1, landedCostPerUnitCentsEur: 200_00,
        preferredSupplierId: null, supplierName: null,
        paymentTerms: null, isManufactured: true, leadTimeDays: 0,
      },
    ],
  })
  eq(r[0].health, 'RED')
  eq(r[0].endingBalanceCents, -100_00)
})

test('projection: amber when balance < 20% safety floor', () => {
  // Cash 1000€; safety floor 200€; week 0 net = −850€ → balance 150€ < 200€ → AMBER
  const r = projectWeeklyCashFlow({
    today: new Date('2026-05-06T00:00:00Z'),
    horizonWeeks: 4,
    cashOnHandCents: 1000_00,
    dailyRevenueCents: 0,
    openPos: [],
    speculativeRecs: [
      {
        productId: 'p1', sku: 'X',
        unitsRecommended: 1, landedCostPerUnitCentsEur: 850_00,
        preferredSupplierId: null, supplierName: null,
        paymentTerms: null, isManufactured: true, leadTimeDays: 0,
      },
    ],
  })
  eq(r[0].health, 'AMBER')
  eq(r[0].endingBalanceCents, 150_00)
})

test('projection: trailing daily revenue inflow each week', () => {
  // 100€/day → 700€/week × 4 weeks = 2800€ inflow with no outflow
  const r = projectWeeklyCashFlow({
    today: new Date('2026-05-06T00:00:00Z'),
    horizonWeeks: 4,
    cashOnHandCents: 0,
    dailyRevenueCents: 100_00,
    openPos: [],
    speculativeRecs: [],
  })
  eq(r[0].inflowCents, 700_00)
  eq(r[3].endingBalanceCents, 4 * 700_00)
  eq(r[0].items[0].kind, 'SALES_FORECAST')
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`cash-flow.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
