/**
 * AX2.9 — collect the integrity snapshot from the DB and evaluate it.
 *
 * Runs on the existing anomaly-guard cron (every 10 min) so nothing new has to
 * be scheduled or watched, and is exposed at /api/health so a problem shows up
 * where someone is already looking. Report-only: it never halts anything.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { evaluateIntegrity, type IntegrityReport, type IntegritySnapshot } from '../ads-core/ads-sync-integrity.js'

const minsSince = (d: Date | null | undefined): number | null =>
  d ? Math.round((Date.now() - d.getTime()) / 60_000) : null

export async function collectIntegritySnapshot(): Promise<IntegritySnapshot> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [
    deadLettersLastHour, deadLetters24h, orphanedTargets, orphanedLast24h,
    freshest, amsNewest, campaignsFailedWrite, conns, openDriftRows, driftNeedsAttention, lastReconcile,
  ] = await Promise.all([
    prisma.outboundSyncQueue.count({ where: { syncType: { startsWith: 'AD_' }, isDead: true, diedAt: { gte: hourAgo } } }),
    prisma.outboundSyncQueue.count({ where: { syncType: { startsWith: 'AD_' }, isDead: true, diedAt: { gte: dayAgo } } }),
    prisma.adTarget.count({ where: { orphanedAt: { not: null } } }),
    prisma.adTarget.count({ where: { orphanedAt: { gte: dayAgo } } }),
    prisma.campaign.aggregate({ _max: { settingsSyncedAt: true } }),
    prisma.amazonAdsHourlyPerformance.aggregate({ _max: { reportedAt: true } }).catch(() => null),
    prisma.campaign.count({ where: { lastSyncStatus: 'FAILED' } }),
    prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true, mode: true, writesEnabledAt: true } }),
    // AX-VT.5 — open drift + reconcile freshness. Both fail OPEN (0 / null) rather than throwing:
    // the integrity check is report-only and must never break the cron it rides on.
    prisma.adDrift.count({ where: { resolvedAt: null } }).catch(() => 0),
    prisma.adDrift.count({ where: { resolvedAt: null, classification: { in: ['EXTERNAL_CHANGE', 'WRITE_FAILED'] } } }).catch(() => 0),
    prisma.cronRun.findFirst({
      where: { jobName: 'ads-structural-reconcile', status: 'SUCCESS' },
      orderBy: { finishedAt: 'desc' }, select: { finishedAt: true },
    }).catch(() => null),
  ])

  // Campaigns stranded where no production connection can accept a write.
  const writable = new Set(conns.filter((c) => c.mode === 'production' && c.writesEnabledAt).map((c) => c.marketplace))
  const byMarket = await prisma.campaign.groupBy({
    by: ['marketplace'], where: { status: { not: 'ARCHIVED' } }, _count: { _all: true },
  })
  const campaignsInUnwritableMarket = byMarket
    .filter((m) => m.marketplace && !writable.has(m.marketplace))
    .reduce((sum, m) => sum + m._count._all, 0)

  return {
    deadLettersLastHour,
    deadLetters24h,
    orphanedTargets,
    orphanedLast24h,
    minutesSinceSettingsSync: minsSince(freshest._max.settingsSyncedAt),
    minutesSinceAmsIngest: minsSince(amsNewest?._max.reportedAt ?? null),
    campaignsFailedWrite,
    campaignsInUnwritableMarket,
    openDriftRows,
    driftNeedsAttention,
    minutesSinceStructuralReconcile: minsSince(lastReconcile?.finishedAt ?? null),
    writeOutcomesByKind: await writeOutcomesByKind(dayAgo),
  }
}

/**
 * WF.2 — 24h write outcomes split by AdTarget.kind.
 *
 * AdMutation carries the outcome but not the kind, so the two are joined here. Two grouped
 * queries plus one id→kind lookup; the id sets are small (a day of mutations), and this runs on a
 * 10-minute cron, not a request path.
 */
async function writeOutcomesByKind(since: Date): Promise<Array<{ kind: string; applied: number; failed: number }>> {
  try {
    const rows = await prisma.adMutation.findMany({
      where: { entityType: 'AD_TARGET', updatedAt: { gte: since }, state: { in: ['APPLIED', 'FAILED'] } },
      select: { entityId: true, state: true },
    })
    if (!rows.length) return []
    const targets = await prisma.adTarget.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.entityId))] } }, select: { id: true, kind: true } })
    const kindById = new Map(targets.map((t) => [t.id, t.kind]))
    const acc = new Map<string, { applied: number; failed: number }>()
    for (const r of rows) {
      const kind = kindById.get(r.entityId)
      if (!kind) continue // deleted locally since the write — no class to attribute it to
      const a = acc.get(kind) ?? { applied: 0, failed: 0 }
      if (r.state === 'APPLIED') a.applied++; else a.failed++
      acc.set(kind, a)
    }
    return [...acc.entries()].map(([kind, v]) => ({ kind, ...v }))
  } catch {
    return [] // report-only: never break the cron this rides on
  }
}

export async function runSyncIntegrityCheck(): Promise<IntegrityReport> {
  const report = evaluateIntegrity(await collectIntegritySnapshot())
  if (report.severity === 'CRITICAL') {
    logger.error('[AX2.9] ads sync integrity CRITICAL', { findings: report.findings.map((f) => f.code), snapshot: report.snapshot })
  } else if (report.severity === 'WARN') {
    logger.warn('[AX2.9] ads sync integrity WARN', { findings: report.findings.map((f) => f.code) })
  }
  return report
}
