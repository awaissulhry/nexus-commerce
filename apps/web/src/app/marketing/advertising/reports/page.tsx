/**
 * Phase 5d — Reports job pipeline dashboard.
 *
 * Shows the AmazonAdsReportJob queue: status badges, per-job details,
 * and a manual trigger panel (Create Cycle / Poll / Ingest Completed).
 * Filter by status via URL param so the view is bookmarkable.
 *
 * Data flow: POST create-cycle → jobs go PENDING → POST poll advances
 * them to IN_PROGRESS / COMPLETED → POST ingest-completed downloads the
 * S3 file and writes rows to AmazonAdsDailyPerformance / AmazonAdsSearchTerm.
 */

import { ClipboardList } from 'lucide-react'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { ReportsPipelineClient, type ReportJobRow } from './ReportsPipelineClient'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

interface ReportJobsResponse {
  items: ReportJobRow[]
  count: number
}

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

interface PageProps {
  searchParams: Promise<{ status?: string; limit?: string }>
}

function KpiTile({
  label,
  value,
  color,
}: {
  label: string
  value: string | number
  color: string
}) {
  return (
    <div className={`rounded-lg border p-3 ${color}`}>
      <p className="text-xs font-medium opacity-70 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold mt-1 tabular-nums">{value}</p>
    </div>
  )
}

export default async function ReportsPipelinePage({ searchParams }: PageProps) {
  const params = await searchParams
  const backend = getBackendUrl()
  const statusFilter = params.status ?? ''
  const limit = params.limit ?? '100'

  const qs = new URLSearchParams()
  if (statusFilter) qs.set('status', statusFilter)
  qs.set('limit', limit)

  const [data, overview] = await Promise.all([
    fetchJson<ReportJobsResponse>(
      `${backend}/api/advertising/reports?${qs.toString()}`,
      { items: [], count: 0 },
    ),
    fetchJson<{ reports: Record<string, number> }>(
      `${backend}/api/advertising/overview/v1`,
      { reports: {} },
    ),
  ])

  const reports = overview.reports ?? {}
  const pending     = reports.PENDING     ?? 0
  const inProgress  = reports.IN_PROGRESS ?? 0
  const completed   = reports.COMPLETED   ?? 0
  const failed      = reports.FAILED      ?? 0

  return (
    <div className="px-4 py-4">
      <div className="mb-3">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-slate-400" aria-hidden />
          Report Jobs
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Async Reports API pipeline — create → poll → ingest. Jobs survive server
          restarts via AmazonAdsReportJob table.
        </p>
      </div>

      <AdvertisingNav />

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <KpiTile
          label="Pending"
          value={pending}
          color="border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"
        />
        <KpiTile
          label="In Progress"
          value={inProgress}
          color="border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 bg-blue-50/50 dark:bg-blue-900/10"
        />
        <KpiTile
          label="Completed"
          value={completed}
          color="border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 bg-emerald-50/50 dark:bg-emerald-900/10"
        />
        <KpiTile
          label="Failed"
          value={failed}
          color={
            failed > 0
              ? 'border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 bg-red-50/50 dark:bg-red-900/10'
              : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
          }
        />
      </div>

      <ReportsPipelineClient
        jobs={data.items}
        backendUrl={backend}
        statusFilter={statusFilter}
      />

      {data.count >= Number(limit) && (
        <p className="mt-2 text-xs text-slate-400 text-center">
          Showing {limit} most recent jobs.{' '}
          <a
            href={`?${new URLSearchParams({ ...(statusFilter ? { status: statusFilter } : {}), limit: '200' }).toString()}`}
            className="underline hover:text-slate-600 dark:hover:text-slate-300"
          >
            Load 200
          </a>
        </p>
      )}
    </div>
  )
}
