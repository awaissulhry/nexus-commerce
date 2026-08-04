/** RPT.9 — client contract for pipeline health. */
import { getBackendUrl } from '@/lib/backend-url'

export type FeedStatus = 'ok' | 'late' | 'failing' | 'idle' | 'never'

export interface FeedHealth {
  id: string; label: string; source: string
  cadence: 'hourly' | 'daily' | 'weekly'
  cronJob: string | null
  status: FeedStatus
  lastDataDay: string | null
  lagDays: number | null
  rows: number
  lastRunAt: string | null
  lastRunOk: boolean | null
  recentFailures: number
  note: string | null
}

/**
 * Two independent feeds asserting things that cannot both be true. Ranked above
 * a late feed: "the money moved but no report exists" is a defect, not a delay.
 */
export interface Contradiction {
  kind: 'spend-without-rows' | 'impossible-value'
  marketplace: string
  date: string
  severity: 'critical' | 'warning'
  detail: string
}

export interface PipelineHealth {
  asOf: string
  feeds: FeedHealth[]
  contradictions: Contradiction[]
  jobs: {
    reportJobs: Array<{ status: string; n: number }>
    exportFailures: { total: number; recoverable: number; note: string }
    reportRunsMissingRowCount: { total: number; note: string }
  }
  alerts: string[]
  elapsedMs: number
}

export async function fetchPipelineHealth(signal?: AbortSignal): Promise<PipelineHealth> {
  const res = await fetch(`${getBackendUrl()}/api/advertising/reporting/pipeline`, {
    credentials: 'include', signal,
  })
  if (!res.ok) throw new Error(`Pipeline health unavailable (${res.status})`)
  return (await res.json()) as PipelineHealth
}
