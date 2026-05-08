/**
 * MasterPriceService — single entrypoint for every master-price (Product.basePrice)
 * mutation. Mirrors stock-movement.service.ts (H.1/H.2): one service that all
 * writers route through, so the cascade to ChannelListing + audit log + outbound
 * sync push happens in one atomic transaction, regardless of caller.
 *
 * The bug class this closes: any code path that writes Product.basePrice without
 * going through here leaves ChannelListing rows out of date (their masterPrice
 * snapshot stales, their cascaded price doesn't recompute), and the marketplace
 * keeps showing the pre-edit value until something else triggers a sync. At
 * 3,200 SKUs × multiple marketplaces this drift is invisible, expensive, and
 * compounds. The fix is structural: centralize the mutation, fan out
 * deterministically, persist everything in one transaction.
 *
 * Cascade rules (per ChannelListing):
 *
 *   followMasterPrice = true:
 *     pricingRule = FIXED              → price := newMasterPrice (treat as match-master,
 *                                         since the user opted into following)
 *     pricingRule = MATCH_AMAZON       → price untouched (Amazon-driven, separate flow
 *                                         handles it via PricingSnapshot)
 *     pricingRule = PERCENT_OF_MASTER  → price := newMasterPrice * (1 + adj/100)
 *     Always: masterPrice := newMasterPrice
 *
 *   followMasterPrice = false:
 *     price untouched (drift signal — masterPrice ≠ price means seller has set
 *     a marketplace-specific override)
 *     Always: masterPrice := newMasterPrice (snapshot)
 *
 * Outbound push:
 *   When a listing's `price` actually changes, we enqueue an OutboundSyncQueue row
 *   with syncType='PRICE_UPDATE' and a 5-minute holdUntil grace window (matches
 *   the existing PHASE 12a pattern in outbound-sync-phase9.service.ts). The
 *   bullmq-sync.worker.ts consumer picks the row up after the grace window and
 *   dispatches to pricing-outbound.service.ts → marketplace API. Listings whose
 *   price didn't change (followMasterPrice=false, or MATCH_AMAZON) get only the
 *   masterPrice snapshot update — no marketplace push needed.
 *
 * Audit:
 *   AuditLog row written with slim before/after diff (changed fields only — not
 *   full row dumps, per the model's docstring). Metadata captures the affected
 *   listing IDs + idempotency key + caller-supplied reason so the audit viewer
 *   can answer "who changed this price, when, from what value, and what
 *   propagated where."
 *
 * Idempotency:
 *   ctx.idempotencyKey, when supplied, is recorded on AuditLog.metadata so a
 *   retry can be detected at the audit layer. We do NOT use it to short-circuit
 *   inside the service — the no-op check below (newBasePrice === current) is
 *   the cheap correctness guard.
 *
 * Transactional guarantees:
 *   Product update + ChannelListing fan-out + OutboundSyncQueue inserts +
 *   AuditLog write all run in a single Prisma $transaction. Either everything
 *   commits or nothing does. The BullMQ enqueue (Redis) happens *after* the
 *   transaction commits — if Redis is down, the DB row remains PENDING and a
 *   future drain can pick it up; we never lose work.
 */

import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { outboundSyncQueue } from '../lib/queue.js'
import { logger } from '../utils/logger.js'

// 5 minutes, matches PHASE 12a grace window across other outbound writers.
const DEFAULT_HOLD_MS = 5 * 60 * 1000

export interface MasterPriceUpdateContext {
  /** Who initiated the change. Surfaces in AuditLog.userId; null for system writes. */
  actor?: string | null
  /** Free-form reason — e.g. 'inline-grid-edit', 'bulk-pricing-job', 'csv-import'. */
  reason?: string
  /** Idempotency key from the caller (HTTP request id, job id, etc.). */
  idempotencyKey?: string
  /**
   * Override the 5-minute push grace window. Defaults to true (apply grace).
   * Set false for non-interactive callers (imports, scheduled repricing) where
   * an immediate push is the correct behavior.
   */
  applyGrace?: boolean
  /** Optional Prisma transactional client — when called inside an outer $transaction. */
  tx?: Prisma.TransactionClient
}

export interface MasterPriceUpdateResult {
  /** True when the price actually changed; false when it was a no-op. */
  changed: boolean
  oldBasePrice: number | null
  newBasePrice: number
  /** ChannelListings whose `price` column was rewritten as a result of the cascade. */
  cascadedListingIds: string[]
  /**
   * ChannelListings that had only their `masterPrice` snapshot updated (followMasterPrice=false
   * or pricingRule=MATCH_AMAZON). Tracks drift baselines without producing a marketplace push.
   */
  snapshottedListingIds: string[]
  /** OutboundSyncQueue row IDs enqueued for marketplace push. */
  queuedSyncIds: string[]
  /** AuditLog row id. */
  auditLogId: string | null
}

interface ChannelListingForCascade {
  id: string
  channel: string
  region: string
  marketplace: string
  externalListingId: string | null
  price: Prisma.Decimal | null
  masterPrice: Prisma.Decimal | null
  pricingRule: 'FIXED' | 'MATCH_AMAZON' | 'PERCENT_OF_MASTER'
  priceAdjustmentPercent: Prisma.Decimal | null
  followMasterPrice: boolean
}

/**
 * Compute what a ChannelListing's `price` should become given a new master price.
 * Returns null when the price should NOT be touched (only the masterPrice snapshot
 * updates). Pure function — no side effects, easy to unit-test in isolation.
 */
export function computeListingPrice(
  newMasterPrice: number,
  rule: ChannelListingForCascade['pricingRule'],
  followMasterPrice: boolean,
  adjustmentPercent: Prisma.Decimal | null,
): number | null {
  if (!followMasterPrice) return null
  if (rule === 'MATCH_AMAZON') return null
  if (rule === 'PERCENT_OF_MASTER') {
    const adj = adjustmentPercent != null ? Number(adjustmentPercent) : 0
    return roundCurrency(newMasterPrice * (1 + adj / 100))
  }
  // FIXED + followMasterPrice=true → match master.
  return roundCurrency(newMasterPrice)
}

function roundCurrency(value: number): number {
  // ChannelListing.price is Decimal(10, 2). Round to 2dp to avoid Prisma rejecting
  // a value like 19.99000000000004 from a JS float multiply.
  return Math.round(value * 100) / 100
}

export class MasterPriceService {
  constructor(private readonly client: PrismaClient = prisma) {}

  /**
   * Update Product.basePrice and cascade the change to every linked
   * ChannelListing per the rules documented at the top of this file.
   *
   * Throws if the product doesn't exist or if newBasePrice is negative.
   * Returns a no-op result (changed=false) when newBasePrice equals the
   * current value — by design, repeated identical writes are free and don't
   * generate audit / queue noise.
   */
  async update(
    productId: string,
    newBasePrice: number,
    ctx: MasterPriceUpdateContext = {},
  ): Promise<MasterPriceUpdateResult> {
    if (!Number.isFinite(newBasePrice) || newBasePrice < 0) {
      throw new Error(
        `MasterPriceService.update: invalid basePrice ${newBasePrice} (must be a non-negative finite number)`,
      )
    }
    const rounded = roundCurrency(newBasePrice)
    const txFn = ctx.tx ?? this.client

    // Step 1: read current product + listings inside the (outer or inner)
    // transaction so we have a consistent snapshot to diff against.
    const runner = async (
      tx: Prisma.TransactionClient | PrismaClient,
    ): Promise<MasterPriceUpdateResult> => {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, basePrice: true, sku: true },
      })
      if (!product) {
        throw new Error(`MasterPriceService.update: product ${productId} not found`)
      }
      const oldBasePrice =
        product.basePrice != null ? Number(product.basePrice) : null

      // No-op short-circuit. Saves an entire fan-out + queue write when a
      // caller submits the same value twice (e.g. a debounced auto-save firing
      // after a successful prior save).
      if (oldBasePrice != null && oldBasePrice === rounded) {
        return {
          changed: false,
          oldBasePrice,
          newBasePrice: rounded,
          cascadedListingIds: [],
          snapshottedListingIds: [],
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
          price: true,
          masterPrice: true,
          pricingRule: true,
          priceAdjustmentPercent: true,
          followMasterPrice: true,
        },
      })) as unknown as ChannelListingForCascade[]

      // Step 2: write the master.
      await tx.product.update({
        where: { id: productId },
        data: { basePrice: rounded.toFixed(2) },
      })

      // Step 3: cascade. For each listing, compute the new price (or null when
      // we should only snapshot the master). Track which IDs got which treatment
      // so the result tells the caller exactly what propagated.
      const cascadedListingIds: string[] = []
      const snapshottedListingIds: string[] = []
      const queueRowsToCreate: Prisma.OutboundSyncQueueCreateManyInput[] = []
      const holdUntil =
        ctx.applyGrace === false
          ? null
          : new Date(Date.now() + DEFAULT_HOLD_MS)

      for (const listing of listings) {
        const newListingPrice = computeListingPrice(
          rounded,
          listing.pricingRule,
          listing.followMasterPrice,
          listing.priceAdjustmentPercent,
        )
        const oldListingPrice =
          listing.price != null ? Number(listing.price) : null

        if (newListingPrice != null && newListingPrice !== oldListingPrice) {
          // Real cascade: update both snapshot + computed price + flag for sync.
          await tx.channelListing.update({
            where: { id: listing.id },
            data: {
              masterPrice: rounded.toFixed(2),
              price: newListingPrice.toFixed(2),
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
            syncType: 'PRICE_UPDATE',
            holdUntil,
            externalListingId: listing.externalListingId,
            payload: {
              source: 'MASTER_PRICE_CHANGE',
              productId,
              productSku: product.sku,
              channel: listing.channel,
              marketplace: listing.marketplace,
              price: newListingPrice,
              oldPrice: oldListingPrice,
              masterPrice: rounded,
              oldMasterPrice: oldBasePrice,
              pricingRule: listing.pricingRule,
              priceAdjustmentPercent:
                listing.priceAdjustmentPercent != null
                  ? Number(listing.priceAdjustmentPercent)
                  : null,
              reason: ctx.reason ?? null,
              idempotencyKey: ctx.idempotencyKey ?? null,
            },
          })
        } else {
          // Snapshot-only path: masterPrice tracks the new master so the
          // followMasterPrice=false drift signal (masterPrice ≠ price) stays
          // accurate. price column untouched.
          await tx.channelListing.update({
            where: { id: listing.id },
            data: { masterPrice: rounded.toFixed(2) },
          })
          snapshottedListingIds.push(listing.id)
        }
      }

      // Step 4: enqueue all the OutboundSyncQueue rows in one createMany.
      // Note: createMany doesn't return ids, so we follow up with a findMany
      // filtered to just the listings we touched in this call to surface them
      // to the caller for observability.
      let queuedSyncIds: string[] = []
      if (queueRowsToCreate.length > 0) {
        await tx.outboundSyncQueue.createMany({ data: queueRowsToCreate })
        const justEnqueued = await tx.outboundSyncQueue.findMany({
          where: {
            channelListingId: { in: cascadedListingIds },
            syncType: 'PRICE_UPDATE',
            syncStatus: 'PENDING',
          },
          orderBy: { createdAt: 'desc' },
          take: cascadedListingIds.length,
          select: { id: true },
        })
        queuedSyncIds = justEnqueued.map((r) => r.id)
      }

      // Step 5: audit. Slim before/after — only the field that actually changed.
      // metadata carries the propagation summary so the audit viewer can render
      // "→ 5 listings cascaded, 2 snapshot-only, 5 syncs queued."
      const audit = await tx.auditLog.create({
        data: {
          entityType: 'Product',
          entityId: productId,
          action: 'update',
          userId: ctx.actor ?? null,
          before: { basePrice: oldBasePrice },
          after: { basePrice: rounded },
          metadata: {
            field: 'basePrice',
            reason: ctx.reason ?? null,
            idempotencyKey: ctx.idempotencyKey ?? null,
            cascadedListingIds,
            snapshottedListingIds,
            queuedSyncIds,
            graceMs: holdUntil
              ? holdUntil.getTime() - Date.now()
              : 0,
          },
          createdAt: new Date(),
        },
        select: { id: true },
      })

      return {
        changed: true,
        oldBasePrice,
        newBasePrice: rounded,
        cascadedListingIds,
        snapshottedListingIds,
        queuedSyncIds,
        auditLogId: audit.id,
      }
    }

    // Reuse the caller's transaction if provided; otherwise open a new one.
    // This lets PATCH /api/products/bulk wrap a multi-product service call
    // in a single transaction without blowing up on nested $transaction.
    const result = ctx.tx
      ? await runner(ctx.tx)
      : await this.client.$transaction(runner)

    // Step 6: BullMQ enqueue happens AFTER the DB transaction commits. If
    // Redis is down, the DB row stays PENDING and the next drain pass picks
    // it up — we never lose work. We log on enqueue failure but don't throw,
    // because the user's edit already landed and the DB row is the source of
    // truth for "needs to be pushed."
    //
    // When ctx.tx is supplied we are running inside the caller's outer
    // transaction — that tx hasn't committed yet, and could roll back. The
    // cron worker drains the PENDING queue rows after the outer commit
    // completes, so the caller is responsible for any post-commit speedup
    // (typically: don't bother — cron is fine).
    if (!ctx.tx && result.queuedSyncIds.length > 0) {
      const delay =
        ctx.applyGrace === false ? 0 : DEFAULT_HOLD_MS
      for (const queueId of result.queuedSyncIds) {
        try {
          await outboundSyncQueue.add(
            'sync-job',
            {
              queueId,
              productId,
              syncType: 'PRICE_UPDATE',
              source: 'MASTER_PRICE_CHANGE',
            },
            {
              delay,
              jobId: queueId,
            },
          )
        } catch (err) {
          logger.warn(
            'MasterPriceService: BullMQ enqueue failed (DB row remains PENDING for next drain)',
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
      logger.info('MasterPriceService.update', {
        productId,
        oldBasePrice: result.oldBasePrice,
        newBasePrice: result.newBasePrice,
        cascaded: result.cascadedListingIds.length,
        snapshotted: result.snapshottedListingIds.length,
        queued: result.queuedSyncIds.length,
        actor: ctx.actor ?? null,
        reason: ctx.reason ?? null,
      })
    }

    return result
  }
}

/** Default singleton — most callers should import this. */
export const masterPriceService = new MasterPriceService()
