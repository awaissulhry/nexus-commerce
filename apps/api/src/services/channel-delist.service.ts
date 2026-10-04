import { getAmazonSellerId } from '../lib/amazon-sp-client.js'
/**
 * D.2 — channel-delist.service
 *
 * Dispatcher for OutboundSyncQueue rows whose syncType is
 * UNPUBLISH_LISTING (pause the offer, keep the listing record) or
 * DELETE_LISTING (best-effort remove from the channel catalog). Both
 * are enqueued by the /products bulk-hard-delete cascade (D.1).
 *
 * PLAN Step 1.3 (R-39) — unpublish = "stop selling, keep the identifiers":
 *   Amazon: SCT.6's per-market offer close (the channel half in
 *   amazon-market-offer.service.ts); FBA is refused by name. The closed offer is
 *   saved on the job's record (payload.channelEvidence) so a person can put it back.
 *   eBay: quantity 0 on every SKU of the ItemID, only with the item's
 *   out-of-stock control ON (off, 0 would END the ItemID).
 *   There is no republish from Nexus: this flow deletes the local record.
 * Shopify delist refuses both actions until the account-bound adapter lands.
 * No adapter may perform a more destructive action than the caller requested.
 *
 * The OutboundSyncQueue row carries:
 *   - productId          (may be null after hard-delete cascade — that's OK)
 *   - channelListingId   (likely null after cascade — that's OK)
 *   - targetChannel      ("AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE")
 *   - targetRegion       (marketplace code, e.g. "IT", "DE")
 *   - externalListingId  (ASIN | eBay ItemID | Shopify product gid/number)
 *   - payload.channelAction ("unpublish" | "delete")
 *   - payload.sellerSku (Offer.sku in scope, else Product.sku, captured at enqueue)
 *   - payload.channelConnectionId / aliasKey (owning account and alias)
 *
 * Returns the shape the BullMQ worker already understands:
 *   { success: true } on a real change
 *   { success: false, error, retryable } on a failure
 */

import { amazonSpApiClient } from '../clients/amazon-sp-api.client.js'
import { prisma } from '@nexus/database'
import {
  buildReviseInventoryStatusBatchXml, callTradingApi, endFixedPriceItem, escapeXml, parseGetItemQuantities,
  REVISE_INVENTORY_STATUS_MAX_ENTRIES, siteIdForMarket,
} from './ebay-trading-api.service.js'
import { isFbaCoordinate } from '../lib/amazon-fulfillment.js'
import { ebayAuthService } from './ebay-auth.service.js'
import { tryResolveConnection } from './connection-resolver.service.js'
import { DELIST_OPERATOR_COPY, type DelistErrorCode } from './delist-error-codes.js'

export type ChannelAction = 'unpublish' | 'delete'

export interface ChannelDelistJob {
  queueId: string
  productId: string | null
  channelListingId: string | null
  targetChannel: string
  targetRegion: string | null
  externalListingId: string | null
  /** Captured before the local product/listing is removed. Never an ASIN. */
  sellerSku?: string | null
  channelConnectionId?: string | null
  syncType: 'UNPUBLISH_LISTING' | 'DELETE_LISTING'
  payload: any
}

export interface ChannelDelistResult {
  success: boolean
  outcome?: 'SUCCESS' | 'FAILURE' | 'REFUSED' | 'UNKNOWN' | 'NOT_SENT'
  channelFact?: 'UNKNOWN' | 'REFUSED' | 'NOT_SELLING'
  error?: string
  errorCode?: string
  retryable?: boolean
  dryRun?: boolean
  submissionId?: string
  /** What the channel held before the change — saved on the job's record (payload.channelEvidence). */
  evidence?: Record<string, unknown>
}

const AMAZON_MARKETPLACE_IDS: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
  UK: 'A1F83G8C2ARO7P',
  US: 'ATVPDKIKX0DER',
  JP: 'A1VC38T7YXB528',
}

function resolveAmazonMarketplaceId(region: string | null): string | null {
  if (!region) return null
  const upper = region.toUpperCase()
  return AMAZON_MARKETPLACE_IDS[upper] ?? null
}

export async function dispatchChannelDelist(
  job: ChannelDelistJob,
): Promise<ChannelDelistResult> {
  const action: ChannelAction =
    job.syncType === 'UNPUBLISH_LISTING' ? 'unpublish' : 'delete'

  if (!job.externalListingId) return delistRefusal('DELIST_NO_EXTERNAL_ID')

  switch (job.targetChannel) {
    case 'AMAZON':
      return delistAmazon(job, action)
    case 'EBAY':
      return delistEbay(job, action)
    case 'SHOPIFY':
      return delistShopify(job, action)
    case 'WOOCOMMERCE':
    default:
      return delistRefusal('DELIST_UNSUPPORTED_CHANNEL')
  }
}

/**
 * 🔴 PLAN Step 1.2 — the ONE table of "can this (channel, action) pair actually remove a live
 * listing today?".
 *
 * It existed before, three times, as the first line of three adapters: Amazon and eBay refused
 * `unpublish`, Shopify refused both. Nothing outside this file could read those rules, so the
 * /products/bulk-hard-delete route deleted the local product, the adapter then refused, and the
 * listing stayed live on the channel with no product row left to manage it. An orphan.
 *
 * R1 — one rule, one owner. The route asks this function BEFORE deleting; the adapters below ask
 * it instead of restating it. When Step 1.3 implements reversible unpublish, ONE row changes here
 * and the route's refusal lifts with it. A second copy in the route would not have lifted, and
 * would have gone on refusing a delete that had become safe.
 *
 * `removes: false` means "this listing keeps selling after the action". It never means the action
 * errored — that is decided per attempt, further down.
 */
export type EbayOutOfStockControl = 'ON' | 'OFF' | 'UNKNOWN'

/**
 * PLAN Step 1.3 (R-39) — the facts one listing brings to the table. Unpublish depends on them;
 * delete does not.
 */
export interface DelistListingFacts {
  /** The listing as `isFbaCoordinate` reads it (fulfillmentMethod, platformAttributes, product). */
  amazonListing?: Parameters<typeof isFbaCoordinate>[0]
  /** Positive FBA evidence: an active FBA offer, or FBA stock the channel reported. */
  amazonFbaEvidence?: Parameters<typeof isFbaCoordinate>[2]
  /** eBay's out-of-stock control: the account preference (route) or the item's own (adapter). */
  ebayOutOfStockControl?: EbayOutOfStockControl
}

export function delistCapability(
  channel: string,
  action: ChannelAction,
  facts: DelistListingFacts = {},
): { removes: true } | { removes: false; errorCode: DelistErrorCode } {
  switch (channel) {
    case 'AMAZON':
      if (action === 'delete') return { removes: true }
      // Unpublish = SCT.6 close. Nexus never closes an FBA offer, so an FBA listing keeps selling.
      return isFbaCoordinate(facts.amazonListing, facts.amazonListing?.product, facts.amazonFbaEvidence)
        ? { removes: false, errorCode: 'AMAZON_UNPUBLISH_FBA' }
        : { removes: true }
    case 'EBAY':
      if (action === 'delete') return { removes: true }
      // Unpublish = quantity 0, which only HIDES the item while the out-of-stock control is on.
      if (facts.ebayOutOfStockControl === 'ON') return { removes: true }
      return { removes: false, errorCode: facts.ebayOutOfStockControl === 'OFF' ? 'EBAY_UNPUBLISH_OOS_OFF' : 'EBAY_UNPUBLISH_OOS_UNKNOWN' }
    case 'SHOPIFY':
      return { removes: false, errorCode: 'SHOPIFY_DELIST_NOT_IMPLEMENTED' }
    default:
      return { removes: false, errorCode: 'DELIST_UNSUPPORTED_CHANNEL' }
  }
}

function delistRefusal(errorCode: DelistErrorCode, detail?: string): ChannelDelistResult {
  return {
    success: false, outcome: 'REFUSED', channelFact: 'UNKNOWN', retryable: false,
    errorCode, error: DELIST_OPERATOR_COPY[errorCode] + (detail ? ` ${detail}` : ''),
  }
}

function unknownDelist(errorCode: DelistErrorCode, error: unknown, retryable = true): ChannelDelistResult {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    success: false, outcome: 'UNKNOWN', channelFact: retryable ? 'UNKNOWN' : 'REFUSED',
    retryable, errorCode, error: `${DELIST_OPERATOR_COPY[errorCode]} ${detail}`,
  }
}

async function delistAmazon(
  job: ChannelDelistJob,
  action: ChannelAction,
): Promise<ChannelDelistResult> {
  // The payload's own fulfilment first (captured before the delete); the live read decides again below.
  const payloadListing = { fulfillmentMethod: typeof job.payload?.fulfillmentMethod === 'string' ? job.payload.fulfillmentMethod : null }
  const amazonCapability = delistCapability('AMAZON', action, { amazonListing: payloadListing })
  if (amazonCapability.removes === false) return delistRefusal(amazonCapability.errorCode)
  if (!job.targetRegion) return delistRefusal('AMAZON_DELIST_NO_REGION')
  const marketplaceId = resolveAmazonMarketplaceId(job.targetRegion)
  if (!marketplaceId) return delistRefusal('AMAZON_DELIST_UNKNOWN_MARKET')
  const sku = job.sellerSku === undefined ? job.payload?.sellerSku : job.sellerSku
  if (typeof sku !== 'string' || !sku.trim()) return delistRefusal('AMAZON_DELIST_NO_SKU')
  const accountId = job.channelConnectionId === undefined ? job.payload?.channelConnectionId : job.channelConnectionId
  if (typeof accountId !== 'string' || !accountId) return delistRefusal('AMAZON_DELIST_NO_SELLER')
  let sellerId: string
  try {
    sellerId = await getAmazonSellerId(accountId)
  } catch (err) {
    return delistRefusal('AMAZON_DELIST_NO_SELLER', err instanceof Error ? err.message : String(err))
  }
  if (!sellerId) return delistRefusal('AMAZON_DELIST_NO_SELLER')

  if (action === 'unpublish') return unpublishAmazon({ sellerId, sku, marketplaceId, payloadListing })
  return deleteAmazonListingOnChannel({ sellerId, sku, marketplaceId })
}

/**
 * The CHANNEL half of an Amazon delete, one owner for both callers: the hard-delete cascade above and the
 * listing-action engine's Delete listing (listing-action-adapters/amazon.ts, build shape v2). `deleteListingsItem`
 * for THIS marketplace only (`marketplaceIds` names one); other markets keep their listings. The publish mode
 * is the client's own: anything but live answers a dry run (outcome NOT_SENT) and sends nothing.
 */
export async function deleteAmazonListingOnChannel(input: { sellerId: string; sku: string; marketplaceId: string }): Promise<ChannelDelistResult> {
  try {
    const r = await amazonSpApiClient.deleteListingsItem({
      sellerId: input.sellerId,
      sku: input.sku,
      marketplaceId: input.marketplaceId,
    })
    if (!r.success) return unknownDelist('AMAZON_DELIST_UNVERIFIED', r.error ?? 'No acknowledgement received')
    return { success: true, outcome: r.dryRun ? 'NOT_SENT' : 'SUCCESS', submissionId: r.submissionId, dryRun: r.dryRun }
  } catch (e: unknown) {
    return unknownDelist('DELIST_TRANSPORT_UNKNOWN', e)
  }
}

/**
 * PLAN Step 1.3 (R-39) — close THIS marketplace's offer through SCT.6's channel half. Nothing is
 * sent when the read fails (FBA cannot be ruled out), when Amazon reports any non-merchant
 * fulfilment channel (FBA stock — never touched), or when there is no offer to close.
 */
async function unpublishAmazon(input: {
  sellerId: string
  sku: string
  marketplaceId: string
  payloadListing: { fulfillmentMethod: string | null }
}): Promise<ChannelDelistResult> {
  const { closeAmazonOfferOnChannel } = await import('./amazon-market-offer.service.js')
  let attempt: Awaited<ReturnType<typeof closeAmazonOfferOnChannel>>
  try {
    attempt = await closeAmazonOfferOnChannel({
      sellerId: input.sellerId, sku: input.sku, marketplaceId: input.marketplaceId, productType: '',
      refuse: (live) => {
        const fbaStock = live.fulfillmentChannels.some((code) => code !== 'DEFAULT')
        const capability = delistCapability('AMAZON', 'unpublish', { amazonListing: input.payloadListing, amazonFbaEvidence: { hasActiveFbaOffer: fbaStock } })
        return capability.removes ? null : `Amazon reports fulfilment channels: ${live.fulfillmentChannels.join(', ') || 'none'}.`
      },
    })
  } catch (e: unknown) {
    return unknownDelist('DELIST_TRANSPORT_UNKNOWN', e)
  }
  const seen = { sku: input.sku, marketplaceId: input.marketplaceId, fulfillmentChannels: attempt.live.fulfillmentChannels }
  switch (attempt.notSent) {
    case 'LIVE_READ_FAILED': return unknownDelist('AMAZON_UNPUBLISH_READ_FAILED', attempt.detail ?? 'read failed')
    case 'REFUSED': return delistRefusal('AMAZON_UNPUBLISH_FBA', attempt.detail)
    case 'NO_PRODUCT_TYPE': return delistRefusal('AMAZON_UNPUBLISH_NO_PRODUCT_TYPE')
    case 'NO_LIVE_OFFER':
      // Nothing to close: this marketplace has no offer, so the SKU is not selling here.
      return { success: true, outcome: 'SUCCESS', channelFact: 'NOT_SELLING', evidence: { ...seen, offerSnapshot: [], note: 'No offer in this marketplace; nothing was sent.' } }
  }
  const res = attempt.res!
  if (!res.success) return unknownDelist('AMAZON_DELIST_UNVERIFIED', res.error ?? 'No acknowledgement received')
  return {
    success: true, outcome: res.dryRun ? 'NOT_SENT' : 'SUCCESS', submissionId: res.submissionId, dryRun: res.dryRun,
    evidence: { ...seen, offerSnapshot: attempt.snapshot, snapshotSource: attempt.snapshotSource, productType: attempt.productType, submissionId: res.submissionId ?? null },
  }
}

async function delistShopify(
  job: ChannelDelistJob,
  action: ChannelAction,
): Promise<ChannelDelistResult> {
  if (!(job.channelConnectionId === undefined ? job.payload?.channelConnectionId : job.channelConnectionId)) {
    return delistRefusal('SHOPIFY_DELIST_NO_ACCOUNT')
  }
  const shopifyCapability = delistCapability('SHOPIFY', action)
  // The table refuses Shopify for both actions today; if that ever changes, this states the gap
  // rather than silently reporting the old error code.
  if (shopifyCapability.removes === false) return delistRefusal(shopifyCapability.errorCode)
  return delistRefusal('SHOPIFY_DELIST_NOT_IMPLEMENTED')
}

// Ownership/reachability prose never confirms absence. Check refusals FIRST,
// including a response that contains both an ended phrase and an access error.
export const ENDED_CONFIRMED = [
  /already ended/i,
  /already closed/i,
  /auction already closed/i,
  /item has already been (deleted|removed)/i,
]
export const COULD_NOT_ASK = [
  /item cannot be accessed/i,
  /item (is )?not (active|available)/i,
  /listing (is )?not (active|available|found)/i,
  /item not found/i,
  /invalid item/i,
  /not currently available/i,
]

// ── Real EndFixedPriceItem delist ─────────────────────────────────────────

async function delistEbay(
  job: ChannelDelistJob,
  action: ChannelAction,
): Promise<ChannelDelistResult> {
  // Unpublish is decided on the ITEM's own out-of-stock control, read below (unpublishEbay).
  if (action === 'delete') {
    const ebayCapability = delistCapability('EBAY', action)
    if (ebayCapability.removes === false) return delistRefusal(ebayCapability.errorCode)
  }
  const itemId = job.externalListingId
  if (!itemId) return delistRefusal('EBAY_DELIST_NO_ITEMID')

  // Resolve the market before auth so an unknown site never asks the operator
  // to reconnect an otherwise valid account. Absence is not an Italian target.
  if (!job.targetRegion) return delistRefusal('EBAY_DELIST_NO_REGION')
  let siteId: string
  try {
    siteId = siteIdForMarket(job.targetRegion)
  } catch {
    return delistRefusal('EBAY_UNKNOWN_MARKET')
  }

  // The producer captures the account on the exact ItemID/coordinate before
  // deletion. The generic listing/item resolvers may default an unattributed
  // row to the primary account, so a delist never uses those fallback forms.
  const accountId = job.channelConnectionId === undefined ? job.payload?.channelConnectionId : job.channelConnectionId
  if (typeof accountId !== 'string' || !accountId) return delistRefusal('EBAY_DELIST_NO_CONNECTION')
  let oauthToken: string
  try {
    const connection = await tryResolveConnection({ accountId })
    if (!connection || connection.channelType !== 'EBAY') return delistRefusal('EBAY_DELIST_NO_CONNECTION')
    oauthToken = await ebayAuthService.getValidToken(connection.id)
  } catch (err: unknown) {
    return delistRefusal('EBAY_DELIST_AUTH_ERROR', err instanceof Error ? err.message : String(err))
  }

  if (action === 'unpublish') return unpublishEbay(itemId, { oauthToken, siteId, connectionId: accountId, market: job.targetRegion })

  try {
    const ack = await endFixedPriceItem({ itemId }, { oauthToken, siteId, connectionId: accountId })
    const dryRun = ack.itemId?.startsWith('DRYRUN-') === true
    if (!['Success', 'Warning'].includes(ack.ack)) {
      return unknownDelist('EBAY_DELIST_UNVERIFIED', `Acknowledgement: ${ack.ack}`)
    }
    return { success: true, outcome: dryRun ? 'NOT_SENT' : 'SUCCESS', dryRun }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (COULD_NOT_ASK.some(pattern => pattern.test(message))) {
      return unknownDelist('EBAY_DELIST_COULD_NOT_ASK', err, false)
    }
    if (ENDED_CONFIRMED.some(pattern => pattern.test(message))) {
      return { success: true, outcome: 'SUCCESS', channelFact: 'NOT_SELLING' }
    }
    // A received negative acknowledgement is a failure; a lost response is
    // UNKNOWN even when a retry budget is exhausted.
    if (/^eBay EndFixedPriceItem Failure:/i.test(message)) {
      return {
        success: false, outcome: 'FAILURE', retryable: true,
        errorCode: 'EBAY_DELIST_FAILED', error: `${DELIST_OPERATOR_COPY.EBAY_DELIST_FAILED} ${message}`,
      }
    }
    return unknownDelist('DELIST_TRANSPORT_UNKNOWN', err)
  }
}

// ── PLAN Step 1.3 (R-39) — eBay unpublish: quantity 0 under the out-of-stock control ──────────

/** GetItem in the shape proven live on 2026-09-23 (docs/product-cheat/tools/unpublish-probe.mts). */
function buildUnpublishGetItemXml(itemId: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel><OutputSelector>Item.ItemID,Item.Quantity,Item.SellingStatus.QuantitySold,Item.SellingStatus.ListingStatus,Item.Variations.Variation.SKU,Item.Variations.Variation.Quantity,Item.Variations.Variation.SellingStatus.QuantitySold,Item.OutOfStockControl</OutputSelector></GetItemRequest>`
}

/** A single-SKU item: ItemID + Quantity, no SKU (eBay requires a SKU only for variations). */
function buildUnpublishSingleItemXml(itemId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <InventoryStatus>
    <ItemID>${escapeXml(itemId)}</ItemID>
    <Quantity>0</Quantity>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`
}

/** 'true' → ON, 'false' → OFF, absent or anything else → UNKNOWN. */
export function parseOutOfStockControl(raw: string, tag: 'OutOfStockControl' | 'OutOfStockControlPreference'): EbayOutOfStockControl {
  const value = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, 'i').exec(raw ?? '')?.[1]?.toLowerCase()
  return value === 'true' ? 'ON' : value === 'false' ? 'OFF' : 'UNKNOWN'
}

const ACK_OK = new Set(['Success', 'Warning'])
const isGateRefusal = (err: unknown) => (err as { name?: string; code?: string } | null)?.name === 'EbayWriteRefusedError'
  || (err as { code?: string } | null)?.code === 'EBAY_WRITE_REFUSED'

export async function unpublishEbay(
  itemId: string,
  ctx: { oauthToken: string; siteId: string; connectionId: string; market: string },
): Promise<ChannelDelistResult> {
  // 1 — read the item: its out-of-stock control, its status, what each SKU has left.
  let raw: string
  try {
    const read = await callTradingApi('GetItem', buildUnpublishGetItemXml(itemId), ctx)
    if (read.itemId?.startsWith('DRYRUN-')) return { success: true, outcome: 'NOT_SENT', dryRun: true }
    raw = read.raw ?? ''
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (COULD_NOT_ASK.some(pattern => pattern.test(message))) return unknownDelist('EBAY_DELIST_COULD_NOT_ASK', err, false)
    return unknownDelist('DELIST_TRANSPORT_UNKNOWN', err)
  }
  const outOfStockControl = parseOutOfStockControl(raw, 'OutOfStockControl')
  const capability = delistCapability('EBAY', 'unpublish', { ebayOutOfStockControl: outOfStockControl })
  if (capability.removes === false) return delistRefusal(capability.errorCode)
  const item = parseGetItemQuantities(raw)
  if (!item.listingStatus) return unknownDelist('EBAY_DELIST_UNVERIFIED', 'GetItem named no listing status; nothing was sent.')
  const remainingBefore = item.variations.length
    ? item.variations.map(v => ({ sku: v.sku, remaining: v.available }))
    : [{ sku: null as string | null, remaining: item.itemAvailable }]
  const evidence = { itemId, outOfStockControl, listingStatus: item.listingStatus, remainingBefore }
  if (item.listingStatus !== 'Active') return { success: true, outcome: 'SUCCESS', channelFact: 'NOT_SELLING', evidence: { ...evidence, note: 'The item is not active; nothing was sent.' } }
  if (!item.variations.length && item.itemAvailable === null) return unknownDelist('EBAY_DELIST_UNVERIFIED', 'GetItem named no quantity; nothing was sent.')
  const selling = remainingBefore.filter(entry => (entry.remaining ?? 0) > 0)
  if (!selling.length) return { success: true, outcome: 'SUCCESS', channelFact: 'NOT_SELLING', evidence: { ...evidence, note: 'Every quantity is already 0; nothing was sent.' } }

  // 2 — quantity 0: every variation SKU with stock (≤4 per call), or the ItemID of a single item.
  const calls: string[][] = []
  if (item.variations.length) {
    const skus = selling.map(entry => entry.sku as string)
    for (let i = 0; i < skus.length; i += REVISE_INVENTORY_STATUS_MAX_ENTRIES) calls.push(skus.slice(i, i + REVISE_INVENTORY_STATUS_MAX_ENTRIES))
  } else calls.push([])
  const zeroed: string[] = []
  const failures: string[] = []
  for (const chunk of calls) {
    const xml = chunk.length
      ? buildReviseInventoryStatusBatchXml({ itemId, entries: chunk.map(sku => ({ sku, quantity: 0 })) })
      : buildUnpublishSingleItemXml(itemId)
    try {
      const res = await callTradingApi('ReviseInventoryStatus', xml, ctx)
      if (res.itemId?.startsWith('DRYRUN-')) return { success: true, outcome: 'NOT_SENT', dryRun: true }
      if (ACK_OK.has(res.ack)) zeroed.push(...(chunk.length ? chunk : [itemId]))
      else failures.push(`Acknowledgement: ${res.ack}`)
    } catch (err: unknown) {
      if (isGateRefusal(err) && zeroed.length === 0 && failures.length === 0) return { success: true, outcome: 'NOT_SENT', dryRun: true }
      const message = err instanceof Error ? err.message : String(err)
      // A received Failure is a failure; anything else is a lost answer — the outcome is unknown.
      if (!/^eBay \w+ Failure:/i.test(message)) {
        return { ...unknownDelist('DELIST_TRANSPORT_UNKNOWN', err), evidence: { ...evidence, zeroed } }
      }
      failures.push(message)
    }
  }
  if (!failures.length) return { success: true, outcome: 'SUCCESS', channelFact: 'NOT_SELLING', evidence: { ...evidence, zeroed } }
  const errorCode: DelistErrorCode = zeroed.length ? 'EBAY_UNPUBLISH_PARTIAL' : 'EBAY_UNPUBLISH_FAILED'
  return {
    success: false, outcome: 'FAILURE', retryable: true, errorCode,
    error: `${DELIST_OPERATOR_COPY[errorCode]} ${failures.slice(0, 2).join(' | ')}`,
    evidence: { ...evidence, zeroed },
  }
}

/**
 * PLAN Step 1.3 (R-39) — the ACCOUNT's out-of-stock preference, read by the hard-delete route
 * BEFORE its transaction, so an eBay unpublish that could END an ItemID is refused while the
 * product still exists. Bounded; any failure, timeout or dry run is UNKNOWN (fail closed).
 */
export async function readEbayOutOfStockPreference(
  accountId: string,
  market: string,
  timeoutMs = 5_000,
): Promise<EbayOutOfStockControl> {
  const ask = async (): Promise<EbayOutOfStockControl> => {
    const connection = await tryResolveConnection({ accountId })
    if (!connection || connection.channelType !== 'EBAY') return 'UNKNOWN'
    const oauthToken = await ebayAuthService.getValidToken(connection.id)
    const res = await callTradingApi(
      'GetUserPreferences',
      '<?xml version="1.0" encoding="utf-8"?><GetUserPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ShowOutOfStockControlPreference>true</ShowOutOfStockControlPreference></GetUserPreferencesRequest>',
      { oauthToken, siteId: siteIdForMarket(market), connectionId: accountId, market },
    )
    if (res.itemId?.startsWith('DRYRUN-')) return 'UNKNOWN'
    return parseOutOfStockControl(res.raw ?? '', 'OutOfStockControlPreference')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      ask(),
      new Promise<EbayOutOfStockControl>(resolve => { timer = setTimeout(() => resolve('UNKNOWN'), timeoutMs) }),
    ])
  } catch {
    return 'UNKNOWN'
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Convenience: write the same outcome to OutboundSyncQueue that the
 * BullMQ worker would. Used when the delist runs inline rather than
 * via the worker (e.g. tests or one-off scripts).
 */
export async function applyDelistResultToQueue(
  queueId: string,
  result: ChannelDelistResult,
): Promise<void> {
  await prisma.$transaction(async tx => {
    const row = await tx.outboundSyncQueue.findUnique({
      where: { id: queueId },
      select: { retryCount: true, maxRetries: true, payload: true, syncStatus: true, channelListingId: true, productId: true, targetChannel: true, targetRegion: true, externalListingId: true },
    })
    if (!row || row.syncStatus === 'CANCELLED') return
    const outcome = result.dryRun ? 'NOT_SENT' : result.outcome ?? (result.success ? 'SUCCESS' : 'REFUSED')
    const unknown = outcome === 'UNKNOWN'
    const newRetry = result.success ? row.retryCount : row.retryCount + 1
    const exhausted = !result.retryable || newRetry >= row.maxRetries
    const retryAt = result.retryable ? new Date(Date.now() + 60_000 * 2 ** Math.min(newRetry - 1, 6)) : null
    const saved = await tx.outboundSyncQueue.updateMany({
      where: { id: queueId, syncStatus: row.syncStatus },
      data: {
        syncStatus: outcome === 'NOT_SENT' ? 'SKIPPED' : result.success ? 'SUCCESS'
          : !exhausted ? 'PENDING' : unknown ? 'SKIPPED' : 'FAILED',
        syncedAt: outcome === 'SUCCESS' ? new Date() : null,
        errorMessage: result.dryRun ? DELIST_OPERATOR_COPY.DELIST_DRY_RUN : result.error ?? null,
        errorCode: result.dryRun ? 'DELIST_DRY_RUN' : result.errorCode ?? null,
        retryCount: newRetry,
        holdUntil: retryAt,
        nextRetryAt: exhausted ? null : retryAt,
        isDead: !result.success && exhausted,
        diedAt: !result.success && exhausted ? new Date() : null,
        payload: {
          ...(row.payload as Record<string, unknown>),
          delistOutcome: outcome,
          channelFact: result.channelFact ?? 'UNKNOWN',
          // PLAN Step 1.3 — what the channel held before (e.g. the closed Amazon offer), for a hand restore.
          ...(result.evidence ? { channelEvidence: result.evidence as never } : {}),
        },
      },
    })
    if (!saved.count) return
    const payload = row.payload as { channelListingId?: string; productId?: string; marketplace?: string; channelConnectionId?: string; aliasKey?: string; sellerSku?: string; actor?: string; coordinates?: Array<{ productId: string; channel: string; marketplace: string; channelConnectionId: string | null; aliasKey: string }> }
    await tx.productEvent.create({ data: {
      aggregateId: String(payload.channelListingId ?? row.channelListingId ?? queueId),
      aggregateType: 'ChannelListing', eventType: 'CHANNEL_DELIST_OUTCOME',
      data: {
        queueId, productId: payload.productId ?? row.productId,
        channel: row.targetChannel, marketplace: payload.marketplace ?? row.targetRegion,
        channelConnectionId: payload.channelConnectionId ?? null, aliasKey: payload.aliasKey ?? null,
        sellerSku: payload.sellerSku ?? null, externalListingId: row.externalListingId,
        coordinates: payload.coordinates ?? null,
        delistOutcome: outcome, channelFact: result.channelFact ?? 'UNKNOWN',
        errorCode: result.errorCode ?? null, error: result.error ?? null,
        channelEvidence: (result.evidence ?? null) as never,
      },
      metadata: { source: 'SYSTEM', userId: payload.actor ?? null },
    } })
  })
}
