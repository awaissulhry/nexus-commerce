/**
 * R.13 — Pure-function tests for event prep.
 */

import {
  eventAppliesToProduct,
  computeExtraUnitsForEvent,
  shouldPromoteForPrep,
  bumpUrgencyOneTier,
  findApplicableEvent,
  type RetailEventLite,
} from './event-prep.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

const baseEvent: RetailEventLite = {
  id: 'ev-1',
  name: 'Black Friday',
  startDate: new Date('2026-11-29T00:00:00Z'),
  endDate: new Date('2026-12-01T00:00:00Z'),
  productType: null,
  channel: null,
  marketplace: null,
  expectedLift: 1.8,
  prepLeadTimeDays: 30,
  isActive: true,
}

// ─── eventAppliesToProduct ───
test('event productType=null applies to all', () => {
  eq(eventAppliesToProduct({ event: baseEvent, productType: 'JACKET' }), true)
})
test('event productType matches → applies', () => {
  eq(eventAppliesToProduct({ event: { ...baseEvent, productType: 'JACKET' }, productType: 'JACKET' }), true)
})
test('event productType differs → blocked', () => {
  eq(eventAppliesToProduct({ event: { ...baseEvent, productType: 'JACKET' }, productType: 'HELMET' }), false)
})
test('inactive event → blocked', () => {
  eq(eventAppliesToProduct({ event: { ...baseEvent, isActive: false }, productType: 'JACKET' }), false)
})
test('lift = 1.0 → blocked (no incremental demand)', () => {
  eq(eventAppliesToProduct({ event: { ...baseEvent, expectedLift: 1.0 }, productType: 'JACKET' }), false)
})
test('lift < 1.0 → blocked (event suppresses demand)', () => {
  eq(eventAppliesToProduct({ event: { ...baseEvent, expectedLift: 0.5 }, productType: 'JACKET' }), false)
})

// ─── computeExtraUnitsForEvent ───
test('velocity 5, duration 10, lift 1.8 → 40 extra units', () => {
  eq(computeExtraUnitsForEvent({ velocity: 5, eventDurationDays: 10, expectedLift: 1.8 }), 40)
})
test('lift = 1.0 → 0 extra (no incremental)', () => {
  eq(computeExtraUnitsForEvent({ velocity: 5, eventDurationDays: 10, expectedLift: 1.0 }), 0)
})
test('lift < 1.0 → 0 extra (clamps)', () => {
  eq(computeExtraUnitsForEvent({ velocity: 5, eventDurationDays: 10, expectedLift: 0.5 }), 0)
})
test('velocity 0 → 0 extra', () => {
  eq(computeExtraUnitsForEvent({ velocity: 0, eventDurationDays: 10, expectedLift: 1.8 }), 0)
})
test('negative duration clamps to 0', () => {
  eq(computeExtraUnitsForEvent({ velocity: 5, eventDurationDays: -3, expectedLift: 1.8 }), 0)
})
test('fractional rounds up (ceiling)', () => {
  // 0.7 × 10 × 0.8 = 5.6 → ceil = 6
  eq(computeExtraUnitsForEvent({ velocity: 0.7, eventDurationDays: 10, expectedLift: 1.8 }), 6)
})

// ─── shouldPromoteForPrep ───
test('deadline 5d, LT 14 → promote', () => {
  eq(shouldPromoteForPrep({ daysUntilDeadline: 5, leadTimeDays: 14 }), true)
})
test('deadline 30d, LT 14 → no promote (have time)', () => {
  eq(shouldPromoteForPrep({ daysUntilDeadline: 30, leadTimeDays: 14 }), false)
})
test('deadline = LT (boundary) → promote', () => {
  eq(shouldPromoteForPrep({ daysUntilDeadline: 14, leadTimeDays: 14 }), true)
})
test('past deadline → still promote (already late)', () => {
  eq(shouldPromoteForPrep({ daysUntilDeadline: -3, leadTimeDays: 14 }), true)
})

// ─── bumpUrgencyOneTier ───
test('LOW → MEDIUM', () => eq(bumpUrgencyOneTier('LOW'), 'MEDIUM'))
test('MEDIUM → HIGH', () => eq(bumpUrgencyOneTier('MEDIUM'), 'HIGH'))
test('HIGH → CRITICAL', () => eq(bumpUrgencyOneTier('HIGH'), 'CRITICAL'))
test('CRITICAL stays CRITICAL (already maxed)', () => eq(bumpUrgencyOneTier('CRITICAL'), 'CRITICAL'))

// ─── findApplicableEvent ───
test('picks earliest-deadline event', () => {
  const today = new Date('2026-10-01T00:00:00Z')
  const events: RetailEventLite[] = [
    { ...baseEvent, id: 'bf', startDate: new Date('2026-11-29T00:00:00Z'), endDate: new Date('2026-12-01T00:00:00Z'), prepLeadTimeDays: 30 },
    { ...baseEvent, id: 'cm', name: 'Cyber Monday', startDate: new Date('2026-12-02T00:00:00Z'), endDate: new Date('2026-12-02T00:00:00Z'), prepLeadTimeDays: 30 },
  ]
  const r = findApplicableEvent({ events, productType: 'JACKET', velocity: 5, today })
  eq(r?.eventId, 'bf')
})
test('returns null when no events apply (all in past)', () => {
  const today = new Date('2027-01-01T00:00:00Z')
  const r = findApplicableEvent({ events: [baseEvent], productType: 'JACKET', velocity: 5, today })
  eq(r, null)
})
test('returns null when productType filter excludes everything', () => {
  const today = new Date('2026-10-01T00:00:00Z')
  const events: RetailEventLite[] = [{ ...baseEvent, productType: 'HELMET' }]
  const r = findApplicableEvent({ events, productType: 'JACKET', velocity: 5, today })
  eq(r, null)
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`event-prep.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
