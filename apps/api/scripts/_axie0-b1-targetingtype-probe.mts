/**
 * AX-IE.0 / B1 — READ-ONLY live probe.
 *
 * Question: does v3 `POST /sp/campaigns/list` return `targetingType`?
 * It gates E4 (the exporter currently guesses targeting type by regex on the
 * campaign name, mislabelling 26 of 196 campaigns).
 *
 * Read-only: a single list call. No writes, no mutation, write-gate untouched.
 */
process.env.NEXUS_AMAZON_ADS_MODE = 'live' // probe must not hit the sandbox fixture

const { default: prisma } = await import('../src/db.js')
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')

const conn = await prisma.amazonAdsConnection.findFirst({
  where: { marketplace: 'IT', mode: 'production', isActive: true },
  select: { profileId: true, marketplace: true, region: true },
})
if (!conn) { console.log('NO_IT_PRODUCTION_CONNECTION'); process.exit(1) }
console.log('PROFILE', conn.profileId, conn.marketplace, conn.region)

const res = await liveCall<{ campaigns?: Array<Record<string, unknown>>; nextToken?: string }>({
  profileId: conn.profileId,
  region: conn.region as 'EU',
  method: 'POST',
  path: '/sp/campaigns/list',
  body: { maxResults: 10, stateFilter: { include: ['ENABLED', 'PAUSED'] } },
  contentType: 'application/vnd.spCampaign.v3+json',
  acceptHeader: 'application/vnd.spCampaign.v3+json',
})

const camps = res.campaigns ?? []
console.log('RETURNED', camps.length)
if (camps.length) {
  console.log('KEYS_UNION', JSON.stringify([...new Set(camps.flatMap((c) => Object.keys(c)))].sort()))
  console.log('HAS_targetingType', camps.some((c) => 'targetingType' in c))
  console.log('VALUES', JSON.stringify(camps.map((c) => ({
    id: c.campaignId, name: String(c.name ?? '').slice(0, 42), targetingType: c.targetingType,
  })), null, 2))
}
await prisma.$disconnect()
