/**
 * W4.7 — Pure-function tests for pickPrice + isWithinSchedule.
 *
 * No DB. Run with `npx tsx <file>`.
 */

import {
  isWithinSchedule,
  pickPrice,
  type RuleConfig,
} from './repricing-engine.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

const baseRule: RuleConfig = {
  strategy: 'match_buy_box',
  minPrice: 50,
  maxPrice: 150,
}

// ── isWithinSchedule ───────────────────────────────────────────

test('schedule: empty config = always-on', () => {
  const r = isWithinSchedule({}, new Date('2026-05-09T13:00:00Z'))
  eq(r, true)
})

test('schedule: hour range hit (9-17) at 13:00 UTC → in', () => {
  const r = isWithinSchedule(
    { activeFromHour: 9, activeToHour: 17 },
    new Date('2026-05-09T13:00:00Z'),
  )
  eq(r, true)
})

test('schedule: hour range miss (9-17) at 22:00 UTC → out', () => {
  const r = isWithinSchedule(
    { activeFromHour: 9, activeToHour: 17 },
    new Date('2026-05-09T22:00:00Z'),
  )
  eq(r, false)
})

test('schedule: midnight-crossing (22-6) at 23:00 → in', () => {
  const r = isWithinSchedule(
    { activeFromHour: 22, activeToHour: 6 },
    new Date('2026-05-09T23:00:00Z'),
  )
  eq(r, true)
})

test('schedule: midnight-crossing (22-6) at 03:00 → in', () => {
  const r = isWithinSchedule(
    { activeFromHour: 22, activeToHour: 6 },
    new Date('2026-05-09T03:00:00Z'),
  )
  eq(r, true)
})

test('schedule: midnight-crossing (22-6) at 12:00 → out', () => {
  const r = isWithinSchedule(
    { activeFromHour: 22, activeToHour: 6 },
    new Date('2026-05-09T12:00:00Z'),
  )
  eq(r, false)
})

test('schedule: activeDays present and includes today → in', () => {
  // 2026-05-09 is a Saturday (UTC day=6).
  const r = isWithinSchedule({ activeDays: [1, 2, 3, 4, 5, 6] }, new Date('2026-05-09T12:00:00Z'))
  eq(r, true)
})

test('schedule: activeDays excludes Sunday → out', () => {
  // 2026-05-10 is a Sunday (UTC day=0).
  const r = isWithinSchedule({ activeDays: [1, 2, 3, 4, 5, 6] }, new Date('2026-05-10T12:00:00Z'))
  eq(r, false)
})

// ── pickPrice — manual ─────────────────────────────────────────

test('manual strategy → never moves price', () => {
  const r = pickPrice(
    { ...baseRule, strategy: 'manual' },
    { currentPrice: 100, buyBoxPrice: 80 },
    new Date('2026-05-09T13:00:00Z'),
  )
  eq(r.changed, false)
  eq(r.price, 100)
  eq(r.reason, 'manual-strategy')
})

// ── pickPrice — match_buy_box ─────────────────────────────────

test('match_buy_box: buy-box known → matches it', () => {
  const r = pickPrice(
    baseRule,
    { currentPrice: 100, buyBoxPrice: 89.99 },
    new Date('2026-05-09T13:00:00Z'),
  )
  eq(r.price, 89.99)
  eq(r.changed, true)
  eq(r.capped, null)
})

test('match_buy_box: no buy-box data → holds', () => {
  const r = pickPrice(
    baseRule,
    { currentPrice: 100, buyBoxPrice: null },
    new Date('2026-05-09T13:00:00Z'),
  )
  eq(r.price, 100)
  eq(r.changed, false)
  eq(r.reason, 'hold-no-buy-box-data')
})

test('match_buy_box: buy-box below floor → clamps to floor', () => {
  const r = pickPrice(
    baseRule,
    { currentPrice: 100, buyBoxPrice: 30 }, // below floor 50
    new Date('2026-05-09T13:00:00Z'),
  )
  eq(r.price, 50)
  eq(r.capped, 'floor')
})

test('match_buy_box: buy-box above ceiling → clamps to ceiling', () => {
  const r = pickPrice(
    baseRule,
    { currentPrice: 100, buyBoxPrice: 200 }, // above ceiling 150
    new Date('2026-05-09T13:00:00Z'),
  )
  eq(r.price, 150)
  eq(r.capped, 'ceiling')
})

// ── pickPrice — beat_lowest_by_pct ─────────────────────────────

test('beat_lowest_by_pct: undercuts by 5% (lowest=100 → 95)', () => {
  const r = pickPrice(
    { ...baseRule, strategy: 'beat_lowest_by_pct', beatPct: 5 },
    { currentPrice: 110, lowestCompPrice: 100 },
    new Date('2026-05-09T13:00:00Z'),
  )
  eq(r.price, 95)
  eq(r.capped, null)
})

test('beat_lowest_by_pct: missing beatPct → holds', () => {
  const r = pickPrice(
    { ...baseRule, strategy: 'beat_lowest_by_pct' },
    { currentPrice: 100, lowestCompPrice: 100 },
    new Date('2026-05-09T13:00:00Z'),
  )
  eq(r.changed, false)
  eq(r.reason, 'hold-no-competitor-data')
})

// ── pickPrice — beat_lowest_by_amount ──────────────────────────

test('beat_lowest_by_amount: undercuts by absolute (lowest=100 - 2 = 98)', () => {
  const r = pickPrice(
    { ...baseRule, strategy: 'beat_lowest_by_amount', beatAmount: 2 },
    { currentPrice: 110, lowestCompPrice: 100 },
    new Date('2026-05-09T13:00:00Z'),
  )
  eq(r.price, 98)
})

// ── pickPrice — fixed_to_buy_box_minus ─────────────────────────

test('fixed_to_buy_box_minus: buy-box 100 - 5 = 95', () => {
  const r = pickPrice(
    { ...baseRule, strategy: 'fixed_to_buy_box_minus', beatAmount: 5 },
    { currentPrice: 110, buyBoxPrice: 100 },
    new Date('2026-05-09T13:00:00Z'),
  )
  eq(r.price, 95)
})

// ── pickPrice — schedule gates strategy ────────────────────────

test('out-of-schedule → returns currentPrice with outside-schedule reason', () => {
  const r = pickPrice(
    { ...baseRule, activeFromHour: 9, activeToHour: 17 },
    { currentPrice: 110, buyBoxPrice: 80 },
    new Date('2026-05-09T22:00:00Z'),
  )
  eq(r.price, 110)
  eq(r.changed, false)
  eq(r.reason, 'outside-schedule')
})

// ── pickPrice — no-op when target equals currentPrice ──────────

test('target equals currentPrice → changed=false', () => {
  const r = pickPrice(
    baseRule,
    { currentPrice: 89.99, buyBoxPrice: 89.99 },
    new Date('2026-05-09T13:00:00Z'),
  )
  eq(r.price, 89.99)
  eq(r.changed, false, 'no-op when same')
})

let failed = 0
for (const t of tests) {
  try {
    t.fn()
    console.log(`  ok  ${t.name}`)
  } catch (e) {
    failed++
    console.error(`FAIL  ${t.name}\n      ${e instanceof Error ? e.message : String(e)}`)
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log(`\n${tests.length} tests passed`)
