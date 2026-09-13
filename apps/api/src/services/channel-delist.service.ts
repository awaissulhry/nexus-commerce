import { getAmazonSellerId } from '../lib/amazon-sp-client.js'
/**
 * D.2 — channel-delist.service
 *
 * Dispatcher for OutboundSyncQueue rows whose syncType is
 * UNPUBLISH_LISTING (pause the offer, keep the listing record) or
 * DELETE_LISTING (best-effort remove from the channel catalog). Both
 * are enqueued by the /products bulk-hard-delete cascade (D.1).
 *
 * Amazon and eBay unpublish refuse until a reversible implementation exists.
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
import { endFixedPriceItem, siteIdForMarket } from './ebay-trading-api.service.js'
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
  if (action === 'unpublish') return delistRefusal('AMAZON_UNPUBLISH_NOT_IMPLEMENTED')
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

  try {
    const r = await amazonSpApiClient.deleteListingsItem({
      sellerId,
      sku,
      marketplaceId,
    })
    if (!r.success) return unknownDelist('AMAZON_DELIST_UNVERIFIED', r.error ?? 'No acknowledgement received')
    return { success: true, outcome: r.dryRun ? 'NOT_SENT' : 'SUCCESS', submissionId: r.submissionId, dryRun: r.dryRun }
  } catch (e: unknown) {
    return unknownDelist('DELIST_TRANSPORT_UNKNOWN', e)
  }
}

async function delistShopify(
  job: ChannelDelistJob,
  action: ChannelAction,
): Promise<ChannelDelistResult> {
  if (!(job.channelConnectionId === undefined ? job.payload?.channelConnectionId : job.channelConnectionId)) {
    return delistRefusal('SHOPIFY_DELIST_NO_ACCOUNT')
  }
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
  if (action === 'unpublish') return delistRefusal('EBAY_UNPUBLISH_NOT_IMPLEMENTED')
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

  try {
    const ack = await endFixedPriceItem({ itemId }, { oauthToken, siteId })
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
      },
      metadata: { source: 'SYSTEM', userId: payload.actor ?? null },
    } })
  })
}
