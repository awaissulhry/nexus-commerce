/**
 * Phase 5.3 — Daily inventory-reconcile cron.
 *
 * Three detect-only checks run each morning at 03:45 (after Amazon T+1 ingest):
 *   1. Amazon marketplace drift — reconcileAllAmazonMarketplaces(), per-metric
 *      driftPct vs NEXUS_RECONCILE_DRIFT_PCT threshold (default 5 %).
 *   2. Cumulative slow-bleed — SUM(ABS(drift)) from AUTO_APPLIED events in the
 *      last NEXUS_DRIFT_WINDOW_HOURS (default 168 h = 7 d) per channel.
 *   3. Stale unresolved conflicts — SyncHealthLog rows older than
 *      NEXUS_STALE_CONFLICT_DAYS (default 3) still UNRESOLVED.
 *
 * Checks 2 + 3 are gated by NEXUS_DRIFT_ALERTS !== '0'.
 * Entire cron disabled by NEXUS_RECONCILE_CRON=0.
 *
 * DETECT-ONLY: NO calls to applyStockMovement / release / consume /
 * recordChannelStockEvent. Reads + emits + logs only.
 *
 * Note: the third Amazon metric key is `fbaInventoryUnits` (not `inventory`) —
 * that is the exact field name in ReconciliationReport.metrics.
 */
import cron from 'node-cron'
import prisma from '../db.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'
import {
  reconcileAllAmazonMarketplaces,
  type ReconciliationReport,
} from '../services/channel-reconciliation.service.js'
import {
  reconcileDriftExceeds,
  cumulativeDriftBreaches,
  staleConflictCutoff,
} from '../services/reconcile-alerts.js'
import { publishOrderEvent } from '../services/order-events.service.js'

const JOB = 'inventory-reconcile'
let scheduledTask: ReturnType<typeof cron.schedule> | null = null

/** All three per-metric drift keys in the ReconciliationReport shape. */
const AMAZON_METRIC_KEYS: Array<keyof ReconciliationReport['metrics']> = [
  'orderCount',
  'revenue',
  'fbaInventoryUnits',
]

export function startReconcileCron(): void {
  if (process.env.NEXUS_RECONCILE_CRON === '0') {
    logger.info('inventory-reconcile cron: disabled via env')
    return
  }
  if (scheduledTask) {
    logger.warn('inventory-reconcile cron already started — skipping')
    return
  }
  const schedule = process.env.NEXUS_RECONCILE_CRON_SCHEDULE ?? '45 3 * * *'
  if (!cron.validate(schedule)) {
    logger.error('inventory-reconcile cron: invalid schedule, not starting', { schedule })
    return
  }

  scheduledTask = cron.schedule(schedule, () => {
    void recordCronRun(JOB, async () => {
      const driftThresholdPct = Number(process.env.NEXUS_RECONCILE_DRIFT_PCT ?? 5)
      const windowHours = Number(process.env.NEXUS_DRIFT_WINDOW_HOURS ?? 168)
      const cumulativeThresholdUnits = Number(process.env.NEXUS_CUMULATIVE_DRIFT_UNITS ?? 25)
      const staleConflictDays = Number(process.env.NEXUS_STALE_CONFLICT_DAYS ?? 3)
      const driftAlertsEnabled = process.env.NEXUS_DRIFT_ALERTS !== '0'

      let amazonDriftAlerts = 0
      let cumulativeDriftAlerts = 0
      let staleConflictAlerts = 0

      // ── Block 1: Amazon drift ────────────────────────────────────────
      try {
        const report = await reconcileAllAmazonMarketplaces({ daysBack: 30 })
        for (const mrReport of report.marketplaces) {
          for (const metricKey of AMAZON_METRIC_KEYS) {
            const driftPct = mrReport.metrics[metricKey].driftPct ?? null
            if (reconcileDriftExceeds(driftPct, driftThresholdPct)) {
              try {
                publishOrderEvent({
                  type: 'sync.reconcile.drift',
                  channel: 'AMAZON',
                  marketplace: mrReport.marketplaceCode,
                  metric: metricKey,
                  driftPct: driftPct as number,
                  ts: Date.now(),
                })
                amazonDriftAlerts++
              } catch (emitErr) {
                logger.warn('inventory-reconcile: drift event emit failed', {
                  marketplace: mrReport.marketplaceCode,
                  metric: metricKey,
                  err: emitErr instanceof Error ? emitErr.message : String(emitErr),
                })
              }
            }
          }
        }
        logger.info('inventory-reconcile: amazon drift block complete', {
          marketplaces: report.marketplaces.length,
          alerts: amazonDriftAlerts,
        })
      } catch (err) {
        logger.error('inventory-reconcile: amazon drift block failed', {
          err: err instanceof Error ? err.message : String(err),
        })
      }

      // ── Blocks 2 + 3: gated by NEXUS_DRIFT_ALERTS ────────────────────
      if (driftAlertsEnabled) {
        // -- Block 2: Cumulative slow-bleed --------------------------------
        try {
          const since = new Date(Date.now() - windowHours * 60 * 60 * 1000)
          // SUM(ABS(drift)) cannot be expressed via Prisma groupBy; raw query
          // is safe — `since` is parameterised by Prisma's tagged template.
          const channelDrifts = await prisma.$queryRaw<
            Array<{ channel: string; absDrift: bigint }>
          >`
            SELECT channel, SUM(ABS(drift)) AS "absDrift"
            FROM "ChannelStockEvent"
            WHERE status = 'AUTO_APPLIED' AND "createdAt" >= ${since}
            GROUP BY channel
          `
          for (const row of channelDrifts) {
            const absDriftUnits = Number(row.absDrift ?? 0)
            if (cumulativeDriftBreaches(absDriftUnits, cumulativeThresholdUnits)) {
              try {
                publishOrderEvent({
                  type: 'sync.drift.cumulative',
                  channel: row.channel,
                  absDriftUnits,
                  windowHours,
                  ts: Date.now(),
                })
                cumulativeDriftAlerts++
              } catch (emitErr) {
                logger.warn('inventory-reconcile: cumulative drift emit failed', {
                  channel: row.channel,
                  err: emitErr instanceof Error ? emitErr.message : String(emitErr),
                })
              }
            }
          }
          logger.info('inventory-reconcile: cumulative bleed block complete', {
            channelsChecked: channelDrifts.length,
            alerts: cumulativeDriftAlerts,
          })
        } catch (err) {
          logger.error('inventory-reconcile: cumulative bleed block failed', {
            err: err instanceof Error ? err.message : String(err),
          })
        }

        // -- Block 3: Stale unresolved conflicts ---------------------------
        try {
          const cutoff = staleConflictCutoff(Date.now(), staleConflictDays)
          const count = await prisma.syncHealthLog.count({
            where: {
              resolutionStatus: 'UNRESOLVED',
              createdAt: { lt: cutoff },
            },
          })
          if (count > 0) {
            try {
              publishOrderEvent({
                type: 'sync.conflict.stale',
                count,
                olderThanDays: staleConflictDays,
                ts: Date.now(),
              })
              staleConflictAlerts++
            } catch (emitErr) {
              logger.warn('inventory-reconcile: stale conflict emit failed', {
                err: emitErr instanceof Error ? emitErr.message : String(emitErr),
              })
            }
          }
          logger.info('inventory-reconcile: stale conflicts block complete', {
            staleCount: count,
            alerts: staleConflictAlerts,
          })
        } catch (err) {
          logger.error('inventory-reconcile: stale conflict block failed', {
            err: err instanceof Error ? err.message : String(err),
          })
        }
      }

      return `amazonDriftAlerts=${amazonDriftAlerts} cumulativeDriftAlerts=${cumulativeDriftAlerts} staleConflictAlerts=${staleConflictAlerts}`
    }).catch((err) => {
      logger.error('inventory-reconcile cron: run failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    })
  })

  logger.info('inventory-reconcile cron started', { schedule })
}
