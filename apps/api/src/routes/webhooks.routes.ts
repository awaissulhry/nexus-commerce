/**
 * S.1 — Inventory webhooks routed through canonical applyStockMovement.
 *
 * Pre-S.1, these handlers used inventory-sync.service (the shadow path)
 * which wrote Product.totalStock directly, audited movements without
 * locationId/quantityBefore, and queried the legacy Listing table.
 * That bypassed every H.1/H.2 invariant.
 *
 * Now every mutation routes through stock-movement.service.applyStockMovement,
 * which:
 *   - resolves to a StockLocation (defaults to IT-MAIN)
 *   - writes the StockLevel ledger
 *   - recomputes Product.totalStock = SUM(StockLevel.quantity)
 *   - emits a StockMovement audit row with locationId + quantityBefore
 *   - cascades to ChannelListings + enqueues OutboundSyncQueue rows
 *
 * GET /webhooks/recent-adjustments removed — use GET /api/stock/movements
 * (DB-backed, supports filters and pagination).
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { applyStockMovement } from '../services/stock-movement.service.js'
import { logger } from '../utils/logger.js'

interface OrderCreatedPayload {
  sku: string
  quantity: number
  channel?: string
  orderId?: string
  timestamp?: string
}

type WebhookAdjustmentReason = 'SALE' | 'RESTOCK' | 'ADJUSTMENT' | 'RETURN'

interface StockAdjustmentPayload {
  sku: string
  newQuantity: number
  reason?: WebhookAdjustmentReason
}

// Map the webhook's high-level reason to a StockMovementReason. SALE is
// not exposed here (only sale paths via order ingestion / channel
// services use ORDER_PLACED — webhook is for manual operator flows).
const ADJUSTMENT_REASON_MAP: Record<WebhookAdjustmentReason, 'INBOUND_RECEIVED' | 'MANUAL_ADJUSTMENT' | 'RETURN_RECEIVED' | 'ORDER_PLACED'> = {
  SALE: 'ORDER_PLACED',
  RESTOCK: 'INBOUND_RECEIVED',
  ADJUSTMENT: 'MANUAL_ADJUSTMENT',
  RETURN: 'RETURN_RECEIVED',
}

export async function webhookRoutes(app: FastifyInstance) {
  // ── POST /api/webhooks/order-created ─────────────────────────────
  // External "an order arrived" webhook. Decrements stock by `quantity`
  // for the matching SKU. Real channel order ingestion (Amazon, eBay,
  // Shopify) does NOT call this — those services hit applyStockMovement
  // directly. This endpoint is kept for external proxies / test
  // harnesses that want a stock-only effect without an Order row.
  app.post<{ Body: OrderCreatedPayload }>('/api/webhooks/order-created', async (request, reply) => {
    try {
      const { sku, quantity, channel = 'UNKNOWN', orderId } = request.body

      if (!sku || !quantity || quantity <= 0) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'INVALID_PAYLOAD',
            message: 'Missing required fields: sku, quantity (must be > 0)',
          },
        })
      }

      const product = await prisma.product.findUnique({
        where: { sku },
        select: { id: true, sku: true, totalStock: true },
      })

      if (!product) {
        return reply.status(404).send({
          success: false,
          error: { code: 'PRODUCT_NOT_FOUND', message: `Product not found: ${sku}` },
        })
      }

      const previousQuantity = product.totalStock
      const movement = await applyStockMovement({
        productId: product.id,
        change: -quantity,
        reason: 'ORDER_PLACED',
        referenceType: 'Webhook',
        referenceId: orderId ?? null,
        orderId: orderId ?? undefined,
        actor: 'webhook:order-created',
        notes: `External order webhook (channel=${channel})`,
      })

      logger.info('[WEBHOOK] order-created processed', {
        sku,
        quantity,
        movementId: movement.id,
        balanceAfter: movement.balanceAfter,
      })

      return reply.status(200).send({
        success: true,
        data: {
          movement: {
            id: movement.id,
            productId: movement.productId,
            sku: product.sku,
            locationId: movement.locationId,
            change: movement.change,
            previousQuantity,
            balanceAfter: movement.balanceAfter,
            quantityBefore: movement.quantityBefore,
            reason: movement.reason,
            createdAt: movement.createdAt,
          },
          message: 'Stock decremented via canonical applyStockMovement',
        },
      })
    } catch (error: any) {
      logger.error('[WEBHOOK] order-created failed', { error: error?.message ?? String(error) })
      return reply.status(500).send({
        success: false,
        error: { code: 'WEBHOOK_ERROR', message: error?.message ?? 'Failed to process order webhook' },
      })
    }
  })

  // ── POST /webhooks/stock-adjustment ──────────────────────────────
  // Sets a SKU's totalStock to an absolute value. Computes the delta
  // and routes it through applyStockMovement so the StockLevel ledger
  // and channel cascade fire correctly. The delta=0 short-circuit
  // returns the existing snapshot without an audit row (apply rejects
  // change=0 by design).
  app.post<{ Body: StockAdjustmentPayload }>('/webhooks/stock-adjustment', async (request, reply) => {
    try {
      const { sku, newQuantity, reason = 'ADJUSTMENT' } = request.body

      if (!sku || newQuantity === undefined) {
        return reply.status(400).send({
          success: false,
          error: { code: 'INVALID_PAYLOAD', message: 'Missing required fields: sku, newQuantity' },
        })
      }
      if (!Number.isFinite(newQuantity) || newQuantity < 0) {
        return reply.status(400).send({
          success: false,
          error: { code: 'INVALID_PAYLOAD', message: 'newQuantity must be a non-negative integer' },
        })
      }

      const product = await prisma.product.findUnique({
        where: { sku },
        select: { id: true, sku: true, totalStock: true },
      })

      if (!product) {
        return reply.status(404).send({
          success: false,
          error: { code: 'PRODUCT_NOT_FOUND', message: `Product not found: ${sku}` },
        })
      }

      const previousQuantity = product.totalStock
      const change = newQuantity - previousQuantity

      if (change === 0) {
        return reply.status(200).send({
          success: true,
          data: {
            movement: null,
            sku: product.sku,
            previousQuantity,
            newQuantity,
            message: 'No change — totalStock already at target value',
          },
        })
      }

      const movement = await applyStockMovement({
        productId: product.id,
        change,
        reason: ADJUSTMENT_REASON_MAP[reason],
        referenceType: 'Webhook',
        actor: 'webhook:stock-adjustment',
        notes: `Stock-adjustment webhook (reason=${reason})`,
      })

      logger.info('[WEBHOOK] stock-adjustment processed', {
        sku,
        previousQuantity,
        newQuantity,
        movementId: movement.id,
      })

      return reply.status(200).send({
        success: true,
        data: {
          movement: {
            id: movement.id,
            productId: movement.productId,
            sku: product.sku,
            locationId: movement.locationId,
            change: movement.change,
            previousQuantity,
            balanceAfter: movement.balanceAfter,
            quantityBefore: movement.quantityBefore,
            reason: movement.reason,
            createdAt: movement.createdAt,
          },
          message: 'Stock adjusted via canonical applyStockMovement',
        },
      })
    } catch (error: any) {
      logger.error('[WEBHOOK] stock-adjustment failed', { error: error?.message ?? String(error) })
      return reply.status(500).send({
        success: false,
        error: { code: 'WEBHOOK_ERROR', message: error?.message ?? 'Failed to process stock adjustment webhook' },
      })
    }
  })

  // GET /webhooks/recent-adjustments removed in S.1.
  // Use GET /api/stock/movements (DB-backed) for the same data —
  // it supports productId/variationId/warehouseId filters and a
  // `limit` parameter, and survives process restarts (the old
  // endpoint kept its list in-memory and lost it every redeploy).
}
