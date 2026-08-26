/**
 * BID page study — the campaigns with NO bidder, and what they spend.
 *
 * READ-ONLY. The bidder census showed 46 campaigns received a bid write in 60 days and 38 of
 * those had exactly one writer. So the "six overlapping bidders" risk is declared, not observed.
 * The observed problem is the opposite: how many live, spending campaigns has nothing bid on?
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const e2 = (c: number) => `€${(c / 100).toFixed(2)}`
const SINCE = new Date(Date.now() - 60 * 86_400_000)
const SINCE30 = new Date(Date.now() - 30 * 86_400_000)

console.log('\n═══ BID page — the campaigns nothing bids on ═══\n')

const logs = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: SINCE }, actionType: 'AD_BID_UPDATE' },
  select: { entityId: true, entityType: true },
})
const tIds = [...new Set(logs.filter((l) => l.entityType === 'AD_TARGET').map((l) => l.entityId))]
const gIds = [...new Set(logs.filter((l) => l.entityType === 'AD_GROUP').map((l) => l.entityId))]
const [tRows, gRows] = await Promise.all([
  prisma.adTarget.findMany({ where: { id: { in: tIds } }, select: { adGroup: { select: { campaignId: true } } } }),
  prisma.adGroup.findMany({ where: { id: { in: gIds } }, select: { campaignId: true } }),
])
const written = new Set<string>()
for (const t of tRows) if (t.adGroup?.campaignId) written.add(t.adGroup.campaignId)
for (const g of gRows) written.add(g.campaignId)

const camps = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: { id: true, name: true, marketplace: true, liveBidWritesEnabled: true, minBidCents: true, maxBidCents: true, dailyBudget: true, externalCampaignId: true },
})
const scheds = await prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true } })
const hasSched = new Set(scheds.map((s) => s.campaignId))

// 30-day spend per campaign from the live perf table (NOT the dead denormalised columns)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'],
  where: { entityType: 'CAMPAIGN', date: { gte: SINCE30 }, localEntityId: { not: null } },
  _sum: { costMicros: true, sales7dCents: true, clicks: true },
})
const spend = new Map<string, { c: number; s: number; k: number }>()
for (const p of perf) spend.set(p.localEntityId!, { c: Math.round(Number(p._sum.costMicros ?? 0) / 10_000), s: Number(p._sum.sales7dCents ?? 0), k: Number(p._sum.clicks ?? 0) })

const rows = camps.map((c) => ({ ...c, sp: spend.get(c.id) ?? { c: 0, s: 0, k: 0 }, bid: written.has(c.id), sched: hasSched.has(c.id) }))
const noBidder = rows.filter((r) => !r.bid)
const noBidderSpending = noBidder.filter((r) => r.sp.c > 0)

console.log(`ENABLED campaigns: ${int(camps.length)}`)
console.log(`  received a bid write in 60d : ${int(rows.filter((r) => r.bid).length)}`)
console.log(`  🔴 NO bid write in 60d       : ${int(noBidder.length)}`)
console.log(`     …of which SPENT money in 30d: ${int(noBidderSpending.length)}, total ${e2(noBidderSpending.reduce((s, r) => s + r.sp.c, 0))}`)
console.log(`     …of which have the write gate OPEN: ${int(noBidder.filter((r) => r.liveBidWritesEnabled).length)}`)
console.log(`     …of which have a rank schedule: ${int(noBidder.filter((r) => r.sched).length)}`)

console.log(`\n── the un-bid campaigns that spend, worst first ──`)
console.log(`${pad('  campaign', 38)} ${pad('mkt', 4)} ${pad('30d spend', 10)} ${pad('30d sales', 10)} ${pad('ACoS', 7)} ${pad('gate', 6)} sched`)
for (const r of noBidderSpending.sort((a, b) => b.sp.c - a.sp.c).slice(0, 20)) {
  const acos = r.sp.s > 0 ? `${((r.sp.c / r.sp.s) * 100).toFixed(0)}%` : (r.sp.c > 0 ? '∞' : '—')
  console.log(`  ${pad(r.name, 36)} ${pad(r.marketplace ?? '—', 4)} ${pad(e2(r.sp.c), 10)} ${pad(e2(r.sp.s), 10)} ${pad(acos, 7)} ${pad(r.liveBidWritesEnabled ? 'OPEN' : 'closed', 6)} ${r.sched ? 'yes' : 'NO'}`)
}

const bidAndSpend = rows.filter((r) => r.bid && r.sp.c > 0)
console.log(`\n── for contrast, the campaigns that ARE bid on ──`)
console.log(`  count ${int(bidAndSpend.length)} · 30d spend ${e2(bidAndSpend.reduce((s, r) => s + r.sp.c, 0))} · 30d sales ${e2(bidAndSpend.reduce((s, r) => s + r.sp.s, 0))}`)
console.log(`  un-bid share of ENABLED spend: ${((noBidderSpending.reduce((s, r) => s + r.sp.c, 0) / Math.max(1, noBidderSpending.reduce((s, r) => s + r.sp.c, 0) + bidAndSpend.reduce((s, r) => s + r.sp.c, 0))) * 100).toFixed(1)}%`)

// ── the repeating-failure loop: one entity, many identical failed writes ────
console.log(`\n── 🔴 repeating FAILED bid writes (the same write re-issued) ──`)
const failed = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: SINCE }, actionType: 'AD_BID_UPDATE', amazonResponseStatus: 'FAILED' },
  select: { entityId: true, entityType: true, payloadBefore: true, payloadAfter: true, createdAt: true, userId: true },
  orderBy: { createdAt: 'asc' },
})
const bid = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.bidCents ?? o?.bid; return typeof x === 'number' ? x : null }
const byEntity = new Map<string, { n: number; moves: Set<string>; first: Date; last: Date; actor: string | null }>()
for (const f of failed) {
  const k = f.entityId
  const mv = `${bid(f.payloadBefore)}→${bid(f.payloadAfter)}`
  const e = byEntity.get(k) ?? { n: 0, moves: new Set<string>(), first: f.createdAt, last: f.createdAt, actor: f.userId }
  e.n++; e.moves.add(mv); e.last = f.createdAt
  byEntity.set(k, e)
}
console.log(`  ${int(failed.length)} failures across ${int(byEntity.size)} entities`)
const repeats = [...byEntity].filter(([, e]) => e.n >= 5)
console.log(`  entities failing the SAME write ≥5 times: ${int(repeats.length)}`)
for (const [id, e] of repeats.sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
  const days = Math.round((+e.last - +e.first) / 86_400_000)
  console.log(`    ${pad(id, 28)} ${String(e.n).padStart(4)} failures over ${String(days).padStart(3)}d · distinct moves attempted: ${e.moves.size} (${[...e.moves].slice(0, 3).join(', ')})`)
}
const orphanMarked = await prisma.adTarget.count({ where: { id: { in: [...byEntity.keys()] }, orphanedAt: { not: null } } })
console.log(`\n  of the ${int(byEntity.size)} failing entities, marked orphanedAt: ${int(orphanMarked)}`)
console.log(`  ← updateAdTargetWithSync refuses an orphaned entity. Anything unmarked keeps retrying nightly.`)

// how many distinct calendar days did each repeating failure span, i.e. is it still live?
const stillFailing = [...byEntity].filter(([, e]) => +e.last > Date.now() - 7 * 86_400_000)
console.log(`  entities that failed a bid write in the LAST 7 DAYS: ${int(stillFailing.length)}`)

await prisma.$disconnect()
