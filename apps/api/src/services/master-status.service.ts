/**
 * MasterStatusService — single entrypoint for every master-status (Product.status)
 * mutation. Mirrors master-price.service.ts: one service all writers route through,
 * so the cascade to ChannelListing.listingStatus + AuditLog + OutboundSyncQueue
 * happens atomically regardless of caller.
 *
 * The bug class this closes (TECH_DEBT #53): Product.status was being written
 * directly (e.g. bulk-action.service.ts:processStatusUpdate) without informing
 * marketplaces. Going ACTIVE → INACTIVE in bulk should pull the listings down on
 * Amazon and eBay; before this service it was a database-only flip and the
 * marketplaces continued showing items as available, with buyers placing orders
 * on items the seller had marked off-shelf.
 *
 * Cascade rules (per ChannelListing):
 *
 *   Product.status = ACTIVE   → listingStatus := ACTIVE
 *   Product.status = INACTIVE → listingStatus := INACTIVE
 *   Product.status = DRAFT    → listingStatus := DRAFT
 *
 *   Listings already in a terminal/error state are skipped, since their state
 *   is owned by the marketplace, not the master:
 *     ENDED  — listing was retired on the marketplace; resurrecting it is a
 *              re-listing flow, not a status flip
 *     ERROR  — operator must resolve the underlying issue first; cascading
 *              over an ERROR can mask the failure
 *
 * Outbound push:
 *   For every listing whose listingStatus actually changes, an OutboundSyncQueue
 *   row is enqueued with syncType='STATUS_UPDATE' and the standard 5-minute
 *   holdUntil grace window. The cron worker (sync.worker.ts → processPendingSyncs)
 *   drains it within ~60s of the grace window expiring.
 *
 * Audit:
 *   AuditLog row written with slim before/after diff (status only) and metadata
 *   listing exactly which listings cascaded and which were skipped (and why),
 *   so the audit viewer can answer "who changed status, when, what propagated."
 *
 * Idempotency:
 *   Same approach as MasterPriceService: identical no-op write returns
 *   changed=false, no audit/queue noise. ctx.idempotencyKey lands on
 *   AuditLog.metadata for caller-side retry detection.
 *
 * Transactional guarantees:
 *   Product update + ChannelListing fan-out + OutboundSyncQueue inserts +
 *   AuditLog write all run inside a single Prisma $transaction. BullMQ enqueue
 *   runs after commit; if Redis is down the DB row stays PENDING and the cron
 *   drain picks it up.
 */

import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { outboundSyncQueue } from '../lib/queue.js'
import { logger } from '../utils/logger.js'

const DEFAULT_HOLD_MS = 5 * 60 * 1000

export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE'

const VALID_PRODUCT_STATUS: readonly ProductStatus[] = [
  'DRAFT',
  'ACTIVE',
  'INACTIVE',
] as const

// Mirrors the docstring above. ENDED + ERROR rows are skipped because the
// marketplace owns those states, not the master.
const TERMINAL_LISTING_STATUSES = new Set(['ENDED', 'ERROR'])

export interface MasterStatusUpdateContext {
  actor?: string | null
  reason?: string
  idempotencyKey?: string
  /** Override the 5-minute push grace window. Defaults to true. */
  applyGrace?: boolean
  tx?: Prisma.TransactionClient
  /**
   * Skip the post-transaction BullMQ enqueue (DB row is still PENDING; the
   * cron worker drains within ~60s). Used by callers that have hit the
   * BullMQ enqueue hang in their detached context (TECH_DEBT #54).
   */
  skipBullMQEnqueue?: boolean
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

interface ChannelListingForStatusCascade {
  id: string
  channel: string
  region: string
  marketplace: string
  externalListingId: string | null
  listingStatus: string
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

      const listings = (await tx.channelListing.findMany({
        where: { productId },
        select: {
          id: true,
          channel: true,
          region: true,
          marketplace: true,
          externalListingId: true,
          listingStatus: true,
        },
      })) as ChannelListingForStatusCascade[]

      await tx.product.update({
        where: { id: productId },
        data: { status: newStatus },
      })

      const cascadedListingIds: string[] = []
      const skippedListingIds: string[] = []
      const queueRowsToCreate: Prisma.OutboundSyncQueueCreateManyInput[] = []
      const holdUntil =
        ctx.applyGrace === false
          ? null
          : new Date(Date.now() + DEFAULT_HOLD_MS)

      for (const listing of listings) {
        if (TERMINAL_LISTING_STATUSES.has(listing.listingStatus)) {
          skippedListingIds.push(listing.id)
          continue
        }
        if (listing.listingStatus === newStatus) {
          // Already in target state — nothing to push, but still skip; this
          // happens after a partial cascade was retried.
          skippedListingIds.push(listing.id)
          continue
        }

        await tx.channelListing.update({
          where: { id: listing.id },
          data: {
            listingStatus: newStatus,
            lastSyncStatus: 'PENDING',
            lastSyncedAt: null,
            version: { increment: 1 },
          },
        })
        cascadedListingIds.push(listing.id)
        queueRowsToCreate.push({
          productId,
          channelListingId: listing.id,
          targetChannel: listing.channel as any,
          targetRegion: listing.region,
          syncStatus: 'PENDING' as any,
          syncType: 'STATUS_UPDATE',
          holdUntil,
          externalListingId: listing.externalListingId,
          payload: {
            source: 'MASTER_STATUS_CHANGE',
            productId,
            productSku: product.sku,
            channel: listing.channel,
            marketplace: listing.marketplace,
            oldListingStatus: listing.listingStatus,
            newListingStatus: newStatus,
            oldProductStatus: oldStatus,
            newProductStatus: newStatus,
            reason: ctx.reason ?? null,
            idempotencyKey: ctx.idempotencyKey ?? null,
          },
        })
      }

      let queuedSyncIds: string[] = []
      if (queueRowsToCreate.length > 0) {
        await tx.outboundSyncQueue.createMany({ data: queueRowsToCreate })
        const justEnqueued = await tx.outboundSyncQueue.findMany({
          where: {
            channelListingId: { in: cascadedListingIds },
            syncType: 'STATUS_UPDATE',
            syncStatus: 'PENDING',
          },
          orderBy: { createdAt: 'desc' },
          take: cascadedListingIds.length,
          select: { id: true },
        })
        queuedSyncIds = justEnqueued.map((r) => r.id)
      }

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
            graceMs: holdUntil ? holdUntil.getTime() - Date.now() : 0,
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

    if (!ctx.skipBullMQEnqueue && result.queuedSyncIds.length > 0) {
      const delay = ctx.applyGrace === false ? 0 : DEFAULT_HOLD_MS
      for (const queueId of result.queuedSyncIds) {
        try {
          await outboundSyncQueue.add(
            'sync-job',
            {
              queueId,
              productId,
              syncType: 'STATUS_UPDATE',
              source: 'MASTER_STATUS_CHANGE',
            },
            { delay, jobId: queueId },
          )
        } catch (err) {
          logger.warn(
            'MasterStatusService: BullMQ enqueue failed (DB row remains PENDING for next drain)',
            {
              queueId,
              productId,
              err: err instanceof Error ? err.message : String(err),
            },
          )
        }
      }
    }

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
