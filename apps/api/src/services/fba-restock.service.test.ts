/**
 * R.8 — pure-function tests for parseRestockTsv + compareRecommendations.
 */

import {
  parseRestockTsv,
  compareRecommendations,
  DEFAULT_STALE_DAYS,
} from './fba-restock.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}
function near(actual: number, expected: number, tol: number, msg = '') {
  if (Math.abs(actual - expected) > tol) throw new Error(`${msg} expected≈${expected} actual=${actual}`)
}

// ─── parseRestockTsv ───────────────────────────────────────────────

test('parseRestockTsv: empty string → []', () => {
  eq(parseRestockTsv(''), [])
})

test('parseRestockTsv: header only → []', () => {
  eq(parseRestockTsv('sku\trecommended-replenishment-qty\n'), [])
})

test('parseRestockTsv: simple two-row TSV', () => {
  const tsv =
    'sku\trecommended-replenishment-qty\tdays-of-supply\tdays-to-inbound\n' +
    'SKU-A\t150\t14.5\t7\n' +
    'SKU-B\t0\t90\t14\n'
  const rows = parseRestockTsv(tsv)
  eq(rows.length, 2)
  eq(rows[0].sku, 'SKU-A')
  eq(rows[0].recommendedReplenishmentQty, 150)
  near(rows[0].daysOfSupply!, 14.5, 0.01)
  eq(rows[0].daysToInbound, 7)
  eq(rows[1].recommendedReplenishmentQty, 0)
})

test('parseRestockTsv: missing optional columns yield null', () => {
  const tsv = 'sku\trecommended-replenishment-qty\n' + 'SKU-A\t100\n'
  const rows = parseRestockTsv(tsv)
  eq(rows[0].daysOfSupply, null)
  eq(rows[0].alertType, null)
  eq(rows[0].salesPace30dUnits, null)
})

test('parseRestockTsv: empty cells parsed as null', () => {
  const tsv =
    'sku\trecommended-replenishment-qty\tdays-of-supply\n' +
    'SKU-A\t\t\n'
  const rows = parseRestockTsv(tsv)
  eq(rows.length, 1)
  eq(rows[0].recommendedReplenishmentQty, null)
  eq(rows[0].daysOfSupply, null)
})

test('parseRestockTsv: alternate column names (alert-type, sales-pace)', () => {
  const tsv =
    'sku\tsales-pace\talert-type\n' +
    'SKU-A\t42\tRecommended Restock\n'
  const rows = parseRestockTsv(tsv)
  eq(rows[0].salesPace30dUnits, 42)
  eq(rows[0].alertType, 'Recommended Restock')
})

test('parseRestockTsv: handles CRLF + trailing blank line', () => {
  const tsv = 'sku\trecommended-replenishment-qty\r\nSKU-A\t100\r\n\r\n'
  const rows = parseRestockTsv(tsv)
  eq(rows.length, 1)
  eq(rows[0].sku, 'SKU-A')
})

test('parseRestockTsv: numbers with thousands separator', () => {
  const tsv = 'sku\trecommended-replenishment-qty\nSKU-A\t1,250\n'
  const rows = parseRestockTsv(tsv)
  eq(rows[0].recommendedReplenishmentQty, 1250)
})

test('parseRestockTsv: skips rows without a sku', () => {
  const tsv = 'sku\tqty\n\t100\nSKU-B\t50\n'
  const rows = parseRestockTsv(tsv)
  eq(rows.length, 1)
  eq(rows[0].sku, 'SKU-B')
})

// ─── compareRecommendations ────────────────────────────────────────

const FRESH = new Date('2026-05-06T00:00:00Z')

test('compare: no amazon row → NO_AMAZON_SIGNAL', () => {
  const r = compareRecommendations({
    ourQty: 100, amazonQty: null, asOf: null, now: FRESH,
  })
  eq(r.status, 'NO_AMAZON_SIGNAL')
  eq(r.deltaPct, null)
})

test('compare: stale row (older than 7d) → NO_AMAZON_SIGNAL', () => {
  const old = new Date(FRESH.getTime() - 8 * 86400000)
  const r = compareRecommendations({
    ourQty: 100, amazonQty: 200, asOf: old, now: FRESH,
  })
  eq(r.status, 'NO_AMAZON_SIGNAL')
  eq(r.isStale, true)
})

test('compare: aligned within 20%', () => {
  const r = compareRecommendations({
    ourQty: 100, amazonQty: 110, asOf: FRESH, now: FRESH,
  })
  eq(r.status, 'ALIGNED')
  near(r.deltaPct!, 10, 0.01)
})

test('compare: amazon recommends more (>20%)', () => {
  const r = compareRecommendations({
    ourQty: 100, amazonQty: 130, asOf: FRESH, now: FRESH,
  })
  eq(r.status, 'AMAZON_HIGHER')
  eq(r.deltaPct, 30)
})

test('compare: we recommend more (>20%)', () => {
  const r = compareRecommendations({
    ourQty: 100, amazonQty: 70, asOf: FRESH, now: FRESH,
  })
  eq(r.status, 'OUR_HIGHER')
  eq(r.deltaPct, -30)
})

test('compare: amazon zero with our positive → AMAZON_ZERO', () => {
  const r = compareRecommendations({
    ourQty: 100, amazonQty: 0, asOf: FRESH, now: FRESH,
  })
  eq(r.status, 'AMAZON_ZERO')
  eq(r.deltaPct, -100)
})

test('compare: both zero → ALIGNED via clamp', () => {
  // ourQty=0 forces denom=1 to avoid divide-by-zero. amazonQty=0 →
  // deltaUnits=0 → deltaPct=0 → ALIGNED.
  const r = compareRecommendations({
    ourQty: 0, amazonQty: 0, asOf: FRESH, now: FRESH,
  })
  eq(r.status, 'ALIGNED')
  eq(r.deltaPct, 0)
})

test('compare: custom threshold tightens detection', () => {
  // 10% delta below 20% default threshold = ALIGNED, but with
  // threshold=5 it flips to AMAZON_HIGHER.
  const r = compareRecommendations({
    ourQty: 100, amazonQty: 110, asOf: FRESH, now: FRESH, thresholdPct: 5,
  })
  eq(r.status, 'AMAZON_HIGHER')
})

test('compare: custom staleness window', () => {
  // 5d-old row would normally be fresh, but staleDays=3 marks it stale
  const fiveDayOld = new Date(FRESH.getTime() - 5 * 86400000)
  const r = compareRecommendations({
    ourQty: 100, amazonQty: 200, asOf: fiveDayOld, now: FRESH, staleDays: 3,
  })
  eq(r.isStale, true)
  eq(r.status, 'NO_AMAZON_SIGNAL')
})

test('compare: DEFAULT_STALE_DAYS is 7', () => {
  eq(DEFAULT_STALE_DAYS, 7)
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`fba-restock.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
