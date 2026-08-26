// RD-P4 pre-flight — the CURRENT freshness picture, and whether the age the page prints
// belongs to the week the value came from. Read-only, no .catch anywhere.
import '../src/env.js'
import prisma from '../src/db.js'

async function main() {
  console.log('=== 1. SQP weeks per market — current ===')
  const weeks = await prisma.searchQueryPerformance.groupBy({
    by: ['marketplace', 'startDate'], _count: { _all: true },
    orderBy: { startDate: 'desc' }, take: 20,
  })
  for (const w of weeks) {
    console.log(`  ${w.marketplace} ${w.startDate.toISOString().slice(0, 10)} rows=${String(w._count._all).padStart(5)} ageDays=${Math.round((Date.now() - +w.startDate) / 86400000)}`)
  }

  console.log('\n=== 2. TOP lane freshness ===')
  const newestP = await prisma.amazonAdsPlacementReport.findFirst({ where: { placement: 'Top of Search on-Amazon' }, orderBy: { date: 'desc' }, select: { date: true } })
  const rows14 = await prisma.amazonAdsPlacementReport.count({ where: { placement: 'Top of Search on-Amazon', date: { gte: new Date(Date.now() - 14 * 86400000) } } })
  const withIS = await prisma.amazonAdsPlacementReport.count({ where: { placement: 'Top of Search on-Amazon', date: { gte: new Date(Date.now() - 14 * 86400000) }, topOfSearchIS: { not: null } } })
  console.log(`  newest=${newestP?.date.toISOString().slice(0, 10)} ageDays=${newestP ? Math.round((Date.now() - +newestP.date) / 86400000) : 'n/a'} rows(14d)=${rows14} withTopOfSearchIS=${withIS}`)

  console.log('\n=== 3. 🔴 Does the age the page prints belong to the week the VALUE came from? ===')
  const groups = await prisma.rankScheduleGroup.findMany({ where: { enabled: true }, select: { id: true, name: true } })
  for (const g of groups) {
    const scheds = await prisma.adSchedule.findMany({ where: { groupId: g.id, enabled: true }, select: { campaignId: true } })
    const ads = await prisma.adProductAd.findMany({
      where: { adGroup: { campaignId: { in: scheds.map((s) => s.campaignId) } }, status: 'ENABLED' },
      select: { asin: true },
    })
    const asins = [...new Set(ads.map((a) => a.asin).filter(Boolean))] as string[]
    const camp = await prisma.campaign.findFirst({ where: { id: { in: scheds.map((s) => s.campaignId) } }, select: { marketplace: true } })
    const mk = camp?.marketplace ?? null
    if (!mk || !asins.length) { console.log(`  ${g.name.padEnd(26)} mkt=${mk} asins=${asins.length} — skipped`); continue }

    // what the PAGE prints as age today: market-wide newest
    const mktNewest = await prisma.searchQueryPerformance.findFirst({ where: { marketplace: mk }, orderBy: { startDate: 'desc' }, select: { startDate: true } })
    // what the VALUE is actually computed from: newest week for THESE asins
    const asinNewest = await prisma.searchQueryPerformance.findFirst({ where: { marketplace: mk, asin: { in: asins } }, orderBy: { startDate: 'desc' }, select: { startDate: true } })
    const rowsAtAsinWeek = asinNewest
      ? await prisma.searchQueryPerformance.count({ where: { marketplace: mk, asin: { in: asins }, startDate: asinNewest.startDate } })
      : 0
    const everRows = await prisma.searchQueryPerformance.count({ where: { asin: { in: asins } } })
    const d = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : 'none')
    const mismatch = mktNewest && asinNewest && +mktNewest.startDate !== +asinNewest.startDate
    console.log(`  ${g.name.padEnd(26)} mkt=${mk} asins=${asins.length} everRows=${everRows}`)
    console.log(`      age PRINTED from market-wide newest = ${d(mktNewest?.startDate)}`)
    console.log(`      value COMPUTED from these ASINs'   = ${d(asinNewest?.startDate)}  rowsThatWeek=${rowsAtAsinWeek}${mismatch ? '   🔴 DIFFERENT WEEKS' : ''}`)
  }

  console.log('\n=== 4. Trailing norm — what "85 rows" should be compared against (IT) ===')
  const itWeeks = await prisma.searchQueryPerformance.groupBy({
    by: ['startDate'], where: { marketplace: 'IT' }, _count: { _all: true },
    orderBy: { startDate: 'desc' }, take: 10,
  })
  const counts = itWeeks.map((w) => w._count._all)
  const sorted = [...counts].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  console.log(`  IT last ${counts.length} weeks: [${counts.join(', ')}]  median=${median}`)

  await prisma.$disconnect()
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
