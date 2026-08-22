/**
 * Read a campaign back FROM AMAZON and compare it with our row.
 *
 * The programme's law is "never claim delivery from acceptance": `updateCampaignWithSync` returns
 * ok at ENQUEUE, the write gate runs later in the worker, and a refusal is healed away by the next
 * ingest — so our own row agreeing with our own intent proves nothing. This asks Amazon.
 *
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run --service "@nexus/api" \
 *     npx tsx scripts/_readback-amazon.mts "DE_Exact_3_Keywords"
 *
 * Read-only: one POST /sp/campaigns/list, which is how Amazon's v3 API reads.
 */
import '../src/env.js'
const name = process.argv[2]
if (!name) { console.error('usage: _readback-amazon.mts "<campaign name>"'); process.exit(1) }
const { default: prisma } = await import('../src/db.js')
const { listCampaignsV3 } = await import('../src/services/advertising/ads-api-client.js')

const c = await prisma.campaign.findFirst({ where: { name }, select: { externalCampaignId: true, marketplace: true, dailyBudget: true, status: true } })
if (!c?.externalCampaignId) { console.error(`no campaign "${name}" with an Amazon id`); process.exit(1) }
const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: c.marketplace!, isActive: true }, select: { profileId: true, region: true } })
if (!conn) { console.error(`no active ads connection for ${c.marketplace}`); process.exit(1) }

console.log(`mode=${process.env.NEXUS_AMAZON_ADS_MODE ?? 'unset'} profile=${conn.profileId} market=${c.marketplace}`)
const rows = await listCampaignsV3({ profileId: conn.profileId, region: (conn.region ?? 'EU') as never }, { campaignIds: [c.externalCampaignId] })
const a = rows[0]
if (!a) { console.log('🔴 Amazon returned no campaign for that id'); await prisma.$disconnect(); process.exit(1) }
console.log(`AMAZON  ${a.campaignId} ${a.name} state=${a.state} budget=${a.budget?.budget} ${a.budget?.budgetType ?? ''}`)
console.log(`NEXUS   status=${c.status} budget=${Number(c.dailyBudget)}`)
console.log(Number(a.budget?.budget) === Number(c.dailyBudget)
  ? '\n✅ Amazon agrees with Nexus — the write landed'
  : '\n🔴 MISMATCH — our row and Amazon disagree; do not report this write as delivered')
await prisma.$disconnect()
