/**
 * BSP-B5 wire check: take the EXACT payload the "Stand down in the dead hours" starter produced in
 * the browser and run the REAL executor functions on it. A starter that fills a form the engine
 * ignores is the defect this whole programme exists to remove, so this proves the round trip
 * rather than trusting that the shapes look right.
 */
import { activeWindow, computeBudget } from '../src/jobs/ad-budget-schedule.job.js'

// verbatim from the intercepted POST body
const windows = [1,2,3,4,5,6,0].map((day) => ({ day, start: '05:00', end: '08:00', adj: 'decPct', value: 30 }))
const TZ = 'Europe/Rome'
const at = (iso: string) => new Date(iso)

console.log('§ Does the engine see the starter\'s window as ACTIVE inside it?')
for (const [label, utc] of [['06:30 Rome Sat', '2026-08-22T04:30:00Z'], ['07:59 Rome Sat', '2026-08-22T05:59:00Z']] as const) {
  const a = activeWindow(windows, TZ, at(utc))
  console.log(`  ${label}: ${a ? `ACTIVE (adj=${a.win.adj} value=${a.win.value}, entry ${a.entryDate})` : 'inactive 🔴'}`)
}
console.log('§ …and INACTIVE outside it?')
for (const [label, utc] of [['04:30 Rome Sat', '2026-08-22T02:30:00Z'], ['08:00 Rome Sat (end exclusive)', '2026-08-22T06:00:00Z'], ['20:00 Rome Sat', '2026-08-22T18:00:00Z']] as const) {
  const a = activeWindow(windows, TZ, at(utc))
  console.log(`  ${label}: ${a ? '🔴 ACTIVE (should not be)' : 'inactive ✓'}`)
}
console.log('§ What budget would it compute, on real campaign budgets?')
for (const base of [1.00, 2.49, 6.17, 80.00]) {
  const t = computeBudget(base, 'campaign-budget', 'decPct', 30)
  console.log(`  base €${base.toFixed(2)} → €${t.toFixed(2)}${t === base ? '   (no-op: already at the €1 floor)' : `   (−${Math.round((1 - t / base) * 100)}%)`}`)
}
console.log('§ And the multiplier starter (all-day, no hours)?')
const mult = [0, 6].map((day) => ({ day, start: '', end: '', adj: 'mult', value: 1.5 }))
const sat = activeWindow(mult, TZ, at('2026-08-22T10:00:00Z'))
const wed = activeWindow(mult, TZ, at('2026-08-19T10:00:00Z'))
console.log(`  Saturday: ${sat ? `ACTIVE all-day (entry ${sat.entryDate})` : '🔴 inactive'}`)
console.log(`  Wednesday: ${wed ? '🔴 ACTIVE (should not be)' : 'inactive ✓'}`)
console.log(`  €6.17 × 1.5 = €${computeBudget(6.17, 'budget-multiplier', 'mult', 1.5).toFixed(2)}`)
