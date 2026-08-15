/** SOV.2 — does the ad side actually overlap SQP queries once external ids resolve? */
import prisma from '../src/db.js'

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const since = new Date(Date.now() - 30 * 86_400_000)

const [terms, camps, sqp] = await Promise.all([
  prisma.amazonAdsSearchTerm.findMany({ where: { marketplace: 'IT', date: { gte: since } }, select: { query: true, campaignId: true } }),
  prisma.campaign.findMany({ select: { id: true, externalCampaignId: true, marketplace: true } }),
  prisma.searchQueryPerformance.findMany({ where: { marketplace: 'IT' }, orderBy: { startDate: 'desc' }, take: 700, select: { searchQuery: true } }),
])
const localByExt = new Map(camps.filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId!, c.id] as const))
const resolved = terms.filter((t) => localByExt.has(t.campaignId)).length
const adQueries = new Set(terms.map((t) => norm(t.query ?? '')))
const sqpQueries = new Set(sqp.map((r) => norm(r.searchQuery)))
let overlap = 0
for (const q of sqpQueries) if (adQueries.has(q)) overlap++
console.log(JSON.stringify({ termRows: terms.length, resolvedToLocal: resolved, distinctAdQueries: adQueries.size, sqpQueries: sqpQueries.size, overlap }))
await prisma.$disconnect()
