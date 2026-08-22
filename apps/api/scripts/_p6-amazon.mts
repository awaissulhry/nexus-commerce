/** READ-ONLY against Amazon. Run with:
 *  cd apps/api && railway run --service "@nexus/api" env -u REDIS_URL NEXUS_AMAZON_ADS_QUOTA_MODE=off npx tsx scripts/_p6-amazon.mts
 *  1) which AMS subscriptions exist TODAY (the P6 deliverable #2)
 *  2) does Amazon's PULL budget-usage API answer for our campaigns (a Track C that needs no AWS)? */
const { default: prisma } = await import('../src/db.js')
const { liveCall, adsMode } = await import('../src/services/advertising/ads-api-client.js')
console.log('adsMode =', adsMode())
const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { profileId: true, region: true, marketplace: true } })
console.log('active connections:', JSON.stringify(conns))
const prof = conns[0]
if (!prof) { console.log('NO ACTIVE CONNECTION'); process.exit(0) }
const region = (prof.region === 'NA' || prof.region === 'FE' ? prof.region : 'EU') as 'EU' | 'NA' | 'FE'

console.log('\n=== 1 · GET /streams/subscriptions ===')
try {
  const subs = await liveCall<unknown>({ profileId: prof.profileId, region, method: 'GET', path: '/streams/subscriptions' })
  console.log(JSON.stringify(subs, null, 2).slice(0, 4000))
} catch (e) {
  const err = e as Error & { statusCode?: number; body?: string }
  console.log('ERROR', err.statusCode, err.message.slice(0, 400))
}

console.log('\n=== 2 · POST /sp/campaigns/budget/usage (read-only query, 20 enabled campaigns) ===')
const camps = await prisma.campaign.findMany({ where: { status: 'ENABLED', externalCampaignId: { not: null } }, select: { externalCampaignId: true, name: true, dailyBudget: true }, take: 20 })
const ids = camps.map((c) => c.externalCampaignId!).filter(Boolean)
console.log('asking for', ids.length, 'campaignIds')
try {
  const usage = await liveCall<unknown>({
    profileId: prof.profileId, region, method: 'POST', path: '/sp/campaigns/budget/usage',
    body: { campaignIds: ids },
    contentType: 'application/vnd.spcampaignbudgetusage.v3+json',
    acceptHeader: 'application/vnd.spcampaignbudgetusage.v3+json',
  })
  console.log(JSON.stringify(usage, null, 2).slice(0, 5000))
} catch (e) {
  const err = e as Error & { statusCode?: number; body?: string }
  console.log('ERROR v3', err.statusCode, (err.body ?? err.message).slice(0, 500))
  try {
    const usage2 = await liveCall<unknown>({
      profileId: prof.profileId, region, method: 'POST', path: '/sp/campaigns/budget/usage',
      body: { campaignIds: ids },
      contentType: 'application/vnd.spcampaignbudgetusage.v1+json',
      acceptHeader: 'application/vnd.spcampaignbudgetusage.v1+json',
    })
    console.log('v1 OK:', JSON.stringify(usage2, null, 2).slice(0, 5000))
  } catch (e2) {
    const err2 = e2 as Error & { statusCode?: number; body?: string }
    console.log('ERROR v1', err2.statusCode, (err2.body ?? err2.message).slice(0, 500))
  }
}
await prisma.$disconnect()
