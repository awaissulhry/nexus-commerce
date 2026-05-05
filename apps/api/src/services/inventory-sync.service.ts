/**
 * Phase 23.1: Global Inventory Controller
 * Omni-channel stock synchronization service
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { stockUpdateQueue } from '../lib/queue.js'
import { checkStockThreshold } from './alert.service.js'

/**
 * Stock adjustment event for tracking
 */
export interface StockAdjustment {
  id: string
  sku: string
  productId: string
  previousQuantity: number
  newQuantity: number
  quantityChanged: number
  reason: 'SALE' | 'RESTOCK' | 'ADJUSTMENT' | 'RETURN'
  affectedChannels: string[]
  timestamp: Date
}

// In-memory store for recent stock adjustments (for dashboard)
const recentAdjustments: StockAdjustment[] = []
const MAX_RECENT_ADJUSTMENTS = 50

/**
 * Sync global stock across all channels
 * Updates SSOT database and queues channel-specific updates
 * Phase 23.2: Applies stock buffers to protect against overselling
 */
export async function syncGlobalStock(
  sku: string,
  newQuantity: number,
  reason: 'SALE' | 'RESTOCK' | 'ADJUSTMENT' | 'RETURN' = 'ADJUSTMENT'
): Promise<StockAdjustment | null> {
  try {
    logger.info(`[INVENTORY SYNC] Starting stock sync for SKU: ${sku}`, {
      newQuantity,
      reason,
    })

    // Find product by SKU with low-stock threshold
    const product = await prisma.product.findUnique({
      where: { sku },
      select: {
        id: true,
        sku: true,
        name: true,
        totalStock: true,
        lowStockThreshold: true,
      },
    })

    if (!product) {
      logger.warn(`[INVENTORY SYNC] Product not found for SKU: ${sku}`)
      return null
    }

    const previousQuantity = product.totalStock || 0
    const quantityChanged = newQuantity - previousQuantity

    // Update SSOT database
    const updatedProduct = await prisma.product.update({
      where: { id: product.id },
      data: {
        totalStock: newQuantity,
        updatedAt: new Date(),
      },
      select: {
        id: true,
        sku: true,
        totalStock: true,
      },
    })

    logger.info(`[INVENTORY SYNC] Updated SSOT: ${sku} from ${previousQuantity} to ${newQuantity}`)

    // B.1/B.2 — append-only audit row for every stock change. Mapping
    // legacy reasons to the StockMovementReason enum.
    if (quantityChanged !== 0) {
      const reasonMap: Record<string, any> = {
        SALE: 'ORDER_PLACED',
        RESTOCK: 'INBOUND_RECEIVED',
        ADJUSTMENT: 'MANUAL_ADJUSTMENT',
        RETURN: 'RETURN_RECEIVED',
      }
      try {
        await prisma.stockMovement.create({
          data: {
            productId: product.id,
            change: quantityChanged,
            balanceAfter: newQuantity,
            reason: reasonMap[reason] ?? 'MANUAL_ADJUSTMENT',
            referenceType: 'inventory-sync.service',
            actor: 'system',
          },
        })
      } catch (e) {
        logger.warn(`[INVENTORY SYNC] StockMovement audit failed for ${sku}:`, e)
      }
    }

    // Find all channel listings for this product (including stock buffers)
    const channelListings = await prisma.listing.findMany({
      where: { productId: product.id },
      select: {
        id: true,
        channelId: true,
        productId: true,
        stockBuffer: true, // Phase 23.2: Stock buffer for overselling protection
      },
    })

    logger.info(`[INVENTORY SYNC] Found ${channelListings.length} channel listings for ${sku}`)

    // Also fetch ChannelListing records for additional buffer protection
    const channelListingsV2 = await prisma.channelListing.findMany({
      where: { productId: product.id },
      select: {
        id: true,
        channel: true,
        region: true,
        stockBuffer: true,
      },
    })

    // Queue stock update jobs for legacy Listing records
    const affectedChannels: string[] = []

    for (const listing of channelListings) {
      try {
        // Phase 23.2: Apply stock buffer
        // finalQuantity = Math.max(0, newQuantity - stockBuffer)
        // This ensures marketplaces see a slightly lower stock to prevent overselling
        const stockBuffer = listing.stockBuffer || 0
        const finalQuantity = Math.max(0, newQuantity - stockBuffer)

        // Queue the stock update job
        await stockUpdateQueue.add(
          'update-stock',
          {
            productId: product.id,
            sku: product.sku,
            channelId: listing.channelId,
            newQuantity: finalQuantity, // Send buffered quantity to marketplace
            actualQuantity: newQuantity, // Keep track of actual SSOT quantity
            stockBuffer: stockBuffer,
            previousQuantity: previousQuantity,
            reason: reason,
            timestamp: new Date().toISOString(),
          },
          {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
            removeOnComplete: true,
          }
        )

        affectedChannels.push(listing.channelId)
        logger.info(`[INVENTORY SYNC] Queued stock update for channel ${listing.channelId}: ${sku}`)
      } catch (error: any) {
        logger.error(`[INVENTORY SYNC] Failed to queue stock update for channel ${listing.channelId}:`, error.message)
      }
    }

    // Queue stock update jobs for ChannelListing records (Phase 9+)
    for (const listing of channelListingsV2) {
      try {
        const stockBuffer = listing.stockBuffer || 0
        const finalQuantity = Math.max(0, newQuantity - stockBuffer)
        const channelMarket = `${listing.channel}_${listing.region}`

        await stockUpdateQueue.add(
          'update-channel-listing-stock',
          {
            productId: product.id,
            sku: product.sku,
            channelListingId: listing.id,
            channel: listing.channel,
            region: listing.region,
            newQuantity: finalQuantity,
            actualQuantity: newQuantity,
            stockBuffer: stockBuffer,
            previousQuantity: previousQuantity,
            reason: reason,
            timestamp: new Date().toISOString(),
          },
          {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
            removeOnComplete: true,
          }
        )

        affectedChannels.push(channelMarket)
        logger.info(`[INVENTORY SYNC] Queued stock update for channel listing ${channelMarket}: ${sku}`)
      } catch (error: any) {
        logger.error(`[INVENTORY SYNC] Failed to queue stock update for channel listing ${listing.channel}:`, error.message)
      }
    }

    // Create stock adjustment record
    const adjustment: StockAdjustment = {
      id: `adj-${Date.now()}`,
      sku: product.sku,
      productId: product.id,
      previousQuantity,
      newQuantity,
      quantityChanged,
      reason,
      affectedChannels,
      timestamp: new Date(),
    }

    // Store in recent adjustments (for dashboard)
    recentAdjustments.unshift(adjustment)
    if (recentAdjustments.length > MAX_RECENT_ADJUSTMENTS) {
      recentAdjustments.pop()
    }

    logger.info(`[INVENTORY SYNC] Stock sync complete for ${sku}`, {
      quantityChanged,
      affectedChannels: affectedChannels.length,
    })

    // Phase 23.2: Check stock threshold and trigger alerts if necessary
    try {
      await checkStockThreshold(sku, newQuantity)
    } catch (error: any) {
      logger.warn(`[INVENTORY SYNC] Error checking stock threshold for ${sku}:`, error.message)
      // Don't throw - alerts are non-critical
    }

    return adjustment
  } catch (error: any) {
    logger.error(`[INVENTORY SYNC] Error syncing stock for ${sku}:`, error.message)
    throw error
  }
}

/**
 * Get recent stock adjustments for dashboard
 */
export function getRecentAdjustments(limit: number = 20): StockAdjustment[] {
  return recentAdjustments.slice(0, limit)
}

/**
 * Get stock adjustment history for a specific product
 */
export async function getProductStockHistory(
  productId: string,
  limit: number = 50
): Promise<StockAdjustment[]> {
  try {
    // In a production system, this would query a dedicated audit table
    // For now, return from in-memory store filtered by productId
    return recentAdjustments.filter((adj) => adj.productId === productId).slice(0, limit)
  } catch (error: any) {
    logger.error(`[INVENTORY SYNC] Error fetching stock history:`, error.message)
    throw error
  }
}

/**
 * Process a sale (deduct inventory)
 */
export async function processSale(sku: string, quantity: number): Promise<StockAdjustment | null> {
  try {
    const product = await prisma.product.findUnique({
      where: { sku },
      select: { totalStock: true },
    })

    if (!product) {
      throw new Error(`Product not found: ${sku}`)
    }

    const newQuantity = Math.max(0, (product.totalStock || 0) - quantity)
    return syncGlobalStock(sku, newQuantity, 'SALE')
  } catch (error: any) {
    logger.error(`[INVENTORY SYNC] Error processing sale for ${sku}:`, error.message)
    throw error
  }
}

/**
 * Process a restock (add inventory)
 */
export async function processRestock(sku: string, quantity: number): Promise<StockAdjustment | null> {
  try {
    const product = await prisma.product.findUnique({
      where: { sku },
      select: { totalStock: true },
    })

    if (!product) {
      throw new Error(`Product not found: ${sku}`)
    }

    const newQuantity = (product.totalStock || 0) + quantity
    return syncGlobalStock(sku, newQuantity, 'RESTOCK')
  } catch (error: any) {
    logger.error(`[INVENTORY SYNC] Error processing restock for ${sku}:`, error.message)
    throw error
  }
}

/**
 * Get current stock level for a product
 */
export async function getStockLevel(sku: string): Promise<number | null> {
  try {
    const product = await prisma.product.findUnique({
      where: { sku },
      select: { totalStock: true },
    })

    return product?.totalStock || null
  } catch (error: any) {
    logger.error(`[INVENTORY SYNC] Error fetching stock level for ${sku}:`, error.message)
    throw error
  }
}

/**
 * Cleanup function for graceful shutdown
 */
export async function closeConnections(): Promise<void> {
  try {
    await stockUpdateQueue.close()
    logger.info('[INVENTORY SYNC] Connections closed')
  } catch (error: any) {
    logger.error('[INVENTORY SYNC] Error closing connections:', error.message)
  }
}
