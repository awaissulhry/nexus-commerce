/**
 * P4.3f — the Shopify quantity read-back cron.
 *
 * 🔴 Registry-only is a MANUAL trigger, not a habit. P4.2c shipped a sweep into
 * `CRON_REGISTRY` alone while fixing exactly that shape and reported it as
 * working; P4.2d had to add the schedule. So this job is SCHEDULED here and
 * started from `index.ts` beside its two siblings, and the test asserts the
 * schedule call rather than the registry entry.
 *
 * Every 6 hours, matching eBay's Trading lane rather than Amazon's daily report
 * pull — a Shopify read is a GraphQL query per listing against a cost-based
 * limit, not a quota-limited report job.
 *
 * ON by default with an opt-out (`NEXUS_SHOPIFY_QTY_READBACK=0`), the same shape
 * as `NEXUS_EBAY_READBACK` and `NEXUS_QTY_READBACK`. It is a READ, and making
 * the third channel the only one that stays dark would re-create the very
 * inconsistency this package keeps closing.
 */
import cron from '../lib/cron/clustered.js'
import { readBackShopifyQuantities, SHOPIFY_QTY_READBACK } from '../services/shopify/quantity-readback.service.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runShopifyQtyReadback(): Promise<string> {
  const r = await readBackShopifyQuantities()
  // `unreadable` is reported beside `checked`, never folded into it: a run that
  // could not read anything must not print like a clean one.
  // P4.4e — the price arm is reported beside the quantity arm, never folded in.
  return `checked=${r.checked} unreadable=${r.unreadable} skipped=${r.skipped} mismatched=${r.mismatches.length} logged=${r.logged} healed=${r.healed}`
    + ` | price: mismatched=${r.priceMismatches.length} logged=${r.priceLogged} (heal off)`
    + `${r.capped ? ' (capped)' : ''}`
}

export function startShopifyQtyReadbackCron(): void {
  if (process.env.NEXUS_SHOPIFY_QTY_READBACK === '0') {
    logger.info(`${SHOPIFY_QTY_READBACK} cron: disabled via NEXUS_SHOPIFY_QTY_READBACK=0`)
    return
  }
  if (scheduledTask) {
    logger.warn(`${SHOPIFY_QTY_READBACK} cron already started — skipping`)
    return
  }
  // A cron expression can close a block comment: '15 */6 * * *' contains '*/'.
  // It is a string here and never inside one.
  const schedule = process.env.NEXUS_SHOPIFY_QTY_READBACK_SCHEDULE ?? '15 */6 * * *'
  if (!cron.validate(schedule)) {
    logger.error(`${SHOPIFY_QTY_READBACK} cron: invalid schedule, not starting`, { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => {
    await recordCronRun(SHOPIFY_QTY_READBACK, runShopifyQtyReadback)
  })
  logger.info(`${SHOPIFY_QTY_READBACK} cron: scheduled`, { schedule })
}
