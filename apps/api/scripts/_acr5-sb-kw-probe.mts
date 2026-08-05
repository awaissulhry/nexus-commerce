/**
 * ACR Stage 5 — find the real SB keyword READ endpoint. READ-ONLY (list calls only).
 *
 * `/sb/v4/keywords/list` with the obvious mime answers 403 with an AWS-gateway shaped error,
 * which means the request never reached the Ads API at all. SB keyword creation must not be
 * written against a guess, so the endpoint is established empirically first — the same
 * discipline that produced the SD/SB campaign shapes.
 *
 * Usage: cd apps/api && railway run npx tsx scripts/_acr5-sb-kw-probe.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')

const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: 'IT', isActive: true }, select: { profileId: true, region: true } })
if (!conn) { console.log('no IT connection'); process.exit(1) }
const ctx = { profileId: conn.profileId, region: (conn.region as 'EU') ?? 'EU' }
const sbIds = (await prisma.campaign.findMany({
  where: { marketplace: 'IT', adProduct: 'SPONSORED_BRANDS' }, select: { externalCampaignId: true },
})).map(c => c.externalCampaignId!).filter(Boolean)

const CANDIDATES: Array<{ label: string; method: 'GET' | 'POST'; path: string; mime?: string; body?: unknown }> = [
  { label: 'CONTROL negativeKeywords v4', method: 'POST', path: '/sb/v4/negativeKeywords/list', mime: 'application/vnd.sbnegativekeywordresource.v4+json', body: { maxResults: 3, campaignIdFilter: { include: sbIds } } },
  { label: 'keywords v4 (sbkeywordresource)', method: 'POST', path: '/sb/v4/keywords/list', mime: 'application/vnd.sbkeywordresource.v4+json', body: { maxResults: 3, campaignIdFilter: { include: sbIds } } },
  { label: 'keywords v4 (plain json)', method: 'POST', path: '/sb/v4/keywords/list', mime: 'application/json', body: { maxResults: 3, campaignIdFilter: { include: sbIds } } },
  { label: 'legacy GET /sb/keywords', method: 'GET', path: '/sb/keywords', mime: 'application/json' },
  { label: 'legacy POST /sb/keywords/list', method: 'POST', path: '/sb/keywords/list', mime: 'application/json', body: { maxResults: 3 } },
  { label: 'v3 GET /sb/v3/keywords', method: 'GET', path: '/sb/v3/keywords', mime: 'application/json' },
]

for (const c of CANDIDATES) {
  try {
    const r = await liveCall<unknown>({
      ...ctx, method: c.method, path: c.path, body: c.body,
      contentType: c.mime, acceptHeader: c.mime,
    })
    const s = JSON.stringify(r)
    console.log(`✔ ${c.label.padEnd(34)} → ${s.slice(0, 220)}`)
  } catch (e: any) {
    console.log(`✖ ${c.label.padEnd(34)} → ${String(e?.message ?? e).slice(0, 150)}`)
  }
}
await prisma.$disconnect(); process.exit(0)
