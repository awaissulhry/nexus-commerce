import { workspaceKey } from '@nexus/database/workspace-context'
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
import { applyStockMovement, ProtectedLocationError } from './stock-movement.service.js'
import { logger } from '../utils/logger.js'
import { loadSyncLedgers } from './stock-pool/sync-ledgers.js'
import { productByOwnSku } from './listings/reported-sku.js'

const DEFAULT_AUTO_APPLY_THRESHOLD = 1

/**
 * MCP full control 08 S2 (F7) — may a channel's reported number change this location? Never the FBA mirror (only
 * the FBA inventory sync writes it); a Shopify location only from Shopify's own events (the webhook keeps that
 * mirror). An Amazon event never changes any location (S2b). Other locations, and another channel's event with no
 * location, are not refused here.
 */
async function channelEventLocationRefusal(locationId: string | null | undefined, channel: string): Promise<ProtectedLocationError | null> {
  // 08 S2b — Amazon reports FBA stock only: its number never changes any location, an own warehouse least of all.
  if (channel === 'AMAZON') {
    return new ProtectedLocationError(locationId ?? '', 'AMAZON_FBA', 'an Amazon stock event',
      'An Amazon stock event reports FBA stock: it never changes an own warehouse, and only the FBA inventory sync writes FBA stock. Ignore it; the next FBA sync updates the FBA number.')
  }
  if (!locationId) return null
  const location = await prisma.stockLocation.findUnique({ where: { id: locationId }, select: { type: true } })
  if (location?.type === 'AMAZON_FBA') return new ProtectedLocationError(locationId, location.type, 'a channel stock event')
  if (location?.type === 'SHOPIFY_LOCATION' && channel !== 'SHOPIFY') {
    return new ProtectedLocationError(locationId, location.type, `a ${channel} stock event`)
  }
  return null
}

/** The FBA mirror location the FBA inventory sync writes (`amazon-inventory.service.ts`). */
const FBA_MIRROR_CODE = 'AMAZON-EU-FBA'

/**
 * MCP full control 08 S2b — the location an event is compared with and recorded at. Amazon's one stock notification
 * (FBA_INVENTORY_AVAILABILITY_CHANGES, `amazon-sqs-poll.job.ts`) is FBA fulfillable stock and names no location, so an
 * Amazon event without one is about the FBA mirror. Before, it was compared with the product's stock in every location
 * and a drift of 1 landed on the default own warehouse. With no mirror the event keeps no location (and still never
 * applies: `channelEventLocationRefusal`).
 */
async function observedLocationId(input: Pick<RecordChannelStockEventInput, 'channel' | 'locationId'>): Promise<string | null> {
  if (input.locationId || input.channel !== 'AMAZON') return input.locationId ?? null
  const mirror = await prisma.stockLocation.findUnique({ where: { workspace_code: workspaceKey({ code: FBA_MIRROR_CODE }) }, select: { id: true } })
  return mirror?.id ?? null
}

/** 08 S2b — why an FBA observation is settled the moment it is recorded. */
export const FBA_IGNORED_REASON = 'Amazon owns the FBA number'

/**
 * An Amazon event about the FBA number: at the FBA mirror, or with no location at all (no mirror to pin it to). An
 * Amazon event pinned to an own warehouse by hand is not one: it waits for review (and Apply still refuses it).
 */
async function isFbaObservation(channel: string, locationId: string | null): Promise<boolean> {
  if (channel !== 'AMAZON') return false
  if (!locationId) return true
  return (await prisma.stockLocation.findUnique({ where: { id: locationId }, select: { type: true } }))?.type === 'AMAZON_FBA'
}

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
  /** Either sku OR productId. productId wins when both are set —
   *  webhook callers that already resolved channel-id → productId
   *  pass it directly to skip the redundant SKU lookup. */
  sku?: string
  productId?: string
  /** S7 — the connected account that reported `sku`. When set, a listing's OWN SKU on that account is matched first
   *  (`productByOwnSku`); otherwise, and for a SKU no listing holds as its own, the product SKU lookup below runs as
   *  before. Two products on one SKU: the event is recorded unmatched, never on a guessed product. */
  channelConnectionId?: string | null
  /** When set, the local-stock lookup AND the resulting movement
   *  are scoped to this specific ProductVariation. Used by eBay
   *  variation-listings + Shopify variant inventory items. */
  variationId?: string | null
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
  if (!input.sku?.trim() && !input.productId) {
    throw new Error('recordChannelStockEvent: sku or productId required')
  }
  if (input.channelReportedQty < 0) {
    throw new Error('recordChannelStockEvent: channelReportedQty cannot be negative')
  }

  // Idempotency check first — saves us a round-trip to resolve the
  // product on a retry.
  const existing = await prisma.channelStockEvent.findUnique({
    where: {
      channel_channelEventId: workspaceKey({
        channel: input.channel,
        channelEventId: input.channelEventId,
      }),
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

  // Resolve productId either from explicit input or by SKU lookup.
  // Webhook callers (Shopify inventory_item_id → ChannelListing →
  // productId) pass productId directly; manual / CSV ingest paths
  // pass SKU and let us look it up.
  let product: { id: string; sku: string } | null = null
  if (input.productId) {
    product = await prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true, sku: true },
    })
  } else if (input.sku?.trim()) {
    const own = await productByOwnSku(prisma, { channel: input.channel, channelConnectionId: input.channelConnectionId, sku: input.sku })
    if (own && own.ambiguous === true) {
      logger.warn('channel-stock-event: the reported SKU names more than one product — recorded unmatched', { channel: input.channel, sku: input.sku.trim(), productIds: own.productIds, reason: own.sentence })
    } else if (own && own.ambiguous === false) {
      product = await prisma.product.findUnique({ where: { id: own.productId }, select: { id: true, sku: true } })
    } else {
      product = await prisma.product.findFirst({
        where: { sku: input.sku.trim() },
        select: { id: true, sku: true },
      })
    }
  }
  // Materialise the SKU we'll persist on the row. Prefer the
  // resolved product's sku (canonical); fall back to caller-supplied
  // sku for unmatched events so the operator can still debug.
  const sku = product?.sku ?? input.sku?.trim() ?? ''
  if (!sku) {
    throw new Error('recordChannelStockEvent: could not resolve sku from input')
  }

  // Compute local stock at observation time. Sum across StockLevel
  // when the event isn't pinned to a specific location/variant,
  // otherwise scope the read.
  let localQty = 0
  const locationId = await observedLocationId(input)
  // Shared stock — a product that sells from another business's pool: the channel shows the pool's
  // number, so that is what it is compared with, and a channel's number is never written into this
  // business's own ledger (the lender counts its own stock).
  const productLedger = product ? (await loadSyncLedgers(prisma, [product.id])).get(product.id) : undefined
  const pooled = productLedger?.source.kind === 'pool'
  if (product && pooled) {
    localQty = productLedger!.quantity
  } else if (product) {
    const where: Prisma.StockLevelWhereInput = {
      productId: product.id,
      // variationId === null sums master-stock; pinning to a specific
      // variation IS valid (eBay variation listings, Shopify variant
      // inventory items). When omitted entirely, sum across all
      // variants for the product (master + every variation).
      ...(input.variationId !== undefined ? { variationId: input.variationId } : {}),
      ...(locationId ? { locationId } : {}),
    }
    const agg = await prisma.stockLevel.aggregate({
      where,
      _sum: { quantity: true },
    })
    localQty = agg._sum.quantity ?? 0
  }

  const drift = input.channelReportedQty - localQty
  const threshold = autoApplyThreshold(input.channel)
  let initialStatus: 'PENDING' | 'AUTO_APPLIED' | 'REVIEW_NEEDED' | 'APPLIED' | 'IGNORED'
  if (drift === 0) {
    initialStatus = 'APPLIED' // no-op observation, audit only
  } else if (await isFbaObservation(input.channel, locationId)) {
    // 08 S2b (lead decision 2026-10-01) — Amazon's FBA number is Amazon's: nothing in Nexus can apply it, so it is
    // kept on record and settled at once rather than left waiting for a review nobody can act on.
    initialStatus = 'IGNORED'
  } else if (Math.abs(drift) <= threshold && !pooled && !(await channelEventLocationRefusal(locationId, input.channel))) {
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
        variationId: input.variationId ?? null,
        sku,
        locationId,
        channelReportedQty: input.channelReportedQty,
        localQtyAtObservation: localQty,
        drift,
        status: initialStatus,
        rawPayload: input.rawPayload as Prisma.InputJsonValue,
        ...(initialStatus === 'IGNORED' ? { resolution: FBA_IGNORED_REASON, resolvedAt: new Date(), resolvedByUserId: 'auto' } : {}),
      },
    })

    // For AUTO_APPLIED + drift !== 0 we fire the movement immediately.
    // APPLIED with drift=0 is an audit-only row — no movement.
    if (initialStatus === 'AUTO_APPLIED' && product) {
      const mv = await applyStockMovement({
        productId: product.id,
        variationId: input.variationId ?? undefined,
        locationId: locationId ?? undefined,
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
  if (event.drift !== 0 && (await loadSyncLedgers(prisma, [event.productId])).get(event.productId)?.source.kind === 'pool') {
    throw new Error('This product sells from shared stock owned by another business profile. Count it there; a channel number cannot change it from here.')
  }

  // 08 S2 (F7) — never the FBA mirror; a Shopify location only from Shopify's own events.
  if (event.drift !== 0) {
    const refusal = await channelEventLocationRefusal(event.locationId, event.channel)
    if (refusal) throw refusal
  }

  // No-drift events are weirdly possible (operator clicks Apply on
  // an audit-only row) — skip the movement and just stamp.
  let movementId: string | null = null
  if (event.drift !== 0) {
    const mv = await applyStockMovement({
      productId: event.productId,
      variationId: event.variationId ?? undefined,
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
