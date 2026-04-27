/**
 * Phase 23.1: Order Webhook Routes
 * Handles incoming order events and triggers inventory sync
 */

import type { FastifyInstance } from 'fastify'
import { syncGlobalStock, processSale, getRecentAdjustments } from '../services/inventory-sync.service'
import { logger } from '../utils/logger'

interface OrderCreatedPayload {
  sku: string
  quantity: number
  channel?: string
  orderId?: string
  timestamp?: string
}

interface StockAdjustmentPayload {
  sku: string
  newQuantity: number
  reason?: 'SALE' | 'RESTOCK' | 'ADJUSTMENT' | 'RETURN'
}

export async function webhookRoutes(app: FastifyInstance) {
  /**
   * POST /api/webhooks/order-created
   * Phase 23.1: Simulate a sale and trigger global inventory sync
   *
   * Payload:
   * {
   *   "sku": "AMAZON-LEATHER-JACKET-001",
   *   "quantity": 2,
   *   "channel": "AMAZON",
   *   "orderId": "AMZ-12345",
   *   "timestamp": "2026-04-27T13:51:00Z"
   * }
   */
  app.post<{ Body: OrderCreatedPayload }>('/api/webhooks/order-created', async (request, reply) => {
    try {
      const { sku, quantity, channel = 'UNKNOWN', orderId, timestamp } = request.body

      if (!sku || !quantity) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_PAYLOAD',
            message: 'Missing required fields: sku, quantity',
          },
        })
      }

      logger.info(`[WEBHOOK] Order created event received`, {
        sku,
        quantity,
        channel,
        orderId,
      })

      // Process the sale (deduct inventory)
      const adjustment = await processSale(sku, quantity)

      if (!adjustment) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'PRODUCT_NOT_FOUND',
            message: `Product not found: ${sku}`,
          },
        })
      }

      logger.info(`[WEBHOOK] Sale processed successfully`, {
        sku,
        quantityDeducted: quantity,
        newStock: adjustment.newQuantity,
        affectedChannels: adjustment.affectedChannels.length,
      })

      return reply.status(200).send({
        success: true,
        data: {
          adjustment: {
            id: adjustment.id,
            sku: adjustment.sku,
            previousQuantity: adjustment.previousQuantity,
            newQuantity: adjustment.newQuantity,
            quantityChanged: adjustment.quantityChanged,
            reason: adjustment.reason,
            affectedChannels: adjustment.affectedChannels,
            timestamp: adjustment.timestamp,
          },
          message: `Inventory synced across ${adjustment.affectedChannels.length} channels`,
        },
      })
    } catch (error: any) {
      logger.error(`[WEBHOOK] Error processing order:`, error.message)

      return reply.status(500).send({
        success: false,
        error: {
          code: 'WEBHOOK_ERROR',
          message: error.message || 'Failed to process order webhook',
        },
      })
    }
  })

  /**
   * POST /api/webhooks/stock-adjustment
   * Manually adjust stock for a product
   *
   * Payload:
   * {
   *   "sku": "AMAZON-LEATHER-JACKET-001",
   *   "newQuantity": 50,
   *   "reason": "RESTOCK"
   * }
   */
  app.post<{ Body: StockAdjustmentPayload }>('/webhooks/stock-adjustment', async (request, reply) => {
    try {
      const { sku, newQuantity, reason = 'ADJUSTMENT' } = request.body

      if (!sku || newQuantity === undefined) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_PAYLOAD',
            message: 'Missing required fields: sku, newQuantity',
          },
        })
      }

      logger.info(`[WEBHOOK] Stock adjustment event received`, {
        sku,
        newQuantity,
        reason,
      })

      // Sync global stock
      const adjustment = await syncGlobalStock(sku, newQuantity, reason)

      if (!adjustment) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'PRODUCT_NOT_FOUND',
            message: `Product not found: ${sku}`,
          },
        })
      }

      logger.info(`[WEBHOOK] Stock adjustment processed successfully`, {
        sku,
        newQuantity,
        affectedChannels: adjustment.affectedChannels.length,
      })

      return reply.status(200).send({
        success: true,
        data: {
          adjustment: {
            id: adjustment.id,
            sku: adjustment.sku,
            previousQuantity: adjustment.previousQuantity,
            newQuantity: adjustment.newQuantity,
            quantityChanged: adjustment.quantityChanged,
            reason: adjustment.reason,
            affectedChannels: adjustment.affectedChannels,
            timestamp: adjustment.timestamp,
          },
          message: `Stock adjusted and synced across ${adjustment.affectedChannels.length} channels`,
        },
      })
    } catch (error: any) {
      logger.error(`[WEBHOOK] Error processing stock adjustment:`, error.message)

      return reply.status(500).send({
        success: false,
        error: {
          code: 'WEBHOOK_ERROR',
          message: error.message || 'Failed to process stock adjustment webhook',
        },
      })
    }
  })

  /**
   * GET /api/webhooks/recent-adjustments
   * Get recent stock adjustments for dashboard
   */
  app.get('/webhooks/recent-adjustments', async (request, reply) => {
    try {
      const limit = (request.query as any).limit || 20
      const adjustments = getRecentAdjustments(parseInt(limit))

      return reply.status(200).send({
        success: true,
        data: {
          adjustments,
          count: adjustments.length,
        },
      })
    } catch (error: any) {
      logger.error(`[WEBHOOK] Error fetching recent adjustments:`, error.message)

      return reply.status(500).send({
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: error.message || 'Failed to fetch recent adjustments',
        },
      })
    }
  })
}
