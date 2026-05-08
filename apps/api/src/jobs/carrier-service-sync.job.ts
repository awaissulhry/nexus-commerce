/**
 * CR.12 — nightly Sendcloud service-catalog sync.
 *
 * Pulls /shipping_methods from each connected Sendcloud account once
 * a day and upserts the result into CarrierService. The service-map
 * editor (CR.7's Services tab) reads from CarrierService directly,
 * so a fresh sync keeps the picker honest with whatever services
 * the operator's Sendcloud integration actually offers.
 *
 * Why a cron + on-connect sync rather than fetch-on-every-render:
 *   • Sendcloud rate-limits per integration; the picker firing on
 *     every drawer-open is wasteful at scale.
 *   • Service catalogs change rarely (carrier adds a new service tier
 *     a few times a year). Daily refresh is plenty.
 *   • CR.7's POST /mappings already auto-creates rows on demand, so
 *     a missing service in CarrierService never blocks the operator
 *     — this job just keeps the picker complete.
 *
 * Cadence: 02:00 server time daily by default (NEXUS_CARRIER_SERVICE_SYNC_SCHEDULE
 * to override). Gated behind NEXUS_ENABLE_CARRIER_SERVICE_SYNC_CRON
 * (default-ON because the work is small + the value is real).
 *
 * Idempotency:
 *   • Upserts on (carrierId, externalId) — same Sendcloud method id
 *     across runs updates the same row.
 *   • Marks rows present-on-Sendcloud as isActive=true; rows that
 *     vanished (Sendcloud removed the service) flip to isActive=false
 *     rather than delete, so existing CarrierServiceMapping rows
 *     pointing at them keep working until operator re-binds.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import * as sendcloud from '../services/sendcloud/index.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let lastRunAt: Date | null = null
let lastSyncedCount = 0
let lastError: string | null = null

/**
 * Probe weight + country used when calling /shipping_methods. Sendcloud
 * filters its response by these on the server side; we want the
 * widest possible cut so the catalog is exhaustive. Operator may have
 * services bound only above 5kg or only to non-IT — we'd miss those
 * with a single-call probe. So we walk a small grid of (weight,
 * country) pairs and union the results.
 *
 * Grid is intentionally small: too many calls and Sendcloud rate-
 * limits us. Two weight tiers × 4 countries = 8 calls covers >95% of
 * realistic shop catalogs.
 */
const PROBE_GRID: Array<{ weightKg: number; toCountry: string }> = [
  { weightKg: 1, toCountry: 'IT' },
  { weightKg: 1, toCountry: 'DE' },
  { weightKg: 1, toCountry: 'FR' },
  { weightKg: 1, toCountry: 'GB' },
  { weightKg: 10, toCountry: 'IT' },
  { weightKg: 10, toCountry: 'DE' },
  { weightKg: 10, toCountry: 'FR' },
  { weightKg: 10, toCountry: 'GB' },
]

/** One full sync pass. Exposed for manual /admin invocation. */
export async function runCarrierServiceSync(): Promise<{
  carriersScanned: number
  servicesSynced: number
  servicesDeactivated: number
}> {
  const carriers = await prisma.carrier.findMany({
    where: { isActive: true, code: 'SENDCLOUD' },
  })
  let totalSynced = 0
  let totalDeactivated = 0

  for (const carrier of carriers) {
    try {
      const creds = await sendcloud.resolveCredentials()

      // Union services across the probe grid. Map by externalId so
      // duplicates (same method ID returned for different probes)
      // collapse cleanly.
      const found = new Map<string, {
        externalId: string
        name: string
        carrier: string
        minWeightKg: number
        maxWeightKg: number
        basePriceEur: number
      }>()
      for (const probe of PROBE_GRID) {
        try {
          const methods = await sendcloud.listShippingMethods(creds, probe)
          for (const m of methods) {
            const ext = String(m.id)
            if (!found.has(ext)) {
              found.set(ext, {
                externalId: ext,
                name: m.name,
                carrier: m.carrier,
                minWeightKg: m.minWeightKg,
                maxWeightKg: m.maxWeightKg,
                basePriceEur: m.price,
              })
            }
          }
        } catch (err) {
          // Per-probe failures don't fail the whole sync; log + continue.
          logger.warn('carrier-service-sync: probe failed', {
            carrierId: carrier.id,
            probe,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Upsert the survivors. CR.24: classify tier from the name +
      // carrier sub-name so resolveServiceMap's auto-tier fallback
      // (CR.22) actually has typed rows to match against. Null when
      // the name gives no signal — better than guessing.
      const { classifyServiceTier } = await import('../services/sendcloud/tier-classifier.js')
      for (const m of found.values()) {
        const tier = classifyServiceTier(m.name, m.carrier)
        await prisma.carrierService.upsert({
          where: {
            carrierId_externalId: { carrierId: carrier.id, externalId: m.externalId },
          },
          create: {
            carrierId: carrier.id,
            externalId: m.externalId,
            name: m.name,
            carrierSubName: m.carrier,
            tier,
            minWeightG: Math.round(m.minWeightKg * 1000),
            maxWeightG: Math.round(m.maxWeightKg * 1000),
            basePriceCents: Math.round(m.basePriceEur * 100),
            isActive: true,
          },
          update: {
            name: m.name,
            carrierSubName: m.carrier,
            tier,
            minWeightG: Math.round(m.minWeightKg * 1000),
            maxWeightG: Math.round(m.maxWeightKg * 1000),
            basePriceCents: Math.round(m.basePriceEur * 100),
            isActive: true,
            syncedAt: new Date(),
          },
        })
        totalSynced++
      }

      // Deactivate services that vanished from Sendcloud's catalog —
      // soft-delete rather than hard so existing mappings keep working.
      const seenIds = Array.from(found.keys())
      const stale = await prisma.carrierService.updateMany({
        where: {
          carrierId: carrier.id,
          isActive: true,
          ...(seenIds.length > 0 ? { externalId: { notIn: seenIds } } : {}),
        },
        data: { isActive: false },
      })
      totalDeactivated += stale.count
    } catch (err) {
      // Per-carrier failures don't fail the run; log and continue.
      logger.warn('carrier-service-sync: carrier failed', {
        carrierId: carrier.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  lastRunAt = new Date()
  lastSyncedCount = totalSynced
  lastError = null
  if (totalSynced > 0 || totalDeactivated > 0) {
    logger.info('carrier-service-sync: complete', {
      carriersScanned: carriers.length,
      servicesSynced: totalSynced,
      servicesDeactivated: totalDeactivated,
    })
  }
  return { carriersScanned: carriers.length, servicesSynced: totalSynced, servicesDeactivated: totalDeactivated }
}

export function startCarrierServiceSyncCron(): void {
  if (process.env.NEXUS_ENABLE_CARRIER_SERVICE_SYNC_CRON === '0') {
    logger.info('carrier-service-sync cron: disabled by env')
    return
  }
  if (scheduledTask) {
    logger.warn('carrier-service-sync cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_CARRIER_SERVICE_SYNC_SCHEDULE ?? '0 2 * * *'
  if (!cron.validate(schedule)) {
    logger.error('carrier-service-sync cron: invalid schedule expression', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, () => {
    void runCarrierServiceSync().catch((err) => {
      lastError = err instanceof Error ? err.message : String(err)
      logger.error('carrier-service-sync cron: failure', { error: lastError })
    })
  })
  logger.info('carrier-service-sync cron: scheduled', { schedule })
}

export function stopCarrierServiceSyncCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}

export function getCarrierServiceSyncStatus(): {
  scheduled: boolean
  lastRunAt: Date | null
  lastSyncedCount: number
  lastError: string | null
} {
  return {
    scheduled: scheduledTask !== null,
    lastRunAt,
    lastSyncedCount,
    lastError,
  }
}
