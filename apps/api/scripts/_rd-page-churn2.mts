// RD page study — writes per rank schedule (correct column this time) + hourly coverage.
import '../src/env.js'
import prisma from '../src/db.js'

async function main() {
  const since60 = new Date(Date.now() - 60 * 86400000)

  console.log('=== 1. CampaignBidHistory writes per rank schedule (60d), with its motion profile ===')
  const logs = await prisma.campaignBidHistory.groupBy({
    by: ['changedBy'],
    where: { changedAt: { gte: since60 }, changedBy: { startsWith: 'automation:rank-defend-' } },
    _count: { _all: true },
  })
  const scheds = await prisma.adSchedule.findMany({ select: { id: true, campaignId: true, targetOverrides: true, enabled: true, groupId: true } })
  const schedById = new Map(scheds.map((s) => [s.id, s]))
  const camps = await prisma.campaign.findMany({ where: { id: { in: scheds.map((s) => s.campaignId) } }, select: { id: true, name: true } })
  const campById = new Map(camps.map((c) => [c.id, c.name]))
  const ranked = logs.map((l) => {
    const sid = String(l.changedBy).replace('automation:rank-defend-', '')
    const s = schedById.get(sid)
    const ovr = s?.targetOverrides as Record<string, { stepUpPct?: number; maxBiasPct?: number; biasPct?: number }> | undefined
    const ot = ovr?.['own-top']
    const chasing = ot?.maxBiasPct != null && ot?.biasPct != null && ot.maxBiasPct > ot.biasPct
    return { n: l._count._all, camp: s ? (campById.get(s.campaignId) ?? s.campaignId) : `(schedule ${sid} DELETED)`, chasing, step: ot?.stepUpPct ?? null, floor: ot?.biasPct ?? null, ceil: ot?.maxBiasPct ?? null }
  }).sort((a, b) => b.n - a.n)
  let total = 0, chaseTotal = 0
  for (const r of ranked) {
    total += r.n; if (r.chasing) chaseTotal += r.n
    console.log(`  ${String(r.n).padStart(5)}  ${r.camp.slice(0, 44).padEnd(44)} ${r.chasing ? `RAMPING floor=${r.floor}% ceil=${r.ceil}% step=+${r.step}%/cyc` : 'snap-and-hold'}`)
  }
  console.log(`  TOTAL = ${total} bid-history rows across ${ranked.length} schedules; ${chaseTotal} (${total ? Math.round((chaseTotal / total) * 100) : 0}%) from the 4 ramping schedules`)

  console.log('\n=== 2. Are the three 92-window plans literally the same plan? ===')
  const gs = await prisma.rankScheduleGroup.findMany({ where: { enabled: true }, select: { name: true, windows: true, defaultTargetKey: true } })
  const sigs = gs.map((g) => ({ name: g.name, sig: JSON.stringify(g.windows), n: (g.windows as unknown[]).length }))
  for (const a of sigs) {
    const twins = sigs.filter((b) => b.name !== a.name && b.sig === a.sig).map((b) => b.name)
    console.log(`  ${a.name.padEnd(26)} windows=${a.n}  identicalTo=[${twins.join(', ') || 'none'}]`)
  }

  console.log('\n=== 3. Hourly (Marketing Stream) coverage across the 33 live member campaigns ===')
  const live = await prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true } })
  const liveIds = live.map((l) => l.campaignId)
  const liveCamps = await prisma.campaign.findMany({ where: { id: { in: liveIds } }, select: { id: true, name: true, externalCampaignId: true } })
  let withData = 0
  const perCamp: Array<{ name: string; days: number; clicks: number; orders: number }> = []
  for (const c of liveCamps) {
    const agg = await prisma.amazonAdsHourlyPerformance.aggregate({
      where: { date: { gte: new Date(Date.now() - 56 * 86400000) }, OR: [{ localEntityId: c.id }, { entityId: c.externalCampaignId ?? '__none__' }] },
      _sum: { clicks: true, orders7d: true },
    })
    const d = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(DISTINCT "date") AS n FROM "AmazonAdsHourlyPerformance"
      WHERE "date" >= NOW() - INTERVAL '56 days' AND ("localEntityId" = ${c.id} OR "entityId" = ${c.externalCampaignId ?? '__none__'})`
    const days = Number(d[0]?.n ?? 0)
    if (days > 0) withData++
    perCamp.push({ name: c.name, days, clicks: agg._sum.clicks ?? 0, orders: agg._sum.orders7d ?? 0 })
  }
  perCamp.sort((a, b) => b.days - a.days)
  for (const p of perCamp) console.log(`  ${p.name.slice(0, 44).padEnd(44)} daysWithHourlyData=${String(p.days).padStart(2)}/56  clicks=${String(p.clicks).padStart(4)}  orders=${p.orders}`)
  console.log(`  ⇒ ${withData}/${liveCamps.length} live campaigns have ANY hourly data in 56 days`)

  console.log('\n=== 4. Orders per weekday×hour cell — is a per-hour CVR statistically usable? ===')
  const cells = await prisma.$queryRaw<Array<{ nonzero: bigint; totalcells: bigint; maxorders: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE o > 0) AS nonzero, COUNT(*) AS totalcells, MAX(o) AS maxorders FROM (
      SELECT EXTRACT(DOW FROM ts)::int AS d, EXTRACT(HOUR FROM ts)::int AS h, SUM(COALESCE("orders7d",0)) AS o
      FROM (SELECT (("date" + (("hour")::text || ' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome') AS ts, "orders7d"
            FROM "AmazonAdsHourlyPerformance" WHERE "date" >= NOW() - INTERVAL '56 days') t
      GROUP BY d, h) x`
  const c0 = cells[0]
  console.log(`  weekday×hour cells with ≥1 order: ${c0?.nonzero}/${c0?.totalcells}; busiest cell = ${c0?.maxorders} orders in 8 weeks`)

  await prisma.$disconnect()
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
