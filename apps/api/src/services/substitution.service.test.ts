/**
 * R.17 — Pure-function tests for substitution-aware demand.
 */

import {
  adjustDemandForSubstitution,
  type DailyPoint,
  type SubstitutionLink,
  type StockoutWindow,
} from './substitution.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

const ownSeries: DailyPoint[] = [
  { day: '2026-05-01', units: 5 },
  { day: '2026-05-02', units: 5 },
  { day: '2026-05-03', units: 5 },
]

test('no stockout windows → series unchanged (clamps formatting)', () => {
  const r = adjustDemandForSubstitution({
    productId: 'A',
    ownSeries,
    links: [],
    substituteSeries: new Map(),
    stockoutWindows: [],
    now: new Date('2026-05-04T00:00:00Z'),
  })
  eq(r, [
    { day: '2026-05-01', units: 5 },
    { day: '2026-05-02', units: 5 },
    { day: '2026-05-03', units: 5 },
  ])
})

test('no links → series unchanged even with stockout windows', () => {
  const r = adjustDemandForSubstitution({
    productId: 'A',
    ownSeries,
    links: [],
    substituteSeries: new Map(),
    stockoutWindows: [{
      productId: 'A',
      startedAt: new Date('2026-05-01T00:00:00Z'),
      endedAt: new Date('2026-05-03T00:00:00Z'),
    }],
    now: new Date('2026-05-04T00:00:00Z'),
  })
  eq(r.length, 3)
  eq(r[0].units, 5)
})

test('PRIMARY case: own stockout + substitute sales → credit back', () => {
  // A is primary, was out 2026-05-01 to 2026-05-03.
  // B is substitute. B sold 10 units/day during those days.
  // Fraction 0.5 → A gets +5 each day on top of own series.
  const links: SubstitutionLink[] = [
    { primaryProductId: 'A', substituteProductId: 'B', substitutionFraction: 0.5 },
  ]
  const subSeries = new Map<string, DailyPoint[]>([
    ['B', [
      { day: '2026-05-01', units: 10 },
      { day: '2026-05-02', units: 10 },
      { day: '2026-05-03', units: 10 },
    ]],
  ])
  const stockouts: StockoutWindow[] = [
    {
      productId: 'A',
      startedAt: new Date('2026-05-01T00:00:00Z'),
      endedAt: new Date('2026-05-03T00:00:00Z'),
    },
  ]
  const r = adjustDemandForSubstitution({
    productId: 'A',
    ownSeries,
    links,
    substituteSeries: subSeries,
    stockoutWindows: stockouts,
    now: new Date('2026-05-04T00:00:00Z'),
  })
  eq(r[0].units, 10)  // 5 own + 5 credited
  eq(r[1].units, 10)
  eq(r[2].units, 10)
})

test('SUBSTITUTE case: primary stockout → remove inflated portion', () => {
  // B is substitute. B sold 10 units/day during A's stockout.
  // Fraction 0.5 → B's adjusted demand is 5 (10 - 5 stolen).
  const links: SubstitutionLink[] = [
    { primaryProductId: 'A', substituteProductId: 'B', substitutionFraction: 0.5 },
  ]
  const bSeries: DailyPoint[] = [
    { day: '2026-05-01', units: 10 },
    { day: '2026-05-02', units: 10 },
    { day: '2026-05-03', units: 10 },
  ]
  const stockouts: StockoutWindow[] = [
    {
      productId: 'A',
      startedAt: new Date('2026-05-01T00:00:00Z'),
      endedAt: new Date('2026-05-03T00:00:00Z'),
    },
  ]
  const r = adjustDemandForSubstitution({
    productId: 'B',
    ownSeries: bSeries,
    links,
    substituteSeries: new Map(),
    stockoutWindows: stockouts,
    now: new Date('2026-05-04T00:00:00Z'),
  })
  eq(r[0].units, 5)  // 10 - 0.5 × 10 = 5
})

test('substitute clamp: own < adjusted-down → 0 (never negative)', () => {
  // Edge case: own sales 1, fraction 0.9. 1 - 0.9 = 0.1, then floor.
  // Real edge: 0 - any = clamp to 0.
  const r = adjustDemandForSubstitution({
    productId: 'B',
    ownSeries: [{ day: '2026-05-01', units: 1 }],
    links: [{ primaryProductId: 'A', substituteProductId: 'B', substitutionFraction: 0.9 }],
    substituteSeries: new Map(),
    stockoutWindows: [{
      productId: 'A',
      startedAt: new Date('2026-05-01T00:00:00Z'),
      endedAt: new Date('2026-05-01T23:59:59Z'),
    }],
    now: new Date('2026-05-02T00:00:00Z'),
  })
  eq(r[0].units, 0.1)  // 1 - 0.9 × 1 = 0.1, two-decimal precision

  // Now make own=0 to confirm clamp
  const r2 = adjustDemandForSubstitution({
    productId: 'B',
    ownSeries: [{ day: '2026-05-01', units: 0 }],
    links: [{ primaryProductId: 'A', substituteProductId: 'B', substitutionFraction: 0.9 }],
    substituteSeries: new Map(),
    stockoutWindows: [{
      productId: 'A',
      startedAt: new Date('2026-05-01T00:00:00Z'),
      endedAt: new Date('2026-05-01T23:59:59Z'),
    }],
    now: new Date('2026-05-02T00:00:00Z'),
  })
  eq(r2[0].units, 0)
})

test('ongoing stockout (endedAt=null) treated as until-now', () => {
  const links: SubstitutionLink[] = [
    { primaryProductId: 'A', substituteProductId: 'B', substitutionFraction: 0.5 },
  ]
  const subSeries = new Map<string, DailyPoint[]>([
    ['B', [{ day: '2026-05-01', units: 10 }, { day: '2026-05-02', units: 10 }]],
  ])
  const r = adjustDemandForSubstitution({
    productId: 'A',
    ownSeries: [{ day: '2026-05-01', units: 5 }, { day: '2026-05-02', units: 5 }],
    links,
    substituteSeries: subSeries,
    stockoutWindows: [{
      productId: 'A',
      startedAt: new Date('2026-05-01T00:00:00Z'),
      endedAt: null,  // ongoing
    }],
    now: new Date('2026-05-02T12:00:00Z'),  // includes both days
  })
  eq(r[0].units, 10)  // credited
  eq(r[1].units, 10)  // credited
})

test('multiple primaries credited to same substitute → sum', () => {
  // B substitutes for both A and C
  const links: SubstitutionLink[] = [
    { primaryProductId: 'A', substituteProductId: 'B', substitutionFraction: 0.3 },
    { primaryProductId: 'C', substituteProductId: 'B', substitutionFraction: 0.4 },
  ]
  // B sold 10 on day 05-01 — both A and C were out that day
  const stockouts: StockoutWindow[] = [
    { productId: 'A', startedAt: new Date('2026-05-01T00:00:00Z'), endedAt: new Date('2026-05-01T23:59:59Z') },
    { productId: 'C', startedAt: new Date('2026-05-01T00:00:00Z'), endedAt: new Date('2026-05-01T23:59:59Z') },
  ]
  const r = adjustDemandForSubstitution({
    productId: 'B',
    ownSeries: [{ day: '2026-05-01', units: 10 }],
    links,
    substituteSeries: new Map(),
    stockoutWindows: stockouts,
    now: new Date('2026-05-02T00:00:00Z'),
  })
  // 10 - 0.3 × 10 - 0.4 × 10 = 10 - 3 - 4 = 3
  eq(r[0].units, 3)
})

test('no overlap between stockout window and series days → no adjustment', () => {
  const r = adjustDemandForSubstitution({
    productId: 'A',
    ownSeries,
    links: [{ primaryProductId: 'A', substituteProductId: 'B', substitutionFraction: 0.5 }],
    substituteSeries: new Map([['B', [{ day: '2026-04-01', units: 100 }]]]),
    stockoutWindows: [{
      productId: 'A',
      startedAt: new Date('2026-04-01T00:00:00Z'),
      endedAt: new Date('2026-04-01T23:59:59Z'),  // pre-window
    }],
    now: new Date('2026-05-04T00:00:00Z'),
  })
  // own series days are 05-01..05-03; stockout was on 04-01 — no overlap
  eq(r.find((p) => p.day === '2026-05-01')?.units, 5)
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`substitution.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
