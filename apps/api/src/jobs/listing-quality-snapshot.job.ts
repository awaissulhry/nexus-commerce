/**
 * PA.2 — Listing Quality Snapshot cron.
 *
 * Runs weekly (Monday 07:00 UTC). For each ACTIVE product with at least
 * one ACTIVE ChannelListing, calls scoreListingQuality() and persists the
 * result to ListingQualitySnapshot so operators can track quality trends.
 *
 * Processed in batches of 20 to stay within token budget. On-demand
 * snapshots are also created via the score-quality route hook.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { ListingContentService, type QualityDimensionScore } from '../services/ai/listing-content.service.js'

const BATCH_SIZE = 20
const listingContentService = new ListingContentService()

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

interface RunSummary {
  products: number
  snapshots: number
  errors: number
}

function dimensionsToRecord(dims: QualityDimensionScore[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of dims) out[d.name] = d.score
  return out
}

export async function runListingQualitySnapshotOnce(): Promise<RunSummary> {
  const summary: RunSummary = { products: 0, snapshots: 0, errors: 0 }

  // Load ACTIVE products
  const products = await prisma.product.findMany({
    where: { status: 'ACTIVE' } as never,
    select: {
      id: true,
      sku: true,
      name: true,
      brand: true,
      description: true,
      bulletPoints: true,
      keywords: true,
      weightValue: true,
      weightUnit: true,
      dimLength: true,
      dimWidth: true,
      dimHeight: true,
      dimUnit: true,
      productType: true,
      variantAttributes: true,
      categoryAttributes: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })

  // Load channel listings for all products in bulk
  const productIds = products.map((p) => p.id)
  const allListings = await prisma.channelListing.findMany({
    where: { productId: { in: productIds } },
    select: { productId: true, channel: true, marketplace: true },
  })

  const listingsByProduct = new Map<string, Array<{ channel: string; marketplace: string | null }>>()
  for (const l of allListings) {
    const arr = listingsByProduct.get(l.productId) ?? []
    arr.push({ channel: l.channel, marketplace: l.marketplace })
    listingsByProduct.set(l.productId, arr)
  }

  const productsWithListings = products.filter((p) => (listingsByProduct.get(p.id)?.length ?? 0) > 0)
  summary.products = productsWithListings.length

  for (let i = 0; i < productsWithListings.length; i += BATCH_SIZE) {
    const batch = productsWithListings.slice(i, i + BATCH_SIZE)
    await Promise.allSettled(
      batch.map(async (product) => {
        const listings = listingsByProduct.get(product.id) ?? []
        if (!listings.length) return

        const channels = listings.map((l) => ({
          platform: l.channel,
          marketplace: l.marketplace ?? 'IT',
        }))

        try {
          const result = await listingContentService.scoreListingQuality({
            product: {
              id: product.id,
              sku: product.sku,
              name: product.name,
              brand: product.brand,
              description: product.description,
              bulletPoints: product.bulletPoints,
              keywords: product.keywords,
              weightValue: product.weightValue ? Number(product.weightValue) : null,
              weightUnit: product.weightUnit,
              dimLength: product.dimLength ? Number(product.dimLength) : null,
              dimWidth: product.dimWidth ? Number(product.dimWidth) : null,
              dimHeight: product.dimHeight ? Number(product.dimHeight) : null,
              dimUnit: product.dimUnit,
              productType: product.productType,
              variantAttributes: product.variantAttributes,
              categoryAttributes: product.categoryAttributes,
            },
            channels,
            provider: null,
            budgetScope: { feature: 'listing-quality-snapshot', wizardId: 'cron' },
          })

          await prisma.listingQualitySnapshot.createMany({
            data: result.perChannel.map((ch) => ({
              productId: product.id,
              channel: ch.platform.toUpperCase(),
              marketplace: ch.marketplace || null,
              overallScore: ch.overallScore,
              dimensions: dimensionsToRecord(ch.dimensions),
              triggeredBy: 'cron',
            })),
          })

          summary.snapshots += result.perChannel.length
        } catch {
          summary.errors++
        }
      }),
    )
  }

  return summary
}

export async function runListingQualitySnapshotCron(): Promise<void> {
  try {
    await recordCronRun('listing-quality-snapshot', async () => {
      const s = await runListingQualitySnapshotOnce()
      const msg = `products=${s.products} snapshots=${s.snapshots} errors=${s.errors}`
      logger.info('listing-quality-snapshot cron: completed', { ...s })
      return msg
    })
  } catch (err) {
    logger.error('listing-quality-snapshot cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startListingQualitySnapshotCron(): void {
  if (scheduledTask) return
  const schedule = process.env.NEXUS_QUALITY_SNAPSHOT_SCHEDULE ?? '0 7 * * 1'
  scheduledTask = cron.schedule(schedule, () => {
    void runListingQualitySnapshotCron()
  })
  logger.info('listing-quality-snapshot cron: scheduled', { schedule })
}
