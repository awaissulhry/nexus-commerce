// RD page study — WHO writes, HOW OFTEN, what the week actually looks like, and whether
// an hourly CVR signal is even available. Read-only.
import '../src/env.js'
import prisma from '../src/db.js'
import { resolveActiveTargetKey, type ScheduleWindow } from '../src/services/advertising/rank-controller.js'

async function main() {
  const since60 = new Date(Date.now() - 60 * 86400000)

  console.log('=== 1. Placement/bid writes per rank SCHEDULE, mapped to its campaign (60d) ===')
  const logs = await prisma.advertisingActionLog.groupBy({
    by: ['reasonActor'],
    where: { createdAt: { gte: since60 }, reasonActor: { startsWith: 'automation:rank-defend-' } },
    _count: { _all: true },
  }).catch(async () => {
    // reasonActor may not be the column name — fall back and report honestly rather than zero.
    console.log('   (reasonActor groupBy failed — trying `actor`)')
    return [] as Array<{ reasonActor: string | null; _count: { _all: number } }>
  })
  const scheds = await prisma.adSchedule.findMany({ select: { id: true, campaignId: true, name: true, targetOverrides: true, enabled: true } })
  const schedById = new Map(scheds.map((s) => [s.id, s]))
  const camps = await prisma.campaign.findMany({ where: { id: { in: scheds.map((s) => s.campaignId) } }, select: { id: true, name: true } })
  const campById = new Map(camps.map((c) => [c.id, c.name]))
  const ranked = logs.map((l) => {
    const sid = String(l.reasonActor).replace('automation:rank-defend-', '')
    const s = schedById.get(sid)
    const ovr = s?.targetOverrides as Record<string, { stepUpPct?: number; maxBiasPct?: number; biasPct?: number }> | undefined
    const ot = ovr?.['own-top']
    return {
      n: l._count._all,
      camp: s ? (campById.get(s.campaignId) ?? s.campaignId) : `(schedule ${sid} deleted)`,
      chase: ot?.maxBiasPct != null && ot?.biasPct != null && ot.maxBiasPct > ot.biasPct,
      step: ot?.stepUpPct ?? null, floor: ot?.biasPct ?? null, ceil: ot?.maxBiasPct ?? null,
    }
  }).sort((a, b) => b.n - a.n)
  let total = 0
  for (const r of ranked) { total += r.n; console.log(`  ${String(r.n).padStart(5)}  ${r.camp.slice(0, 44).padEnd(44)} ${r.chase ? `CHASING floor=${r.floor}% ceil=${r.ceil}% step=+${r.step}/cyc` : 'snap-and-hold'}`) }
  console.log(`  TOTAL rank-defend writes (60d) = ${total} across ${ranked.length} schedules`)

  console.log('\n=== 2. The GALE week, hour by hour (Rome) — does own-top get zeroed nightly? ===')
  const g = await prisma.rankScheduleGroup.findFirst({ where: { name: 'IT GALE JACKET' } })
  if (g) {
    const wins = (Array.isArray(g.windows) ? g.windows : []) as ScheduleWindow[]
    const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const abbr: Record<string, string> = { 'own-top': 'T', 'defend-top': 'd', 'rest-of-search': 'r', 'pause': '.', 'own-top-allout': 'A' }
    for (let d = 1; d <= 7; d++) {
      const dd = d % 7
      let line = ''
      for (let h = 0; h < 24; h++) line += abbr[resolveActiveTargetKey(wins, g.defaultTargetKey, dd, h) ?? ''] ?? '?'
      console.log(`  ${D[dd]}  ${line}   (hours 0..23)`)
    }
    console.log('  legend: T=own-top  d=defend-top  A=own-top-allout  r=rest-of-search  .=pause(min bid)')
    // Count lane FLIPS per week — every Top→Rest flip zeroes the other placement.
    let flips = 0, zeroTop = 0
    const placeOf: Record<string, string> = { 'own-top': 'TOP', 'defend-top': 'TOP', 'own-top-allout': 'TOP', 'rest-of-search': 'REST', 'pause': 'PAUSE0' }
    let prev = ''
    for (let i = 0; i < 168; i++) {
      const d = Math.floor(i / 24), h = i % 24
      const k = resolveActiveTargetKey(wins, g.defaultTargetKey, d, h) ?? ''
      const p = placeOf[k] ?? '?'
      if (prev && p !== prev) { flips++; if (p === 'REST' || p === 'PAUSE0') zeroTop++ }
      prev = p
    }
    console.log(`  lane changes per week = ${flips}; of those, ${zeroTop} force the Top multiplier to 0 (rest-of-search zeroes Top; the Min-bid target has biasPct=0 on PLACEMENT_TOP)`)
  }

  console.log('\n=== 3. Is an hourly CVR signal available at all? ===')
  const hourlyAgg = await prisma.amazonAdsHourlyPerformance.aggregate({
    where: { date: { gte: new Date(Date.now() - 56 * 86400000) } },
    _count: { _all: true }, _sum: { clicks: true, orders7d: true, impressions: true },
  })
  const days = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(DISTINCT "date") AS n FROM "AmazonAdsHourlyPerformance" WHERE "date" >= NOW() - INTERVAL '56 days'`
  const newest = await prisma.amazonAdsHourlyPerformance.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
  console.log(`  rows(56d)=${hourlyAgg._count._all}  distinctDays=${days[0]?.n}  newest=${newest?.date.toISOString().slice(0, 10)}`)
  console.log(`  clicks=${hourlyAgg._sum.clicks}  orders7d=${hourlyAgg._sum.orders7d}  impressions=${hourlyAgg._sum.impressions}`)
  console.log(`  ⇒ CVR = orders7d/clicks is ${(hourlyAgg._sum.clicks ?? 0) > 0 && (hourlyAgg._sum.orders7d ?? 0) > 0 ? 'COMPUTABLE' : 'NOT computable'} at hour grain`)

  console.log('\n=== 4. Hour-of-day CVR across the live fleet (Rome), last 8 whole weeks ===')
  const rows = await prisma.$queryRaw<Array<{ hour: number; clicks: bigint; orders: bigint; cost: bigint }>>`
    SELECT EXTRACT(HOUR FROM ts)::int AS hour, SUM("clicks") AS clicks, SUM(COALESCE("orders7d",0)) AS orders, SUM("costMicros") AS cost
    FROM (SELECT (("date" + (("hour")::text || ' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome') AS ts, "clicks", "orders7d", "costMicros"
          FROM "AmazonAdsHourlyPerformance" WHERE "date" >= NOW() - INTERVAL '56 days') t
    GROUP BY hour ORDER BY hour`
  for (const r of rows) {
    const c = Number(r.clicks), o = Number(r.orders)
    console.log(`  ${String(r.hour).padStart(2, '0')}:00  clicks=${String(c).padStart(5)}  orders=${String(o).padStart(4)}  CVR=${c > 0 ? ((o / c) * 100).toFixed(1) + '%' : '—'}  spend=€${(Number(r.cost) / 1e6).toFixed(0)}`)
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
