/**
 * AR page study 2 — READ-ONLY. The numbers a ROW could honestly carry.
 * Budget by status, market split behind the Automations reach, target-grain writes rolled
 * up per campaign, and whether the stored metric columns are a hidden 30-day window.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int = (n: number) => n.toLocaleString('en-IE')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

const camps = await prisma.campaign.findMany({
  select: {
    id: true, name: true, marketplace: true, status: true, dailyBudget: true, spend: true,
    sales: true, externalCampaignId: true, dynamicBidding: true, liveBidWritesEnabled: true,
    portfolioId: true, deliveryStatus: true,
  },
})
type C = (typeof camps)[number]
const num = (v: unknown) => Number(v ?? 0)
const db = (c: C) => (c.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement?: string; percentage?: number }> }

// ── budget by status ─────────────────────────────────────────────────────────
console.log('\n── budget, by status ──')
for (const st of ['ENABLED', 'PAUSED', 'ARCHIVED']) {
  const g = camps.filter((c) => c.status === st)
  if (!g.length) continue
  const sum = g.reduce((a, c) => a + num(c.dailyBudget), 0)
  const atFloor = g.filter((c) => num(c.dailyBudget) <= 1).length
  console.log(`   ${pad(st, 9)} ${String(g.length).padStart(3)} campaigns · €${sum.toFixed(2)}/day · ${atFloor} at ≤€1 · median €${[...g].map((c) => num(c.dailyBudget)).sort((a, b) => a - b)[Math.floor(g.length / 2)].toFixed(2)}`)
}

// ── market split (why the Automations column has TWO values, not one) ────────
console.log('\n── campaigns by marketplace ──')
const byMkt = new Map<string, number>()
for (const c of camps) byMkt.set(c.marketplace ?? '—', (byMkt.get(c.marketplace ?? '—') ?? 0) + 1)
console.log(`   ${[...byMkt].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`)

// ── placement lanes: how many, and how many are non-zero ────────────────────
console.log('\n── placement lanes ──')
const withArr = camps.filter((c) => (db(c).placementBidding ?? []).length > 0)
const withNonZero = camps.filter((c) => (db(c).placementBidding ?? []).some((p) => Number(p.percentage ?? 0) !== 0))
console.log(`   placementBidding array present : ${int(withArr.length)}`)
console.log(`   at least one NON-ZERO lane     : ${int(withNonZero.length)}`)
const laneCounts = new Map<number, number>()
for (const c of withArr) laneCounts.set((db(c).placementBidding ?? []).length, (laneCounts.get((db(c).placementBidding ?? []).length) ?? 0) + 1)
console.log(`   lanes per campaign: ${[...laneCounts].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}→${v}`).join(' · ')}`)

// ── stored metric columns vs a real window: is `spend` a hidden 30d figure? ──
console.log('\n── is Campaign.spend a hidden window? (stored vs windowed, per campaign) ──')
const ids = camps.map((c) => c.id)
const m2c = (v: bigint | number | null | undefined) => Math.round(Number(v ?? 0) / 10000)
const windowed = async (days: number) => {
  const g = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'],
    where: { entityType: 'CAMPAIGN', localEntityId: { in: ids }, date: { gte: new Date(Date.now() - days * 86_400_000) } },
    _sum: { costMicros: true },
  })
  return new Map(g.map((r) => [r.localEntityId!, m2c(r._sum.costMicros) / 100]))
}
const w7 = await windowed(7), w30 = await windowed(30), w60 = await windowed(60)
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.02, b * 0.02)
const spenders = camps.filter((c) => num(c.spend) > 0)
console.log(`   campaigns with stored spend>0: ${spenders.length}`)
console.log(`   stored spend matches 7d on ${spenders.filter((c) => close(num(c.spend), w7.get(c.id) ?? 0)).length} · 30d on ${spenders.filter((c) => close(num(c.spend), w30.get(c.id) ?? 0)).length} · 60d on ${spenders.filter((c) => close(num(c.spend), w60.get(c.id) ?? 0)).length}`)
for (const c of [...spenders].sort((a, b) => num(b.spend) - num(a.spend)).slice(0, 6)) {
  console.log(`      ${pad(c.name, 34)} stored €${num(c.spend).toFixed(2).padStart(8)} | 7d €${(w7.get(c.id) ?? 0).toFixed(2).padStart(8)} | 30d €${(w30.get(c.id) ?? 0).toFixed(2).padStart(8)} | 60d €${(w60.get(c.id) ?? 0).toFixed(2).padStart(8)}`)
}

// ── target-grain writes, rolled up per campaign (what "bids changed" would read) ──
console.log('\n── AD_TARGET writes in 60d, rolled up to the campaign ──')
const since = new Date(Date.now() - 60 * 86_400_000)
const tgtLogs = await prisma.advertisingActionLog.groupBy({
  by: ['entityId'], where: { entityType: 'AD_TARGET', createdAt: { gte: since } }, _count: { _all: true },
})
const tgtIds = tgtLogs.map((t) => t.entityId).filter(Boolean) as string[]
const targets = await prisma.adTarget.findMany({
  where: { id: { in: tgtIds } },
  select: { id: true, adGroup: { select: { campaignId: true } } },
})
const tByCampaign = new Map<string, number>()
const cntById = new Map(tgtLogs.map((t) => [t.entityId, t._count._all]))
let unresolved = 0
for (const t of targets) {
  const cid = t.adGroup?.campaignId
  if (!cid) continue
  tByCampaign.set(cid, (tByCampaign.get(cid) ?? 0) + (cntById.get(t.id) ?? 0))
}
unresolved = tgtIds.length - targets.length
console.log(`   ${int(tgtLogs.reduce((a, t) => a + t._count._all, 0))} rows across ${int(tgtLogs.length)} targets → ${int(tByCampaign.size)} campaigns  (${int(unresolved)} target ids no longer resolve)`)
const top = [...tByCampaign].sort((a, b) => b[1] - a[1]).slice(0, 8)
const nameById = new Map(camps.map((c) => [c.id, c]))
for (const [cid, n] of top) {
  const c = nameById.get(cid)
  console.log(`      ${pad(c?.name ?? cid, 40)} ${String(int(n)).padStart(6)} bid writes · ${c?.status} · gate ${c?.liveBidWritesEnabled ? 'OPEN' : 'shut'}`)
}
const gridTouched = camps.filter((c) => tByCampaign.has(c.id)).length
console.log(`   campaigns on the grid with ≥1 bid write: ${int(gridTouched)} / ${camps.length}`)

// ── the actor column: how many CAMPAIGN rows carry no userId ─────────────────
console.log('\n── who is "null"? the 9,378 CAMPAIGN rows with no userId ──')
const nullActor = await prisma.advertisingActionLog.groupBy({
  by: ['actionType'], where: { entityType: 'CAMPAIGN', createdAt: { gte: since }, userId: null }, _count: { _all: true },
})
console.log(`   ${nullActor.sort((a, b) => b._count._all - a._count._all).map((a) => `${a.actionType}×${int(a._count._all)}`).join(' · ')}`)
const withActor = await prisma.advertisingActionLog.count({ where: { entityType: 'CAMPAIGN', createdAt: { gte: since }, userId: { not: null } } })
const allC = await prisma.advertisingActionLog.count({ where: { entityType: 'CAMPAIGN', createdAt: { gte: since } } })
console.log(`   CAMPAIGN rows with an actor: ${int(withActor)} / ${int(allC)}`)

// ── deliveryStatus: is it a usable column? ───────────────────────────────────
console.log('\n── deliveryStatus distribution ──')
const byDel = new Map<string, number>()
for (const c of camps) byDel.set(String(c.deliveryStatus ?? '—'), (byDel.get(String(c.deliveryStatus ?? '—')) ?? 0) + 1)
console.log(`   ${[...byDel].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`)

await prisma.$disconnect()
console.log('\n═══ done — read-only ═══\n')
