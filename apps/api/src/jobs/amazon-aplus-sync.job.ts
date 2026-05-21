/**
 * Daily Amazon A+ Content metadata sync cron.
 *
 * Schedule: 04:00 UTC daily. A+ Content changes infrequently (operators
 * publish via Brand Registry on their own cadence), so daily catch-up
 * is more than enough. Pulls metadata (name, status, marketplace,
 * updateTime) for all docs and upserts; full body extraction stays
 * out-of-band.
 *
 * Idempotent — `pullAPlusContentMetadata` upserts by amazonDocumentId.
 *
 * Gated behind NEXUS_ENABLE_AMAZON_APLUS_CRON=1.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { pullAPlusContentMetadata } from '../services/aplus-amazon-pull.service.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

async function runAplusSync(): Promise<void> {
  const startedAt = Date.now()
  await recordCronRun('amazon-aplus-sync', async () => {
    const summary = await pullAPlusContentMetadata({})
    logger.info('amazon-aplus cron: tick complete', {
      durationMs: Date.now() - startedAt,
      documentsListed: summary.documentsListed,
      documentsUpserted: summary.documentsUpserted,
      errors: summary.errors.length,
    })
    return `listed=${summary.documentsListed} upserted=${summary.documentsUpserted} errors=${summary.errors.length}`
  }).catch((err) => {
    logger.error('amazon-aplus cron: failure', {
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

export function startAmazonAplusCron(): void {
  if (scheduledTask) {
    logger.warn('amazon-aplus cron already started — skipping')
    return
  }
  if (process.env.NEXUS_ENABLE_AMAZON_APLUS_CRON !== '1') {
    logger.info('amazon-aplus cron: disabled (set NEXUS_ENABLE_AMAZON_APLUS_CRON=1 to enable)')
    return
  }
  // Daily at 04:00 UTC — 30 min after settlement, spreads API load.
  const schedule = process.env.NEXUS_AMAZON_APLUS_CRON_SCHEDULE ?? '0 4 * * *'
  if (!cron.validate(schedule)) {
    logger.error('amazon-aplus cron: invalid schedule expression', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runAplusSync()
  })
  logger.info('amazon-aplus cron: scheduled', { schedule })
}

export function stopAmazonAplusCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export { runAplusSync }
