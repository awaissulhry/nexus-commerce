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

async function delistEbay(
  _job: ChannelDelistJob,
  _action: ChannelAction,
): Promise<ChannelDelistResult> {
  // W5.49b — eBay Trading API EndFixedPriceItem is stubbed. Mark the
  // queue row as FAILED with a clear, actionable error so /sync-logs
  // surfaces it; operator can end the listing manually in Seller Hub.
  return {
    success: false,
    error: 'eBay delist not yet implemented (W5.49b pending). End the listing manually in Seller Hub.',
    errorCode: 'EBAY_DELIST_NOT_IMPLEMENTED',
    retryable: false,
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
