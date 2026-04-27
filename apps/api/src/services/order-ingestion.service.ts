/**
 * Phase 26: Order Ingestion Service
 * Ingests orders from multiple channels and triggers inventory sync
 */

import prisma from '../db'
import { logger } from '../utils/logger'
import { processSale } from './inventory-sync.service'
import { Prisma } from '@prisma/client'

/**
 * Mock customer data for realistic order generation
 */
const MOCK_CUSTOMERS = [
  {
    name: 'John Smith',
    email: 'john.smith@example.com',
    address: {
      street: '123 Main St',
      city: 'New York',
      state: 'NY',
      postalCode: '10001',
      country: 'USA',
    },
  },
  {
    name: 'Sarah Johnson',
    email: 'sarah.j@example.com',
    address: {
      street: '456 Oak Ave',
      city: 'Los Angeles',
      state: 'CA',
      postalCode: '90001',
      country: 'USA',
    },
  },
  {
    name: 'Michael Chen',
    email: 'mchen@example.com',
    address: {
      street: '789 Pine Rd',
      city: 'Chicago',
      state: 'IL',
      postalCode: '60601',
      country: 'USA',
    },
  },
  {
    name: 'Emily Davis',
    email: 'emily.davis@example.com',
    address: {
      street: '321 Elm St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77001',
      country: 'USA',
    },
  },
  {
    name: 'Robert Wilson',
    email: 'rwilson@example.com',
    address: {
      street: '654 Maple Dr',
      city: 'Phoenix',
      state: 'AZ',
      postalCode: '85001',
      country: 'USA',
    },
  },
]

/**
 * Mock product SKUs for order items
 */
const MOCK_SKUS = [
  { sku: 'PROD-001', name: 'Wireless Headphones', price: 79.99 },
  { sku: 'PROD-002', name: 'USB-C Cable', price: 12.99 },
  { sku: 'PROD-003', name: 'Phone Case', price: 24.99 },
  { sku: 'PROD-004', name: 'Screen Protector', price: 9.99 },
  { sku: 'PROD-005', name: 'Portable Charger', price: 34.99 },
  { sku: 'PROD-006', name: 'Laptop Stand', price: 49.99 },
  { sku: 'PROD-007', name: 'Keyboard', price: 89.99 },
  { sku: 'PROD-008', name: 'Mouse', price: 29.99 },
]

type OrderChannel = 'AMAZON' | 'EBAY' | 'SHOPIFY'

/**
 * Ingestion statistics
 */
export interface IngestionStats {
  ordersCreated: number
  itemsCreated: number
  totalRevenue: number
  channelBreakdown: {
    AMAZON: number
    EBAY: number
    SHOPIFY: number
  }
  timestamp: Date
}

/**
 * Generate random integer between min and max
 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * Generate random element from array
 */
function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * Generate a unique channel order ID
 */
function generateChannelOrderId(channel: OrderChannel): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)
  
  switch (channel) {
    case 'AMAZON':
      return `AMZ-${timestamp}-${random}`
    case 'EBAY':
      return `EBY-${timestamp}-${random}`
    case 'SHOPIFY':
      return `SHP-${timestamp}-${random}`
    default:
      return `ORD-${timestamp}-${random}`
  }
}

/**
 * Ingest mock orders from multiple channels
 * Generates 5 realistic orders with multiple items
 * Triggers inventory sync for each item
 */
export async function ingestMockOrders(): Promise<IngestionStats> {
  try {
    logger.info('[ORDER INGESTION] Starting mock order ingestion...')

    const stats: IngestionStats = {
      ordersCreated: 0,
      itemsCreated: 0,
      totalRevenue: 0,
      channelBreakdown: {
        AMAZON: 0,
        EBAY: 0,
        SHOPIFY: 0,
      },
      timestamp: new Date(),
    }

    // Generate 5 mock orders
    for (let i = 0; i < 5; i++) {
      const channel = randomElement<OrderChannel>(['AMAZON', 'EBAY', 'SHOPIFY'])
      const customer = randomElement(MOCK_CUSTOMERS)
      const channelOrderId = generateChannelOrderId(channel)

      // Generate 2-4 items per order
      const itemCount = randomInt(2, 4)
      const orderItems: Array<{ sku: string; quantity: number; price: number }> = []
      let orderTotal = 0

      for (let j = 0; j < itemCount; j++) {
        const product = randomElement(MOCK_SKUS)
        const quantity = randomInt(1, 3)
        const itemTotal = product.price * quantity
        orderTotal += itemTotal

        orderItems.push({
          sku: product.sku,
          quantity,
          price: product.price,
        })
      }

      // Create order in database
      const order = await prisma.order.create({
        data: {
          channel: channel as any,
          channelOrderId,
          status: 'PENDING' as any,
          totalPrice: new Prisma.Decimal(orderTotal.toFixed(2)),
          customerName: customer.name,
          customerEmail: customer.email,
          shippingAddress: customer.address,
        },
      })

      logger.info(`[ORDER INGESTION] Created order ${order.id} from ${channel}`, {
        channelOrderId,
        itemCount: orderItems.length,
        total: orderTotal,
      })

      stats.ordersCreated++
      stats.channelBreakdown[channel]++
      stats.totalRevenue += orderTotal

      // Create order items
      for (const item of orderItems) {
        try {
          await prisma.orderItem.create({
            data: {
              orderId: order.id,
              sku: item.sku,
              quantity: item.quantity,
              price: new Prisma.Decimal(item.price.toFixed(2)),
            },
          })

          stats.itemsCreated++
          logger.info(`[ORDER INGESTION] Created order item for SKU: ${item.sku}`)
        } catch (error: any) {
          logger.warn(`[ORDER INGESTION] Failed to create order item for ${item.sku}:`, error.message)
        }
      }

      // Process inventory sync for each item
      for (const item of orderItems) {
        try {
          logger.info(`[ORDER INGESTION] Processing sale for SKU: ${item.sku}, Qty: ${item.quantity}`)
          
          // Call inventory sync service to deduct stock and trigger channel updates
          await processSale(item.sku, item.quantity)
          
          logger.info(`[ORDER INGESTION] Inventory sync triggered for ${item.sku}`)
        } catch (error: any) {
          logger.warn(
            `[ORDER INGESTION] Failed to sync inventory for ${item.sku}:`,
            error.message
          )
          // Continue with other items even if one fails
        }
      }
    }

    logger.info('[ORDER INGESTION] Mock order ingestion complete', {
      ordersCreated: stats.ordersCreated,
      itemsCreated: stats.itemsCreated,
      totalRevenue: stats.totalRevenue,
      channelBreakdown: stats.channelBreakdown,
    })

    return stats
  } catch (error: any) {
    logger.error('[ORDER INGESTION] Error during mock order ingestion:', error.message)
    throw error
  }
}

/**
 * Fetch all orders with pagination
 */
export async function getOrders(
  page: number = 1,
  limit: number = 20
): Promise<{
  orders: any[]
  total: number
  page: number
  pages: number
}> {
  try {
    const skip = (page - 1) * limit

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        skip,
        take: limit,
        include: {
          items: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      }),
      prisma.order.count(),
    ])

    return {
      orders,
      total,
      page,
      pages: Math.ceil(total / limit),
    }
  } catch (error: any) {
    logger.error('[ORDER INGESTION] Error fetching orders:', error.message)
    throw error
  }
}

/**
 * Update order status to SHIPPED
 */
export async function shipOrder(orderId: string): Promise<any> {
  try {
    const order = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'SHIPPED' as any,
        updatedAt: new Date(),
      },
      include: {
        items: true,
      },
    })

    logger.info(`[ORDER INGESTION] Order ${orderId} marked as SHIPPED`)
    return order
  } catch (error: any) {
    logger.error(`[ORDER INGESTION] Error shipping order ${orderId}:`, error.message)
    throw error
  }
}
