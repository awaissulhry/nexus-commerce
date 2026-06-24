/**
 * FBA-flip guard cron.
 *
 * Standing detector for the FBA→FBM "Quantity bug": alerts if a merchant
 * QUANTITY_UPDATE to Amazon ever SUCCEEDS for an FBA SKU — which flips the
 * offer to FBM ("Venduto e spedito da …"). The 2026-06 incident ran ~2 days
 * before it was noticed; this catches a recurrence within one cron tick.
 *
 * Detection-only — it never touches publishing. On a trip it logs a CRITICAL
 * line (surfaces in the sync-logs/error hub) telling the operator to gate
 * NEXUS_ENABLE_AMAZON_PUBLISH off and investigate.
 *
 * Schedule: every 10 min (20-min lookback overlaps ticks so nothing slips).
 * Opt out: NEXUS_ENABLE_FBA_FLIP_GUARD=0.
 */
import cron from 'node-cron'
import { prisma } from '@nexus/database'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { restoreFbaListings } from '../services/fba-restore.service.js'

const JOB = 'fba-flip-guard'
const SCHEDULE = '*/10 * * * *'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

type FlipRow = { sku: string | null }

export async function runFbaFlipGuardCron(): Promise<void> {
  try {
    await recordCronRun(JOB, async () => {
      // A merchant QUANTITY_UPDATE that SUCCEEDED for a SKU with any FBA signal
      // (listing/product method FBA, FBA stock on hand, or an active FBA offer)
      // means we pushed fulfillment_availability:DEFAULT+qty and flipped the offer.
      const rows = await prisma.$queryRaw<FlipRow[]>`
        SELECT p.sku AS sku
        FROM "OutboundSyncQueue" q
        JOIN "ChannelListing" cl ON cl.id = q."channelListingId"
        JOIN "Product" p ON p.id = cl."productId"
        WHERE q."targetChannel" = 'AMAZON'
          AND q."syncType" = 'QUANTITY_UPDATE'
          AND q."syncStatus" = 'SUCCESS'
          AND q."createdAt" > now() - interval '20 minutes'
          AND (
            cl."fulfillmentMethod"::text = 'FBA'
            OR p."fulfillmentMethod"::text = 'FBA'
            OR EXISTS (SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id = sl."locationId"
                       WHERE sl."productId" = cl."productId" AND loc.code = 'AMAZON-EU-FBA' AND sl.quantity > 0)
            OR EXISTS (SELECT 1 FROM "Offer" o WHERE o."channelListingId" = cl.id
                       AND o."fulfillmentMethod"::text = 'FBA' AND o."isActive")
          )`

      if (rows.length > 0) {
        const skus = [...new Set(rows.map((r) => r.sku).filter(Boolean))] as string[]
        logger.error(
          '🔴 FBA-FLIP GUARD TRIPPED — a merchant QUANTITY_UPDATE succeeded for FBA SKU(s); the Amazon offer was likely flipped to FBM',
          {
            critical: true,
            count: rows.length,
            skus: skus.slice(0, 25),
            action: 'Check the fail-closed guard + that the fixed build is live (/api/health). Auto-restore is firing now.',
          },
        )

        if (process.env.NEXUS_FBA_AUTO_RESTORE !== '0') {
          try {
            const summary = await restoreFbaListings({ skus, dryRun: false })
            logger.error('🟡 FBA auto-restore fired by flip-guard', {
              restored: summary.sent,
              processed: summary.processed,
              skippedNoFba: summary.skippedNoFba,
              errors: summary.results.filter((r) => !r.ok && !r.dryRun).length,
              sample: summary.results.slice(0, 10),
            })
          } catch (restoreErr) {
            logger.error('fba-flip-guard: auto-restore failed', {
              error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
            })
          }
        } else {
          logger.error('fba-flip-guard: auto-restore disabled (NEXUS_FBA_AUTO_RESTORE=0) — run POST /admin/amazon/restore-fba {"dryRun":false} manually')
        }

        return `ALERT: ${rows.length} FBA quantity push(es) across ${skus.length} sku(s)`
      }
      return 'ok — no FBA quantity pushes in window'
    })
  } catch (err) {
    logger.error('fba-flip-guard cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startFbaFlipGuardCron(): void {
  if (process.env.NEXUS_ENABLE_FBA_FLIP_GUARD === '0') {
    logger.info('fba-flip-guard cron: disabled via env')
    return
  }
  if (scheduledTask) return
  scheduledTask = cron.schedule(SCHEDULE, () => {
    void runFbaFlipGuardCron()
  })
  logger.info(`fba-flip-guard cron: scheduled (${SCHEDULE})`)
}
