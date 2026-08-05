/**
 * ACR Stage 5 — are the 88 SB keyword mismatches real drift, or a flaw in the new reader?
 * READ-ONLY. Compares local rows against Amazon's own answer field by field.
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { listSbKeywords } = await import('../src/services/advertising/ads-api-client.js')

console.log('\n— LOCAL SB keyword rows, by status and bid —')
const local = await prisma.$queryRawUnsafe<any[]>(`
  SELECT t.status, t."bidCents", COUNT(*)::int AS n
  FROM "AdTarget" t
  JOIN "AdGroup" g ON g.id = t."adGroupId"
  JOIN "Campaign" c ON c.id = g."campaignId"
  WHERE c."adProduct" = 'SPONSORED_BRANDS' AND t.kind = 'KEYWORD' AND t."isNegative" = false
  GROUP BY 1,2 ORDER BY n DESC`)
for (const r of local) console.log(`  status=${r.status} bidCents=${r.bidCents} → ${r.n}`)

for (const marketplace of ['IT', 'DE']) {
  const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace, isActive: true }, select: { profileId: true, region: true } })
  if (!conn) continue
  const ids = (await prisma.campaign.findMany({
    where: { marketplace, adProduct: 'SPONSORED_BRANDS' }, select: { externalCampaignId: true },
  })).map(c => c.externalCampaignId!).filter(Boolean)
  const remote = await listSbKeywords({ profileId: conn.profileId, region: (conn.region as 'EU') ?? 'EU' }, { externalCampaignIds: ids })
  const byState = new Map<string, number>()
  const bids = new Set<number>()
  for (const k of remote) {
    byState.set(String(k.state), (byState.get(String(k.state)) ?? 0) + 1)
    if (k.bid != null) bids.add(k.bid)
  }
  console.log(`\n— AMAZON ${marketplace}: ${remote.length} SB keywords —`)
  console.log(`  states: ${JSON.stringify(Object.fromEntries(byState))}`)
  console.log(`  distinct bids: ${[...bids].sort((a, b) => a - b).join(', ')}`)
}

console.log('\nVERDICT: if local says ARCHIVED/50c while Amazon says enabled at a different bid,')
console.log('the mismatch is REAL drift — our DB does not reflect what is live on Amazon.')
await prisma.$disconnect(); process.exit(0)
