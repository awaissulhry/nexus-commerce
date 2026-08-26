import '../src/env.js'
import prisma from '../src/db.js'
const NOW = new Date()
async function main() {
  console.log('NOW=' + NOW.toISOString())
  const campsAll = await prisma.campaign.count()
  const campsDetail = await prisma.amazonAdsCampaignDetail.count()
  const campsByMkt = await prisma.campaign.groupBy({ by: ['marketplace'], _count: { _all: true } })
  console.log(JSON.stringify({ campaignRowsTotal: campsAll, amazonAdsCampaignDetailRows: campsDetail, campaignsByMarketplace: campsByMkt.map(c => ({ m: c.marketplace, n: c._count._all })) }, null, 2))
  // any SQP row ingested on/after 2026-08-11 at all?
  const after = await prisma.searchQueryPerformance.count({ where: { ingestedAt: { gte: new Date('2026-08-11T00:00:00Z') } } })
  const upd = await prisma.searchQueryPerformance.count({ where: { updatedAt: { gte: new Date('2026-08-11T00:00:00Z') } } }).catch((e) => 'NO updatedAt FIELD: ' + (e instanceof Error ? e.message.slice(0, 120) : ''))
  console.log(JSON.stringify({ sqpRowsIngestedOnOrAfter_2026_08_11: after, sqpRowsUpdatedOnOrAfter_2026_08_11: upd }, null, 2))
  // sanity: a deliberately wrong-field query must THROW, not return 0
  try { await prisma.searchQueryPerformance.count({ where: { notAField: 1 } as never }); console.log('ZERO-TRAP: wrong field did NOT throw — counts are untrustworthy') } catch { console.log('ZERO-TRAP OK: a wrong field name throws, so the zeros above are real measurements') }
  await prisma.$disconnect()
}
main().catch(async (e) => { console.error('FATAL', e); await prisma.$disconnect(); process.exit(1) })
