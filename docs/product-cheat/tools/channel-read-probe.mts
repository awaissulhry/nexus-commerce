// PLAN Step 3.1 (R-33) — are the two doors open? ONE Amazon listing read and ONE eBay listing read, each with the SELLER
// ACCOUNT's own credentials, against production. READ ONLY for listings. Default: print the plan and stop.
//   npx tsx docs/product-cheat/tools/channel-read-probe.mts                      # the plan only
//   npx tsx docs/product-cheat/tools/channel-read-probe.mts --execute-approved   # the two reads (Owner-approved, R-33)
// A read only counts as OPEN when it returns the thing asked for: Amazon an ASIN for a live SKU (its client turns a 404
// into success with no ASIN), eBay a GetItem body whose ItemID matches (outside production, without NEXUS_EBAY_REAL_API,
// its client returns a FAKE success with an empty body — this probe sets the flag and requires the body).
import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'dotenv'

const ROOT = '/Users/awais/nexus-commerce'
const plan = {
  step: 'PLAN Step 3.1 — one Amazon read and one eBay read, seller-account credentials, production',
  workspace: 'nexus_legacy_workspace',
  calls: ['Amazon SP-API GET listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=APJ6JRA9NG5V4&includedData=summaries (one live Amazon·IT SKU, not AIREON)',
    'eBay Trading GetItem (one live eBay·IT ItemID; OutputSelector ItemID, Title, SKU, ListingStatus)'],
  sideEffects: 'The canonical clients only: a normal OAuth refresh and its lease if a token is near expiry, and the gateway call-log rows. No listing, price, stock, order or subscription write.',
}
console.log(JSON.stringify(plan, null, 2))
if (!process.argv.includes('--execute-approved')) process.exit(0)

const deadline = setTimeout(() => { console.error('Probe stopped at its 120-second bound; no result claimed.'); process.exit(1) }, 120_000)
deadline.unref()
const env = parse(readFileSync(`${ROOT}/.env`, 'utf8'))
const target = new URL(env.DATABASE_URL)
if (target.hostname !== 'ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.aws.neon.tech' || target.pathname !== '/neondb') throw new Error('Unexpected production database target.')
for (const [key, value] of Object.entries(env)) if (/^(DATABASE_URL$|DIRECT_URL$|NEXUS_|AMAZON_|EBAY_|AWS_|REDIS_)/.test(key)) process.env[key] = value
process.env.NEXUS_WORKSPACES_ENABLED = '1'
process.env.NEXUS_DATABASE_POOL_MAX = '2'
process.env.NEXUS_EBAY_REAL_API = 'true' // GetItem is a READ (tradingCallKind 'read'); without this the client fakes success
const report: Record<string, unknown> = { targetHost: target.hostname, database: target.pathname, at: new Date().toISOString() }

const { default: prisma } = await import(`${ROOT}/apps/api/src/db.js`)
const { withWorkspace } = await import(`${ROOT}/apps/api/src/lib/workspace-context.js`)
// The token service reads each channel's spec from a registry the API fills at boot (`index.ts:192`); load it the same way.
await import(`${ROOT}/apps/api/src/services/cx/connectors/index.js`)
try {
  await withWorkspace({ workspaceId: plan.workspace, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    // ── Amazon ──
    try {
      const listing = await prisma.channelListing.findFirst({
        where: { channel: 'AMAZON', marketplace: 'IT', externalListingId: { not: null }, channelConnectionId: { not: null }, isPublished: true,
          product: { deletedAt: null, NOT: { sku: { startsWith: 'AIREON' } } } },
        include: { product: { select: { sku: true } }, offers: { where: { isActive: true }, select: { sku: true } } }, orderBy: { updatedAt: 'desc' } })
      if (!listing) throw new Error('no live Amazon·IT listing found to read')
      const account = await prisma.channelConnection.findUniqueOrThrow({ where: { id: listing.channelConnectionId! }, select: { id: true, region: true, authStatus: true, managedBy: true } })
      const sku = listing.offers[0]?.sku ?? listing.product.sku
      const { getAmazonSellerId } = await import(`${ROOT}/apps/api/src/lib/amazon-sp-client.js`)
      const { AmazonSpApiClient } = await import(`${ROOT}/apps/api/src/clients/amazon-sp-api.client.js`)
      const sellerId = await getAmazonSellerId(account.id)
      const read = await new AmazonSpApiClient({ id: account.id, region: account.region ?? 'eu' }).getListingsItem({ sellerId, sku, marketplaceId: 'APJ6JRA9NG5V4', includedData: ['summaries'] })
      report.amazon = { account: { id: account.id, authStatus: account.authStatus, managedBy: account.managedBy }, sku, storedAsin: listing.externalListingId,
        success: read.success, asin: read.asin, status: read.status, error: read.error ?? null,
        open: read.success && !!read.asin, asinMatchesStored: read.asin === listing.externalListingId }
    } catch (error) { report.amazon = { open: false, error: error instanceof Error ? error.message : String(error) } }
    // ── eBay ──
    try {
      const listing = await prisma.channelListing.findFirst({
        where: { channel: 'EBAY', marketplace: 'IT', externalListingId: { not: null }, channelConnectionId: { not: null }, isPublished: true, product: { deletedAt: null } },
        include: { product: { select: { sku: true } } }, orderBy: { updatedAt: 'desc' } })
      if (!listing) throw new Error('no live eBay·IT listing found to read')
      const account = await prisma.channelConnection.findUniqueOrThrow({ where: { id: listing.channelConnectionId! }, select: { id: true, authStatus: true, managedBy: true } })
      const { ebayAuthService } = await import(`${ROOT}/apps/api/src/services/ebay-auth.service.js`)
      const { callTradingApi } = await import(`${ROOT}/apps/api/src/services/ebay-trading-api.service.js`)
      const token = await ebayAuthService.getValidToken(account.id)
      const itemId = listing.externalListingId!
      const xml = `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${itemId}</ItemID><DetailLevel>ReturnSummary</DetailLevel><OutputSelector>Item.ItemID,Item.Title,Item.SKU,Item.SellingStatus.ListingStatus</OutputSelector></GetItemRequest>`
      const res = await callTradingApi('GetItem', xml, { oauthToken: token, siteId: 101, connectionId: account.id })
      const raw = res.raw ?? ''
      const gotId = /<ItemID>(\d+)<\/ItemID>/.exec(raw)?.[1] ?? null
      report.ebay = { account: { id: account.id, authStatus: account.authStatus, managedBy: account.managedBy }, sku: listing.product.sku, itemId,
        ack: /<Ack>([^<]+)<\/Ack>/.exec(raw)?.[1] ?? res.ack ?? null, bodyBytes: raw.length, returnedItemId: gotId,
        listingStatus: /<ListingStatus>([^<]+)<\/ListingStatus>/.exec(raw)?.[1] ?? null, titleChars: /<Title>([^<]*)<\/Title>/.exec(raw)?.[1]?.length ?? null,
        errors: (res.errors ?? []).slice(0, 3), open: raw.length > 0 && gotId === itemId }
    } catch (error) { report.ebay = { open: false, error: error instanceof Error ? error.message : String(error) } }
  })
} finally {
  await prisma.$disconnect().catch(() => undefined)
}
const path = `${ROOT}/docs/product-cheat/records/step-3.1-channel-read-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(path, JSON.stringify(report, null, 1))
console.log(`REPORT ${JSON.stringify(report)}`)
console.log(`record: ${path}`)
process.exit(0)
