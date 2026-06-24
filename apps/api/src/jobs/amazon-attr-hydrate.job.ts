/**
 * F.3 — periodic attribute hydration. Pulls full Amazon attributes for listings
 * whose stored platformAttributes are sparse (would show blank required fields in
 * the flat-file editor) and stores ONLY platformAttributes.attributes — inventory
 * (quantity/followMaster*) and price are left untouched. Bounded per tick so a
 * single tick can't hammer SP-API. Schedule overridable via
 * NEXUS_ATTR_HYDRATE_SCHEDULE; per-tick cap via NEXUS_ATTR_HYDRATE_PER_TICK.
 */
import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { hydrateAmazonAttributes, type HydrateResult } from '../services/amazon/flat-file-hydrate.service.js'
import { amazonCredsConfigured } from '../lib/amazon-sp-client.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
const PER_TICK = Number(process.env.NEXUS_ATTR_HYDRATE_PER_TICK ?? '40')

export async function runAttrHydrate(): Promise<HydrateResult> {
  if (!amazonCredsConfigured()) return { scanned: 0, hydrated: 0, skipped: 0, errors: 0 }
  return hydrateAmazonAttributes({ onlySparse: true, limit: PER_TICK })
}

export function startAttrHydrateCron(): void {
  if (scheduledTask) { logger.warn('attr-hydrate cron already started'); return }
  const schedule = process.env.NEXUS_ATTR_HYDRATE_SCHEDULE ?? '17 */3 * * *' // every 3h at :17
  if (!cron.validate(schedule)) { logger.error('attr-hydrate cron: invalid schedule', { schedule }); return }
  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun('attr-hydrate', async () => {
      const r = await runAttrHydrate()
      return `scanned=${r.scanned} hydrated=${r.hydrated} skipped=${r.skipped} errors=${r.errors}`
    })
  })
  logger.info('attr-hydrate cron: scheduled', { schedule })
}

export function stopAttrHydrateCron(): void {
  if (scheduledTask) { scheduledTask.stop(); scheduledTask = null }
}
