/**
 * R0.2 — Amazon report registry (docs/AMAZON_DATA_STRATEGY.md).
 *
 * Reads/writes the AmazonReportRun table — the "every report pull, stamped
 * with its freshness" registry. The report orchestrator
 * (sp-api-reports.service) calls start/complete/fail around each pull, so
 * every future pull is recorded automatically. `backfillRegistry()` seeds
 * day-one freshness from the existing CronRun history; the overview reads
 * the latest run per feed for the Reports hub (R0.3).
 *
 * Hard rule: registry bookkeeping must NEVER break a real report pull —
 * every write here is best-effort (callers swallow failures).
 */

import prisma from '../db.js'
import { AMAZON_REPORT_CATALOG } from './amazon-report-catalog.js'

export async function startReportRun(input: {
  reportType: string
  marketplace?: string | null
  source?: string
  dataStartTime?: Date | null
  dataEndTime?: Date | null
  triggeredBy?: string | null
}): Promise<string> {
  const row = await prisma.amazonReportRun.create({
    data: {
      reportType: input.reportType,
      marketplace: input.marketplace ?? null,
      source: input.source ?? 'REPORTS_API',
      status: 'IN_PROGRESS',
      dataStartTime: input.dataStartTime ?? null,
      dataEndTime: input.dataEndTime ?? null,
      triggeredBy: input.triggeredBy ?? 'cron',
    },
    select: { id: true },
  })
  return row.id
}

export async function completeReportRun(
  id: string,
  patch: {
    reportId?: string | null
    reportDocumentId?: string | null
    rowCount?: number | null
    rawStored?: boolean
    rawRef?: string | null
    freshAsOf?: Date | null
  },
): Promise<void> {
  await prisma.amazonReportRun
    .update({
      where: { id },
      data: {
        status: 'DONE',
        reportId: patch.reportId ?? undefined,
        reportDocumentId: patch.reportDocumentId ?? undefined,
        rowCount: patch.rowCount ?? undefined,
        rawStored: patch.rawStored ?? undefined,
        rawRef: patch.rawRef ?? undefined,
        freshAsOf: patch.freshAsOf ?? new Date(),
        completedAt: new Date(),
      },
    })
    .catch(() => {
      // reportId @unique collision or a missing row — never break the pull.
    })
}

export async function failReportRun(
  id: string,
  opts: { errorMessage?: string; status?: string },
): Promise<void> {
  await prisma.amazonReportRun
    .update({
      where: { id },
      data: {
        status: opts.status ?? 'FATAL',
        errorMessage: (opts.errorMessage ?? '').slice(0, 2000),
        completedAt: new Date(),
      },
    })
    .catch(() => {})
}

/**
 * Seed day-one freshness from the existing cron history: for each cataloged
 * feed with a cronJob, find its latest SUCCESS CronRun and record a
 * representative AmazonReportRun (triggeredBy='backfill'). Idempotent —
 * re-running updates the same backfill row. On-demand feeds (no cronJob)
 * register as 'REGISTERED' with no freshness.
 */
export async function backfillRegistry(): Promise<{
  entries: number
  withFreshness: number
}> {
  let withFreshness = 0
  for (const entry of AMAZON_REPORT_CATALOG) {
    let freshAsOf: Date | null = null
    if (entry.cronJob) {
      const last = await prisma.cronRun.findFirst({
        where: { jobName: entry.cronJob, status: 'SUCCESS', finishedAt: { not: null } },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      })
      freshAsOf = last?.finishedAt ?? null
    }
    if (freshAsOf) withFreshness++

    const data = {
      reportType: entry.reportType,
      marketplace: null,
      source: entry.source,
      status: freshAsOf ? 'DONE' : 'REGISTERED',
      freshAsOf,
      completedAt: freshAsOf,
      triggeredBy: 'backfill',
    }
    const existing = await prisma.amazonReportRun.findFirst({
      where: { reportType: entry.reportType, triggeredBy: 'backfill', marketplace: null },
      select: { id: true },
    })
    if (existing)
      await prisma.amazonReportRun.update({ where: { id: existing.id }, data })
    else await prisma.amazonReportRun.create({ data })
  }
  return { entries: AMAZON_REPORT_CATALOG.length, withFreshness }
}

export interface ReportFreshnessRow {
  reportType: string
  label: string
  source: string
  cadence: string
  cronJob: string | null
  status: string
  freshAsOf: Date | null
  lastPulledAt: Date | null
  rowCount: number | null
}

/** Catalog ⨝ latest AmazonReportRun per feed — the Reports hub overview. */
export async function getReportFreshnessOverview(): Promise<ReportFreshnessRow[]> {
  const types = AMAZON_REPORT_CATALOG.map((e) => e.reportType)
  const runs = await prisma.amazonReportRun.findMany({
    where: { reportType: { in: types } },
    orderBy: { requestedAt: 'desc' },
    select: {
      reportType: true,
      status: true,
      freshAsOf: true,
      completedAt: true,
      rowCount: true,
    },
  })
  const latest = new Map<string, (typeof runs)[number]>()
  for (const r of runs) if (!latest.has(r.reportType)) latest.set(r.reportType, r)

  return AMAZON_REPORT_CATALOG.map((e) => {
    const r = latest.get(e.reportType)
    return {
      reportType: e.reportType,
      label: e.label,
      source: e.source,
      cadence: e.cadence,
      cronJob: e.cronJob,
      status: r?.status ?? 'UNREGISTERED',
      freshAsOf: r?.freshAsOf ?? null,
      lastPulledAt: r?.completedAt ?? null,
      rowCount: r?.rowCount ?? null,
    }
  })
}

export async function listReportRuns(opts: {
  reportType?: string
  limit?: number
}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  return prisma.amazonReportRun.findMany({
    where: opts.reportType ? { reportType: opts.reportType } : {},
    orderBy: { requestedAt: 'desc' },
    take: limit,
  })
}
