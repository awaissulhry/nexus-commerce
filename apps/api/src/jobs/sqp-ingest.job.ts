/**
 * Apex E.1 — SQP ingest cron.
 *
 * Pulls Brand Analytics Search Query Performance (latest WEEK) for each active
 * Amazon marketplace into SearchQueryPerformance, so the competitive-share view
 * stays current. Idempotent upsert (re-fetching the same week is safe).
 *
 * Default OFF (NEXUS_ENABLE_SQP_INGEST_CRON) until Brand Analytics access is
 * confirmed via probeSqpAccess — calling the report without the role just
 * errors. Registered in CRON_REGISTRY for manual triggering regardless.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { envEnabled } from '../utils/env-flag.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runSqpIngestCron(): Promise<void> {
  try {
    await recordCronRun('sqp-ingest', async () => {
      const { ingestSqp } = await import('../services/advertising/sqp.service.js')
      const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true } })
      const markets = [...new Set(conns.map((c) => c.marketplace))]
      let totalRows = 0
      let ok = 0
      let failed = 0
      for (const mkt of markets) {
        try {
          const r = await ingestSqp({ marketplaceCode: mkt, period: 'WEEK' })
          totalRows += r.upserted
          ok += 1
        } catch (err) {
          failed += 1
          logger.warn('[sqp-ingest] marketplace failed', { marketplace: mkt, error: err instanceof Error ? err.message : String(err) })
        }
      }
      return `markets=${markets.length} ok=${ok} failed=${failed} rows=${totalRows}`
    })
  } catch (err) {
    logger.error('sqp-ingest cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startSqpIngestCron(): void {
  if (scheduledTask) {
    logger.warn('sqp-ingest cron already started')
    return
  }
  if (!envEnabled('NEXUS_ENABLE_SQP_INGEST_CRON')) {
    logger.info('sqp-ingest cron NOT scheduled (NEXUS_ENABLE_SQP_INGEST_CRON off) — manual trigger available once Brand Analytics access is confirmed')
    return
  }
  // Daily 03:45 UTC (after sales-report at 02:00); fetches the current WEEK each
  // run — idempotent upsert keeps it fresh as Amazon finalises the week.
  scheduledTask = cron.schedule('45 3 * * *', () => void runSqpIngestCron())
  logger.info('sqp-ingest cron scheduled (45 3 * * *)')
}
