/**
 * Nightly Amazon catalog refresh cron.
 *
 * Pulls the GET_MERCHANT_LISTINGS_ALL_DATA report and upserts every SKU
 * into the local Product table, then rebuilds the parent/child hierarchy.
 * Mirrors the logic in `routes/amazon.routes.ts:GET /api/amazon/products`
 * so a manual trigger and the cron behave identically.
 *
 * Pattern: node-cron (matches sales-report-ingest.job.ts, forecast.job.ts).
 *
 * Gated behind NEXUS_ENABLE_CATALOG_SYNC_CRON=1. Without it the cron is
 * dormant and the manual trigger at GET /api/amazon/products is the
 * only entry point.
 *
 * Default schedule: 03:00 UTC daily — runs after the F.3 sales-report
 * cron (02:00 UTC) so both can complete on the same Amazon throttle
 * budget without colliding.
 *
 * Failure handling: report polling can take 5–15 min; failures inside
 * upsert are logged per-SKU but don't stop the job. The next nightly
 * run will reconcile any drift.
 */

import cron from 'node-cron'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

const amazonService = new AmazonService()

async function runCatalogRefresh(): Promise<void> {
  if (!amazonService.isConfigured()) {
    logger.warn('catalog-refresh cron: Amazon SP-API not configured — skipping')
    return
  }

  const startedAt = Date.now()
  logger.info('catalog-refresh cron: tick')

  try {
    await recordCronRun('catalog-refresh', async () => {
    const items = await amazonService.fetchActiveCatalog()
    if (items.length === 0) {
      logger.info('catalog-refresh cron: no products returned by Amazon')
      return 'itemsReturned=0'
    }

    let upserted = 0
    let upsertFailed = 0
    for (const item of items) {
      try {
        await prisma.product.upsert({
          where: { sku: item.sku },
          update: {
            name: item.title || item.sku,
            basePrice: item.price || 0,
            totalStock: item.quantity || 0,
            amazonAsin: item.asin,
            status: 'ACTIVE',
            ...(item.parentAsin ? { parentAsin: item.parentAsin } : {}),
            ...(item.variationTheme ? { variationTheme: item.variationTheme } : {}),
          },
          create: {
            sku: item.sku,
            name: item.title || item.sku,
            basePrice: item.price || 0,
            totalStock: item.quantity || 0,
            amazonAsin: item.asin,
            status: 'ACTIVE',
            syncChannels: ['AMAZON'],
            minMargin: 0,
            ...(item.parentAsin ? { parentAsin: item.parentAsin } : {}),
            ...(item.variationTheme ? { variationTheme: item.variationTheme } : {}),
          },
        })
        upserted++
      } catch (err) {
        upsertFailed++
        logger.warn('catalog-refresh cron: per-SKU upsert failed', {
          sku: item.sku,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Hierarchy pass — same algorithm as the manual route
    const childItems = items.filter((i) => i.parentAsin)
    let parentsLinked = 0
    if (childItems.length > 0) {
      const parentAsinSet = new Set(childItems.map((i) => i.parentAsin!))
      const parentAsinToDbId = new Map<string, string>()

      for (const parentAsin of parentAsinSet) {
        const existing = await prisma.product.findFirst({
          where: { amazonAsin: parentAsin },
          select: { id: true },
        })
        if (existing) {
          await prisma.product.update({
            where: { id: existing.id },
            data: { isParent: true },
          })
          parentAsinToDbId.set(parentAsin, existing.id)
        } else {
          const childItem = childItems.find((i) => i.parentAsin === parentAsin)
          const parentSku = `PARENT-${parentAsin}`
          const parentName = (childItem?.title ?? `Parent ${parentAsin}`)
            .replace(/\s*[-–]\s*(size|color|colour|taglia|colore):?\s*\S+/gi, '')
            .trim()
          const parent = await prisma.product.upsert({
            where: { sku: parentSku },
            update: { isParent: true, amazonAsin: parentAsin },
            create: {
              sku: parentSku,
              name: parentName,
              basePrice: 0,
              totalStock: 0,
              isParent: true,
              amazonAsin: parentAsin,
              status: 'ACTIVE',
              syncChannels: ['AMAZON'],
              minMargin: 0,
            },
          })
          parentAsinToDbId.set(parentAsin, parent.id)
        }
      }

      for (const item of childItems) {
        const parentDbId = parentAsinToDbId.get(item.parentAsin!)
        if (!parentDbId) continue
        await prisma.product.update({
          where: { sku: item.sku },
          data: {
            parentId: parentDbId,
            ...(item.variationTheme ? { variationTheme: item.variationTheme } : {}),
          },
        })
        parentsLinked++
      }

      // Roll up child stock into parent.totalStock
      for (const [, parentDbId] of parentAsinToDbId) {
        const children = await prisma.product.findMany({
          where: { parentId: parentDbId },
          select: { totalStock: true },
        })
        const totalStock = children.reduce((sum, c) => sum + c.totalStock, 0)
        await prisma.product.update({
          where: { id: parentDbId },
          data: { totalStock },
        })
      }
    }

    logger.info('catalog-refresh cron: complete', {
      durationMs: Date.now() - startedAt,
      itemsReturned: items.length,
      upserted,
      upsertFailed,
      parentsLinked,
    })
      return `itemsReturned=${items.length} upserted=${upserted} upsertFailed=${upsertFailed} parentsLinked=${parentsLinked}`
    })
  } catch (err) {
    logger.error('catalog-refresh cron: top-level failure', {
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    })
  }
}

export function startCatalogRefreshCron(): void {
  if (scheduledTask) {
    logger.warn('catalog-refresh cron already started — skipping')
    return
  }

  // Default 03:00 UTC daily. Override via NEXUS_CATALOG_SYNC_CRON_SCHEDULE.
  // 03:00 sits 1 hour after the sales-report cron (02:00) to avoid
  // colliding on the SP-API throttle bucket.
  const schedule = process.env.NEXUS_CATALOG_SYNC_CRON_SCHEDULE ?? '0 3 * * *'

  if (!cron.validate(schedule)) {
    logger.error('catalog-refresh cron: invalid schedule expression', { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void runCatalogRefresh()
  })

  logger.info('catalog-refresh cron: scheduled', { schedule })
}

export function stopCatalogRefreshCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export { runCatalogRefresh }
