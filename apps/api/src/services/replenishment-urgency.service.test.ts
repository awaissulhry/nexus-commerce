/**
 * R.14 — Pure-function tests for channel urgency promotion.
 */

import {
  computeChannelUrgency,
  findWorstChannel,
  promoteUrgency,
} from './replenishment-urgency.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

// ─── computeChannelUrgency ───
test('days <= LT/2 → CRITICAL', () => {
  eq(computeChannelUrgency(7, 14), 'CRITICAL')
  eq(computeChannelUrgency(0, 14), 'CRITICAL')
})
test('days <= LT → HIGH', () => {
  eq(computeChannelUrgency(10, 14), 'HIGH')
  eq(computeChannelUrgency(14, 14), 'HIGH')
})
test('days <= LT*2 → MEDIUM', () => {
  eq(computeChannelUrgency(20, 14), 'MEDIUM')
  eq(computeChannelUrgency(28, 14), 'MEDIUM')
})
test('days > LT*2 → LOW', () => {
  eq(computeChannelUrgency(30, 14), 'LOW')
  eq(computeChannelUrgency(200, 14), 'LOW')
})
test('null daysOfCover → null (no signal)', () => {
  eq(computeChannelUrgency(null, 14), null)
})
test('zero leadTime → null (degenerate, no buffer)', () => {
  eq(computeChannelUrgency(5, 0), null)
})

// ─── findWorstChannel ───
test('multiple channels — picks lowest-rank urgency', () => {
  const r = findWorstChannel(
    [
      { channel: 'AMAZON', marketplace: 'IT', daysOfCover: 200 },  // LOW
      { channel: 'AMAZON', marketplace: 'DE', daysOfCover: 3 },    // CRITICAL
      { channel: 'EBAY',   marketplace: 'IT', daysOfCover: 20 },   // MEDIUM
    ],
    14,
  )
  eq(r, { channel: 'AMAZON', marketplace: 'DE', daysOfCover: 3, urgency: 'CRITICAL' })
})
test('all channels with null daysOfCover → null', () => {
  const r = findWorstChannel(
    [
      { channel: 'AMAZON', marketplace: 'IT', daysOfCover: null },
      { channel: 'EBAY',   marketplace: 'IT', daysOfCover: null },
    ],
    14,
  )
  eq(r, null)
})
test('mix of null + real channels — null channels skipped', () => {
  const r = findWorstChannel(
    [
      { channel: 'AMAZON', marketplace: 'IT', daysOfCover: null },
      { channel: 'EBAY',   marketplace: 'IT', daysOfCover: 5 },
    ],
    14,
  )
  eq(r?.channel, 'EBAY')
  eq(r?.urgency, 'CRITICAL')
})
test('empty channels array → null', () => {
  eq(findWorstChannel([], 14), null)
})

// ─── promoteUrgency ───
test('all channels LOW + global CRITICAL → CRITICAL from GLOBAL', () => {
  const r = promoteUrgency({
    globalUrgency: 'CRITICAL',
    channels: [{ channel: 'AMAZON', marketplace: 'IT', daysOfCover: 200 }],
    leadTimeDays: 14,
  })
  eq(r.urgency, 'CRITICAL')
  eq(r.source, 'GLOBAL')
  // worstChannel populated for context even when global wins
  eq(r.worstChannel?.urgency, 'LOW')
})
test('one channel CRITICAL + global LOW → CRITICAL from CHANNEL', () => {
  const r = promoteUrgency({
    globalUrgency: 'LOW',
    channels: [
      { channel: 'AMAZON', marketplace: 'IT', daysOfCover: 200 },
      { channel: 'AMAZON', marketplace: 'DE', daysOfCover: 3 },
    ],
    leadTimeDays: 14,
  })
  eq(r.urgency, 'CRITICAL')
  eq(r.source, 'CHANNEL')
  eq(r.worstChannel?.marketplace, 'DE')
})
test('all channels HIGH + global MEDIUM → HIGH from CHANNEL', () => {
  const r = promoteUrgency({
    globalUrgency: 'MEDIUM',
    channels: [{ channel: 'AMAZON', marketplace: 'IT', daysOfCover: 12 }],
    leadTimeDays: 14,
  })
  eq(r.urgency, 'HIGH')
  eq(r.source, 'CHANNEL')
})
test('global = channel urgency → tie goes to GLOBAL', () => {
  const r = promoteUrgency({
    globalUrgency: 'HIGH',
    channels: [{ channel: 'AMAZON', marketplace: 'IT', daysOfCover: 12 }], // HIGH
    leadTimeDays: 14,
  })
  eq(r.urgency, 'HIGH')
  eq(r.source, 'GLOBAL')
})
test('no channels with sales + global MEDIUM → MEDIUM from GLOBAL, no worstChannel', () => {
  const r = promoteUrgency({
    globalUrgency: 'MEDIUM',
    channels: [
      { channel: 'AMAZON', marketplace: 'IT', daysOfCover: null },
      { channel: 'EBAY',   marketplace: 'IT', daysOfCover: null },
    ],
    leadTimeDays: 14,
  })
  eq(r.urgency, 'MEDIUM')
  eq(r.source, 'GLOBAL')
  eq(r.worstChannel, null)
})
test('strict tightening — never lowers global urgency', () => {
  // Even when global is CRITICAL and all channels look fine, urgency stays CRITICAL.
  const r = promoteUrgency({
    globalUrgency: 'CRITICAL',
    channels: [{ channel: 'AMAZON', marketplace: 'IT', daysOfCover: 1000 }],
    leadTimeDays: 14,
  })
  eq(r.urgency, 'CRITICAL')
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`replenishment-urgency.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
