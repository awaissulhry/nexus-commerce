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
 *   4. followMasterPrice respect. ChannelListing rows where the
 *      seller has explicitly opted out of master cascade (set their
 *      own per-marketplace override) are still served by the engine
 *      via CHANNEL_OVERRIDE source — so snapshot.computedPrice
 *      reflects the override and the threshold check naturally yields
 *      zero delta. No extra guard needed.
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
  durationMs: number
}

const DEFAULT_THRESHOLD_PCT = 1.0
const SCAN_WINDOW_HOURS = 24
const MAX_ROWS_PER_TICK = 5000

export async function runRepricerTick(
  prisma: PrismaClient,
): Promise<RepricerTickResult> {
  const startedAt = Date.now()
  const liveMode = process.env.NEXUS_REPRICER_LIVE === '1'
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

  for (const snap of snapshots) {
    // Defensive: never push from a fallback resolution. The engine
    // emitted 0 because it had no master / variant / rule.
    if (snap.source === 'FALLBACK') {
      skippedFallback++
      continue
    }
    const newPrice = Number(snap.computedPrice)
    if (!Number.isFinite(newPrice) || newPrice <= 0) {
      skippedZeroPrice++
      continue
    }

    // Find the ChannelListing this snapshot maps to. SKU + channel +
    // marketplace is the natural key.
    const variant = await prisma.productVariation.findUnique({
      where: { sku: snap.sku },
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
      },
      select: {
        id: true,
        price: true,
        externalListingId: true,
        region: true,
      },
    })
    if (!listing) {
      skippedNoListing++
      continue
    }

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

    // Live: write the new price to ChannelListing + enqueue PRICE_UPDATE.
    // Mirrors MasterPriceService.update's enqueue payload shape so the
    // bullmq-sync.worker handles it identically to a master-cascade push.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.channelListing.update({
          where: { id: listing.id },
          data: {
            price: newPrice.toFixed(2),
            lastSyncStatus: 'PENDING',
            lastSyncedAt: null,
          },
        })
        await tx.outboundSyncQueue.create({
          data: {
            productId,
            channelListingId: listing.id,
            targetChannel: snap.channel as any,
            targetRegion: listing.region,
            syncStatus: 'PENDING' as any,
            syncType: 'PRICE_UPDATE',
            holdUntil: null, // skip 5-min grace; repricer is non-interactive
            externalListingId: listing.externalListingId,
            payload: {
              source: 'REPRICER',
              runId,
              sku: snap.sku,
              channel: snap.channel,
              marketplace: snap.marketplace,
              price: newPrice,
              oldPrice: currentPrice,
              snapshotSource: snap.source,
              deltaPct: Math.round(deltaPct * 100) / 100,
            },
          },
        })
      })
      enqueued++
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
    durationMs,
  }
  logger.info('G.1 repricer tick complete', result)
  return result
}
