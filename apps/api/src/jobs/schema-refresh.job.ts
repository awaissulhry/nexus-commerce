/**
 * ALA Phase 5 — nightly Amazon schema refresh cron.
 *
 * Phase 0a found 94% of cached Product Type Definition schemas were past their
 * 24h TTL (some 50+ days stale) because Nexus only refreshes a schema lazily when
 * an operator opens that product type. A type nobody re-opens serves weeks-old
 * field/enum/required rules. This cron proactively re-fetches every cached
 * (productType, marketplace) schema, which runs the existing diff + deprecation
 * detection (FIELD_ADDED/REMOVED/TYPE_CHANGED/REQUIRED_CHANGED + FIELD_DEPRECATED/
 * ENUM_DEPRECATED) so SchemaChange stays current and operators get warned before
 * Amazon retires a field/enum they use.
 *
 * Pattern mirrors catalog-refresh.job.ts (node-cron + recordCronRun).
 * Gated behind NEXUS_ENABLE_SCHEMA_REFRESH_CRON=1. Default schedule: 04:00 UTC
 * daily (after catalog-refresh at 03:00) so they share the SP-API throttle budget.
 * Sequential with a small inter-call delay — the Product Type Definitions API is
 * rate-limited and a stale schema is not urgent.
 */

import nodeCron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import { CategorySchemaService } from '../services/categories/schema-sync.service.js'

let scheduledTask: ReturnType<typeof nodeCron.schedule> | null = null

const amazonService = new AmazonService()
const schemaService = new CategorySchemaService(prisma, amazonService)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function runSchemaRefresh(): Promise<string> {
  if (!amazonService.isConfigured()) {
    logger.warn('schema-refresh cron: Amazon SP-API not configured — skipping')
    return 'skipped=not-configured'
  }

  return recordCronRun('schema-refresh', async () => {
    // Every (productType, marketplace) we have ever cached = the set in active use.
    const pairs = await prisma.categorySchema.findMany({
      where: { channel: 'AMAZON' },
      distinct: ['productType', 'marketplace'],
      select: { productType: true, marketplace: true },
      orderBy: [{ productType: 'asc' }, { marketplace: 'asc' }],
    })

    let refreshed = 0
    let failed = 0
    for (const { productType, marketplace } of pairs) {
      try {
        await schemaService.refreshSchema({ channel: 'AMAZON', marketplace, productType })
        refreshed++
      } catch (err) {
        failed++
        logger.warn('schema-refresh cron: refresh failed', {
          productType, marketplace, error: err instanceof Error ? err.message : String(err),
        })
      }
      await sleep(300) // throttle the Product Type Definitions API
    }

    const summary = `pairs=${pairs.length} refreshed=${refreshed} failed=${failed}`
    logger.info(`schema-refresh cron: ${summary}`)
    return summary
  })
}

export function startSchemaRefreshCron(): void {
  if (scheduledTask) {
    logger.warn('schema-refresh cron: already started')
    return
  }
  if (process.env.NEXUS_ENABLE_SCHEMA_REFRESH_CRON !== '1') {
    logger.info('schema-refresh cron: dormant (set NEXUS_ENABLE_SCHEMA_REFRESH_CRON=1 to enable)')
    return
  }
  const schedule = process.env.SCHEMA_REFRESH_CRON_SCHEDULE ?? '0 4 * * *' // 04:00 UTC daily
  scheduledTask = nodeCron.schedule(schedule, () => {
    runSchemaRefresh().catch((err) => logger.error('schema-refresh cron tick failed', { error: err?.message }))
  })
  logger.info(`schema-refresh cron: scheduled (${schedule})`)
}

export function stopSchemaRefreshCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
