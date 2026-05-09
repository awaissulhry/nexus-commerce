/**
 * CS.1 — Channel → us inbound stock reconciliation.
 *
 * Closes TECH_DEBT #43. We push outbound (StockLevel → channel) via
 * OutboundSyncQueue but channels can adjust on their side (Shopify
 * admin edits, eBay merchant corrections, FBA inbound losses) and
 * drift our local copy. This service is the inbound path.
 *
 * Three operations:
 *
 *   recordChannelStockEvent(input)
 *     Idempotent ingest. Resolves the SKU to a Product, snapshots
 *     local StockLevel, computes drift, classifies into a status:
 *       drift = 0                           → APPLIED   (no-op insert
 *                                              for audit only)
 *       0 < |drift| ≤ AUTO_APPLY_THRESHOLD  → AUTO_APPLIED (small
 *                                              drift, snap silently)
 *       |drift| > AUTO_APPLY_THRESHOLD      → REVIEW_NEEDED (operator
 *                                              must decide)
 *     Webhook callers send dupes on retry; the (channel, channelEventId)
 *     unique index turns the second insert into a no-op P2002.
 *
 *   applyChannelStockEvent(eventId, userId)
 *     Operator-confirmed: snap local StockLevel to channel value via
 *     applyStockMovement(reason: CHANNEL_STOCK_RECONCILIATION). Sets
 *     status=APPLIED + resultingMovementId + resolvedAt + resolvedByUserId.
 *
 *   ignoreChannelStockEvent(eventId, userId, reason)
 *     Operator-confirmed: channel is wrong (e.g., a known overselling
 *     event we already processed). No DB stock change; status=IGNORED
 *     + resolution=reason.
 *
 * Auto-apply threshold: 1 unit by default. Small enough that
 * picking-error / scanner-double-tap drifts heal silently, large
 * enough that real channel-side adjustments surface for review.
 * Override per-channel via NEXUS_CS_AUTO_APPLY_<CHANNEL> env vars
 * (e.g. NEXUS_CS_AUTO_APPLY_SHOPIFY=3 to give Shopify a wider band).
 */

import type { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { applyStockMovement } from './stock-movement.service.js'
import { logger } from '../utils/logger.js'

const DEFAULT_AUTO_APPLY_THRESHOLD = 1

function autoApplyThreshold(channel: string): number {
  const envKey = `NEXUS_CS_AUTO_APPLY_${channel.toUpperCase()}`
  const raw = process.env[envKey]
  if (raw === undefined) return DEFAULT_AUTO_APPLY_THRESHOLD
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_AUTO_APPLY_THRESHOLD
}

export interface RecordChannelStockEventInput {
  channel: 'SHOPIFY' | 'EBAY' | 'AMAZON' | 'WOOCOMMERCE'
  channelEventId: string
  sku: string
  channelReportedQty: number
  /** Optional StockLocation.id pin for multi-warehouse channels. */
  locationId?: string | null
  rawPayload?: unknown
}

export interface ChannelStockEventResult {
  id: string
  status: 'PENDING' | 'AUTO_APPLIED' | 'REVIEW_NEEDED' | 'APPLIED' | 'IGNORED'
  drift: number
  channelReportedQty: number
  localQtyAtObservation: number
  productId: string | null
  /** True when this call inserted the row; false on idempotent
   *  retry of an already-recorded (channel, channelEventId). */
  newlyRecorded: boolean
}

/**
 * Ingest a channel-reported stock observation. Idempotent on
 * (channel, channelEventId). Returns the event row + a flag telling
 * the caller whether the insert was new or a retry hit.
 */
export async function recordChannelStockEvent(
  input: RecordChannelStockEventInput,
): Promise<ChannelStockEventResult> {
  const sku = input.sku.trim()
  if (!sku) throw new Error('recordChannelStockEvent: sku required')
  if (input.channelReportedQty < 0) {
    throw new Error('recordChannelStockEvent: channelReportedQty cannot be negative')
  }

  // Idempotency check first — saves us a round-trip to resolve the
  // product on a retry.
  const existing = await prisma.channelStockEvent.findUnique({
    where: {
      channel_channelEventId: {
        channel: input.channel,
        channelEventId: input.channelEventId,
      },
    },
    select: {
      id: true,
      status: true,
      drift: true,
      channelReportedQty: true,
      localQtyAtObservation: true,
      productId: true,
    },
  })
  if (existing) {
    return { ...existing, newlyRecorded: false }
  }

  // Resolve SKU → product (master + variant). Master takes precedence;
  // unmatched SKUs still get recorded so the operator can debug
  // SKU-mapping issues from the same surface.
  const product = await prisma.product.findFirst({
    where: { sku },
    select: { id: true },
  })

  // Compute local stock at observation time. Sum across StockLevel
  // when the event isn't pinned to a specific location, otherwise
  // read just that location.
  let localQty = 0
  if (product) {
    const where: Prisma.StockLevelWhereInput = {
      productId: product.id,
      ...(input.locationId ? { locationId: input.locationId } : {}),
    }
    const agg = await prisma.stockLevel.aggregate({
      where,
      _sum: { quantity: true },
    })
    localQty = agg._sum.quantity ?? 0
  }

  const drift = input.channelReportedQty - localQty
  const threshold = autoApplyThreshold(input.channel)
  let initialStatus: 'PENDING' | 'AUTO_APPLIED' | 'REVIEW_NEEDED' | 'APPLIED'
  if (drift === 0) {
    initialStatus = 'APPLIED' // no-op observation, audit only
  } else if (Math.abs(drift) <= threshold) {
    initialStatus = 'AUTO_APPLIED'
  } else {
    initialStatus = 'REVIEW_NEEDED'
  }

  // Insert the row + (optionally) write the auto-apply movement in
  // the same transaction so the resultingMovementId is filled before
  // the operator surface paints.
  const result = await prisma.$transaction(async (tx) => {
    const created = await tx.channelStockEvent.create({
      data: {
        channel: input.channel,
        channelEventId: input.channelEventId,
        productId: product?.id ?? null,
        sku,
        locationId: input.locationId ?? null,
        channelReportedQty: input.channelReportedQty,
        localQtyAtObservation: localQty,
        drift,
        status: initialStatus,
        rawPayload: input.rawPayload as Prisma.InputJsonValue,
      },
    })

    // For AUTO_APPLIED + drift !== 0 we fire the movement immediately.
    // APPLIED with drift=0 is an audit-only row — no movement.
    if (initialStatus === 'AUTO_APPLIED' && product) {
      const mv = await applyStockMovement({
        productId: product.id,
        locationId: input.locationId ?? undefined,
        change: drift,
        reason: 'CHANNEL_STOCK_RECONCILIATION',
        referenceType: 'ChannelStockEvent',
        referenceId: created.id,
        notes: `Auto-applied ${input.channel} drift ${drift > 0 ? '+' : ''}${drift} (within threshold ${threshold})`,
        actor: 'channel-stock-event-service',
        tx,
      })
      await tx.channelStockEvent.update({
        where: { id: created.id },
        data: {
          resultingMovementId: mv.id,
          resolvedAt: new Date(),
          resolvedByUserId: 'auto',
          resolution: `Within auto-apply threshold (${threshold}u)`,
        },
      })
    }

    return created
  })

  logger.info('channel-stock-event: recorded', {
    id: result.id,
    channel: input.channel,
    sku,
    drift,
    status: initialStatus,
  })

  return {
    id: result.id,
    status: initialStatus,
    drift,
    channelReportedQty: input.channelReportedQty,
    localQtyAtObservation: localQty,
    productId: product?.id ?? null,
    newlyRecorded: true,
  }
}

/**
 * Operator confirms the channel value is right. Snaps local stock
 * to channel via applyStockMovement(CHANNEL_STOCK_RECONCILIATION).
 * No-ops for already-resolved events (idempotent re-clicks).
 */
export async function applyChannelStockEvent(
  eventId: string,
  userId: string | null,
): Promise<{ id: string; resultingMovementId: string | null; alreadyResolved: boolean }> {
  const event = await prisma.channelStockEvent.findUnique({
    where: { id: eventId },
  })
  if (!event) throw new Error(`ChannelStockEvent ${eventId} not found`)

  if (
    event.status === 'APPLIED' ||
    event.status === 'AUTO_APPLIED' ||
    event.status === 'IGNORED'
  ) {
    return {
      id: event.id,
      resultingMovementId: event.resultingMovementId,
      alreadyResolved: true,
    }
  }

  if (!event.productId) {
    throw new Error(
      `ChannelStockEvent ${eventId} has no resolved productId — cannot apply. Map the SKU first.`,
    )
  }

  // No-drift events are weirdly possible (operator clicks Apply on
  // an audit-only row) — skip the movement and just stamp.
  let movementId: string | null = null
  if (event.drift !== 0) {
    const mv = await applyStockMovement({
      productId: event.productId,
      locationId: event.locationId ?? undefined,
      change: event.drift,
      reason: 'CHANNEL_STOCK_RECONCILIATION',
      referenceType: 'ChannelStockEvent',
      referenceId: event.id,
      notes: `Operator-applied ${event.channel} drift ${event.drift > 0 ? '+' : ''}${event.drift}`,
      actor: userId ?? 'channel-stock-event-apply',
    })
    movementId = mv.id
  }

  await prisma.channelStockEvent.update({
    where: { id: event.id },
    data: {
      status: 'APPLIED',
      resultingMovementId: movementId,
      resolvedAt: new Date(),
      resolvedByUserId: userId,
    },
  })

  return { id: event.id, resultingMovementId: movementId, alreadyResolved: false }
}

/**
 * Operator decides the channel is wrong (e.g., a known overselling
 * event we already processed). No DB stock change.
 */
export async function ignoreChannelStockEvent(
  eventId: string,
  userId: string | null,
  reason: string,
): Promise<{ id: string; alreadyResolved: boolean }> {
  const trimmed = reason.trim()
  if (!trimmed) throw new Error('ignoreChannelStockEvent: reason required')

  const event = await prisma.channelStockEvent.findUnique({
    where: { id: eventId },
    select: { id: true, status: true },
  })
  if (!event) throw new Error(`ChannelStockEvent ${eventId} not found`)
  if (
    event.status === 'APPLIED' ||
    event.status === 'AUTO_APPLIED' ||
    event.status === 'IGNORED'
  ) {
    return { id: event.id, alreadyResolved: true }
  }

  await prisma.channelStockEvent.update({
    where: { id: event.id },
    data: {
      status: 'IGNORED',
      resolution: trimmed,
      resolvedAt: new Date(),
      resolvedByUserId: userId,
    },
  })

  return { id: event.id, alreadyResolved: false }
}

export interface ListChannelStockEventsArgs {
  status?: 'PENDING' | 'AUTO_APPLIED' | 'REVIEW_NEEDED' | 'APPLIED' | 'IGNORED' | 'OPEN' | 'ALL'
  channel?: string
  limit?: number
}

/**
 * Operator triage list. `status='OPEN'` is the operator default —
 * matches PENDING + REVIEW_NEEDED in one query.
 */
export async function listChannelStockEvents(args: ListChannelStockEventsArgs = {}) {
  const where: Prisma.ChannelStockEventWhereInput = {}
  if (args.status === 'OPEN') {
    where.status = { in: ['PENDING', 'REVIEW_NEEDED'] }
  } else if (args.status && args.status !== 'ALL') {
    where.status = args.status
  }
  if (args.channel) where.channel = args.channel
  return prisma.channelStockEvent.findMany({
    where,
    include: { product: { select: { id: true, sku: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, Math.max(1, args.limit ?? 100)),
  })
}
