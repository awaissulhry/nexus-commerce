// PLAN Step 1.3 (A-37, R-37) — prove a reversible "stop selling, keep everything" on ONE listing per channel, before any build.
//   npx tsx docs/product-cheat/tools/unpublish-probe.mts --read      # READ ONLY: eBay out-of-stock control + one candidate per channel
// (The live steps are added only after this read, and only when it shows they are safe — see A-37.)
import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'dotenv'

const ROOT = '/Users/awais/nexus-commerce'
const argv = process.argv.slice(2)
const mode = argv.includes('--read') ? 'read' : argv.includes('--ebay-test') ? 'ebay-test' : argv.includes('--amazon-test') ? 'amazon-test' : 'plan'
const execute = argv.includes('--execute-approved')
console.log(JSON.stringify({ step: 'PLAN Step 1.3 — reversible unpublish, proven on one listing per channel', mode,
  read: ['eBay GetUserPreferences (ShowOutOfStockControlPreference)', 'eBay GetItem of one live eBay·IT item (quantity)', 'Amazon getListingsItem of one live merchant-fulfilled Amazon·IT SKU (summaries + attributes)'],
  sideEffects: 'read only: a normal token refresh and the API call log' }, null, 1))
if (mode === 'plan' || ((mode === 'ebay-test' || mode === 'amazon-test') && !execute)) process.exit(0)
// The publish gates are closed in this machine's env; opened ONLY for an Owner-approved live test (R-37).
if (execute && mode === 'ebay-test') { process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'true'; process.env.EBAY_PUBLISH_MODE = 'live' }
if (execute && mode === 'amazon-test') { process.env.NEXUS_ENABLE_AMAZON_PUBLISH = 'true'; process.env.AMAZON_PUBLISH_MODE = 'live' }
const EBAY_TEST = { itemId: '256564203510', sku: 'GALE-JACKET-BLACK-MEN-M' }
const AMAZON_TEST = { sku: 'xracingbxn48', asin: 'B0BTCBPVTS', marketplaceId: 'APJ6JRA9NG5V4', productType: 'APPAREL' }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const deadline = setTimeout(() => { console.error('Probe stopped at its bound; no result claimed — RE-READ the listing before concluding (an UNKNOWN outcome).'); process.exit(1) }, mode === 'read' ? 120_000 : 420_000)
deadline.unref()
const env = parse(readFileSync(`${ROOT}/.env`, 'utf8'))
const target = new URL(env.DATABASE_URL)
if (target.hostname !== 'ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.aws.neon.tech' || target.pathname !== '/neondb') throw new Error('Unexpected production database target.')
for (const [key, value] of Object.entries(env)) if (/^(DATABASE_URL$|DIRECT_URL$|NEXUS_|AMAZON_|EBAY_|AWS_|REDIS_)/.test(key)) process.env[key] = value
process.env.NEXUS_WORKSPACES_ENABLED = '1'
process.env.NEXUS_DATABASE_POOL_MAX = '2'
process.env.NEXUS_EBAY_REAL_API = 'true' // reads only; without it the client fakes success

const { default: prisma } = await import(`${ROOT}/apps/api/src/db.js`)
const { withWorkspace } = await import(`${ROOT}/apps/api/src/lib/workspace-context.js`)
await import(`${ROOT}/apps/api/src/services/cx/connectors/index.js`)
const report: Record<string, unknown> = { at: new Date().toISOString() }
const tag = (raw: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(raw)?.[1] ?? null
try {
  await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    if (mode === 'ebay-test') {
      const listing = await prisma.channelListing.findFirstOrThrow({ where: { channel: 'EBAY', externalListingId: EBAY_TEST.itemId }, select: { channelConnectionId: true } })
      const { ebayAuthService } = await import(`${ROOT}/apps/api/src/services/ebay-auth.service.js`)
      const trading = await import(`${ROOT}/apps/api/src/services/ebay-trading-api.service.js`)
      const ctx = { oauthToken: await ebayAuthService.getValidToken(listing.channelConnectionId!), siteId: 101, connectionId: listing.channelConnectionId! }
      const read = async () => {
        const raw = (await trading.callTradingApi('GetItem', trading.buildGetItemQuantitiesXml(EBAY_TEST.itemId), ctx)).raw ?? ''
        const q = trading.parseGetItemQuantities(raw)
        return { itemId: tag(raw, 'ItemID'), listingStatus: q.listingStatus, remaining: q.variations.find((v: { sku: string }) => v.sku === EBAY_TEST.sku)?.available ?? null }
      }
      const revise = async (quantity: number) => { const r = await trading.callTradingApi('ReviseInventoryStatus', trading.buildReviseInventoryStatusXml({ ...EBAY_TEST, quantity }), ctx); return { ack: r.ack, errors: (r.errors ?? []).slice(0, 3) } }
      const before = await read()
      report.before = before
      if (before.remaining == null || before.remaining <= 0 || before.listingStatus !== 'Active') throw new Error(`not a safe test state: ${JSON.stringify(before)}`)
      writeFileSync(`${ROOT}/docs/product-cheat/records/step-1.3-ebay-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify({ ...EBAY_TEST, ...before }, null, 1))
      try {
        report.unpublish = await revise(0)
        await wait(10_000)
        report.afterUnpublish = await read()
      } finally {
        report.restore = await revise(before.remaining)
        await wait(10_000)
        report.afterRestore = await read()
        report.restored = (report.afterRestore as { remaining: number | null }).remaining === before.remaining
      }
      return
    }
    if (mode === 'amazon-test') {
      const account = await prisma.channelConnection.findFirstOrThrow({ where: { channelType: 'AMAZON', externalAccountId: { not: null }, isActive: true }, select: { id: true, region: true } })
      const { AmazonSpApiClient } = await import(`${ROOT}/apps/api/src/clients/amazon-sp-api.client.js`)
      const { getAmazonSellerId } = await import(`${ROOT}/apps/api/src/lib/amazon-sp-client.js`)
      const { buildAmazonListingPatch } = await import(`${ROOT}/apps/api/src/services/outbound-sync.service.js`)
      const { listingPublishService } = await import(`${ROOT}/apps/api/src/services/listing-publish.service.js`)
      const gate = await import(`${ROOT}/apps/api/src/services/amazon-publish-gate.service.js`)
      const { digestPayload } = await import(`${ROOT}/apps/api/src/services/channel-publish-audit.service.js`)
      const client = new AmazonSpApiClient({ id: account.id, region: account.region ?? 'eu' })
      const sellerId = await getAmazonSellerId(account.id)
      const read = async () => {
        const r = await client.getListingsItem({ sellerId, sku: AMAZON_TEST.sku, marketplaceId: AMAZON_TEST.marketplaceId, includedData: ['summaries', 'attributes'] })
        const fa = ((r.rawResponse as any)?.attributes?.fulfillment_availability ?? []) as Array<{ fulfillment_channel_code?: string; quantity?: number }>
        return { asin: r.asin, status: r.status, codes: fa.map(f => f.fulfillment_channel_code), quantity: fa.find(f => f.fulfillment_channel_code === 'DEFAULT')?.quantity ?? null,
          offer: (r.rawResponse as any)?.attributes?.purchasable_offer ? 'present' : 'absent' }
      }
      const send = async (quantity: number) => {
        const payload = await buildAmazonListingPatch({ quantity } as never, 'IT', AMAZON_TEST.productType, 'FBM')
        const out: Record<string, unknown> = { payload }
        const sent = await listingPublishService.publish({ channel: 'AMAZON', marketplaceId: AMAZON_TEST.marketplaceId, sku: AMAZON_TEST.sku, productId: null, digest: digestPayload(payload),
          gate: { getMode: gate.getAmazonPublishMode, checkCircuit: gate.checkAmazonCircuit, acquireToken: gate.acquireAmazonPublishToken, recordOutcome: gate.recordAmazonOutcome },
          resolveSeller: async () => ({ id: sellerId }),
          execute: async ({ sellerId: sid }: { sellerId: string }) => {
            const res = await client.submitListingPayload({ sellerId: sid, sku: AMAZON_TEST.sku, payload, marketplaceId: AMAZON_TEST.marketplaceId })
            out.submit = { success: res.success, status: res.status, error: res.error ?? null, dryRun: res.dryRun ?? false, issues: (res.rawResponse as any)?.issues ?? [] }
            return { ok: res.success, error: res.error }
          } } as never)
        out.publish = { success: (sent as any).success, status: (sent as any).status, mode: (sent as any).mode }
        return out
      }
      const poll = async (want: number) => { const reads: unknown[] = []; for (let i = 0; i < 8; i++) { await wait(15_000); const r = await read(); reads.push({ afterSeconds: (i + 1) * 15, ...r }); if (r.quantity === want) break } return reads }
      const before = await read()
      report.before = before
      if (before.asin !== AMAZON_TEST.asin || before.codes.some(c => c !== 'DEFAULT') || !before.quantity || before.quantity <= 0) throw new Error(`not a safe test state: ${JSON.stringify(before)}`)
      writeFileSync(`${ROOT}/docs/product-cheat/records/step-1.3-amazon-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify({ ...AMAZON_TEST, ...before }, null, 1))
      try {
        report.unpublish = await send(0)
        report.afterUnpublish = await poll(0)
      } finally {
        report.restore = await send(before.quantity)
        report.afterRestore = await poll(before.quantity)
        const last = (report.afterRestore as Array<{ quantity: number | null }>).at(-1)
        report.restored = last?.quantity === before.quantity
      }
      return
    }
    // ── eBay ──
    try {
      const listing = await prisma.channelListing.findFirst({
        where: { channel: 'EBAY', marketplace: 'IT', externalListingId: { not: null }, channelConnectionId: { not: null }, isPublished: true,
          product: { deletedAt: null, NOT: { sku: { startsWith: 'AIREON' } } } },
        include: { product: { select: { sku: true } } }, orderBy: { updatedAt: 'desc' } })
      if (!listing) throw new Error('no live eBay·IT listing')
      const { ebayAuthService } = await import(`${ROOT}/apps/api/src/services/ebay-auth.service.js`)
      const { callTradingApi } = await import(`${ROOT}/apps/api/src/services/ebay-trading-api.service.js`)
      const token = await ebayAuthService.getValidToken(listing.channelConnectionId!)
      const ctx = { oauthToken: token, siteId: 101, connectionId: listing.channelConnectionId! }
      const prefs = (await callTradingApi('GetUserPreferences', `<?xml version="1.0" encoding="utf-8"?><GetUserPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ShowOutOfStockControlPreference>true</ShowOutOfStockControlPreference></GetUserPreferencesRequest>`, ctx)).raw ?? ''
      const item = (await callTradingApi('GetItem', `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${listing.externalListingId}</ItemID><DetailLevel>ReturnAll</DetailLevel><OutputSelector>Item.ItemID,Item.Quantity,Item.SellingStatus.QuantitySold,Item.SellingStatus.ListingStatus,Item.Variations.Variation.SKU,Item.Variations.Variation.Quantity,Item.Variations.Variation.SellingStatus.QuantitySold,Item.OutOfStockControl</OutputSelector></GetItemRequest>`, ctx)).raw ?? ''
      const variations = [...item.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map(m => ({ sku: tag(m[1], 'SKU'), quantity: Number(tag(m[1], 'Quantity')), sold: Number(tag(m[1], 'QuantitySold') ?? 0) }))
      report.ebay = { account: listing.channelConnectionId, itemId: listing.externalListingId, productSku: listing.product.sku,
        preferenceAck: tag(prefs, 'Ack'), outOfStockControlPreference: tag(prefs, 'OutOfStockControlPreference'), itemOutOfStockControl: tag(item, 'OutOfStockControl'),
        itemAck: tag(item, 'Ack'), listingStatus: tag(item, 'ListingStatus'), itemQuantity: tag(item, 'Quantity'),
        variations: variations.slice(0, 12), variationCount: variations.length }
    } catch (error) { report.ebay = { error: error instanceof Error ? error.message : String(error) } }
    // ── Amazon (merchant-fulfilled only; FBA stays refused) ──
    try {
      // Nexus marks these merchant-fulfilled, but Amazon can hold an FBA offer beside the merchant one (measured: GALE
      // BLACK-MEN-S has AMAZON_EU + DEFAULT). Merchant quantity 0 would not stop such a SKU selling, and FBA is never
      // touched — so the candidate must be MERCHANT-ONLY on Amazon's own read. Up to 15 are read, the first that is wins.
      const listings = await prisma.channelListing.findMany({
        where: { channel: 'AMAZON', marketplace: 'IT', externalListingId: { not: null }, channelConnectionId: { not: null }, isPublished: true,
          OR: [{ fulfillmentMethod: 'FBM' }, { fulfillmentMethod: null, product: { fulfillmentMethod: { not: 'FBA' } } }],
          quantity: { gt: 0 }, product: { deletedAt: null, NOT: { sku: { startsWith: 'AIREON' } } } },
        include: { product: { select: { sku: true } }, offers: { where: { isActive: true }, select: { sku: true } } }, orderBy: { updatedAt: 'desc' }, take: 15 })
      const { AmazonSpApiClient } = await import(`${ROOT}/apps/api/src/clients/amazon-sp-api.client.js`)
      const { getAmazonSellerId } = await import(`${ROOT}/apps/api/src/lib/amazon-sp-client.js`)
      const seen: unknown[] = []
      for (const listing of listings) {
        const account = await prisma.channelConnection.findUniqueOrThrow({ where: { id: listing.channelConnectionId! }, select: { id: true, region: true } })
        const sku = listing.offers[0]?.sku ?? listing.product.sku
        const r = await new AmazonSpApiClient({ id: account.id, region: account.region ?? 'eu' }).getListingsItem({ sellerId: await getAmazonSellerId(account.id), sku, marketplaceId: 'APJ6JRA9NG5V4', includedData: ['summaries', 'attributes'] })
        const fa = ((r.rawResponse as any)?.attributes?.fulfillment_availability ?? []) as Array<{ fulfillment_channel_code?: string; quantity?: number }>
        const merchantOnly = fa.length > 0 && fa.every(f => f.fulfillment_channel_code === 'DEFAULT') && (fa[0].quantity ?? 0) > 0
        seen.push({ sku, asin: r.asin, status: r.status, codes: fa.map(f => `${f.fulfillment_channel_code}:${f.quantity ?? '-'}`), merchantOnly })
        if (merchantOnly && r.asin) {
          report.amazon = { sku, asin: r.asin, storedAsin: listing.externalListingId, status: r.status, ourQuantity: listing.quantity, fulfillmentAvailability: fa,
            productType: (r.rawResponse as any)?.summaries?.[0]?.productType ?? null, accountId: account.id, candidatesRead: seen.length }
          break
        }
      }
      if (!report.amazon) report.amazon = { none: 'no merchant-only candidate among those read', seen }
    } catch (error) { report.amazon = { error: error instanceof Error ? error.message : String(error) } }
  })
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
} finally {
  await prisma.$disconnect().catch(() => undefined)
}
const path = `${ROOT}/docs/product-cheat/records/step-1.3-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(path, JSON.stringify(report, null, 1))
console.log(`REPORT ${JSON.stringify(report)}`)
console.log(`record: ${path}`)
process.exit(0)
