/**
 * ProductReadCache reconcile cron (ES.4).
 *
 * The read cache (the projection behind the /products LIST) is normally kept
 * fresh by ProductEvent → readCacheQueue → BullMQ worker. That path silently
 * drops work when the worker is off or an enqueue fails, which let live
 * products vanish from the list and stock values freeze at stale numbers (a
 * SET-import looked like it did nothing). applyStockMovement now refreshes the
 * cache directly, but this cron is the worker-INDEPENDENT backstop that
 * guarantees the list can never silently drift again — for ANY write path.
 *
 * Each run compares Product truth against ProductReadCache and heals:
 *   - live Product with NO cache row            → refresh (rebuild the row)
 *   - live Product whose cached totalStock/status/name is stale → refresh
 *   - cache row whose Product is gone/soft-deleted → refresh (marks/deletes it)
 * refresh() is a pure DB upsert — no Redis. Small catalog, so a full scan is
 * cheap. Detect-and-heal (never destructive beyond removing orphan cache rows
 * that refresh() itself prunes).
 *
 * Schedule: every 15 min. Opt out: NEXUS_ENABLE_READCACHE_RECONCILE=0.
 */
import cron from 'node-cron'
import { prisma } from '@nexus/database'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { productReadCacheService } from '../services/product-read-cache.service.js'

const JOB = 'read-cache-reconcile'
const SCHEDULE = process.env.NEXUS_READCACHE_RECONCILE_SCHEDULE ?? '*/15 * * * *'
// Safety cap so a pathological run can never launch thousands of refreshes.
const MAX_HEAL_PER_RUN = Number(process.env.NEXUS_READCACHE_RECONCILE_MAX ?? 2000)

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runReadCacheReconcile(): Promise<string> {
  return recordCronRun(JOB, async () => {
      const [liveProducts, cacheRows] = await Promise.all([
        prisma.product.findMany({
          where: { deletedAt: null },
          select: { id: true, totalStock: true, status: true, name: true },
        }),
        prisma.productReadCache.findMany({
          where: { deletedAt: null },
          select: { id: true, totalStock: true, status: true, name: true },
        }),
      ])
      const cacheById = new Map(cacheRows.map((c) => [c.id, c]))
      const liveIds = new Set(liveProducts.map((p) => p.id))

      // Products that are missing from the cache or whose projection drifted.
      const drifted: string[] = []
      let missing = 0
      let stale = 0
      for (const p of liveProducts) {
        const c = cacheById.get(p.id)
        if (!c) {
          missing++
          drifted.push(p.id)
        } else if (c.totalStock !== p.totalStock || c.status !== p.status || c.name !== p.name) {
          stale++
          drifted.push(p.id)
        }
      }
      // Cache rows whose product is gone or soft-deleted — refresh() prunes them.
      const orphans = cacheRows.filter((c) => !liveIds.has(c.id)).map((c) => c.id)

      const toHeal = [...drifted, ...orphans].slice(0, MAX_HEAL_PER_RUN)
      if (toHeal.length === 0) return 'ok — no drift'

      // Bounded concurrency so we never burst the connection pool.
      const CONCURRENCY = 10
      let healed = 0
      for (let i = 0; i < toHeal.length; i += CONCURRENCY) {
        const slice = toHeal.slice(i, i + CONCURRENCY)
        await Promise.all(
          slice.map((id) =>
            productReadCacheService.refresh(id).then(
              () => { healed++ },
              (err) =>
                logger.warn('read-cache-reconcile: refresh failed', {
                  id,
                  err: err instanceof Error ? err.message : String(err),
                }),
            ),
          ),
        )
      }

      const capped = drifted.length + orphans.length > MAX_HEAL_PER_RUN
      return `healed ${healed} (missing ${missing}, stale ${stale}, orphan ${orphans.length}${capped ? `, capped at ${MAX_HEAL_PER_RUN}` : ''})`
    })
}

export function startReadCacheReconcileCron(): void {
  if (process.env.NEXUS_ENABLE_READCACHE_RECONCILE === '0') {
    logger.info('read-cache-reconcile cron: disabled via env')
    return
  }
  if (scheduledTask) return
  if (!cron.validate(SCHEDULE)) {
    logger.error('read-cache-reconcile cron: invalid schedule expression', { schedule: SCHEDULE })
    return
  }
  scheduledTask = cron.schedule(SCHEDULE, () => {
    void runReadCacheReconcile()
  })
  logger.info(`read-cache-reconcile cron: scheduled (${SCHEDULE} UTC)`)
}
