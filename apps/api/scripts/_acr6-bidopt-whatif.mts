/**
 * ACR.6 — what WOULD the bid optimiser propose if it read the daily table instead of
 * AdTarget's retired aggregates? READ-ONLY. Proposes nothing, writes nothing.
 *
 * previewBidOptimization currently filters `AdTarget.spendCents > 0`. That column's only writer,
 * ads-metrics-ingest, was deliberately retired in H.2e (2026-05-18), so the filter matches nothing
 * and four AUTO rules produce zero proposals. ad-autopilot.job.ts already made the corresponding
 * migration for its own signals — to AmazonAdsDailyPerformance — so this asks what the same move
 * would yield here, at AD_TARGET grain.
 *
 * Mirrors the service's real thresholds so the count is comparable, not indicative:
 *   MIN_CLICKS 5 · FLOOR 5c · MAX_DOWN 50% · MAX_UP 25% · target ACOS 30% (the flat default)
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const FLOOR_CENTS = 5, MAX_DOWN = 0.5, MAX_UP = 0.25, MIN_CLICKS = 5, TARGET_ACOS = 0.3
const since = new Date(); since.setUTCDate(since.getUTCDate() - 30)

const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'],
  where: { entityType: 'AD_TARGET', date: { gte: since }, localEntityId: { not: null } },
  _sum: { costMicros: true, clicks: true, sales7dCents: true, orders7d: true },
})
console.log(`\nAD_TARGET perf rows rolled up: ${perf.length} distinct targets, last 30d`)

const ids = perf.map((p) => p.localEntityId!).filter(Boolean)
const targets = await prisma.adTarget.findMany({
  where: { id: { in: ids }, status: 'ENABLED', isNegative: false },
  select: { id: true, expressionValue: true, bidCents: true },
})
const byId = new Map(targets.map((t) => [t.id, t]))
console.log(`  of those, ENABLED + non-negative AdTargets: ${targets.length}`)

let eligible = 0, cuts = 0, raises = 0, zeroSale = 0
let totalDelta = 0
// THE HAZARD: this account suppresses delivery with ~2c bids rather than pausing
// (feedback_no_pause_use_low_bids). FLOOR_CENTS is 5, so "cut 50%, floor at 5c" RAISES any
// suppressed bid — the optimiser would quietly un-suppress what an operator deliberately silenced.
const SUPPRESS_AT = 5
let unsuppress = 0, unsuppressSpend = 0
const samples: string[] = []
for (const p of perf) {
  const t = byId.get(p.localEntityId!)
  if (!t) continue
  const clicks = p._sum.clicks ?? 0
  if (clicks < MIN_CLICKS) continue
  const spendCents = Math.round(Number(p._sum.costMicros ?? 0n) / 10_000) // micros → cents
  if (spendCents <= 0) continue
  eligible++
  const salesCents = p._sum.sales7dCents ?? 0
  const acos = salesCents > 0 ? spendCents / salesCents : null

  let proposed: number
  let reason: string
  if (acos == null) { proposed = Math.max(FLOOR_CENTS, Math.round(t.bidCents * (1 - MAX_DOWN))); reason = 'zero sales'; zeroSale++ }
  else if (acos > TARGET_ACOS) { const f = Math.max(1 - MAX_DOWN, TARGET_ACOS / acos); proposed = Math.max(FLOOR_CENTS, Math.round(t.bidCents * f)); reason = `acos ${(acos * 100).toFixed(0)}% > target`; cuts++ }
  else { const f = Math.min(1 + MAX_UP, TARGET_ACOS / acos); proposed = Math.round(t.bidCents * f); reason = `acos ${(acos * 100).toFixed(0)}% < target`; raises++ }

  if (proposed === t.bidCents) { eligible--; if (reason.includes('zero')) zeroSale--; else if (cuts) cuts--; continue }
  totalDelta += proposed - t.bidCents
  if (t.bidCents < SUPPRESS_AT && proposed > t.bidCents) { unsuppress++; unsuppressSpend += spendCents }
  if (samples.length < 8) samples.push(`  ${String(t.expressionValue).slice(0, 30).padEnd(32)} ${t.bidCents}c → ${proposed}c  (${reason}, ${clicks} clicks, spend ${spendCents}c)`)
}

console.log(`\nWOULD PROPOSE: ${eligible} bid changes`)
console.log(`  cuts (ACOS above target) .. ${cuts}`)
console.log(`  raises (ACOS below target)  ${raises}`)
console.log(`  hard cuts (zero sales) .... ${zeroSale}`)
console.log(`  net bid delta ............. ${totalDelta >= 0 ? '+' : ''}${totalDelta}c across all proposals`)
console.log('\nsample:')
for (const s of samples) console.log(s)
console.log(`\n🔴 OF THOSE, ${unsuppress} RAISE a bid currently below ${SUPPRESS_AT}c — i.e. below the floor.`)
console.log(`   Those targets are suppressed on purpose (no-pause policy: silence via ~2c bids).`)
console.log(`   The engine's own FLOOR_CENTS=${FLOOR_CENTS} makes a "hard cut" into a RAISE for them.`)
console.log(`   They carry ${unsuppressSpend}c of 30d spend that would resume.`)
console.log('\n(today the same engine proposes 0, because AdTarget.spendCents is 0 for every row)')

await prisma.$disconnect()
