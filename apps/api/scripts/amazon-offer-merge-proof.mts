/**
 * The read-only proof of the Amazon offer merge — run BEFORE NEXUS_AMAZON_OFFER_MERGE goes on (Owner, 2026-09-30).
 *
 * For ONE listing it prints:
 *   (a) what Nexus stores (price, sale, sale window, the market's currency) — read in a READ ONLY transaction;
 *   (b) the live purchasable_offer, verbatim, read through the gateway client;
 *   (c) the exact merge each price sender (the queue's push, the pricing-engine push) would send with the switch ON
 *       for the CURRENT live price — a no-op price;
 *   (d) Amazon's VALIDATION_PREVIEW answer to that merge ("validated without persisting").
 * Nothing is saved in Nexus or on Amazon. The only Amazon calls are the read and the preview, through
 * `previewOnlyClient` (src/services/amazon/offer-merge-proof.ts), which refuses every other client method — pinned by
 * `offer-merge-proof.vitest.test.ts`, which also scans this file for any write method.
 *
 * Where: on the Railway worker, which holds the key that decrypts the channel credentials (a laptop cannot). The lead
 * runs it, with the Owner's word, after the branch is deployed:
 *
 *   railway ssh --service <the worker service>
 *   cd apps/api && npx tsx scripts/amazon-offer-merge-proof.mts --sku <seller SKU> --market IT \
 *     [--connection <channelConnectionId>] [--alias <aliasKey>] [--workspace <workspaceId>]
 *
 * `--connection` / `--alias` pick the listing when the SKU is listed on that market by more than one account or alias.
 */
import '../src/env.js'

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const SKU = arg('sku')
const MARKET = arg('market')?.toUpperCase()
const CONNECTION = arg('connection')
const ALIAS = arg('alias')
const WORKSPACE = arg('workspace') ?? 'nexus_legacy_workspace'
if (!SKU || !MARKET) {
  console.error('usage: npx tsx scripts/amazon-offer-merge-proof.mts --sku <seller SKU> --market <IT|DE|…> [--connection <id>] [--alias <key>] [--workspace <id>]')
  process.exit(1)
}

const { default: prisma } = await import('../src/db.js')
const { withWorkspace } = await import('../src/lib/workspace-context.js')
const { readSaleWindows } = await import('../src/services/pim/sale-window.js')
const { amazonMarketplaceIdOrNull, buildAmazonListingPatch } = await import('../src/services/outbound-sync.service.js')
const { getAmazonSellerId } = await import('../src/lib/amazon-sp-client.js')
const { amazonSpApiClient } = await import('../src/clients/amazon-sp-api.client.js')
const { amazonListingPriceOffer } = await import('../src/services/amazon/purchasable-offer.js')
const { inReadOnlyTransaction, previewOnlyClient, runOfferMergeProof } = await import('../src/services/amazon/offer-merge-proof.js')

let exitCode = 0
try {
  await withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
    // (a) — the database, read-only.
    const stored = await inReadOnlyTransaction(prisma, async (tx) => {
      const listings = await tx.channelListing.findMany({
        where: { channel: 'AMAZON', marketplace: MARKET, product: { sku: SKU }, ...(CONNECTION ? { channelConnectionId: CONNECTION } : {}), ...(ALIAS !== undefined ? { aliasKey: ALIAS } : {}) },
        select: {
          id: true, channelConnectionId: true, aliasKey: true, price: true, priceOverride: true, followMasterPrice: true, salePrice: true,
          fulfillmentMethod: true, syncPaused: true, offerClosedAt: true, platformAttributes: true, product: { select: { sku: true, productType: true, basePrice: true } },
        },
        take: 5,
      })
      const windows = listings.length === 1 ? await readSaleWindows(tx as never, [listings[0].id]) : new Map()
      const marketplace = await tx.marketplace.findFirst({ where: { channel: 'AMAZON', code: MARKET }, select: { code: true, currency: true, taxInclusive: true, marketplaceId: true } })
      return { listings, window: listings.length === 1 ? windows.get(listings[0].id) ?? null : null, marketplace }
    })
    if (stored.listings.length !== 1) {
      console.log(`Found ${stored.listings.length} Amazon ${MARKET} listing(s) for ${SKU}${stored.listings.length ? ' — name one with --connection / --alias:' : '.'}`)
      for (const l of stored.listings) console.log(`  connection=${l.channelConnectionId} alias=${JSON.stringify(l.aliasKey)}`)
      exitCode = 1
      return
    }
    const listing = stored.listings[0]
    const marketplaceId = amazonMarketplaceIdOrNull(MARKET)
    if (!marketplaceId) { console.log(`Amazon · ${MARKET} has no marketplace id. Nothing was done.`); exitCode = 1; return }
    if (!listing.channelConnectionId) { console.log('The listing names no Amazon account. Nothing was done.'); exitCode = 1; return }
    const sellerId = await getAmazonSellerId(listing.channelConnectionId)
    if (!sellerId) { console.log('No seller id for the listing\'s account. Nothing was done.'); exitCode = 1; return }
    const productType = String((listing.platformAttributes as { productType?: string } | null)?.productType ?? listing.product?.productType ?? '').toUpperCase()
    if (!productType) { console.log('No product type on the listing or the product. Nothing was done.'); exitCode = 1; return }
    const market = stored.marketplace

    const result = await runOfferMergeProof({
      sellerId, sku: SKU, market: MARKET, marketplaceId, productType,
      stored: { listing, saleWindow: stored.window, marketplace: market },
      senders: [
        // The queue's push (syncToAmazon): the builder's instance, as `buildAmazonListingPatch` makes it.
        { name: 'queue price push (syncToAmazon)', buildOffer: async (price) => (await buildAmazonListingPatch({ price }, MARKET, productType)).patches[0].value[0] },
        // The pricing-engine push (pushPriceUpdate) prices in its snapshot's currency; the market's stands in for it here.
        ...(market?.marketplaceId && market.currency
          ? [{ name: 'pricing-engine push (pushPriceUpdate)', buildOffer: (price: number) => amazonListingPriceOffer({ marketplaceId: market.marketplaceId!, currencyCode: market.currency, price, taxInclusive: market.taxInclusive ?? false }) }]
          : []),
      ],
      client: previewOnlyClient(amazonSpApiClient),
      print: (text) => console.log(text),
    })
    if (result.read === 'failed' || result.previews.some((p) => (p.answer as { ok?: boolean })?.ok !== true)) exitCode = 1
  })
} finally {
  await prisma.$disconnect().catch(() => undefined)
}
// The queue module holds Redis connections open; the proof is done.
process.exit(exitCode)
