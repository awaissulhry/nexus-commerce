// RD-P2 — WHY does today disagree with the study (2026-08-11)? Config change, or the hour?
// Also: verify the topOfSearchIS zero against the real column, because a wrong field name reads
// exactly like a measurement of zero. No .catch anywhere.
import '../src/env.js'
import prisma from '../src/db.js'

async function main() {
  console.log('=== A. RankTarget library AS IT IS NOW ===')
  const targets = await prisma.rankTarget.findMany({ orderBy: { sortOrder: 'asc' } })
  for (const t of targets) {
    console.log([
      t.key.padEnd(16), `place=${t.placement}`, `IS=${t.targetISPct}`, `acosCap=${t.acosCapPct}`,
      `maxCpc=${t.maxCpcCents}`, `bias(floor)=${t.biasPct}`, `maxBias(ceiling)=${t.maxBiasPct}`,
      `allOut=${t.allOut}`, `pause=${t.pause}`, `step=${t.stepUpPct}/${t.stepDownPct}`,
      `floorBid=${t.floorBidCents}`, `updated=${t.updatedAt.toISOString()}`,
    ].join(' | '))
  }
  console.log('\nThe study measured: maxBiasPct NULL on all five; own-top IS=70 cap=€1.50; defend-top IS=35.')

  console.log('\n=== B. targetOverrides that actually exist now (on AdSchedule) ===')
  const scheds = await prisma.adSchedule.findMany({ select: { id: true, campaignId: true, enabled: true, targetOverrides: true, updatedAt: true } })
  let n = 0
  for (const s of scheds) {
    const o = s.targetOverrides as Record<string, unknown> | null
    if (!o || Object.keys(o).length === 0) continue
    n++
    const c = await prisma.campaign.findUnique({ where: { id: s.campaignId }, select: { name: true } })
    console.log(`  ${(c?.name ?? s.campaignId).slice(0, 32).padEnd(32)} | on=${s.enabled} | ${JSON.stringify(o)} | updated=${s.updatedAt.toISOString().slice(0, 16)}`)
  }
  console.log(`  → ${n} schedules carry overrides (study said 12)`)

  console.log('\n=== C. When were targets / groups last touched? ===')
  const g = await prisma.rankScheduleGroup.findMany({ select: { name: true, updatedAt: true, enabled: true }, orderBy: { updatedAt: 'desc' }, take: 6 })
  for (const x of g) console.log(`  ${x.updatedAt.toISOString().slice(0, 16)} | on=${x.enabled} | ${x.name.slice(0, 44)}`)

  console.log('\n=== D. topOfSearchIS — verify the ZERO against the column itself ===')
  const total = await prisma.amazonAdsPlacementReport.count()
  const topRows = await prisma.amazonAdsPlacementReport.count({ where: { placement: 'Top of Search on-Amazon' } })
  const withIS = await prisma.amazonAdsPlacementReport.count({ where: { placement: 'Top of Search on-Amazon', topOfSearchIS: { not: null } } })
  console.log(`  AmazonAdsPlacementReport total=${total} · placement='Top of Search on-Amazon'=${topRows} · topOfSearchIS NOT NULL=${withIS}`)
  const newest = await prisma.amazonAdsPlacementReport.findFirst({ where: { placement: 'Top of Search on-Amazon' }, orderBy: { date: 'desc' }, select: { date: true, topOfSearchIS: true, marketplace: true } })
  console.log(`  newest Top row: ${JSON.stringify(newest)}`)
  const withISrecent = await prisma.amazonAdsPlacementReport.count({
    where: { placement: 'Top of Search on-Amazon', topOfSearchIS: { not: null }, date: { gte: new Date(Date.now() - 14 * 864e5) } },
  })
  console.log(`  last 14d with topOfSearchIS: ${withISrecent}   (study said 532 of 593)`)
  const distinctPlacements = await prisma.amazonAdsPlacementReport.groupBy({ by: ['placement'], _count: { _all: true } })
  console.log(`  placements present: ${distinctPlacements.map((p) => `${p.placement}=${p._count._all}`).join(' · ')}`)

  console.log('\n=== E. what analyzeTopOfSearch actually returns per row ===')
  const { analyzeTopOfSearch } = await import('../src/services/advertising/ads-top-of-search.service.js')
  const tos = await analyzeTopOfSearch({ marketplace: 'IT' })
  console.log(`  rows=${tos.rows.length} windowDays=${tos.windowDays} targetIS=${tos.targetIS}`)
  if (tos.rows[0]) console.log(`  row[0] keys: ${Object.keys(tos.rows[0]).join(', ')}`)
  if (tos.rows[0]) console.log(`  row[0]: ${JSON.stringify(tos.rows[0])}`)

  console.log('\n=== F. SQP freshness per market ===')
  const weeks = await prisma.searchQueryPerformance.groupBy({ by: ['marketplace', 'startDate'], _count: { _all: true }, orderBy: { startDate: 'desc' }, take: 12 })
  for (const w of weeks) console.log(`  ${w.marketplace} ${w.startDate.toISOString().slice(0, 10)} rows=${w._count._all}`)
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => { console.error(e); return prisma.$disconnect().then(() => process.exit(1)) })
