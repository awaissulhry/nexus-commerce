/**
 * D.2 — channel-delist.service
 *
 * Dispatcher for OutboundSyncQueue rows whose syncType is
 * UNPUBLISH_LISTING (pause the offer, keep the listing record) or
 * DELETE_LISTING (best-effort remove from the channel catalog). Both
 * are enqueued by the /products bulk-hard-delete cascade (D.1).
 *
 * Per-channel behavior:
 *
 *   Amazon (SP-API Listings Items v2021-08-01):
 *     - Unpublish: PATCH availability_status (TODO — needs the client
 *       method; for now we fall back to DELETE with a logged note so
 *       the channel state still changes).
 *     - Delete: deleteListingsItem(sellerId, sku, marketplaceId).
 *       Seller offer is removed; catalog ASIN persists.
 *
 *   eBay (Trading API):
 *     - Unpublish + Delete: EndFixedPriceItem (relistable later via
 *       SellSimilarItem; "Delete" is more aspirational here since
 *       eBay doesn't truly delete listings — the listing record stays
 *       in seller history). Implementation pending W5.49b — for now
 *       returns SKIPPED with a TODO message; the queue row gets
 *       marked FAILED with a clear error so /sync-logs surfaces it.
 *
 *   Shopify (Admin REST + GraphQL):
 *     - Unpublish: productUpdate { status: DRAFT } via REST PUT.
 *     - Delete: existing deleteProduct() via REST DELETE.
 *
 * The OutboundSyncQueue row carries:
 *   - productId          (may be null after hard-delete cascade — that's OK)
 *   - channelListingId   (likely null after cascade — that's OK)
 *   - targetChannel      ("AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE")
 *   - targetRegion       (marketplace code, e.g. "IT", "DE")
 *   - externalListingId  (ASIN | eBay ItemID | Shopify product gid/number)
 *   - payload.channelAction ("unpublish" | "delete")
 *   - payload.externalParentId (Amazon parent ASIN, used to scope SKU lookup)
 *
 * Returns the shape the BullMQ worker already understands:
 *   { success: true } on a real change
 *   { success: false, error, retryable } on a failure
 */

import { logger } from '../utils/logger.js'
import { amazonSpApiClient } from '../clients/amazon-sp-api.client.js'
import { ShopifyService } from './marketplaces/shopify.service.js'
import { prisma } from '@nexus/database'
import { endFixedPriceItem, siteIdForMarket } from './ebay-trading-api.service.js'
import { ebayAuthService } from './ebay-auth.service.js'

export type ChannelAction = 'unpublish' | 'delete'

export interface ChannelDelistJob {
  queueId: string
  productId: string | null
  channelListingId: string | null
  targetChannel: string
  targetRegion: string | null
  externalListingId: string | null
  syncType: 'UNPUBLISH_LISTING' | 'DELETE_LISTING'
  payload: any
}

export interface ChannelDelistResult {
  success: boolean
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
  if (!region) return AMAZON_MARKETPLACE_IDS.IT  // sane default for Xavia
  const upper = region.toUpperCase()
  return AMAZON_MARKETPLACE_IDS[upper] ?? null
}

export async function dispatchChannelDelist(
  job: ChannelDelistJob,
): Promise<ChannelDelistResult> {
  const action: ChannelAction =
    job.syncType === 'UNPUBLISH_LISTING' ? 'unpublish' : 'delete'

  if (!job.externalListingId) {
    return {
      success: false,
      error: 'externalListingId is required for delist',
      retryable: false,
    }
  }

  switch (job.targetChannel) {
    case 'AMAZON':
      return delistAmazon(job, action)
    case 'EBAY':
      return delistEbay(job, action)
    case 'SHOPIFY':
      return delistShopify(job, action)
    case 'WOOCOMMERCE':
      return {
        success: false,
        error: 'WooCommerce delist adapter not yet implemented',
        retryable: false,
      }
    default:
      return {
        success: false,
        error: `Unknown channel: ${job.targetChannel}`,
        retryable: false,
      }
  }
}

async function delistAmazon(
  job: ChannelDelistJob,
  action: ChannelAction,
): Promise<ChannelDelistResult> {
  const marketplaceId = resolveAmazonMarketplaceId(job.targetRegion)
  if (!marketplaceId) {
    return {
      success: false,
      error: `Unknown Amazon marketplace for region ${job.targetRegion}`,
      retryable: false,
    }
  }
  // externalListingId for Amazon is typically the SKU (since the
  // Listings Items endpoint is keyed by SKU, not ASIN).
  const sku = job.externalListingId!
  const sellerId = process.env.AMAZON_SELLER_ID ?? ''
  if (!sellerId) {
    return {
      success: false,
      error: 'AMAZON_SELLER_ID env var not set',
      retryable: false,
    }
  }

  if (action === 'unpublish') {
    // No first-class unpublish on SP-API; PATCH availability=DISCONTINUED
    // would be ideal but isn't wired in the client yet. Fall back to
    // delete for now and log so we can swap in PATCH later.
    logger.warn('Amazon UNPUBLISH falling back to DELETE (PATCH client TODO)', {
      sku,
      marketplaceId,
      queueId: job.queueId,
    })
  }
  try {
    const r = await amazonSpApiClient.deleteListingsItem({
      sellerId,
      sku,
      marketplaceId,
    })
    if (!r.success) {
      return {
        success: false,
        error: r.error ?? 'Amazon delete failed',
        retryable: true,
      }
    }
    return { success: true, submissionId: r.submissionId, dryRun: r.dryRun }
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e), retryable: true }
  }
}

async function delistShopify(
  job: ChannelDelistJob,
  action: ChannelAction,
): Promise<ChannelDelistResult> {
  const productId = job.externalListingId!
  try {
    const svc = new ShopifyService()
    if (action === 'unpublish') {
      // ShopifyService has updateProduct as a public method on some
      // codepaths; if missing in this build, fall back to delete with
      // a warning so the channel state still changes.
      const svcAny = svc as any
      if (typeof svcAny.updateProduct === 'function') {
        await svcAny.updateProduct(productId, {
          product: { id: Number(productId), status: 'draft' },
        })
        return { success: true }
      }
      logger.warn('Shopify UNPUBLISH falling back to DELETE (updateProduct missing)', {
        productId,
        queueId: job.queueId,
      })
    }
    await svc.deleteProduct(productId)
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? String(e), retryable: true }
  }
}

// ── eBay "already ended" idempotency helpers ──────────────────────────────

/**
 * eBay Trading-API error message patterns that mean the listing is
 * already not live. Treating these as success keeps delist idempotent
 * (the goal — listing not live — is already met).
 *
 * Error codes + typical ShortMessage text we match against:
 *   291  "Item cannot be accessed" — item gone / seller doesn't own it
 *   219  "Listing validation error" variants incl. "Listing is not active"
 *   17   "Invalid item" / "Item not found"
 *   various: "auction already closed", "already ended", "not currently available"
 */
const ALREADY_ENDED_PATTERNS: RegExp[] = [
  /already ended/i,
  /already closed/i,
  /auction already closed/i,
  /item cannot be accessed/i,
  /item (is )?not (active|available)/i,
  /listing (is )?not (active|available|found)/i,
  /item not found/i,
  /invalid item/i,
  /not currently available/i,
  /item has already been (deleted|removed)/i,
]

function isAlreadyEndedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return ALREADY_ENDED_PATTERNS.some((p) => p.test(msg))
}

// ── Real EndFixedPriceItem delist ─────────────────────────────────────────

async function delistEbay(
  job: ChannelDelistJob,
  _action: ChannelAction,
): Promise<ChannelDelistResult> {
  // 1. ItemID guard
  const itemId = job.externalListingId
  if (!itemId) {
    return {
      success: false,
      error: 'no eBay ItemID on delist job',
      errorCode: 'EBAY_DELIST_NO_ITEMID',
      retryable: false,
    }
  }

  // 2. Resolve eBay connection + OAuth token (mirrors outbound-sync.service.ts auth path)
  let oauthToken: string
  let siteId: string
  try {
    const connection = await prisma.channelConnection.findFirst({
      where: { channelType: 'EBAY', isActive: true },
      orderBy: { updatedAt: 'desc' },
    })
    if (!connection) {
      return {
        success: false,
        error: 'No active eBay connection found — link an eBay account in Settings',
        errorCode: 'EBAY_DELIST_NO_CONNECTION',
        retryable: false,
      }
    }
    oauthToken = await ebayAuthService.getValidToken(connection.id)
    // targetRegion may be null for legacy rows; default to IT (Xavia primary market)
    siteId = siteIdForMarket(job.targetRegion ?? 'IT')
  } catch (err: unknown) {
    return {
      success: false,
      error: `eBay delist auth error: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: 'EBAY_DELIST_AUTH_ERROR',
      retryable: false,
    }
  }

  // 3. Call EndFixedPriceItem — inherits NEXUS_EBAY_REAL_API gate from callTradingApi
  try {
    await endFixedPriceItem({ itemId }, { oauthToken, siteId })
    return { success: true }
  } catch (err: unknown) {
    // 4. Idempotency: already-ended listings are a success (goal = listing not live)
    if (isAlreadyEndedError(err)) {
      logger.info('ebay delist: item already ended (idempotent)', {
        itemId,
        marketplace: job.targetRegion,
        error: err instanceof Error ? err.message : String(err),
      })
      return { success: true }
    }
    // 5. Genuine failures — retryable so the queue can re-attempt on transient errors
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      errorCode: 'EBAY_DELIST_FAILED',
      retryable: true,
    }
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
  if (result.success) {
    await prisma.outboundSyncQueue.update({
      where: { id: queueId },
      data: {
        syncStatus: 'SUCCESS',
        syncedAt: new Date(),
      },
    })
    return
  }
  const row = await prisma.outboundSyncQueue.findUnique({
    where: { id: queueId },
    select: { retryCount: true, maxRetries: true },
  })
  const newRetry = (row?.retryCount ?? 0) + 1
  const exhausted = !result.retryable || newRetry >= (row?.maxRetries ?? 3)
  await prisma.outboundSyncQueue.update({
    where: { id: queueId },
    data: {
      syncStatus: exhausted ? 'FAILED' : 'PENDING',
      errorMessage: result.error ?? 'Unknown delist error',
      errorCode: result.errorCode,
      retryCount: newRetry,
      ...(exhausted ? { isDead: true, diedAt: new Date() } : {}),
    },
  })
}
