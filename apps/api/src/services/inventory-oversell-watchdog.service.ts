// EV.2 — the oversell watchdog.
//
// The first real consumer of the event bus, and the proof of what the bus buys:
// it needs NO wiring inside cascadeQuantityToListings. It subscribes to
// inventory.stock_changed and derives a new fact.
//
// What it answers: "is any single channel publishing more units than the
// merchant pool can cover?" Today the only oversell signal is
// `sync.oversell.clamped`, raised at PUSH time, for one channel, after a push
// already noticed. This sees every channel at once, the moment stock moves —
// during the window between stock dropping and the pushes landing.
//
// ── Why the largest commitment, not the sum ─────────────────────────────────
// Listing ONE pool on several channels is the intended operating model: nine
// units in the warehouse are advertised as nine on Amazon AND nine on eBay,
// and cascadeQuantityToListings actively maintains exactly that. So the sum of
// commitments EXCEEDS the pool for every healthy multi-channel product, and a
// sum-based rule would fire constantly and mean nothing.
//
// The real defect is one listing promising more than exists — a channel still
// showing 9 after the pool fell to 2 can sell 9. That is what this reports.
//
// DETECTION ONLY. It writes no quantity, proposes no write, and touches no
// channel. Given the FBA→FBM flip history, a watchdog that could act would be
// a much bigger decision than a watchdog that reports.
//
// ── The two ways this would cry wolf ────────────────────────────────────────
//
// 1. COUNTING FBA LISTINGS. Product.totalStock sums WAREHOUSE locations only —
//    the merchant pool. FBA stock is Amazon-managed and is NOT in it, so an FBA
//    listing's quantity is not a claim against that pool. Counting it invents
//    an overcommitment that does not exist.
//
// 2. SUMMING AMAZON EU. Amazon holds merchant quantity at (sellerId, SKU) for
//    the EU region — ONE number seen through several marketplaces. Summing the
//    IT + DE + FR rows multiplies a single real commitment by three. They
//    collapse to one.
//
// Both produce FALSE POSITIVES, and a false positive here is worse than a miss:
// it makes an operator "correct" stock that was already right.

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { resolveCascadePushMethod } from './stock-movement.service.js'
import { publishEvent } from '../lib/events/publish.js'
import { subscribeEvents } from '../lib/events/subscribe.js'
import type { EventBroker } from '../lib/events/broker.js'
import type { EventEnvelope } from '@nexus/events'

/** Channels whose quantity is held per-listing rather than pooled per SKU. */
const PER_LISTING_QUANTITY_CHANNELS = new Set(['EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'])

/**
 * Channels that hold ONE merchant quantity per SKU across all their
 * marketplaces. Amazon is the proven case (EU); the collapse is deliberately
 * applied to ALL Amazon marketplaces rather than an EU allow-list, because
 * that direction UNDER-counts. Under-counting risks a missed alarm; a
 * region-aware split risks a false one, and this is not a place to prefer
 * sensitivity over precision.
 *
 * If a genuinely separate Amazon account (a non-EU region with its own pool)
 * is ever added, this becomes region-aware — and the test below is where that
 * decision should be re-stated.
 */
const POOLED_QUANTITY_CHANNELS = new Set(['AMAZON'])

export interface ListingRow {
  listingId: string
  channel: string
  marketplace: string | null
  quantity: number | null
  listingStatus: string
  fulfillment: 'FBA' | 'FBM'
}

export interface ChannelCommitment {
  listingId: string
  channel: string
  marketplace: string | null
  quantity: number
  sharedWith?: string[]
}

/**
 * Collapse listings into real commitments against the merchant pool.
 * Pure — this is where both false-positive traps live, so it is testable
 * without a database.
 */
export function computeCommitments(listings: ListingRow[]): ChannelCommitment[] {
  const live = listings.filter(
    (l) =>
      // Only an ACTIVE listing is promising anything to a buyer. DRAFT /
      // INACTIVE / ENDED / ERROR hold no commitment.
      l.listingStatus === 'ACTIVE' &&
      // TRAP 1 — FBA quantity is Amazon-managed and is not backed by the
      // merchant pool this is measured against.
      l.fulfillment !== 'FBA' &&
      l.quantity != null &&
      l.quantity > 0,
  )

  const commitments: ChannelCommitment[] = []
  const pooled = new Map<string, ListingRow[]>()

  for (const listing of live) {
    if (POOLED_QUANTITY_CHANNELS.has(listing.channel)) {
      const group = pooled.get(listing.channel) ?? []
      group.push(listing)
      pooled.set(listing.channel, group)
    } else {
      commitments.push({
        listingId: listing.listingId,
        channel: listing.channel,
        marketplace: listing.marketplace,
        quantity: listing.quantity as number,
      })
    }
  }

  // TRAP 2 — one commitment per pooled channel.
  for (const [channel, group] of pooled) {
    // MAX, not sum and not first: the rows should all carry the same number,
    // and where they disagree it is a stale read of one shared value, not
    // independent quantities. Taking the largest is the honest reading of
    // "what might currently be live".
    const winner = group.reduce((a, b) => ((b.quantity ?? 0) > (a.quantity ?? 0) ? b : a))
    commitments.push({
      listingId: winner.listingId,
      channel,
      // Null: this commitment belongs to no single marketplace.
      marketplace: null,
      quantity: winner.quantity as number,
      sharedWith: group
        .map((l) => l.marketplace)
        .filter((m): m is string => Boolean(m))
        .sort(),
    })
  }

  return commitments
}

export interface OversellAssessment {
  productId: string
  sku: string
  poolAvailable: number
  /** The largest single-channel promise. */
  maxChannelCommitment: number
  excessUnits: number
  /** Only the listings that individually exceed the pool. */
  commitments: ChannelCommitment[]
}

/**
 * Assess one product. Returns null when there is no risk — the common case,
 * and the caller publishes nothing for it.
 */
export async function evaluateOversellRisk(
  productId: string,
  poolAvailable: number,
): Promise<OversellAssessment | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { sku: true, fulfillmentMethod: true },
  })
  if (!product) return null

  // Same fbaBucket definition the cascade uses, so the watchdog and the push
  // path cannot disagree about which listings are FBA.
  const stockRows = await prisma.stockLevel.findMany({
    where: { productId },
    select: { quantity: true, location: { select: { type: true } } },
  })
  const fbaBucket = stockRows
    .filter((s) => s.location?.type === 'AMAZON_FBA')
    .reduce((sum, s) => sum + s.quantity, 0)

  const rows = await prisma.channelListing.findMany({
    where: { productId },
    select: {
      id: true,
      channel: true,
      marketplace: true,
      quantity: true,
      listingStatus: true,
      fulfillmentMethod: true,
    },
  })

  const listings: ListingRow[] = rows.map((r) => ({
    listingId: r.id,
    channel: r.channel,
    marketplace: r.marketplace,
    quantity: r.quantity,
    listingStatus: r.listingStatus,
    // resolveCascadePushMethod, not the plain resolver: it is the one the
    // cascade writes against, fail-closed on any FBA signal.
    fulfillment: resolveCascadePushMethod({
      listingFulfillmentMethod: r.fulfillmentMethod,
      channel: r.channel,
      fbaBucket,
      productFulfillmentMethod: product.fulfillmentMethod,
    }),
  }))

  const commitments = computeCommitments(listings)
  // Per-channel, not summed — see the header. A product on three channels
  // showing the whole pool on each is healthy, not an oversell.
  const overcommitted = commitments.filter((c) => c.quantity > poolAvailable)
  if (overcommitted.length === 0) return null

  const maxChannelCommitment = Math.max(...overcommitted.map((c) => c.quantity))
  return {
    productId,
    sku: product.sku,
    poolAvailable,
    maxChannelCommitment,
    excessUnits: maxChannelCommitment - poolAvailable,
    commitments: overcommitted,
  }
}

/**
 * Already reported for this exact cause?
 *
 * Delivery is at-least-once, so this handler WILL occasionally run twice on
 * one stock change. Deduping on the causing event's id makes the consumer
 * idempotent using data the outbox already stores — no new table, and exact
 * rather than a time-window guess.
 */
async function alreadyReported(causationId: string): Promise<boolean> {
  const existing = await prisma.eventOutbox.findFirst({
    where: { type: 'inventory.oversell_risk_detected', causationId },
    select: { id: true },
  })
  return existing !== null
}

export async function handleStockChanged(envelope: EventEnvelope): Promise<void> {
  const payload = envelope.payload as { productId: string; poolTotal: number; change: number }

  // Risk can only be CREATED by the pool shrinking. A receive or a positive
  // correction cannot newly overcommit, so skipping them halves the work on
  // bulk imports without missing a transition.
  if (payload.change >= 0) return

  const assessment = await evaluateOversellRisk(payload.productId, payload.poolTotal)
  if (!assessment) return
  if (await alreadyReported(envelope.id)) return

  // Durable: an oversell is a fact worth keeping, not a refresh hint. The
  // subscriber helper runs this inside the incoming event's correlation, so
  // causationId links it back to the stock change that caused it.
  await publishEvent(prisma, 'inventory.oversell_risk_detected', assessment, {
    accountId: envelope.accountId,
  })

  logger.warn('oversell watchdog: a channel is publishing more than the pool holds', {
    productId: assessment.productId,
    sku: assessment.sku,
    poolAvailable: assessment.poolAvailable,
    maxChannelCommitment: assessment.maxChannelCommitment,
    excessUnits: assessment.excessUnits,
    channels: assessment.commitments.map((c) => c.channel),
  })
}

export async function startOversellWatchdog(broker: EventBroker): Promise<() => Promise<void>> {
  return subscribeEvents(broker, {
    // A durable consumer group: this work must actually happen, so it must
    // survive a restart and be redelivered if a handler dies. Not broadcast —
    // one replica doing it is correct, and every replica doing it is waste.
    group: 'inventory-oversell-watchdog',
    types: ['inventory.stock_changed'],
    handler: handleStockChanged,
    onError: (error, envelope) => {
      logger.error('oversell watchdog: handler failed, event will be redelivered', {
        eventId: envelope.id,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
