import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * G.1 — Always-on repricer scheduler.
 *
 * Bridges the engine's continuously-recomputed PricingSnapshot output to
 * the channel-push pipeline. The engine + nightly snapshot cron already
 * keep PricingSnapshot fresh against FX moves, competitor pulls, rule
 * evaluations, and master-price cascades. This scheduler closes the loop:
 * when snapshot.computedPrice diverges from the listing's last-pushed
 * price beyond a configurable threshold, enqueue an OutboundSyncQueue
 * PRICE_UPDATE row so the existing bullmq-sync.worker dispatches it.
 *
 * Safety model (audit's "highest-blast-radius" warning):
 *
 *   1. Default OFF.   `NEXUS_REPRICER_LIVE !== '1'` → dry-run mode.
 *      Logs every decision; writes nothing to ChannelListing /
 *      OutboundSyncQueue. The G.2 AuditLog row records the dry-run
 *      with the same shape as a live run, so the operator can review
 *      "what would have happened" before flipping the flag.
 *
 *   2. Threshold gate. NEXUS_REPRICER_THRESHOLD_PCT (default 1.0%):
 *      we don't enqueue for tiny deltas. Keeps update volume sane
 *      and avoids thrashing the channel API on FX micro-noise.
 *
 *   3. Engine inherits the floor. We don't recompute prices here —
 *      we trust whatever snapshot.computedPrice the engine produced.
 *      Engine already enforces MIN/MAX/MAP/margin floor + VAT clamping
 *      (pricing-engine.service.ts:209-228, 425-442). If a snapshot
 *      shows source=FALLBACK or isClamped=true with bad inputs,
 *      that's already on /pricing/alerts; the repricer skips
 *      FALLBACK source rows defensively so we never push a 0.
 *
 *   4. followMasterPrice respect (2026-10-01). The engine now gives a listing the price Nexus's own rules give it
 *      (`@nexus/shared/listing-price`): a pinned listing its own price, a following one its rule's price from the
 *      master, Match Amazon and a market in another currency the price they hold. So a delta can only be a FOLLOWING
 *      listing that is not at its rule's price (CHANNEL_RULE / MASTER_INHERIT snapshots) — and that is written through
 *      the ONE channel price door's follower mode, which recomputes, stores and queues it with every rule the cascade
 *      applies (currency, floor/ceiling, paused/draft hold, 30 s hold). A FOLLOWING Match Amazon listing is set to the
 *      engine's Match Amazon suggestion (the lowest competitor − 0.01, within the engine's floor/ceiling) through the
 *      door's MACHINE mode — the designed Match Amazon flow, now with the door's gates. It used to write `price` itself with its own
 *      queue row: a pinned listing without a priceOverride was overwritten by the channel rule's price, and a sale
 *      snapshot's price was written as the listing's regular price. Any other source is skipped.
 *
 *   5. Per-run audit. G.2 — every tick writes one AuditLog row with
 *      entityType='RepricerRun', metrics in `after` payload. The
 *      audit viewer filtered by that entityType is the operator's
 *      "what did the repricer do today" log.
 *
 * Cadence: every 30 min via repricer.job.ts. Cheap when no snapshots
 * have changed: starts with a single timestamp filter on PricingSnapshot
 * (indexed). Scales with delta volume, not catalog size.
 */

import { writeChannelPrices } from './pim/channel-price-write.service.js'
import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'

interface RepricerTickResult {
  runId: string
  liveMode: boolean
  thresholdPct: number
  snapshotsScanned: number
  enqueued: number
  dryRunWouldEnqueue: number
  skippedNoListing: number
  skippedZeroPrice: number
  skippedSubThreshold: number
  skippedFallback: number
  /** A delta that is not a following listing's rule price (a pinned listing, a sale, an offer): never written. */
  skippedNotFollower: number
  durationMs: number
}

const DEFAULT_THRESHOLD_PCT = 1.0
/** The snapshot sources that ARE a following listing's rule price — the only ones the repricer brings a listing to. */
const FOLLOWER_SOURCES = new Set(['CHANNEL_RULE', 'MASTER_INHERIT'])
const SCAN_WINDOW_HOURS = 24
const MAX_ROWS_PER_TICK = 5000

export async function runRepricerTick(
  prisma: PrismaClient,
  // R16 — a business switched to OBSERVE runs dry even where the env is live; it never makes a dry env live.
  opts: { dryRun?: boolean } = {},
): Promise<RepricerTickResult> {
  const startedAt = Date.now()
  const liveMode = process.env.NEXUS_REPRICER_LIVE === '1' && !opts.dryRun
  const thresholdPct = Math.max(
    0,
    Number(process.env.NEXUS_REPRICER_THRESHOLD_PCT ?? DEFAULT_THRESHOLD_PCT),
  )
  const since = new Date(Date.now() - SCAN_WINDOW_HOURS * 60 * 60 * 1000)
  const runId = `repricer-${Date.now()}`

  logger.info('G.1 repricer tick start', {
    runId,
    liveMode,
    thresholdPct,
    scanWindowHours: SCAN_WINDOW_HOURS,
  })

  // Scan recently-recomputed snapshots. Indexed on computedAt so the
  // filter is sub-50ms even at 32K rows.
  const snapshots = await prisma.pricingSnapshot.findMany({
    where: { computedAt: { gte: since } },
    orderBy: { computedAt: 'desc' },
    take: MAX_ROWS_PER_TICK,
  })

  let enqueued = 0
  let dryRunWouldEnqueue = 0
  let skippedNoListing = 0
  let skippedZeroPrice = 0
  let skippedSubThreshold = 0
  let skippedFallback = 0
  let skippedNotFollower = 0

  for (const snap of snapshots) {
    // Match Amazon: the engine's undercut of the lowest competitor (`breakdown.suggestion`) is the price a machine sets
    // on a FOLLOWING Match Amazon listing — the designed flow, through the door's machine mode (2026-10-01).
    const matchAmazon = matchAmazonSuggestion(snap.breakdown)
    // Defensive: never push from a fallback resolution. The engine
    // emitted 0 because it had no master / variant / rule.
    if (snap.source === 'FALLBACK' && matchAmazon == null) {
      skippedFallback++
      continue
    }
    const snapshotPrice = Number(snap.computedPrice)
    if (matchAmazon == null && (!Number.isFinite(snapshotPrice) || snapshotPrice <= 0)) {
      skippedZeroPrice++
      continue
    }

    // Find the ChannelListing this snapshot maps to. SKU + channel +
    // marketplace is the natural key.
    const variant = await prisma.productVariation.findUnique({
      where: { workspace_sku: workspaceKey({ sku: snap.sku }) },
      select: { productId: true },
    })
    const standalone = variant
      ? null
      : await prisma.product.findFirst({
          where: { sku: snap.sku },
          select: { id: true },
        })
    const productId = variant?.productId ?? standalone?.id
    if (!productId) {
      skippedNoListing++
      continue
    }
    const listing = await prisma.channelListing.findFirst({
      where: {
        productId,
        channel: snap.channel,
        marketplace: snap.marketplace,
        // The engine prices the PRIMARY listing (aliasKey ''), so the comparison is with the same row.
        aliasKey: '',
      },
      select: {
        id: true,
        price: true,
        externalListingId: true,
        region: true,
        followMasterPrice: true,
        pricingRule: true,
      },
    })
    if (!listing) {
      skippedNoListing++
      continue
    }

    const machine = matchAmazon != null && listing.followMasterPrice !== false && listing.pricingRule === 'MATCH_AMAZON'
    const newPrice = machine ? matchAmazon! : snapshotPrice
    const currentPrice = listing.price != null ? Number(listing.price) : 0
    if (currentPrice <= 0) {
      // Listing never priced; engine will treat as new push when
      // its first OutboundSyncQueue row drains. Skip here so we
      // don't double-enqueue.
      skippedZeroPrice++
      continue
    }

    const deltaPct = Math.abs((newPrice - currentPrice) / currentPrice) * 100
    if (deltaPct < thresholdPct) {
      skippedSubThreshold++
      continue
    }
    // Only a FOLLOWING listing's rule price, or a following Match Amazon listing's machine price, is the repricer's.
    if (!machine && (!FOLLOWER_SOURCES.has(snap.source) || listing.followMasterPrice === false)) {
      skippedNotFollower++
      continue
    }

    if (!liveMode) {
      logger.info('G.1 repricer dry-run: would enqueue', {
        runId,
        sku: snap.sku,
        channel: snap.channel,
        marketplace: snap.marketplace,
        currentPrice,
        newPrice,
        deltaPct: Math.round(deltaPct * 100) / 100,
        source: snap.source,
      })
      dryRunWouldEnqueue++
      continue
    }

    // Live: the ONE channel price door's follower mode recomputes the listing's rule price from the master, stores it
    // and queues it (or refuses by name: another currency, outside the floor/ceiling, paused or a draft held).
    try {
      // Match Amazon: the door's MACHINE mode (stays following; above 0, the floor/ceiling in the master currency, a
      // paused listing or a draft kept in Nexus). Any other follower: its rule price, recomputed by the follower mode.
      const written = await writeChannelPrices({
        targets: [machine ? { listingId: listing.id, machinePrice: newPrice, unguardedReason: 'repricer' } : { listingId: listing.id, follow: true, unguardedReason: 'repricer' }],
        actor: `repricer:${runId}`, source: 'REPRICER', reason: `Repricer run ${runId}: the listing is not at its rule's price (${currentPrice.toFixed(2)} → ${newPrice.toFixed(2)})`,
      })
      const outcome = written.results[0]
      if (outcome?.queueId) enqueued++
      else logger.info('G.1 repricer: nothing sent', { runId, sku: snap.sku, outcome: outcome?.outcome, reason: outcome?.reason ?? outcome?.notSent })
    } catch (err) {
      logger.warn('G.1 repricer enqueue failed', {
        runId,
        sku: snap.sku,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const durationMs = Date.now() - startedAt

  // G.2 — Audit row. Same AuditLog table the rest of the surface uses.
  // entityType='RepricerRun' makes filtering cheap; entityId is the
  // tick's run ID so each row stands alone.
  try {
    await prisma.auditLog.create({
      data: {
        entityType: 'RepricerRun',
        entityId: runId,
        action: liveMode ? 'execute' : 'dry-run',
        before: null,
        after: {
          liveMode,
          thresholdPct,
          snapshotsScanned: snapshots.length,
          enqueued,
          dryRunWouldEnqueue,
          skippedNoListing,
          skippedZeroPrice,
          skippedSubThreshold,
          skippedFallback,
          skippedNotFollower,
          durationMs,
        },
        metadata: {
          scanWindowHours: SCAN_WINDOW_HOURS,
          maxRowsPerTick: MAX_ROWS_PER_TICK,
        },
      },
    })
  } catch (err) {
    logger.warn('G.2 audit log write failed (non-fatal)', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const result: RepricerTickResult = {
    runId,
    liveMode,
    thresholdPct,
    snapshotsScanned: snapshots.length,
    enqueued,
    dryRunWouldEnqueue,
    skippedNoListing,
    skippedZeroPrice,
    skippedSubThreshold,
    skippedFallback,
    skippedNotFollower,
    durationMs,
  }
  logger.info('G.1 repricer tick complete', result)
  return result
}

/** The engine's Match Amazon suggestion in a snapshot's breakdown (`pricing-engine.service.ts`), or null. */
function matchAmazonSuggestion(breakdown: unknown): number | null {
  const suggestion = (breakdown as { suggestion?: { kind?: string; price?: unknown } } | null)?.suggestion
  if (suggestion?.kind !== 'MATCH_AMAZON') return null
  const price = Number(suggestion.price)
  return Number.isFinite(price) && price > 0 ? price : null
}
