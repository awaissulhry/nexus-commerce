/**
 * BUD.8 §2.3 (decisive) — the restore ENVELOPE, computed the engine's own way.
 *
 * The gate is not "does pacing fire today" — it does not, all four markets are under. The gate is
 * "would restoring these budgets MAKE it fire", because a restored ceiling lets a campaign spend
 * more, spend raises the projection, and the projection is the predicate.
 *
 *   projected = mtd + (mtd / daysElapsed) * remainingDays          (service:113)
 *   pacingNeeded = autoPacing && cap > 0 && projected > cap        (service:114)
 *
 * When it fires, `target = todayTarget * (campMtd / spendTotal)` — so a campaign with near-zero
 * MTD spend gets a near-zero target, clamped to FLOOR_CENTS. The campaigns a restore would lift are
 * precisely the ones with ten days of €1-constrained spend, i.e. the ones pacing would floor first.
 * Restoring them without headroom re-creates 2026-08-05 with the corrected engine.
 *
 * 🔴 MTD is computed the ENGINE's way — groupBy marketplace over ALL CAMPAIGN perf rows, which
 * includes paused and archived campaigns' spend. Scoping it to ENABLED campaigns (the obvious
 * reading) understates it and overstates the headroom.
 *
 * READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const now = new Date()
const y = now.getUTCFullYear(); const m = now.getUTCMonth() + 1
const month = `${y}-${String(m).padStart(2, '0')}`
const start = new Date(Date.UTC(y, m - 1, 1))
const end = new Date(Date.UTC(y, m, 1))
const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
const dayOfMonth = now.getUTCDate()
const remainingDays = Math.max(1, daysInMonth - dayOfMonth + 1)
const daysElapsed = Math.max(1, dayOfMonth)

// ── MTD exactly as the engine reads it ───────────────────────────────────────────────────────
const spendRows = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['marketplace'], where: { entityType: 'CAMPAIGN', date: { gte: start, lt: end } }, _sum: { costMicros: true },
})
const mtdByMkt = new Map(spendRows.map((r) => [r.marketplace, Math.round(Number(r._sum.costMicros ?? 0) / 10_000)]))
const plans = await prisma.adBudgetPlan.findMany({ where: { month, tag: null } })

// ── how much does a ceiling actually cost in spend? ──────────────────────────────────────────
// Measured on UNCONSTRAINED campaigns only — those above the €1 floor. A campaign pinned at €1
// cannot tell us its appetite, so including it would bias the ratio toward zero and make a restore
// look free.
const camps = await prisma.campaign.findMany({
  where: { status: 'ENABLED' }, select: { id: true, name: true, marketplace: true, dailyBudget: true },
})
const campSpend = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'], where: { entityType: 'CAMPAIGN', date: { gte: start, lt: end }, localEntityId: { not: null } }, _sum: { costMicros: true },
})
const mtdByCamp = new Map(campSpend.map((r) => [r.localEntityId as string, Math.round(Number(r._sum.costMicros ?? 0) / 10_000)]))

console.log(`\n══ BUD.8 §2.3 — the restore envelope (${month}, day ${dayOfMonth}/${daysInMonth}, ${remainingDays} remaining) ══\n`)

console.log(`── spend as a fraction of ceiling, UNCONSTRAINED campaigns only (>€1/day) ──`)
console.log(`  ${pad('market', 7)} ${pad('n', 4)} ${pad('ceiling/day', 12)} ${pad('spend/day', 11)} utilisation`)
const utilByMkt = new Map<string, number>()
for (const mkt of ['IT', 'DE', 'ES', 'FR']) {
  const g = camps.filter((c) => c.marketplace === mkt && Number(c.dailyBudget ?? 0) > 1)
  if (!g.length) { console.log(`  ${pad(mkt, 7)} none above the floor`); continue }
  const ceiling = g.reduce((s, c) => s + Math.round(Number(c.dailyBudget) * 100), 0)
  const spendPerDay = Math.round(g.reduce((s, c) => s + (mtdByCamp.get(c.id) ?? 0), 0) / daysElapsed)
  const util = ceiling > 0 ? spendPerDay / ceiling : 0
  utilByMkt.set(mkt, util)
  console.log(`  ${pad(mkt, 7)} ${pad(String(g.length), 4)} ${pad(eur(ceiling), 12)} ${pad(eur(spendPerDay), 11)} ${(util * 100).toFixed(1)}%`)
}

// ── the envelope ─────────────────────────────────────────────────────────────────────────────
console.log(`\n── how much extra SPEND each market can absorb before pacingNeeded flips ──`)
console.log(`  ${pad('market', 7)} ${pad('cap', 11)} ${pad('MTD', 10)} ${pad('projected', 11)} ${pad('headroom', 10)} ${pad('extra €/day', 12)} safe ceiling to restore`)
const safeByMkt = new Map<string, number>()
for (const p of plans) {
  const cap = p.monthlyBudgetCents ?? 0
  const mtd = mtdByMkt.get(p.marketplace) ?? 0
  const projected = cap > 0 ? Math.round(mtd + (mtd / daysElapsed) * remainingDays) : 0
  const headroom = cap - projected
  // Extra spend/day that keeps projection <= cap: the projection multiplies a daily rate by
  // (1 + remainingDays/daysElapsed), so an extra €x/day adds x * (daysElapsed + remainingDays).
  const perDay = Math.floor(headroom / (daysElapsed + remainingDays))
  const util = utilByMkt.get(p.marketplace) ?? 0.05
  const safeCeiling = util > 0 ? Math.floor(perDay / util) : 0
  safeByMkt.set(p.marketplace, safeCeiling)
  console.log(`  ${pad(p.marketplace, 7)} ${pad(eur(cap), 11)} ${pad(eur(mtd), 10)} ${pad(eur(projected), 11)} ${pad(eur(headroom), 10)} ${pad(eur(perDay), 12)} ${eur(safeCeiling)}/day`)
}

// ── what a full restore would actually ask for ───────────────────────────────────────────────
const atFloor = camps.filter((c) => Number(c.dailyBudget ?? 0) <= 1)
const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE', entityId: { in: atFloor.map((c) => c.id) } },
  select: { entityId: true, payloadBefore: true, payloadAfter: true, createdAt: true },
  orderBy: { createdAt: 'asc' },
})
const bud = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget ?? o?.budget; return typeof x === 'number' ? x : null }
console.log(`\n── the ask, against the envelope ──`)
console.log(`  ${pad('market', 7)} ${pad('at floor', 9)} ${pad('wanted/day', 12)} ${pad('safe/day', 11)} verdict`)
for (const mkt of ['IT', 'DE', 'ES', 'FR']) {
  const g = atFloor.filter((c) => c.marketplace === mkt)
  if (!g.length) continue
  let wanted = 0
  for (const c of g) {
    const mine = logs.filter((l) => l.entityId === c.id)
    const t = mine.find((l) => (bud(l.payloadBefore) ?? 0) > 1 && (bud(l.payloadAfter) ?? 99) <= 1)
    wanted += t ? Math.round((bud(t.payloadBefore) ?? 1) * 100) : 100
  }
  const safe = safeByMkt.get(mkt) ?? 0
  const pctOfAsk = wanted > 0 ? (safe / wanted) * 100 : 0
  console.log(`  ${pad(mkt, 7)} ${pad(String(g.length), 9)} ${pad(eur(wanted), 12)} ${pad(eur(safe), 11)} ${safe >= wanted ? '🟢 fits' : `🔴 only ${pctOfAsk.toFixed(0)}% of the ask fits`}`)
}

console.log(`\n  Reading: a restore larger than "safe/day" raises projected spend past the cap, which flips`)
console.log(`  pacingNeeded TRUE, which rewrites every budget in that market by SPEND SHARE — and a`)
console.log(`  just-restored campaign has ~10 days of €1-constrained spend, so its share is ~0 and it`)
console.log(`  is clamped straight back to FLOOR_CENTS. That is 2026-08-05 again, with the fixed engine.`)

await prisma.$disconnect()
