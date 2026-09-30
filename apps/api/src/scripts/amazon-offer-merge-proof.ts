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
 * `previewOnlyClient` (services/amazon/offer-merge-proof.ts), which refuses every other client method; the raw client
 * never leaves `loadRuntime`. Pinned by `services/amazon/offer-merge-proof.vitest.test.ts`, which also scans this file
 * (and its compiled form, when built) for any write.
 *
 * Compiled with the API (`npm run build` → dist/scripts/), so it runs on the production image, which has no tsx. On
 * the Railway worker — the only place the channel credentials can be decrypted — from the image's /app:
 *
 *   railway ssh --service <the worker service>
 *   node apps/api/dist/scripts/amazon-offer-merge-proof.js --sku <seller SKU> --market IT \
 *     [--connection <channelConnectionId>] [--alias <aliasKey>] [--workspace <workspaceId>]
 *
 * `--connection` / `--alias` pick the listing when the SKU is listed on that market by more than one account or alias.
 * It refuses to run anywhere but a Railway replica (RAILWAY_REPLICA_ID), BEFORE it loads any .env or opens any
 * connection: on a laptop the repo-root .env holds production credentials (CLAUDE.md, hard rule 1).
 */
import { pathToFileURL } from 'node:url'
// Types only: a value import of the app would load db.js — and with it any .env — before the Railway check runs.
import type { PreviewOnlyClient, inReadOnlyTransaction, runOfferMergeProof } from '../services/amazon/offer-merge-proof.js'

export const PROOF_USAGE = 'usage: node apps/api/dist/scripts/amazon-offer-merge-proof.js --sku <seller SKU> --market <IT|DE|…> [--connection <channelConnectionId>] [--alias <aliasKey>] [--workspace <workspaceId>]'

export interface ProofArguments { help: boolean; sku?: string; market?: string; connection?: string; alias?: string; workspace: string }

export function parseProofArguments(args: string[]): ProofArguments {
  const options: ProofArguments = { help: false, workspace: 'nexus_legacy_workspace' }
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (key === '--help' || key === '-h') { options.help = true; continue }
    const value = args[i + 1]
    if (!['--sku', '--market', '--connection', '--alias', '--workspace'].includes(key)) throw new Error(`Unknown argument ${key}. ${PROOF_USAGE}`)
    if (seen.has(key) || value === undefined || value.startsWith('--')) throw new Error(`${key} needs one value. ${PROOF_USAGE}`)
    seen.add(key)
    i++
    if (key === '--sku') options.sku = value
    else if (key === '--market') options.market = value.toUpperCase()
    else if (key === '--connection') options.connection = value
    else if (key === '--alias') options.alias = value
    else options.workspace = value
  }
  return options
}

/** Everything the proof needs from the app, loaded only after the arguments and the Railway check pass. */
export interface ProofRuntime {
  prisma: any
  withWorkspace: <T>(context: { workspaceId: string; actorUserId: null; membershipId: null; roleKeys: string[] }, work: () => Promise<T>) => Promise<T>
  readSaleWindows: (db: never, ids: readonly string[]) => Promise<Map<string, { start: string | null; end: string | null }>>
  amazonMarketplaceIdOrNull: (market: string) => string | null
  buildAmazonListingPatch: (payload: { price: number }, market: string, productType: string) => Promise<Record<string, any>>
  getAmazonSellerId: (connectionId: string) => Promise<string | null>
  amazonListingPriceOffer: (input: { marketplaceId: string; currencyCode: string; price: number; taxInclusive: boolean }) => Record<string, unknown>
  inReadOnlyTransaction: typeof inReadOnlyTransaction
  runOfferMergeProof: typeof runOfferMergeProof
  /** The gateway client, ALREADY wrapped: the read and VALIDATION_PREVIEW only. */
  client: PreviewOnlyClient
}

export async function loadRuntime(): Promise<ProofRuntime> {
  // db.js first: it loads the environment before anything reads it.
  const { default: prisma } = await import('../db.js')
  const { withWorkspace } = await import('../lib/workspace-context.js')
  const { readSaleWindows } = await import('../services/pim/sale-window.js')
  const { amazonMarketplaceIdOrNull, buildAmazonListingPatch } = await import('../services/outbound-sync.service.js')
  const { getAmazonSellerId } = await import('../lib/amazon-sp-client.js')
  const { amazonListingPriceOffer } = await import('../services/amazon/purchasable-offer.js')
  const { inReadOnlyTransaction, previewOnlyClient, runOfferMergeProof } = await import('../services/amazon/offer-merge-proof.js')
  const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')
  return {
    prisma, withWorkspace: withWorkspace as ProofRuntime['withWorkspace'], readSaleWindows: readSaleWindows as ProofRuntime['readSaleWindows'],
    amazonMarketplaceIdOrNull, buildAmazonListingPatch: buildAmazonListingPatch as ProofRuntime['buildAmazonListingPatch'],
    getAmazonSellerId, amazonListingPriceOffer, inReadOnlyTransaction, runOfferMergeProof, client: previewOnlyClient(amazonSpApiClient),
  }
}

/** Returns the exit code. Throws (nothing loaded, nothing sent) on bad arguments or outside a Railway replica. */
export async function offerMergeProofMain(args: string[], env: NodeJS.ProcessEnv, load: () => Promise<ProofRuntime> = loadRuntime, print: (text: string) => void = console.log): Promise<number> {
  const options = parseProofArguments(args)
  if (options.help) { print(PROOF_USAGE); return 0 }
  const { sku, market, connection, alias, workspace } = options
  if (!sku || !market) throw new Error(`--sku and --market are required. ${PROOF_USAGE}`)
  if (!env.RAILWAY_REPLICA_ID) {
    throw new Error('Refusing: this proof runs only on a Railway replica (the worker), where the channel credentials can be decrypted — never from a laptop, whose repo-root .env holds production credentials. Nothing was loaded, read or sent.')
  }

  const runtime = await load()
  const { prisma } = runtime
  let exitCode = 0
  try {
    await runtime.withWorkspace({ workspaceId: workspace, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
      // (a) — the database, read-only.
      const stored = await runtime.inReadOnlyTransaction(prisma, async (tx) => {
        const listings = await tx.channelListing.findMany({
          where: { channel: 'AMAZON', marketplace: market, product: { sku }, ...(connection ? { channelConnectionId: connection } : {}), ...(alias !== undefined ? { aliasKey: alias } : {}) },
          select: {
            id: true, channelConnectionId: true, aliasKey: true, price: true, priceOverride: true, followMasterPrice: true, salePrice: true,
            fulfillmentMethod: true, syncPaused: true, offerClosedAt: true, platformAttributes: true, product: { select: { sku: true, productType: true, basePrice: true } },
          },
          take: 5,
        })
        const windows = listings.length === 1 ? await runtime.readSaleWindows(tx as never, [listings[0].id]) : new Map()
        const marketplace = await tx.marketplace.findFirst({ where: { channel: 'AMAZON', code: market }, select: { code: true, currency: true, taxInclusive: true, marketplaceId: true } })
        return { listings, window: listings.length === 1 ? windows.get(listings[0].id) ?? null : null, marketplace }
      })
      if (stored.listings.length !== 1) {
        print(`Found ${stored.listings.length} Amazon ${market} listing(s) for ${sku}${stored.listings.length ? ' — name one with --connection / --alias:' : '.'}`)
        for (const l of stored.listings) print(`  connection=${l.channelConnectionId} alias=${JSON.stringify(l.aliasKey)}`)
        exitCode = 1
        return
      }
      const listing = stored.listings[0]
      const marketplaceId = runtime.amazonMarketplaceIdOrNull(market)
      if (!marketplaceId) { print(`Amazon · ${market} has no marketplace id. Nothing was done.`); exitCode = 1; return }
      if (!listing.channelConnectionId) { print('The listing names no Amazon account. Nothing was done.'); exitCode = 1; return }
      const sellerId = await runtime.getAmazonSellerId(listing.channelConnectionId)
      if (!sellerId) { print('No seller id for the listing\'s account. Nothing was done.'); exitCode = 1; return }
      const productType = String((listing.platformAttributes as { productType?: string } | null)?.productType ?? listing.product?.productType ?? '').toUpperCase()
      if (!productType) { print('No product type on the listing or the product. Nothing was done.'); exitCode = 1; return }
      const mp = stored.marketplace

      const result = await runtime.runOfferMergeProof({
        sellerId, sku, market, marketplaceId, productType,
        stored: { listing, saleWindow: stored.window, marketplace: mp },
        senders: [
          // The queue's push (syncToAmazon): the builder's instance, as `buildAmazonListingPatch` makes it.
          { name: 'queue price push (syncToAmazon)', buildOffer: async (price) => (await runtime.buildAmazonListingPatch({ price }, market, productType)).patches[0].value[0] },
          // The pricing-engine push (pushPriceUpdate) prices in its snapshot's currency; the market's stands in for it here.
          ...(mp?.marketplaceId && mp.currency
            ? [{ name: 'pricing-engine push (pushPriceUpdate)', buildOffer: (price: number) => runtime.amazonListingPriceOffer({ marketplaceId: mp.marketplaceId, currencyCode: mp.currency, price, taxInclusive: mp.taxInclusive ?? false }) }]
            : []),
        ],
        client: runtime.client,
        print,
      })
      if (result.read === 'failed' || result.previews.length === 0 || result.previews.some((p) => (p.answer as { ok?: boolean })?.ok !== true)) exitCode = 1
    })
  } finally {
    await prisma.$disconnect?.().catch(() => undefined)
  }
  return exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // process.exit: the queue module the builder imports holds Redis connections open.
  offerMergeProofMain(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) },
  )
}
