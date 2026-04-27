/**
 * eBay Orders Service
 * Handles fetching eBay orders from the Fulfillment API and syncing them with the database
 * Includes cross-channel inventory deduction logic
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { EbayAuthService } from './ebay-auth.service.js'

interface EbayOrder {
  orderId: string
  creationDate: string
  lastModifiedDate: string
  orderStatus: string
  fulfillmentStatus: string
  buyer: {
    username: string
    email?: string
  }
  shippingAddress: {
    addressLine1: string
    addressLine2?: string
    city: string
    stateOrProvince: string
    postalCode: string
    countryCode: string
  }
  pricingSummary: {
    total: string
    currency: string
  }
  lineItems: Array<{
    lineItemId: string
    sku: string
    title: string
    quantity: number
    lineItemCost: string
    taxes?: {
      taxAmount: string
    }
    discounts?: Array<{
      discountAmount: string
    }>
  }>
}

interface SyncResult {
  syncId: string
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED'
  ordersFetched: number
  ordersCreated: number
  ordersUpdated: number
  itemsProcessed: number
  itemsLinked: number
  inventoryDeducted: number
  errors: Array<{ orderId?: string; error: string }>
  startedAt: Date
  completedAt: Date
}

export class EbayOrdersService {
  private stats = {
    ordersFetched: 0,
    ordersCreated: 0,
    ordersUpdated: 0,
    itemsProcessed: 0,
    itemsLinked: 0,
    inventoryDeducted: 0,
  }

  private resetStats() {
    this.stats = {
      ordersFetched: 0,
      ordersCreated: 0,
      ordersUpdated: 0,
      itemsProcessed: 0,
      itemsLinked: 0,
      inventoryDeducted: 0,
    }
  }

  /**
   * Fetch recent eBay orders from the Fulfillment API
   * Fetches orders from the last 7 days by default
   */
  async fetchEbayOrders(accessToken: string, days: number = 7): Promise<EbayOrder[]> {
    try {
      const sevenDaysAgo = new Date()
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - days)
      const fromDate = sevenDaysAgo.toISOString()

      const response = await fetch(
        `https://api.ebay.com/sell/fulfillment/v1/order?filter=creationdate:[${fromDate}]&limit=200`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      )

      if (!response.ok) {
        const error = await response.json()
        throw new Error(`eBay API error: ${error.message || response.statusText}`)
      }

      const data = await response.json()
      return data.orders || []
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Error fetching eBay orders', { error: message })
      throw error
    }
  }

  /**
   * Find product by eBay SKU or ItemID
   * Uses VariantChannelListing to cross-reference
   */
  private async findProductBySku(sku: string, ebayItemId?: string) {
    try {
      // First try to find by SKU in VariantChannelListing
      const listing = await (prisma as any).variantChannelListing.findFirst({
        where: {
          OR: [
            { externalSku: sku },
            ebayItemId ? { externalListingId: ebayItemId } : undefined,
          ].filter(Boolean),
        },
        include: {
          variant: {
            include: {
              product: true,
            },
          },
        },
      })

      if (listing?.variant?.product) {
        return listing.variant.product
      }

      // Fallback: try to find by SKU in Product or ProductVariation
      const product = await prisma.product.findFirst({
        where: { sku },
      })

      if (product) return product

      const variation = await (prisma as any).productVariation.findFirst({
        where: { sku },
        include: {
          product: true,
        },
      })

      return variation?.product || null
    } catch (error) {
      logger.error('Error finding product by SKU', { sku, error })
      return null
    }
  }

  /**
   * Process a single eBay order and create/update in database
   * Handles inventory deduction for each line item
   */
  private async processOrder(order: EbayOrder, connectionId: string) {
    try {
      // Check if order already exists (idempotency)
      const existingOrder = await (prisma as any).order.findFirst({
        where: {
          ebayOrderId: order.orderId,
          salesChannel: 'EBAY',
        },
      })

      const orderData = {
        salesChannel: 'EBAY',
        ebayOrderId: order.orderId,
        purchaseDate: new Date(order.creationDate),
        lastUpdateDate: new Date(order.lastModifiedDate),
        status: this.mapOrderStatus(order.orderStatus),
        fulfillmentChannel: order.fulfillmentStatus || 'MFN',
        buyerName: order.buyer.username,
        buyerEmail: order.buyer.email,
        buyerPhone: null,
        shippingAddress: order.shippingAddress,
        totalAmount: parseFloat(order.pricingSummary.total),
        currencyCode: order.pricingSummary.currency,
        ebayMetadata: {
          orderStatus: order.orderStatus,
          fulfillmentStatus: order.fulfillmentStatus,
        },
      }

      let dbOrder
      if (existingOrder) {
        // Update existing order
        dbOrder = await (prisma as any).order.update({
          where: { id: existingOrder.id },
          data: orderData,
        })
        this.stats.ordersUpdated++
      } else {
        // Create new order
        dbOrder = await (prisma as any).order.create({
          data: orderData,
        })
        this.stats.ordersCreated++
      }

      // Process line items
      for (const lineItem of order.lineItems) {
        this.stats.itemsProcessed++

        // Find the product
        const product = await this.findProductBySku(lineItem.sku, lineItem.lineItemId)

        if (!product) {
          logger.warn('Could not find product for eBay line item', {
            sku: lineItem.sku,
            ebayItemId: lineItem.lineItemId,
          })
          continue
        }

        this.stats.itemsLinked++

        // Create or update OrderItem
        const itemPrice = parseFloat(lineItem.lineItemCost)
        const taxAmount = lineItem.taxes ? parseFloat(lineItem.taxes.taxAmount) : 0
        const discountAmount = lineItem.discounts
          ? lineItem.discounts.reduce((sum, d) => sum + parseFloat(d.discountAmount), 0)
          : 0

        const subtotal = itemPrice * lineItem.quantity - discountAmount
        const totalWithShipping = subtotal + taxAmount

        await (prisma as any).orderItem.upsert({
          where: {
            orderId_ebayLineItemId: {
              orderId: dbOrder.id,
              ebayLineItemId: lineItem.lineItemId,
            },
          },
          create: {
            orderId: dbOrder.id,
            ebayLineItemId: lineItem.lineItemId,
            productId: product.id,
            sellerSku: lineItem.sku,
            title: lineItem.title,
            quantity: lineItem.quantity,
            itemPrice,
            itemTax: taxAmount,
            shippingPrice: 0, // eBay doesn't break out shipping per item
            shippingTax: 0,
            subtotal,
            totalWithShipping,
            fulfillmentStatus: 'Pending',
            ebayMetadata: {
              lineItemId: lineItem.lineItemId,
            },
          },
          update: {
            quantity: lineItem.quantity,
            itemPrice,
            itemTax: taxAmount,
            subtotal,
            totalWithShipping,
          },
        })

        // CRITICAL: Deduct inventory from Product.totalStock
        await prisma.product.update({
          where: { id: product.id },
          data: {
            totalStock: {
              decrement: lineItem.quantity,
            },
          },
        })

        this.stats.inventoryDeducted++

        logger.info('Inventory deducted for eBay order', {
          productId: product.id,
          productSku: product.sku,
          quantity: lineItem.quantity,
          newStock: Math.max(0, product.totalStock - lineItem.quantity),
        })
      }

      return dbOrder
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Error processing eBay order', { orderId: order.orderId, error: message })
      throw error
    }
  }

  /**
   * Map eBay order status to our unified status
   */
  private mapOrderStatus(ebayStatus: string): string {
    const statusMap: Record<string, string> = {
      ACTIVE: 'Pending',
      COMPLETED: 'Shipped',
      CANCELLED: 'Cancelled',
      INACTIVE: 'Cancelled',
    }
    return statusMap[ebayStatus] || 'Pending'
  }

  /**
   * Main sync method: Fetch eBay orders and sync with database
   */
  async syncEbayOrders(connectionId: string): Promise<SyncResult> {
    const startedAt = new Date()
    const errors: Array<{ orderId?: string; error: string }> = []

    this.resetStats()

    try {
      // Get the eBay connection and valid token
      const connection = await (prisma as any).channelConnection.findUnique({
        where: { id: connectionId },
      })

      if (!connection) {
        throw new Error(`ChannelConnection not found: ${connectionId}`)
      }

      if (!connection.isActive) {
        throw new Error('eBay connection is not active')
      }

      // Get valid access token
      const authService = new EbayAuthService()
      const accessToken = await authService.getValidToken(connection)

      // Fetch orders from eBay
      const orders = await this.fetchEbayOrders(accessToken)
      this.stats.ordersFetched = orders.length

      logger.info('Fetched eBay orders', { count: orders.length })

      // Process each order
      for (const order of orders) {
        try {
          await this.processOrder(order, connectionId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          errors.push({ orderId: order.orderId, error: message })
          logger.error('Failed to process eBay order', { orderId: order.orderId, error: message })
        }
      }

      const completedAt = new Date()

      return {
        syncId: `ebay-orders-${Date.now()}`,
        status: errors.length === 0 ? 'SUCCESS' : errors.length < orders.length ? 'PARTIAL' : 'FAILED',
        ordersFetched: this.stats.ordersFetched,
        ordersCreated: this.stats.ordersCreated,
        ordersUpdated: this.stats.ordersUpdated,
        itemsProcessed: this.stats.itemsProcessed,
        itemsLinked: this.stats.itemsLinked,
        inventoryDeducted: this.stats.inventoryDeducted,
        errors,
        startedAt,
        completedAt,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('eBay orders sync failed', { error: message })

      return {
        syncId: `ebay-orders-${Date.now()}`,
        status: 'FAILED',
        ordersFetched: this.stats.ordersFetched,
        ordersCreated: this.stats.ordersCreated,
        ordersUpdated: this.stats.ordersUpdated,
        itemsProcessed: this.stats.itemsProcessed,
        itemsLinked: this.stats.itemsLinked,
        inventoryDeducted: this.stats.inventoryDeducted,
        errors: [{ error: message }],
        startedAt: new Date(),
        completedAt: new Date(),
      }
    }
  }

  /**
   * Get sync status by syncId
   */
  async getSyncStatus(syncId: string): Promise<any> {
    // In a production system, you'd store sync status in a SyncLog table
    // For now, return a placeholder
    return {
      syncId,
      status: 'COMPLETED',
      message: 'Sync status tracking not yet implemented',
    }
  }
}

export const ebayOrdersService = new EbayOrdersService()
