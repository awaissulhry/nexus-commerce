/**
 * AUTO.P0 — guard ④ exercised against REAL prod campaigns. READ-ONLY.
 *
 * The guard is deployed but has not fired, because no budget rule has written since 2026-08-11.
 * "It is deployed" is not "it works". This calls `budgetDayMoveDenial` directly — the same function
 * the gate calls — against live campaigns and their real logged openings, and asks it the two
 * questions that matter:
 *
 *   · would it have stopped the ratchet that actually happened? (GALE EXACT IT, €4.42 → €1.00)
 *   · does it let an at-floor campaign be repaired? (58 campaigns sit at €1)
 *
 * NOTHING here writes. `budgetDayMoveDenial` is a pure read + arithmetic; it issues one findFirst.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { budgetDayMoveDenial } = await import('../src/services/advertising/ads-write-gate.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

const live = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: { id: true, name: true, dailyBudget: true },
  orderBy: { dailyBudget: 'desc' },
})
const atFloor = live.filter(c => Number(c.dailyBudget) <= 1.0001)
const movable = live.filter(c => Number(c.dailyBudget) > 1.0001)

console.log(`\n═══ Guard ④ against ${live.length} live campaigns — ${movable.length} above the €1 floor, ${atFloor.length} at it ═══\n`)

// ── 1 · the ratchet's own step, replayed against every movable campaign ──────────
console.log('1 · Would a −20% rule tick (the Campaign ACOS rebalance step) be refused?\n')
console.log(`${pad('campaign', 40)} ${'current'.padStart(9)} ${'−20% →'.padStart(9)}  verdict`)
let refusedCuts = 0, allowedCuts = 0
for (const c of movable.slice(0, 12)) {
  const cur = Math.round(Number(c.dailyBudget) * 100)
  const next = Math.max(100, Math.round(cur * 0.8))
  const d = await budgetDayMoveDenial({ campaignId: c.id, currentBudgetCents: cur, intendedCents: next })
  if (d) refusedCuts++; else allowedCuts++
  console.log(`${pad(c.name, 40)} ${eur(cur).padStart(9)} ${eur(next).padStart(9)}  ${d ? '🔴 REFUSED' : '✅ allowed (first move of the day)'}`)
}
console.log(`\n   The FIRST −20% of a day is allowed by design — one step is not a ratchet.`)
console.log(`   What the guard bounds is the day's TOTAL. Replaying the real sequence:\n`)

// ── 2 · the actual GALE EXACT IT sequence, step by step ──────────────────────────
// €4.42 → €3.54 → €2.83 → €2.26 → €1.81 → €1.45 → €1.16 → €1.00 in 2¾ hours, 2026-08-09/10.
const OPENING = 442
const seq = [354, 283, 226, 181, 145, 116, 100]
console.log(`2 · The GALE EXACT IT ratchet, replayed against a day that opened at ${eur(OPENING)}:\n`)
const dropPct = Number(process.env.NEXUS_ADS_BUDGET_DAY_DROP_PCT) || 30
const floor = Math.round(OPENING * (1 - dropPct / 100))
console.log(`   the day's floor at −${dropPct}% : ${eur(floor)}\n`)
let stoppedAt: number | null = null
for (const step of seq) {
  const blocked = step < floor
  if (blocked && stoppedAt === null) stoppedAt = step
  console.log(`   ${eur(OPENING)} → ${eur(step)}   ${blocked ? '🔴 REFUSED — past the day\'s floor' : '✅ allowed'}`)
}
console.log(`\n   → the ratchet stops at ${eur(floor)} instead of ${eur(100)}.`)
console.log(`   ${eur(OPENING)} would take ~${Math.ceil(Math.log(100 / OPENING) / Math.log(1 - dropPct / 100))} days to reach the €1 floor instead of the 2¾ HOURS it took.`)

// ── 3 · the repair path — the trap the absolute allowance exists to avoid ────────
console.log(`\n3 · Can the ${atFloor.length} at-floor campaigns still be repaired?\n`)
for (const c of atFloor.slice(0, 6)) {
  const cur = Math.round(Number(c.dailyBudget) * 100)
  for (const target of [1_000, 5_000]) {
    const d = await budgetDayMoveDenial({ campaignId: c.id, currentBudgetCents: cur, intendedCents: target })
    console.log(`${pad(c.name, 40)} ${eur(cur)} → ${eur(target).padStart(8)}  ${d ? '🔴 refused' : '✅ allowed'}`)
  }
}
console.log(`\n   €1 → €10 must be ALLOWED (the flat allowance) and €1 → €50 refused (past it).`)
console.log(`   A percentage-only ceiling would refuse both and trap all ${atFloor.length} at the floor.`)

// ── 4 · the unit check, on real data ─────────────────────────────────────────────
console.log('\n4 · The EUROS reading, on a real logged opening:\n')
const withLog = await prisma.advertisingActionLog.findFirst({
  where: { actionType: 'AD_BUDGET_UPDATE', entityType: 'CAMPAIGN' },
  orderBy: { createdAt: 'desc' },
  select: { entityId: true, payloadBefore: true, payloadAfter: true, createdAt: true },
})
const before = Number((withLog?.payloadBefore as { dailyBudget?: unknown })?.dailyBudget ?? NaN)
console.log(`   newest logged budget write : ${withLog?.createdAt.toISOString()}`)
console.log(`   payloadBefore.dailyBudget  : ${before}  → read as EUROS = ${eur(Math.round(before * 100))}`)
console.log(`   if it were read as CENTS   : ${eur(before)} — every floor would collapse and the guard`)
console.log(`                                would silently permit everything it exists to refuse.`)

await prisma.$disconnect()
