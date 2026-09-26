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
 * Pattern mirrors catalog-refresh.job.ts (node-cron + recordCronRun). Default schedule: 04:00 UTC
 * daily (after catalog-refresh at 03:00) so they share the SP-API throttle budget.
 * Sequential with a small inter-call delay — the Product Type Definitions API is
 * rate-limited and a stale schema is not urgent.
 */

import nodeCron from '../lib/cron/clustered.js'
import type { PrismaClient } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import { CategorySchemaService } from '../services/categories/schema-sync.service.js'

let scheduledTask: ReturnType<typeof nodeCron.schedule> | null = null

const amazonService = new AmazonService()
const schemaService = new CategorySchemaService(prisma, amazonService)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The channels whose per-category rules this job refreshes. */
export const REFRESHED_CHANNELS = ['AMAZON', 'EBAY', 'ETSY'] as const
export type RefreshTarget = { channel: (typeof REFRESHED_CHANNELS)[number]; marketplace: string; productType: string }

/**
 * Returns DISTINCT (channel, marketplace, productType) targets from active cached schemas,
 * ordered by channel, marketplace, productType (first-seen wins on duplicates).
 * A null Amazon marketplace defaults to 'IT' (Nexus primary market). Etsy's rules are global.
 */
export async function collectInUseSchemaTargets(client: PrismaClient): Promise<RefreshTarget[]> {
  const rows = await client.categorySchema.findMany({
    where: { channel: { in: [...REFRESHED_CHANNELS] }, isActive: true },
    select: { channel: true, marketplace: true, productType: true },
    orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { productType: 'asc' }],
  })
  const seen = new Set<string>()
  const out: RefreshTarget[] = []
  for (const r of rows) {
    const channel = r.channel as RefreshTarget['channel']
    const mp = r.marketplace ?? (channel === 'ETSY' ? 'GLOBAL' : 'IT')
    const key = `${channel}:${mp}:${r.productType}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ channel, marketplace: mp, productType: r.productType })
  }
  return out
}

export async function runSchemaRefresh(): Promise<string> {
  const amazonReady = await amazonService.isConfigured()
  if (!amazonReady) logger.warn('schema-refresh cron: Amazon SP-API not configured — Amazon targets skipped')

  return recordCronRun('schema-refresh', async () => {
    // Refresh every (channel, marketplace, category) actively in use — keeps required-field
    // rules and option lists ≤24h fresh, and a change rebuilds the affected readiness.
    const targets = await collectInUseSchemaTargets(prisma)

    const counts: Record<string, { refreshed: number; failed: number; skipped: number }> = {}
    for (const { channel, productType, marketplace } of targets) {
      const count = (counts[channel] ??= { refreshed: 0, failed: 0, skipped: 0 })
      if (channel === 'AMAZON' && !amazonReady) { count.skipped++; continue }
      try {
        await schemaService.refreshSchema({ channel, marketplace, productType })
        count.refreshed++
      } catch (err) {
        count.failed++
        logger.warn('schema-refresh cron: refresh failed', {
          channel, productType, marketplace, error: err instanceof Error ? err.message : String(err),
        })
      }
      await sleep(300) // throttle the providers' definition APIs
    }

    const summary = `targets=${targets.length} ` + Object.entries(counts)
      .map(([channel, c]) => `${channel}: refreshed=${c.refreshed} failed=${c.failed}${c.skipped ? ` skipped=${c.skipped}` : ''}`).join(' · ')
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
