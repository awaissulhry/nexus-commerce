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
 * Currency (CX review 2026-09-26 — refuse, don't convert):
 *   The master is a number in the master currency (NEXUS_MASTER_CURRENCY, EUR). A listing whose market
 *   sells in another currency — or whose currency is not configured — is NOT sent a master price: its
 *   price stays, its masterPrice snapshot moves, nothing is queued, and the refusal is recorded (result,
 *   audit metadata, and a MASTER_PRICE_CURRENCY_REFUSED sync-health conflict once the transaction is ours
 *   and committed). It used to send the EUR number to a GBP market as pounds.
 *
 * Outbound push:
 *   When a listing's `price` actually changes, we enqueue an OutboundSyncQueue row
 *   with syncType='PRICE_UPDATE' and a 5-minute holdUntil grace window (matches
 *   the existing PHASE 12a pattern in outbound-sync-phase9.service.ts). The
 *   bullmq-sync.worker.ts consumer picks the row up after the grace window and
 *   dispatches to pricing-outbound.service.ts → marketplace API. Listings whose
 *   price didn't change (followMasterPrice=false, or MATCH_AMAZON) get only the
 *   masterPrice snapshot update — no marketplace push needed. A paused listing
 *   (syncPaused) keeps the cascaded price but gets no queue row, as in the stock
 *   cascade: the push lock refused that row at dispatch anyway. A still-draft
 *   (`isStillDraftListing`: DRAFT, never published, no channel id) is treated the
 *   same even when it is not paused: it is not on the channel, and only Publish
 *   sends it — with the price stored here.
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

import { createOutboundRows } from './outbound-rows.js'
import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { outboundSyncQueue, addJobSafely } from '../lib/queue.js'
import { logger } from '../utils/logger.js'
import { masterCurrency } from './fx-rate.service.js'
import { marketCurrency, type MarketCurrencyRow } from './pim/market-currency.js'
import { isStillDraftListing } from '@nexus/shared/push-lock'

// IS.2b — reduced from 5 min to 30s. Price changes from the edit page
// should reach channels within ~1 minute. The route layer debounces
// rapid consecutive edits before calling this service.
const DEFAULT_HOLD_MS = 30 * 1000

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
  /** Listings NOT sent the master price because their market's currency is not the master currency (null = not configured). */
  currencyRefused: Array<{ listingId: string; channel: string; marketplace: string; currency: string | null; masterCurrency: string }>
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
  syncPaused: boolean
  listingStatus: string | null
  isPublished: boolean
}

/**
 * Whether a cascaded price stays in Nexus instead of being queued for the channel: a paused listing (an operator's
 * pause, or a draft kept inert by its pause) and a still-draft (`isStillDraftListing`), paused or not. A draft started
 * before drafts were born paused is not paused, and sending it a price would write to the channel before Publish.
 * A DRAFT row with a channel id has reached the channel, so it is not a still-draft and is queued.
 */
export function holdsCascadedPrice(listing: Pick<ChannelListingForCascade, 'syncPaused' | 'listingStatus' | 'isPublished' | 'externalListingId'>): boolean {
  return listing.syncPaused || isStillDraftListing(listing)
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
          currencyRefused: [],
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
          syncPaused: true,
          listingStatus: true,
          isPublished: true,
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
      const currencyRefused: MasterPriceUpdateResult['currencyRefused'] = []
      const master = masterCurrency()
      let currencyRows: MarketCurrencyRow[] | null = null
      /** The listing market's configured currency, or null (not configured → never the master currency). */
      const currencyOf = async (listing: ChannelListingForCascade): Promise<string | null> => {
        currencyRows ??= await tx.marketplace.findMany({ select: { channel: true, code: true, currency: true } }) as MarketCurrencyRow[]
        try { return marketCurrency(listing.channel, listing.marketplace, currencyRows) } catch { return null }
      }
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
        // Refuse, don't convert: only a listing that sells in the master currency is sent the master number.
        const listingCurrency = newListingPrice != null && newListingPrice !== oldListingPrice ? await currencyOf(listing) : master
        if (listingCurrency !== master) {
          currencyRefused.push({ listingId: listing.id, channel: listing.channel, marketplace: listing.marketplace, currency: listingCurrency, masterCurrency: master })
        }

        if (newListingPrice != null && newListingPrice !== oldListingPrice && listingCurrency === master) {
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
          // A paused listing (an operator's pause, or an inert draft) keeps the stored price but is
          // not queued, the way the stock cascade treats it. Dispatch refused its row anyway
          // (PUSH_SYNC_PAUSED, terminal), so nothing sent changes; resume never replayed those rows.
          // A still-draft is not queued either, paused or not. An unpaused one passes the push lock, and
          // only the BullMQ worker skips an unpublished listing: the cron backstop, which dispatches every
          // row that has no job (each row written inside a caller's transaction), sent its price.
          if (holdsCascadedPrice(listing)) continue
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
        await createOutboundRows(tx, { data: queueRowsToCreate })
        // The queued listings only: a paused listing is cascaded but not queued.
        const queuedListingIds = queueRowsToCreate.map((row) => row.channelListingId as string)
        const justEnqueued = await tx.outboundSyncQueue.findMany({
          where: {
            channelListingId: { in: queuedListingIds },
            syncType: 'PRICE_UPDATE',
            syncStatus: 'PENDING',
          },
          orderBy: { createdAt: 'desc' },
          take: queuedListingIds.length,
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
            currencyRefusedListingIds: currencyRefused.map((r) => r.listingId),
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
        currencyRefused,
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
        // Bounded + circuit-broken: unreachable Redis can't hang the request;
        // the DB row stays PENDING for the drain cron.
        await addJobSafely(
          outboundSyncQueue,
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
      }
    }

    // Refusals are recorded once the transaction is ours and committed (inside a caller's transaction they
    // live in the result and the audit row, which commit or roll back with it). Best effort: never undoes the edit.
    if (result.currencyRefused.length > 0) {
      logger.warn('MasterPriceService.update: master price not sent to a different-currency market', { productId, refused: result.currencyRefused })
      if (!ctx.tx) {
        const { syncHealthService } = await import('./sync-health.service.js')
        for (const refusal of result.currencyRefused) {
          const where = `${refusal.channel} ${refusal.marketplace}`
          await syncHealthService.logConflict({
            channel: refusal.channel,
            conflictType: 'MASTER_PRICE_CURRENCY_REFUSED',
            message: refusal.currency
              ? `The master price ${refusal.masterCurrency} ${result.newBasePrice.toFixed(2)} was not sent to ${where}: that market sells in ${refusal.currency}. Set this listing's own ${refusal.currency} price. Nothing was queued.`
              : `The master price ${refusal.masterCurrency} ${result.newBasePrice.toFixed(2)} was not sent to ${where}: no currency is configured for that market. Nothing was queued.`,
            productId,
            localData: { masterPrice: result.newBasePrice, masterCurrency: refusal.masterCurrency },
            remoteData: { listingId: refusal.listingId, marketplace: refusal.marketplace, marketCurrency: refusal.currency },
          }).catch(() => { /* observability best-effort — the refusal already holds */ })
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
