'use client'

/**
 * RV.9.2 — Pipeline-health banner on /marketing/reviews/requests.
 *
 * Surfaces three failure modes that previously went silent:
 *   1. Mailer hasn't successfully run in >8h — cron is wedged or
 *      NEXUS_ENABLE_REVIEW_INGEST got unset
 *   2. One or more watched crons is stuck RUNNING for >2h — process
 *      crashed mid-run; the orphan-sweeper will tidy on its next tick
 *      but the operator can poke it manually here
 *   3. The most recent attempt of a watched cron FAILED — last error
 *      shown so the operator can diagnose without digging into logs
 *
 * Healthy state renders a tiny green chip, NOT a banner — Salesforce
 * density wins over Linear minimalism per the user's preference.
 */

import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'

export interface PipelineCronSummary {
  jobName: string
  lastRunAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
  stuckRunning: boolean
}

export interface PipelineHealth {
  mailerHealthy: boolean
  hasStuckCron: boolean
  crons: PipelineCronSummary[]
}

function relativeHoursAgo(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const h = ms / 3_600_000
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m ago`
  if (h < 24) return `${h.toFixed(1)}h ago`
  return `${(h / 24).toFixed(1)}d ago`
}

export function PipelineHealthBanner({ health }: { health: PipelineHealth }) {
  const router = useRouter()
  const [sweeping, setSweeping] = useState(false)
  const [sweepResult, setSweepResult] = useState<string | null>(null)

  // Heuristic: any cron whose last attempt failed (and that attempt is
  // newer than the last success) — recent regression worth surfacing.
  const recentlyFailed = health.crons.filter((c) => {
    if (!c.lastFailureAt) return false
    if (!c.lastSuccessAt) return true
    return new Date(c.lastFailureAt) > new Date(c.lastSuccessAt)
  })

  const isHealthy =
    health.mailerHealthy && !health.hasStuckCron && recentlyFailed.length === 0

  const handleSweep = async () => {
    setSweeping(true)
    setSweepResult(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/reviews/pipeline/sweep-stuck-crons`,
        { method: 'POST' },
      )
      const data = (await res.json()) as { swept?: number; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Failed')
      setSweepResult(
        data.swept === 0 ? 'Nothing to sweep' : `Swept ${data.swept} stale row(s)`,
      )
      router.refresh()
    } catch (e: unknown) {
      setSweepResult(`Error: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally {
      setSweeping(false)
    }
  }

  if (isHealthy) {
    const mailer = health.crons.find((c) => c.jobName === 'review-request-mailer')
    return (
      <div className="inline-flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-300 mb-3">
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span>
          Pipeline healthy — last mailer tick {relativeHoursAgo(mailer?.lastSuccessAt ?? null)}
        </span>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 mb-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-rose-900 dark:text-rose-100">
            Pipeline issues detected
          </div>
          <ul className="text-xs text-rose-800 dark:text-rose-200 mt-1 space-y-1 list-disc list-inside">
            {!health.mailerHealthy && (
              <li>
                <strong>Mailer not running</strong> — last success{' '}
                {relativeHoursAgo(
                  health.crons.find((c) => c.jobName === 'review-request-mailer')?.lastSuccessAt ??
                    null,
                )}
                . Expected every 4h. Check{' '}
                <code className="px-1 py-0.5 rounded bg-rose-100 dark:bg-rose-900/40">
                  NEXUS_ENABLE_REVIEW_INGEST=1
                </code>{' '}
                + Railway logs.
              </li>
            )}
            {health.hasStuckCron && (
              <li>
                <strong>Stale RUNNING row(s)</strong> —{' '}
                {health.crons
                  .filter((c) => c.stuckRunning)
                  .map((c) => `${c.jobName} (started ${relativeHoursAgo(c.lastRunAt)})`)
                  .join(', ')}
                . The orphan-sweeper auto-marks these FAILED every 30 min.
              </li>
            )}
            {recentlyFailed.map((c) => (
              <li key={c.jobName}>
                <strong>{c.jobName}</strong> last run failed {relativeHoursAgo(c.lastFailureAt)}
                {c.lastError ? (
                  <>
                    : <code className="font-mono">{c.lastError.slice(0, 120)}</code>
                  </>
                ) : (
                  ''
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <button
            onClick={handleSweep}
            disabled={sweeping}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-medium bg-rose-600 text-white rounded hover:bg-rose-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${sweeping ? 'animate-spin' : ''}`} />
            Sweep stale
          </button>
          {sweepResult && (
            <span className="text-[10px] text-rose-700 dark:text-rose-300">{sweepResult}</span>
          )}
        </div>
      </div>
    </div>
  )
}
