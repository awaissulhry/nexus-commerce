/**
 * Amazon sheet gaps (bug 3) — THE quantity an Amazon listing is sent, for every sender: the stock job
 * (`outbound-sync.service.ts` `syncToAmazon`) and studio Publish. Publish used to work out its own number (the buffer
 * off a PINNED quantity, stock in warehouses that do not serve the market), so the same listing went live with one
 * number and was corrected minutes later by the job with another.
 *
 * The job's steps, in its order and with its sentences:
 *   1. FBA (`isFbaCoordinate` with FBA stock on hand and an active FBA offer) → no quantity at all;
 *   2. the listing's latest committed quantity (`ChannelListing.quantity`, the cascade writes it), else the requested
 *      one — or, for a sender with no request (Publish), the resolver's verdict;
 *   3. the oversell clamp: no more than the stock routed to this market minus the listing's buffer; no routed location
 *      on a pooled product → refused, never capped to 0;
 *   4. the Amazon EU shared-quantity guard: sibling EU markets that disagree → refused; a guard that cannot run → held.
 *      Step 2: with the product's ledger, Follow siblings must also sell from the same warehouses (`withEuSources`).
 * Kill switches as the job reads them: `NEXUS_SYNC_ORDERING_V2=0`, `NEXUS_OVERSELL_CLAMP=0`, `NEXUS_EU_SHARED_QTY_GUARD=0`.
 *
 * `amazonSendQuantity` is pure; `loadAmazonSendQuantity` runs the job's reads for one listing and calls it.
 */
import type { Prisma } from '@prisma/client'
import { isFbaCoordinate } from '../../lib/amazon-fulfillment.js'
import { AMAZON_EU_SHARED_MARKETS, detectEuIntentConflict, EU_GUARD_REMEDY, type EuIntentRow } from '../amazon-eu-quantity-guard.js'
import { computeAvailableToPublish } from '../available-to-publish.service.js'
import { ledgerInputs, loadSyncLedgers, type ProductLedger } from '../stock-pool/sync-ledgers.js'
import { resolveIntendedQuantity, routedAvailable, sellsFrom } from '../sync-control-core.js'
import { sharesAmazonSellerSku } from '../listings/listing-send-sku.js'
import { liveChannelSku, wantedChannelSku } from '../listings/channel-sku.pure.js'
import { loadChannelPolicies, policyFor } from '../sync-control-policy.service.js'

export interface SendQuantityListing {
  marketplace: string | null
  /** `ChannelListing.quantity` — the latest committed number. */
  quantity: number | null
  followMasterQuantity: boolean | null
  stockBuffer: number | null
  sourceLocationCodes: string[] | null
  fulfillmentMethod: string | null
  platformAttributes: unknown
  syncPaused?: boolean | null
  offerClosedAt?: unknown
}

export interface SendQuantityInput {
  sku: string
  /** The job may run a row with no listing (`cl` null); Publish always has one. */
  listing: SendQuantityListing | null
  product: { id: string | null; fulfillmentMethod: string | null }
  /** `loadSyncLedgers`' answer for the product. */
  ledger: ProductLedger | undefined
  evidence: { fbaStockQty: number | null; hasActiveFbaOffer: boolean }
  /** The queue payload's quantity (the job). Absent for Publish: the resolver's number is used when the listing has none. */
  requested?: number | null
  /** The market of the push (the listing's, else the row's). */
  marketplace?: string | null
  channelPolicy?: { pushesPaused: boolean } | null
  /** Sibling Amazon rows of the SKU, as the job reads them; `euRowsError` = the read failed (held, never sent blind). */
  euRows?: EuIntentRow[] | null
  euRowsError?: string | null
  switches?: { orderingV2?: boolean; oversellClamp?: boolean; euGuard?: boolean }
}

/** Flat on purpose: `apps/api` is not strict, so a discriminated union would not narrow. */
export interface SendQuantity {
  /** The number to send; null = send none (FBA, or refused). */
  quantity: number | null
  fba: boolean
  refusal: string | null
  code: 'NO_ROUTED_LOCATION' | 'EU_SHARED_QTY_CONFLICT' | 'EU_SHARED_QTY_GUARD_UNAVAILABLE' | 'NO_QUANTITY' | null
  /** Before the clamp, and the ceiling it was held to — the job's `sync.oversell.clamped` event reads them. */
  requested: number | null
  available: number | null
  clamped: boolean
  euConflict: { detail: string; rows: EuIntentRow[] } | null
}

const none = (over: Partial<SendQuantity>): SendQuantity =>
  ({ quantity: null, fba: false, refusal: null, code: null, requested: null, available: null, clamped: false, euConflict: null, ...over })

/**
 * P4.3d — the oversell ceiling, routed the same way the intended quantity is (the job's `routedCeiling`, pure): the
 * units the product's ledger holds in the locations routed to this market, minus the listing's buffer. `refusal` when
 * nothing is routed there and uncounted does not mean zero (a pooled product): the ceiling is unknown, never 0.
 */
export function routedSendCeiling(ledger: ProductLedger | undefined, args: {
  channel: string; channelLabel: string; marketplace: string; sourceLocationCodes: string[]; stockBuffer: number
}): { available: number; routedAvailable: number; locationCodes: string[]; refusal: string | null } {
  const inputs = ledgerInputs(ledger, args.sourceLocationCodes)
  const routed = routedAvailable({ ledger: inputs.ledger, channel: args.channel, marketplace: args.marketplace, sourceLocationCodes: inputs.sourceLocationCodes })
  return {
    available: computeAvailableToPublish({ fulfillmentMethod: 'FBM', warehouseAvailable: routed.available, fbaSellable: 0, stockBuffer: args.stockBuffer }).available,
    routedAvailable: routed.available,
    locationCodes: routed.locationCodes,
    refusal: !routed.routed && !inputs.uncountedIsZero
      ? `Nothing was sent to ${args.channelLabel}: no stock location is routed to ${args.marketplace} for this listing, so the quantity it may promise cannot be worked out. Route a location to this market in Sync Control.`
      : null,
  }
}

const switchOn = (name: string) => process.env[name] !== '0'

/** PURE — the quantity this Amazon listing is sent now, or why none is. */
export function amazonSendQuantity(input: SendQuantityInput): SendQuantity {
  const { listing, product, sku } = input
  const sw = {
    orderingV2: input.switches?.orderingV2 ?? switchOn('NEXUS_SYNC_ORDERING_V2'),
    oversellClamp: input.switches?.oversellClamp ?? switchOn('NEXUS_OVERSELL_CLAMP'),
    euGuard: input.switches?.euGuard ?? switchOn('NEXUS_EU_SHARED_QTY_GUARD'),
  }
  // 1 — FBA beats everything: Amazon owns the quantity.
  if (isFbaCoordinate(listing, product, input.evidence)) return none({ fba: true })

  // 2 — the latest committed number (the job's `resolveDispatchQuantity`), else the request, else the resolver's.
  const requested = typeof input.requested === 'number' ? input.requested : undefined
  const held = typeof listing?.quantity === 'number' ? listing.quantity : undefined
  let quantity = sw.orderingV2 && listing && requested !== undefined ? held ?? requested : requested ?? held
  const market = String(listing?.marketplace ?? input.marketplace ?? '')
  if (quantity === undefined) {
    const verdict = resolveIntendedQuantity({
      channel: 'AMAZON', marketplace: market, isFba: false, offerClosed: !!listing?.offerClosedAt,
      followMasterQuantity: listing?.followMasterQuantity !== false, syncPaused: !!listing?.syncPaused,
      pinnedQuantity: listing?.quantity ?? null, stockBuffer: listing?.stockBuffer ?? 0, channelPolicy: input.channelPolicy ?? null,
      ...ledgerInputs(input.ledger, listing?.sourceLocationCodes ?? []),
    })
    if ((verdict.kind === 'FOLLOW' || verdict.kind === 'PINNED') && typeof verdict.quantity === 'number') quantity = verdict.quantity
    else {
      const why = verdict.kind === 'PAUSED' ? `its pushes are paused (${verdict.via === 'POLICY' ? 'channel policy' : 'this listing'})`
        : verdict.kind === 'CLOSED' ? 'its offer on this market is closed'
        : verdict.kind === 'UNCOUNTED' ? `no stock location is routed to ${market} for it`
        : 'it has no quantity of its own'
      return none({ refusal: `No quantity was worked out for ${sku}: ${why}.`, code: 'NO_QUANTITY' })
    }
  }
  const out = none({ quantity, requested: quantity })

  // 3 — the oversell clamp, routed (P4.3d).
  if (sw.oversellClamp && product.id) {
    const ceiling = routedSendCeiling(input.ledger, {
      channel: 'AMAZON', channelLabel: 'Amazon', marketplace: market,
      sourceLocationCodes: listing?.sourceLocationCodes ?? [], stockBuffer: listing?.stockBuffer ?? 0,
    })
    if (ceiling.refusal) return none({ refusal: ceiling.refusal, code: 'NO_ROUTED_LOCATION', requested: quantity, available: null })
    out.available = ceiling.available
    if (quantity > ceiling.available) { out.quantity = ceiling.available; out.clamped = true }
  }

  // 4 — the Amazon EU shared-quantity guard (SCT.4; fail closed, D9).
  if (sw.euGuard && product.id && AMAZON_EU_SHARED_MARKETS.has(String(listing?.marketplace ?? '').toUpperCase())) {
    if (input.euRowsError != null || !input.euRows) {
      const detail = input.euRowsError ?? 'the sibling markets were not read'
      return none({ refusal: `EU shared-quantity guard could not run for ${sku} (${detail}). Push held rather than sent blind: Amazon holds one EU quantity per SKU, so an unchecked push can overwrite another market's intent. It will be retried. ${EU_GUARD_REMEDY}`,
        code: 'EU_SHARED_QTY_GUARD_UNAVAILABLE', requested: quantity, available: out.available })
    }
    const euRows = withEuSources(input.euRows, input.ledger)
    const verdict = detectEuIntentConflict(euRows)
    if (verdict.conflict) {
      return none({ refusal: `EU shared-quantity conflict for ${sku}: ${verdict.detail}. Push refused so no market's intent is silently overwritten. ${EU_GUARD_REMEDY}`,
        code: 'EU_SHARED_QTY_CONFLICT', requested: quantity, available: out.available, euConflict: { detail: verdict.detail, rows: input.euRows } })
    }
  }
  return out
}

/**
 * Step 2 — the EU sibling rows with the warehouses each one sells from (`sellsFrom` over the product's ledger: the
 * row's own list, else the market's, else the routes), so the guard sees two Follow markets that would send two
 * different sums. A row that sells from nothing (UNCOUNTED: it sends nothing) carries no set. Without a ledger the rows
 * are returned as they are and the guard compares what it always did.
 */
export function withEuSources(rows: EuIntentRow[], ledger: ProductLedger | undefined): EuIntentRow[] {
  if (!ledger) return rows
  return rows.map((row) => {
    const inputs = ledgerInputs(ledger, row.sourceLocationCodes ?? [])
    const chosen = sellsFrom({ ledger: inputs.ledger, channel: 'AMAZON', marketplace: row.marketplace, sourceLocationCodes: inputs.sourceLocationCodes })
    return { ...row, sources: chosen.rows.length > 0 || inputs.uncountedIsZero ? chosen.codes : null }
  })
}

type Db = Pick<Prisma.TransactionClient, 'channelListing' | 'stockLevel' | 'offer' | 'stockPoolLink' | '$queryRaw' | '$queryRawUnsafe' | 'syncChannelPolicy'>

/** The seller-SKU facts of a sibling row (`sharesAmazonSellerSku`); the Amazon rule reads no alias or Shopify store. */
const SIBLING_SKU_SELECT = {
  aliasKey: true, channelSku: true, liveChannelSku: true, listingStatus: true, isPublished: true, externalListingId: true,
  platformAttributes: true, flatFileSnapshot: true,
  offers: { select: { sku: true, isActive: true, fulfillmentMethod: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  product: { select: { sku: true } },
} satisfies Prisma.ChannelListingSelect

/**
 * The job's sibling read for the EU guard: every published, not ended Amazon row of the product. With `sku` (S3,
 * per-channel SKU), only the rows that sell under that seller SKU on Amazon (`sharesAmazonSellerSku`): Amazon keeps one
 * EU quantity per seller SKU, so two markets with different seller SKUs hold two quantities, and the same SKU is one
 * shared quantity as before. A row whose SKU cannot be told counts as sharing it (fail closed). Without `sku`, every row.
 */
export async function readEuIntentRows(db: Pick<Prisma.TransactionClient, 'channelListing'>, productId: string, sku?: string | null): Promise<EuIntentRow[]> {
  const rows = await db.channelListing.findMany({
    where: { productId, channel: 'AMAZON', isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
    select: { marketplace: true, followMasterQuantity: true, quantityOverride: true, quantity: true, syncPaused: true, fulfillmentMethod: true, offerClosedAt: true, sourceLocationCodes: true, ...SIBLING_SKU_SELECT },
  })
  const bySku = typeof sku === 'string' && sku.trim() ? sku.trim() : null
  const siblings = bySku ? rows.filter((sib) => sharesAmazonSellerSku(sib, sib.product?.sku, bySku)) : rows
  return siblings.map((sib) => ({
    marketplace: sib.marketplace, followMasterQuantity: sib.followMasterQuantity, quantityOverride: sib.quantityOverride,
    quantity: sib.quantity, syncPaused: sib.syncPaused, isFba: sib.fulfillmentMethod === 'FBA',
    // SCT.6 — a CLOSED market offer expresses no quantity intent, as every other reader of these rows says (the Matrix,
    // Sync Control, the heal job). Without it a closed market pinned at an old number fought a live market's Follow, and
    // the push was refused for a conflict nothing else could see (2026-10-07: GALE BLACK-S, IT Follow 51 vs closed ES 2).
    offerClosed: !!sib.offerClosedAt,
    // Step 2 — the row's own "Sells from" list, when it has one; the sender, which holds the ledger, works out what it
    // sells from (`withEuSources`).
    ...((sib.sourceLocationCodes ?? []).length ? { sourceLocationCodes: sib.sourceLocationCodes } : {}),
  }))
}

/** One listing's send quantity with the job's own reads (FBA evidence, ledger, EU siblings, policy). */
export async function loadAmazonSendQuantity(db: Db, input: { listingId: string; requested?: number | null }): Promise<SendQuantity & { listingFound: boolean }> {
  const listing = await db.channelListing.findUnique({
    where: { id: input.listingId },
    select: {
      id: true, productId: true, marketplace: true, quantity: true, followMasterQuantity: true, stockBuffer: true, sourceLocationCodes: true,
      fulfillmentMethod: true, platformAttributes: true, syncPaused: true, offerClosedAt: true, channelConnectionId: true,
      ...SIBLING_SKU_SELECT,
      product: { select: { id: true, sku: true, fulfillmentMethod: true } },
    },
  })
  if (!listing) return { ...none({ refusal: 'This listing no longer exists, so no quantity was worked out.', code: 'NO_QUANTITY' }), listingFound: false }
  const productId = listing.productId
  const [fbaAgg, fbaOffer, ledgers, policies] = await Promise.all([
    db.stockLevel.aggregate({ where: { productId, location: { code: 'AMAZON-EU-FBA' } }, _sum: { quantity: true } }).catch(() => null),
    db.offer.findFirst({ where: { channelListingId: listing.id, fulfillmentMethod: 'FBA', isActive: true }, select: { id: true } }).catch(() => null),
    loadSyncLedgers(db as never, [productId]),
    loadChannelPolicies(db as never),
  ])
  // S3 — the seller SKU this quantity goes to: the one Amazon holds for the listing, or, for a draft Publish is about
  // to create, the one it will be created under. With no single SKU on record the guard reads every sibling (fail closed).
  const skuFacts = { ...listing, channel: 'AMAZON' }
  const sellerSku = (liveChannelSku(skuFacts, listing.product?.sku) ?? wantedChannelSku(skuFacts, listing.product?.sku)).sku
  let euRows: EuIntentRow[] | null = null
  let euRowsError: string | null = null
  if (AMAZON_EU_SHARED_MARKETS.has(String(listing.marketplace ?? '').toUpperCase())) {
    try { euRows = await readEuIntentRows(db, productId, sellerSku) } catch (err) { euRowsError = err instanceof Error ? err.message : String(err) }
  }
  const result = amazonSendQuantity({
    sku: sellerSku ?? listing.product?.sku ?? input.listingId,
    listing,
    product: { id: listing.product?.id ?? productId, fulfillmentMethod: listing.product?.fulfillmentMethod ?? null },
    ledger: ledgers.get(productId),
    evidence: { fbaStockQty: fbaAgg?._sum.quantity ?? null, hasActiveFbaOffer: !!fbaOffer },
    requested: input.requested,
    channelPolicy: policyFor(policies, 'AMAZON', listing.marketplace, listing.channelConnectionId),
    euRows, euRowsError,
  })
  return { ...result, listingFound: true }
}
