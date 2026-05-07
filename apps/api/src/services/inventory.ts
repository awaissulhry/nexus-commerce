import { prisma } from '@nexus/database'

export interface DeductStockOptions {
  productId: string
  quantity: number
  reason: string
  orderId?: string
}

/**
 * Deduct stock from a product and create a stock log entry
 * @param options - Deduction options including productId, quantity, reason, and optional orderId
 * @returns Updated product with new stock level
 * @throws Error if product not found or insufficient stock
 */
export async function deductStock(options: DeductStockOptions) {
  const { productId, quantity, reason, orderId } = options

  if (!productId || quantity <= 0) {
    throw new Error('Invalid productId or quantity')
  }

  try {
    // Find the product
    const product = await prisma.product.findUnique({
      where: { id: productId },
    })

    if (!product) {
      throw new Error(`Product with ID ${productId} not found`)
    }

    // Check if there's enough stock
    const newStock = product.totalStock - quantity
    if (newStock < 0) {
      throw new Error(
        `Insufficient stock for product ${product.sku}. Current: ${product.totalStock}, Requested: ${quantity}`
      )
    }

    // Update product stock and create stock log in a transaction
    const [updatedProduct, stockLog] = await Promise.all([
      prisma.product.update({
        where: { id: productId },
        data: {
          totalStock: newStock,
        },
      }),
      prisma.stockLog.create({
        data: {
          productId,
          quantity: -quantity, // Negative for deductions
          reason,
          orderId,
        },
      }),
    ])

    console.log(
      `Stock deducted for product ${product.sku}: ${quantity} units. New stock: ${newStock}`
    )

    return {
      product: updatedProduct,
      stockLog,
      success: true,
    }
  } catch (error) {
    console.error('Error deducting stock:', error)
    throw error
  }
}

/**
 * Add stock to a product (for returns, adjustments, etc.)
 * @param options - Addition options including productId, quantity, reason, and optional orderId
 * @returns Updated product with new stock level
 */
export async function addStock(options: DeductStockOptions) {
  const { productId, quantity, reason, orderId } = options

  if (!productId || quantity <= 0) {
    throw new Error('Invalid productId or quantity')
  }

  try {
    // Find the product
    const product = await prisma.product.findUnique({
      where: { id: productId },
    })

    if (!product) {
      throw new Error(`Product with ID ${productId} not found`)
    }

    const newStock = product.totalStock + quantity

    // Update product stock and create stock log
    const [updatedProduct, stockLog] = await Promise.all([
      prisma.product.update({
        where: { id: productId },
        data: {
          totalStock: newStock,
        },
      }),
      prisma.stockLog.create({
        data: {
          productId,
          quantity, // Positive for additions
          reason,
          orderId,
        },
      }),
    ])

    console.log(
      `Stock added for product ${product.sku}: ${quantity} units. New stock: ${newStock}`
    )

    return {
      product: updatedProduct,
      stockLog,
      success: true,
    }
  } catch (error) {
    console.error('Error adding stock:', error)
    throw error
  }
}

/**
 * Get stock history for a product
 * @param productId - Product ID
 * @param limit - Number of recent logs to fetch (default: 50)
 * @returns Array of stock log entries
 */
export async function getStockHistory(productId: string, limit: number = 50) {
  try {
    const logs = await prisma.stockLog.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    return logs
  } catch (error) {
    console.error('Error fetching stock history:', error)
    throw error
  }
}

// S.1 — `syncGlobalStock(masterSkuId)` removed. It summed
// ProductVariation.stock (P.1-deprecated, zero rows in production) and
// wrote Product.totalStock directly, bypassing the StockLevel ledger.
// Product.totalStock is now maintained as SUM(StockLevel.quantity) by
// stock-movement.service.recomputeProductTotalStock — no separate
// syncGlobalStock layer is needed.

/**
 * Get channel sync status for a product
 * Returns health status for each connected channel
 * @param productId - Product ID
 * @returns Channel sync status information
 */
export async function getChannelSyncStatus(productId: string) {
  try {
    const product: any = await prisma.product.findUnique({
      where: { id: productId },
    })

    if (!product) {
      throw new Error(`Product with ID ${productId} not found`)
    }

    // Fetch variations with channel listings
    const variations: any[] = await (prisma as any).productVariation.findMany({
      where: { productId },
      include: {
        channelListings: {
          select: {
            channelId: true,
            listingStatus: true,
            lastSyncStatus: true,
            lastSyncedAt: true,
            lastSyncError: true,
            syncRetryCount: true,
          },
        },
      },
    })

    // Aggregate channel status
    const channelStatus: Record<
      string,
      {
        status: 'synced' | 'error' | 'pending' | 'not_listed'
        lastSyncedAt?: Date
        errorCount: number
        variationCount: number
      }
    > = {}

    variations.forEach((variation) => {
      variation.channelListings.forEach((listing: any) => {
        if (!channelStatus[listing.channelId]) {
          channelStatus[listing.channelId] = {
            status: 'not_listed',
            errorCount: 0,
            variationCount: 0,
          }
        }

        const status = channelStatus[listing.channelId]
        status.variationCount++

        if (listing.lastSyncStatus === 'FAILED') {
          status.status = 'error'
          status.errorCount++
        } else if (listing.lastSyncStatus === 'SUCCESS') {
          if (status.status !== 'error') {
            status.status = 'synced'
          }
          status.lastSyncedAt = listing.lastSyncedAt || undefined
        } else if (listing.lastSyncStatus === 'PENDING') {
          if (status.status === 'not_listed') {
            status.status = 'pending'
          }
        }
      })
    })

    return {
      productId,
      sku: product.sku,
      channelStatus,
    }
  } catch (error) {
    console.error('[getChannelSyncStatus] Error fetching channel sync status:', error)
    throw error
  }
}
