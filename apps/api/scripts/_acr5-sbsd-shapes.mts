/**
 * ACR Stage 5 — capture the RAW SD and SB campaign/adGroup JSON from Amazon. READ-ONLY.
 *
 * The create bodies for SD and SB are being written from scratch. Rather than model them on
 * documentation, model them on this account's own live entities: 15 SD + 4 SB campaigns exist
 * on Amazon right now, so their exact field names, casings, date formats and enum values are
 * observable. `/sp/*` shapes are NOT transferable — SD is plain JSON with its own date format
 * and a `tactic`; SB is v4 with its own mime.
 *
 * Usage: cd apps/api && railway run npx tsx scripts/_acr5-sbsd-shapes.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const client = await import('../src/services/advertising/ads-api-client.js')

const conn = await prisma.amazonAdsConnection.findFirst({
  where: { marketplace: 'IT', isActive: true }, select: { profileId: true, region: true },
})
if (!conn) { console.log('no IT connection'); process.exit(1) }
const ctx = { profileId: conn.profileId, region: (conn.region as 'EU') ?? 'EU' }

const ids = await prisma.campaign.findMany({
  where: { marketplace: 'IT', adProduct: { in: ['SPONSORED_DISPLAY', 'SPONSORED_BRANDS'] } },
  select: { adProduct: true, externalCampaignId: true, name: true },
})
const sdIds = ids.filter(i => i.adProduct === 'SPONSORED_DISPLAY').map(i => i.externalCampaignId!).filter(Boolean)
const sbIds = ids.filter(i => i.adProduct === 'SPONSORED_BRANDS').map(i => i.externalCampaignId!).filter(Boolean)

// The typed readers normalise onto a shared DTO, which is exactly what hides the
// field names a create body needs. Go through liveCall for the untouched envelope.
const { liveCall } = client

console.log('\n════════ SD CAMPAIGNS — raw GET /sd/campaigns ════════')
console.log(JSON.stringify(await liveCall({
  ...ctx, method: 'GET', path: `/sd/campaigns?campaignIdFilter=${sdIds.slice(0, 3).join(',')}`,
  contentType: 'application/json', acceptHeader: 'application/json',
}), null, 2).slice(0, 2500))

console.log('\n════════ SD AD GROUPS — raw GET /sd/adGroups ════════')
console.log(JSON.stringify(await liveCall({
  ...ctx, method: 'GET', path: `/sd/adGroups?campaignIdFilter=${sdIds.slice(0, 3).join(',')}`,
  contentType: 'application/json', acceptHeader: 'application/json',
}), null, 2).slice(0, 1800))

console.log('\n════════ SD PRODUCT ADS — raw GET /sd/productAds ════════')
console.log(JSON.stringify(await liveCall({
  ...ctx, method: 'GET', path: `/sd/productAds?campaignIdFilter=${sdIds.slice(0, 2).join(',')}`,
  contentType: 'application/json', acceptHeader: 'application/json',
}), null, 2).slice(0, 1200))

console.log('\n════════ SD TARGETS — raw GET /sd/targets ════════')
console.log(JSON.stringify(await liveCall({
  ...ctx, method: 'GET', path: `/sd/targets?campaignIdFilter=${sdIds.slice(0, 2).join(',')}`,
  contentType: 'application/json', acceptHeader: 'application/json',
}), null, 2).slice(0, 1200))

console.log('\n════════ SB AD GROUPS — raw POST /sb/v4/adGroups/list ════════')
try {
  console.log(JSON.stringify(await liveCall({
    ...ctx, method: 'POST', path: '/sb/v4/adGroups/list',
    body: { maxResults: 10, campaignIdFilter: { include: sbIds } },
    contentType: 'application/vnd.sbadgroupresource.v4+json',
    acceptHeader: 'application/vnd.sbadgroupresource.v4+json',
  }), null, 2).slice(0, 1500))
} catch (e: any) { console.log('  ✖', e?.message) }

console.log('\n════════ SB ADS — raw POST /sb/v4/ads/list ════════')
try {
  console.log(JSON.stringify(await liveCall({
    ...ctx, method: 'POST', path: '/sb/v4/ads/list',
    body: { maxResults: 5, campaignIdFilter: { include: sbIds } },
    contentType: 'application/vnd.sbadresource.v4+json',
    acceptHeader: 'application/vnd.sbadresource.v4+json',
  }), null, 2).slice(0, 2000))
} catch (e: any) { console.log('  ✖', e?.message) }

console.log('\n════════ SB KEYWORDS — raw POST /sb/v4/keywords/list ════════')
try {
  console.log(JSON.stringify(await liveCall({
    ...ctx, method: 'POST', path: '/sb/v4/keywords/list',
    body: { maxResults: 5, campaignIdFilter: { include: sbIds } },
    contentType: 'application/vnd.sbkeywordresource.v4+json',
    acceptHeader: 'application/vnd.sbkeywordresource.v4+json',
  }), null, 2).slice(0, 1400))
} catch (e: any) { console.log('  ✖', e?.message) }

console.log('\n════════ SB CAMPAIGNS — raw POST /sb/v4/campaigns/list ════════')
console.log(JSON.stringify(await liveCall({
  ...ctx, method: 'POST', path: '/sb/v4/campaigns/list',
  body: { maxResults: 10, campaignIdFilter: { include: sbIds } },
  contentType: 'application/vnd.sbcampaignresource.v4+json',
  acceptHeader: 'application/vnd.sbcampaignresource.v4+json',
}), null, 2).slice(0, 2500))
await prisma.$disconnect(); process.exit(0)
