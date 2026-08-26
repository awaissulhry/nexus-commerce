/** SUB — Basis B preconditions. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const ago = (d: Date | null | undefined) => d ? `${((Date.now() - d.getTime()) / 86400000).toFixed(1)}d` : '—'
const sqp = await prisma.searchQueryPerformance.findFirst({ orderBy: { startDate: 'desc' }, select: { startDate: true } })
const st = await prisma.amazonAdsSearchTerm.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
const dp = await prisma.amazonAdsDailyPerformance.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
const pl = await prisma.amazonAdsPlacementReport.findFirst({ where: { topOfSearchIS: { not: null } }, orderBy: { date: 'desc' }, select: { date: true } })
console.log(`SQP.startDate        ${sqp?.startDate.toISOString().slice(0,10)}  ${ago(sqp?.startDate)}`)
console.log(`AdsSearchTerm.date   ${st?.date.toISOString().slice(0,10)}  ${ago(st?.date)}`)
console.log(`DailyPerformance     ${dp?.date.toISOString().slice(0,10)}  ${ago(dp?.date)}`)
console.log(`PlacementIS          ${pl?.date.toISOString().slice(0,10)}  ${ago(pl?.date)}`)
console.log(`AdSpendCeiling rows  ${await prisma.adSpendCeiling.count()}`)
console.log(`Campaign minBidCents set ${await prisma.campaign.count({ where: { minBidCents: { not: null } } })} / ${await prisma.campaign.count()}`)
await prisma.$disconnect()
