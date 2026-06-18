/**
 * FBA→FBM drift detector cron.
 *
 * The fail-closed guard (Fixes 1–3) + the fba-flip-guard cron catch flips that
 * ORIGINATE IN NEXUS. This catches a flip from ANY source — a Seller Central
 * manual edit, a flat-file upload, another integration — by reading Amazon's
 * REAL fulfillment-channel and comparing it to what we expect.
 *
 * How: pull GET_MERCHANT_LISTINGS_ALL_DATA per market (reusing the proven
 * AmazonService.fetchActiveCatalog path, which now surfaces fulfillmentChannel),
 * then for every SKU we expect to be FBA (Amazon FBA stock on hand) check what
 * Amazon actually reports. A SKU we expect FBA that Amazon shows as DEFAULT/MFN
 * = drift → CRITICAL alert telling the operator to run /admin/amazon/restore-fba.
 *
 * Detection-only — never writes to Amazon. Schedule: daily 05:00 UTC (after
 * catalog-refresh 03:00); report pulls are throttle-heavy and external drift is
 * slow-moving, so daily is plenty. Opt out: NEXUS_ENABLE_FBA_DRIFT_DETECTOR=0.
 */
import cron from 'node-cron'
import { prisma } from '@nexus/database'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import type { CatalogItem } from '../services/marketplaces/amazon.service.js'

const JOB = 'fba-drift-detector'
const SCHEDULE = process.env.NEXUS_FBA_DRIFT_CRON_SCHEDULE ?? '0 5 * * *'
const FBA_LOCATION_CODE = 'AMAZON-EU-FBA'
const MP_ID: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', ES: 'A1RKKUPIHCS9HS', UK: 'A1F83G8C2ARO7P',
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
const amazonService = new AmazonService()

/** Amazon reports MFN/merchant as 'DEFAULT' (or blank); FBA as 'AMAZON_*'. */
function isFbmChannel(ch: string | null | undefined): boolean {
  const c = String(ch ?? '').toUpperCase()
  return c === '' || c === 'DEFAULT' || c === 'MFN'
}

export async function runFbaDriftDetector(): Promise<void> {
  try {
    if (!amazonService.isConfigured()) {
      logger.warn('fba-drift-detector: Amazon SP-API not configured — skipping')
      return
    }
    await recordCronRun(JOB, async () => {
      // Expected-FBA = products with FBA stock on hand → their AMAZON listings.
      const fbaStock = await prisma.stockLevel.findMany({
        where: { quantity: { gt: 0 }, location: { code: FBA_LOCATION_CODE } },
        select: { productId: true },
      })
      const fbaProductIds = [...new Set(fbaStock.map((s) => s.productId))]
      if (fbaProductIds.length === 0) return 'no FBA-stock products'

      const listings = await prisma.channelListing.findMany({
        where: { channel: 'AMAZON', productId: { in: fbaProductIds } },
        select: { marketplace: true, product: { select: { sku: true } } },
      })
      // Group expected-FBA SKUs by market.
      const byMarket = new Map<string, Set<string>>()
      for (const cl of listings) {
        const sku = cl.product?.sku
        if (!sku) continue
        let set = byMarket.get(cl.marketplace)
        if (!set) { set = new Set(); byMarket.set(cl.marketplace, set) }
        set.add(sku)
      }
      if (byMarket.size === 0) return 'no expected-FBA Amazon listings'

      const drift: Array<{ sku: string; market: string; channel: string }> = []
      let checked = 0, marketsPulled = 0, marketsFailed = 0
      for (const [market, skus] of byMarket) {
        const mpId = MP_ID[market]
        if (!mpId) continue
        let catalog: CatalogItem[] | undefined
        try {
          catalog = await amazonService.fetchActiveCatalog(mpId)
        } catch (e) {
          marketsFailed++
          logger.warn('fba-drift-detector: report pull failed', { market, error: e instanceof Error ? e.message : String(e) })
          continue
        }
        if (!catalog) continue
        marketsPulled++
        const channelBySku = new Map(catalog.map((i) => [i.sku, i.fulfillmentChannel ?? null]))
        for (const sku of skus) {
          if (!channelBySku.has(sku)) continue // SKU absent from report — can't judge
          checked++
          const ch = channelBySku.get(sku) ?? null
          if (isFbmChannel(ch)) drift.push({ sku, market, channel: String(ch ?? '(empty)') })
        }
      }

      if (drift.length > 0) {
        logger.error(
          '🔴 FBA→FBM DRIFT DETECTED — Amazon reports FBM for SKU(s) we expect to be FBA (flipped outside Nexus, or a regression)',
          {
            critical: true,
            count: drift.length,
            sample: drift.slice(0, 25),
            action: 'Run POST /admin/amazon/restore-fba {"dryRun":false} to convert them back, then investigate the source (Seller Central edit / other tool / flat-file upload).',
          },
        )
        return `DRIFT: ${drift.length} FBA→FBM across ${marketsPulled} market(s); checked ${checked}; ${marketsFailed} pull(s) failed`
      }
      return `ok — no drift (checked ${checked} sku(s) across ${marketsPulled} market(s); ${marketsFailed} pull(s) failed)`
    })
  } catch (err) {
    logger.error('fba-drift-detector: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startFbaDriftDetectorCron(): void {
  if (process.env.NEXUS_ENABLE_FBA_DRIFT_DETECTOR === '0') {
    logger.info('fba-drift-detector cron: disabled via env')
    return
  }
  if (scheduledTask) return
  if (!cron.validate(SCHEDULE)) {
    logger.error('fba-drift-detector cron: invalid schedule expression', { schedule: SCHEDULE })
    return
  }
  scheduledTask = cron.schedule(SCHEDULE, () => {
    void runFbaDriftDetector()
  })
  logger.info(`fba-drift-detector cron: scheduled (${SCHEDULE} UTC)`)
}
