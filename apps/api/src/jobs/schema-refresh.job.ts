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
 * P4 (docs/attributes/PLAN.md §4.2, 2026-09-26): every channel whose rules Nexus caches per category — Amazon product
 * types, eBay leaf categories, Etsy taxonomy nodes — for every coordinate a business uses, and ON by default (it was
 * dormant unless NEXUS_ENABLE_SCHEMA_REFRESH_CRON=1; now NEXUS_ENABLE_SCHEMA_REFRESH_CRON=0 turns it off). A new
 * version logs its changes and marks the affected families' readiness for a rebuild (schema-sync.service.ts).
 * Shopify store definitions refresh on their own path (channel-specs/shopify.ts).
 *
 * P3 (attribute parity, D1 = A, 2026-09-27): until now the targets were read FROM the cached rows, so the job refreshed
 * what existed and never downloaded a pair nobody had opened (28 of 66 Amazon market × type pairs cached). Targets now
 * come from what the business USES (services/categories/schema-coverage.service.ts): a missing pair is downloaded, a
 * cached one refreshed. The sheet's "Download rules" action runs the same loop.
 *
 * Per business: registered through lib/cron/clustered.ts, which with business profiles on runs this handler once per
 * active profile inside withWorkspace — every read, provider credential and cache row belongs to that business. With
 * profiles off it runs once, for the original business.
 *
 * Pattern mirrors catalog-refresh.job.ts (node-cron + recordCronRun). Default schedule: 04:00 UTC
 * daily (after catalog-refresh at 03:00) so they share the SP-API throttle budget.
 * Sequential with a small inter-call delay — the Product Type Definitions API is
 * rate-limited and a stale schema is not urgent.
 */

import nodeCron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import { CategorySchemaService } from '../services/categories/schema-sync.service.js'
import { COVERAGE_CHANNELS, collectSchemaTargets, fillSchemaTargets } from '../services/categories/schema-coverage.service.js'

let scheduledTask: ReturnType<typeof nodeCron.schedule> | null = null

const amazonService = new AmazonService()
const schemaService = new CategorySchemaService(prisma, amazonService)

/** The channels whose per-category rules this job keeps. */
export const REFRESHED_CHANNELS = COVERAGE_CHANNELS

export async function runSchemaRefresh(): Promise<string> {
  const amazonReady = await amazonService.isConfigured()
  if (!amazonReady) logger.warn('schema-refresh cron: Amazon SP-API not configured — Amazon targets skipped')

  return recordCronRun('schema-refresh', async () => {
    // P3 — every pair this business USES (missing ones are downloaded) plus every cached one (refreshed, as before),
    // so required-field rules and option lists stay ≤24h fresh and a change rebuilds the affected readiness.
    const targets = await collectSchemaTargets(prisma)
    const { counts } = await fillSchemaTargets(targets, {
      service: schemaService, refreshCached: true, throttleMs: 300, label: 'schema-refresh cron',
      skip: target => target.channel === 'AMAZON' && !amazonReady,
    })

    const summary = `targets=${targets.length} ` + Object.entries(counts)
      .map(([channel, c]) => `${channel}: added=${c.added} refreshed=${c.refreshed} failed=${c.failed} skipped=${c.skipped}`).join(' · ')
    logger.info(`schema-refresh cron: ${summary}`)
    return summary
  })
}

export function startSchemaRefreshCron(): void {
  if (scheduledTask) {
    logger.warn('schema-refresh cron: already started')
    return
  }
  // P4 — on by default; `0` turns it off.
  if (process.env.NEXUS_ENABLE_SCHEMA_REFRESH_CRON === '0') {
    logger.info('schema-refresh cron: disabled (NEXUS_ENABLE_SCHEMA_REFRESH_CRON=0)')
    return
  }
  const schedule = process.env.SCHEMA_REFRESH_CRON_SCHEDULE ?? '0 4 * * *' // 04:00 UTC daily
  scheduledTask = nodeCron.schedule(schedule, async () => {
    await runSchemaRefresh().catch((err) => logger.error('schema-refresh cron tick failed', { error: err?.message }))
  })
  logger.info(`schema-refresh cron: scheduled (${schedule})`)
}

export function stopSchemaRefreshCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
