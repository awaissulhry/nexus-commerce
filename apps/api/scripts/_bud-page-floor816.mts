/**
 * BUD.8 §3.1 — derive a per-market floor from evidence, and test it against 60 days of real writes.
 *
 * The brief's definition: the smallest daily budget at which a campaign in that market has
 * historically delivered a click. Two things make that measurable here:
 *
 *   · a campaign's CURRENT dailyBudget, and whether it has produced a click in the window;
 *   · the 60-day AD_BUDGET_UPDATE log, which records the value every write ASKED for — so a
 *     proposed floor can be replayed against real intent rather than argued about.
 *
 * "A floor that would have refused nothing is not a floor." The replay is the test.
 *
 * 🔴 A floor only ever DENIES a write below it (ads-write-gate.ts, BUD.2). It never raises a budget.
 * So setting one costs nothing in spend and cannot breach a monthly cap — which is why it is
 * separable from the restore question that §2.3 blocks.
 *
 * READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const MKTS = ['IT', 'DE', 'ES', 'FR']
const since60 = new Date(Date.now() - 60 * 86_400_000)

const camps = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: { id: true, name: true, marketplace: true, dailyBudget: true, minBudgetCents: true },
})
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'],
  where: { entityType: 'CAMPAIGN', date: { gte: since60 }, localEntityId: { not: null } },
  _sum: { clicks: true, costMicros: true },
})
const byCamp = new Map(perf.map((p) => [p.localEntityId as string, { clicks: p._sum.clicks ?? 0, cost: Math.round(Number(p._sum.costMicros ?? 0) / 10_000) }]))

console.log(`\n══ BUD.8 §3.1 — an evidence-derived floor per market ══\n`)
console.log(`── the smallest budget that has delivered a click, per market (60 days) ──`)
console.log(`  ${pad('mkt', 5)} ${pad('enabled', 8)} ${pad('w/ a click', 11)} ${pad('min budget', 11)} ${pad('p25', 9)} ${pad('median', 9)} the campaign at the minimum`)
const proposal = new Map<string, number>()
for (const mkt of MKTS) {
  const g = camps.filter((c) => c.marketplace === mkt)
  const clicked = g.filter((c) => (byCamp.get(c.id)?.clicks ?? 0) > 0)
  if (!clicked.length) { console.log(`  ${pad(mkt, 5)} ${pad(String(g.length), 8)} none — no evidence, no floor proposed`); continue }
  const budgets = clicked.map((c) => Math.round(Number(c.dailyBudget) * 100)).sort((a, b) => a - b)
  const min = budgets[0]
  const p25 = budgets[Math.floor(budgets.length * 0.25)]
  const med = budgets[Math.floor(budgets.length * 0.5)]
  const at = clicked.find((c) => Math.round(Number(c.dailyBudget) * 100) === min)!
  const atClicks = byCamp.get(at.id)?.clicks ?? 0
  console.log(`  ${pad(mkt, 5)} ${pad(String(g.length), 8)} ${pad(String(clicked.length), 11)} ${pad(eur(min), 11)} ${pad(eur(p25), 9)} ${pad(eur(med), 9)} ${at.name.slice(0, 30)} (${atClicks} clicks)`)
  proposal.set(mkt, min)
}

// 🔴 The minimum observed is contaminated: 58 campaigns were forced to €1 by the pacer and some of
// them clicked BEFORE being floored. A floor derived from a post-damage value would enshrine the
// damage — exactly the reason BUD.2 refuses to capture an at-floor baseline. So derive it again
// from campaigns that were never floored.
console.log(`\n── the same, EXCLUDING campaigns the pacer floored (the contamination check) ──`)
const atFloorIds = new Set(camps.filter((c) => Number(c.dailyBudget ?? 0) <= 1).map((c) => c.id))
console.log(`  ${pad('mkt', 5)} ${pad('clean n', 8)} ${pad('min budget', 11)} ${pad('p25', 9)} the campaign at the minimum`)
const clean = new Map<string, number>()
for (const mkt of MKTS) {
  const g = camps.filter((c) => c.marketplace === mkt && !atFloorIds.has(c.id) && (byCamp.get(c.id)?.clicks ?? 0) > 0)
  if (!g.length) { console.log(`  ${pad(mkt, 5)} none`); continue }
  const budgets = g.map((c) => Math.round(Number(c.dailyBudget) * 100)).sort((a, b) => a - b)
  const at = g.find((c) => Math.round(Number(c.dailyBudget) * 100) === budgets[0])!
  console.log(`  ${pad(mkt, 5)} ${pad(String(g.length), 8)} ${pad(eur(budgets[0]), 11)} ${pad(eur(budgets[Math.floor(budgets.length * 0.25)]), 9)} ${at.name.slice(0, 30)} (${byCamp.get(at.id)?.clicks} clicks, ${eur(byCamp.get(at.id)?.cost ?? 0)} spend)`)
  clean.set(mkt, budgets[0])
}

// ── replay: what would each candidate floor have refused, over 60 days of real writes? ───────
const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: since60 } },
  select: { entityId: true, payloadAfter: true, payloadBefore: true, userId: true, createdAt: true },
})
const mktOf = new Map(camps.map((c) => [c.id, c.marketplace ?? '—']))
const bud = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget ?? o?.budget; return typeof x === 'number' ? Math.round(x * 100) : null }

console.log(`\n── replay: writes the floor would have DENIED, 60 days (${logs.length} rows) ──`)
console.log(`  ${pad('floor', 8)} ${pad('IT', 12)} ${pad('DE', 12)} ${pad('ES', 12)} ${pad('FR', 12)} total`)
for (const cand of [100, 200, 300, 500, 1000]) {
  const per = MKTS.map((mkt) => logs.filter((l) => mktOf.get(l.entityId) === mkt && (bud(l.payloadAfter) ?? 1e9) < cand).length)
  console.log(`  ${pad(eur(cand), 8)} ${per.map((n) => pad(String(n), 12)).join('')}${per.reduce((a, b) => a + b, 0)}`)
}

console.log(`\n── per-market proposal, replayed at its own value ──`)
console.log(`  ${pad('mkt', 5)} ${pad('proposed', 10)} ${pad('writes denied', 14)} ${pad('campaigns hit', 14)} of which the 08-05 sweep`)
for (const mkt of MKTS) {
  const f = clean.get(mkt)
  if (f == null) { console.log(`  ${pad(mkt, 5)} no evidence`); continue }
  const denied = logs.filter((l) => mktOf.get(l.entityId) === mkt && (bud(l.payloadAfter) ?? 1e9) < f)
  const sweep = denied.filter((l) => l.createdAt >= new Date('2026-08-05T02:00:00Z') && l.createdAt < new Date('2026-08-05T03:00:00Z'))
  console.log(`  ${pad(mkt, 5)} ${pad(eur(f), 10)} ${pad(String(denied.length), 14)} ${pad(String(new Set(denied.map((l) => l.entityId)).size), 14)} ${sweep.length}`)
}

// ── who currently sits BELOW each proposed floor ─────────────────────────────────────────────
console.log(`\n── campaigns already below their market's proposed floor (they sit under it, unraised) ──`)
for (const mkt of MKTS) {
  const f = clean.get(mkt)
  if (f == null) continue
  const below = camps.filter((c) => c.marketplace === mkt && Math.round(Number(c.dailyBudget) * 100) < f)
  console.log(`  ${pad(mkt, 5)} floor ${pad(eur(f), 9)} → ${String(below.length).padStart(3)} of ${String(camps.filter((c) => c.marketplace === mkt).length).padStart(3)} enabled sit below it`)
}
console.log(`\n  🔴 A floor DENIES a write below it; it does not raise anything. A campaign already at €1`)
console.log(`  stays at €1 — the floor stops the NEXT cut, it does not undo the last one. Restoring is`)
console.log(`  a separate act, and §2.3 blocks it.`)

console.log(`\n── currently set ──`)
console.log(`  campaigns with minBudgetCents set: ${camps.filter((c) => c.minBudgetCents != null).length} of ${camps.length}`)

await prisma.$disconnect()
