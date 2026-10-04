/**
 * MasterStatusService — single entrypoint for every master-status (Product.status) mutation, so every writer
 * (bulk action, products-list bulk status, scheduled changes, assortment copy) records the same audit row.
 *
 * 🔴 Sheet publish parity, step 7 (the Owner's D4 choice, 2026-10-01): the master Status is a NEXUS-ONLY catalog
 * field. It no longer touches channel listings at all.
 *
 * What it did before, and why that was removed (measured on 087224821):
 *   - It set every listing's `listingStatus` to the new product status. That column is the CHANNEL's state (the
 *     Shopify sync, the publisher and the sheet's Status column read it), so an INACTIVE product showed its live
 *     listings as inactive while the channels kept selling.
 *   - It queued a STATUS_UPDATE row per listing. No dispatcher turns that row into a channel change: Amazon skipped it
 *     (`AMAZON_EMPTY_PATCH_NOT_SENT`), eBay reported SUCCESS with nothing sent, Shopify family products failed with
 *     "Unsupported native Shopify sync type", and older Shopify and Etsy rows were treated as a quantity push. So the
 *     screen said the change reached the channels when it had not.
 * Stopping, pausing and ending a listing is now the sheet's per-channel Status column (listing-action.service.ts):
 * preview, confirm, then the channel calls through the gateway.
 *
 * Audit: an AuditLog row with the status diff; its metadata lists the listings left untouched and says why.
 * Idempotency: an identical write returns changed=false with no audit row. ctx.idempotencyKey lands on the metadata.
 */

import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE'

const VALID_PRODUCT_STATUS: readonly ProductStatus[] = [
  'DRAFT',
  'ACTIVE',
  'INACTIVE',
] as const

export interface MasterStatusUpdateContext {
  actor?: string | null
  reason?: string
  idempotencyKey?: string
  /** Kept so existing callers compile; nothing is queued any more (see the header). */
  applyGrace?: boolean
  tx?: Prisma.TransactionClient
}

export interface MasterStatusUpdateResult {
  changed: boolean
  oldStatus: ProductStatus | null
  newStatus: ProductStatus
  cascadedListingIds: string[]
  skippedListingIds: string[]
  queuedSyncIds: string[]
  auditLogId: string | null
}

export class MasterStatusService {
  constructor(private readonly client: PrismaClient = prisma) {}

  async update(
    productId: string,
    newStatus: ProductStatus,
    ctx: MasterStatusUpdateContext = {},
  ): Promise<MasterStatusUpdateResult> {
    if (!VALID_PRODUCT_STATUS.includes(newStatus)) {
      throw new Error(
        `MasterStatusService.update: invalid status ${newStatus} (must be one of ${VALID_PRODUCT_STATUS.join(', ')})`,
      )
    }

    const runner = async (
      tx: Prisma.TransactionClient | PrismaClient,
    ): Promise<MasterStatusUpdateResult> => {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, status: true, sku: true },
      })
      if (!product) {
        throw new Error(
          `MasterStatusService.update: product ${productId} not found`,
        )
      }
      const oldStatus = (product.status ?? null) as ProductStatus | null

      if (oldStatus === newStatus) {
        return {
          changed: false,
          oldStatus,
          newStatus,
          cascadedListingIds: [],
          skippedListingIds: [],
          queuedSyncIds: [],
          auditLogId: null,
        }
      }

      const listings = await tx.channelListing.findMany({ where: { productId }, select: { id: true } })

      await tx.product.update({
        where: { id: productId },
        data: { status: newStatus },
      })

      // Nexus-only (see the header): no listing is changed and nothing is queued for a channel.
      const cascadedListingIds: string[] = []
      const skippedListingIds = listings.map((listing) => listing.id)
      const queuedSyncIds: string[] = []

      const audit = await tx.auditLog.create({
        data: {
          entityType: 'Product',
          entityId: productId,
          action: 'update',
          userId: ctx.actor ?? null,
          before: { status: oldStatus },
          after: { status: newStatus },
          metadata: {
            field: 'status',
            reason: ctx.reason ?? null,
            idempotencyKey: ctx.idempotencyKey ?? null,
            cascadedListingIds,
            skippedListingIds,
            queuedSyncIds,
            listingsUntouched: 'The master Status is Nexus-only; use the sheet Status column to change how a listing sells.',
          },
          createdAt: new Date(),
        },
        select: { id: true },
      })

      return {
        changed: true,
        oldStatus,
        newStatus,
        cascadedListingIds,
        skippedListingIds,
        queuedSyncIds,
        auditLogId: audit.id,
      }
    }

    const result = ctx.tx
      ? await runner(ctx.tx)
      : await this.client.$transaction(runner)

    if (result.changed) {
      logger.info('MasterStatusService.update', {
        productId,
        oldStatus: result.oldStatus,
        newStatus: result.newStatus,
        cascaded: result.cascadedListingIds.length,
        skipped: result.skippedListingIds.length,
        queued: result.queuedSyncIds.length,
        actor: ctx.actor ?? null,
        reason: ctx.reason ?? null,
      })
    }

    return result
  }
}

export const masterStatusService = new MasterStatusService()
