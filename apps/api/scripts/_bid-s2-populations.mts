/**
 * BID.S2 — the chip populations, each against a NAMED denominator and stamped with the hour.
 *
 * READ-ONLY. This is the table that goes in the doc. It runs the SAME resolver logic the page runs,
 * so a number here and a number on screen cannot drift.
 *
 * 🔴 Read the hour before reading the numbers. The rank engine floors ~900 bids at 00:00 Rome and
 * restores them at 08:00, so `suppressed`, `min-bid-window`, `at-floor` and `unrecorded` are all
 * clock readings. Two runs at different hours disagreeing is the system working, not a bug.
 */
import '../src/env.js'
const { getBidGrid, BID_MARKET_ALL } = await import('../src/services/advertising/bid-grid.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const now = new Date()
const rome = now.toLocaleString('en-GB', { timeZone: 'Europe/Rome', dateStyle: 'medium', timeStyle: 'short' })

// The resolver, transcribed from `bid/bidState.ts`. Kept in step by the vitest suite over there and
// by this script's own precedence assertion below.
type Key = 'out-of-band' | 'unrecorded' | 'suppressed' | 'min-bid-window' | 'at-floor' | 'no-bidder' | 'not-in-auction' | 'unnamed' | 'no-data'
interface R {
  bidCents: number; status: string; campaignStatus: string
  minBidCents: number | null; maxBidCents: number | null
  suppressedFromBidCents: number | null; inMinBidWindow: boolean
  lastAuditedCents: number | null; unrecorded: boolean
  bidder: string; derived: boolean; measured: boolean
}
function states(t: R): Key[] {
  const out: Key[] = []
  if (t.maxBidCents != null && t.bidCents > t.maxBidCents) out.push('out-of-band')
  else if (t.minBidCents != null && t.bidCents < t.minBidCents) out.push('out-of-band')
  if (t.unrecorded && t.lastAuditedCents != null) out.push('unrecorded')
  if (t.suppressedFromBidCents != null) out.push('suppressed')
  else if (t.inMinBidWindow) out.push('min-bid-window')
  else if (t.bidCents <= 2) out.push('at-floor')
  if (t.bidder === 'none') out.push('no-bidder')
  if (t.status === 'ENABLED' && t.campaignStatus !== 'ENABLED') out.push('not-in-auction')
  if (t.derived) out.push('unnamed')
  if (!t.measured) out.push('no-data')
  return out
}

const base = {
  market: BID_MARKET_ALL, line: null, portfolio: null, campaign: null,
  view: 'targets' as const, kind: [], match: [], band: null, measured: 'all' as const,
  q: null, windowDays: 30, sort: null, dir: 'desc' as const, limit: 5000,
}

console.log(`\n═══ BID.S2 — chip populations · ${rome} Rome ═══`)
console.log('🔴 CLOCK READING. Floor 00:00 Rome, restore 08:00. suppressed / min-bid-window /')
console.log('   at-floor / unrecorded all move with that cycle.\n')

const enabled = await getBidGrid({ ...base, status: 'enabled' })
const A = enabled.rows as unknown as R[]
const B = A.filter((r) => r.campaignStatus === 'ENABLED')
const all = await getBidGrid({ ...base, status: 'all' })
const T = all.rows as unknown as R[]

console.log('Denominators')
console.log(`  T · all positive targets, any status      ${int(T.length)}`)
console.log(`  A · ENABLED positive targets              ${int(A.length)}`)
console.log(`  B · A, inside an ENABLED campaign         ${int(B.length)}   ← "in auction"`)
console.log(`      A and B differ by ${(A.length / Math.max(1, B.length)).toFixed(1)}×. Every count below names which one it uses.\n`)

const KEYS: Key[] = ['out-of-band', 'unrecorded', 'suppressed', 'min-bid-window', 'at-floor', 'no-bidder', 'not-in-auction', 'unnamed', 'no-data']
console.log('chip                     of A (2,944)   of B (in auction)   share of A')
for (const k of KEYS) {
  const a = A.filter((r) => states(r).includes(k)).length
  const b = B.filter((r) => states(r).includes(k)).length
  console.log(`  ${k.padEnd(22)} ${String(int(a)).padStart(8)} ${String(int(b)).padStart(18)}   ${((a / A.length) * 100).toFixed(1)}%`)
}

// how many rows carry MORE than the two the cell shows
const overflow = A.filter((r) => states(r).length > 2).length
const none = A.filter((r) => states(r).length === 0).length
console.log(`\n  rows with NO chip at all        ${int(none)} (${((none / A.length) * 100).toFixed(1)}%)`)
console.log(`  rows with more than 2 chips     ${int(overflow)} (${((overflow / A.length) * 100).toFixed(1)}%) — the cell caps at 2, the FILTER sees all`)

// bidder, at campaign grain
console.log('\nBidder, per campaign')
const camps = new Map<string, { bidder: string; status: string }>()
for (const r of T as unknown as Array<R & { campaignId: string; campaignStatus: string }>) {
  camps.set(r.campaignId, { bidder: r.bidder, status: r.campaignStatus })
}
for (const [label, filt] of [['all campaigns holding a target', () => true], ['ENABLED campaigns', (c: { status: string }) => c.status === 'ENABLED']] as const) {
  const tally: Record<string, number> = { schedule: 0, goal: 0, manual: 0, none: 0 }
  for (const c of camps.values()) if (filt(c)) tally[c.bidder]++
  console.log(`  ${label.padEnd(32)} schedule ${tally.schedule} · goal ${tally.goal} · manual ${tally.manual} · none ${tally.none}`)
}

// sparkline vs metrics — the two sets that must not imply each other
console.log('\nSparkline coverage vs metric coverage (denominator A)')
const withCurve = new Set(Object.keys(enabled.series))
const rowsA = enabled.rows as Array<{ id: string; measured: boolean }>
const both = rowsA.filter((r) => withCurve.has(r.id) && r.measured).length
const curveOnly = rowsA.filter((r) => withCurve.has(r.id) && !r.measured).length
const metricsOnly = rowsA.filter((r) => !withCurve.has(r.id) && r.measured).length
const neither = rowsA.filter((r) => !withCurve.has(r.id) && !r.measured).length
console.log(`  both ${int(both)} · curve only ${int(curveOnly)} · metrics only ${int(metricsOnly)} · neither ${int(neither)}`)
console.log(`  a curve means "someone wrote a bid"; metrics mean "Amazon served it". Different questions.`)

// out-of-band, itemised — the money question
console.log('\nOut of band, itemised (denominator A)')
const oob = (A as unknown as Array<R & { label: string; campaignName: string }>)
  .filter((r) => r.maxBidCents != null && r.bidCents > r.maxBidCents)
  .sort((a, b) => (b.bidCents - (b.maxBidCents ?? 0)) - (a.bidCents - (a.maxBidCents ?? 0)))
console.log(`  ${int(oob.length)} bids sit above their campaign's ceiling. Top 5 by overshoot:`)
for (const r of oob.slice(0, 5)) {
  console.log(`    ${(r.label || '(unnamed)').slice(0, 30).padEnd(30)} €${(r.bidCents / 100).toFixed(2)} vs ceiling €${((r.maxBidCents ?? 0) / 100).toFixed(2)}  ${r.campaignName.slice(0, 26)}`)
}

console.log('')
await prisma.$disconnect()
