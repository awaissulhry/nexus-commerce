/**
 * eBay Orders Sync Routes
 * Handles fetching and syncing eBay orders with inventory deduction
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { ebayOrdersService } from '../services/ebay-orders.service.js'
import { logger } from '../utils/logger.js'

interface SyncOrdersBody {
  connectionId: string
}

export async function ebayOrdersRoutes(app: FastifyInstance) {
  /**
   * POST /api/sync/ebay/orders
   * Trigger eBay orders sync for a specific connection
   * Fetches recent orders and deducts inventory
   */
  app.post<{ Body: SyncOrdersBody }>('/api/sync/ebay/orders', async (request, reply) => {
    try {
      const { connectionId } = request.body

      if (!connectionId) {
        return reply.status(400).send({
          success: false,
          error: 'connectionId is required',
        })
      }

      // Verify connection exists and is active
      const connection = await (prisma as any).channelConnection.findUnique({
        where: { id: connectionId },
      })

      if (!connection) {
        return reply.status(404).send({
          success: false,
          error: 'ChannelConnection not found',
        })
      }

      if (!connection.isActive) {
        return reply.status(400).send({
          success: false,
          error: 'eBay connection is not active',
        })
      }

      logger.info('Starting eBay orders sync', { connectionId })

      // Execute sync
      const result = await ebayOrdersService.syncEbayOrders(connectionId)

      // Update connection with sync status
      await (prisma as any).channelConnection.update({
        where: { id: connectionId },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: result.status,
          lastSyncError: result.errors.length > 0 ? result.errors[0].error : null,
        },
      })

      logger.info('eBay orders sync completed', {
        syncId: result.syncId,
        status: result.status,
        ordersFetched: result.ordersFetched,
        ordersCreated: result.ordersCreated,
        ordersUpdated: result.ordersUpdated,
        inventoryDeducted: result.inventoryDeducted,
      })

      return reply.send({
        success: result.status === 'SUCCESS',
        syncId: result.syncId,
        status: result.status,
        summary: {
          ordersFetched: result.ordersFetched,
          ordersCreated: result.ordersCreated,
          ordersUpdated: result.ordersUpdated,
          itemsProcessed: result.itemsProcessed,
          itemsLinked: result.itemsLinked,
          inventoryDeducted: result.inventoryDeducted,
          errorCount: result.errors.length,
        },
        errors: result.errors,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('eBay orders sync failed', { error: message })
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * GET /api/sync/ebay/orders/:connectionId
   * Get sync status for a connection
   */
  app.get<{ Params: { connectionId: string } }>(
    '/api/sync/ebay/orders/:connectionId',
    async (request, reply) => {
      try {
        const { connectionId } = request.params

        const connection = await (prisma as any).channelConnection.findUnique({
          where: { id: connectionId },
        })

        if (!connection) {
          return reply.status(404).send({
            success: false,
            error: 'ChannelConnection not found',
          })
        }

        return reply.send({
          success: true,
          connectionId,
          lastSyncAt: connection.lastSyncAt,
          lastSyncStatus: connection.lastSyncStatus,
          lastSyncError: connection.lastSyncError,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('Error fetching sync status', { error: message })
        return reply.status(500).send({
          success: false,
          error: message,
        })
      }
    }
  )

  /**
   * GET /api/sync/ebay/orders/stats/:connectionId
   * Get order statistics for a connection
   */
  app.get<{ Params: { connectionId: string } }>(
    '/api/sync/ebay/orders/stats/:connectionId',
    async (request, reply) => {
      try {
        const { connectionId } = request.params

        // Verify connection exists
        const connection = await (prisma as any).channelConnection.findUnique({
          where: { id: connectionId },
        })

        if (!connection) {
          return reply.status(404).send({
            success: false,
            error: 'ChannelConnection not found',
          })
        }

        // Get order statistics
        const totalOrders = await (prisma as any).order.count({
          where: {
            salesChannel: 'EBAY',
          },
        })

        const totalItems = await (prisma as any).orderItem.count({
          where: {
            order: {
              salesChannel: 'EBAY',
            },
          },
        })

        const totalRevenue = await (prisma as any).order.aggregate({
          where: {
            salesChannel: 'EBAY',
          },
          _sum: {
            totalAmount: true,
          },
        })

        return reply.send({
          success: true,
          stats: {
            totalOrders,
            totalItems,
            totalRevenue: totalRevenue._sum.totalAmount || 0,
            lastSyncAt: connection.lastSyncAt,
            lastSyncStatus: connection.lastSyncStatus,
          },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('Error fetching order stats', { error: message })
        return reply.status(500).send({
          success: false,
          error: message,
        })
      }
    }
  )
}
