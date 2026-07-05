'use client'

/**
 * L.2.0 — Unified observability hub.
 *
 * The hub aggregates the Fastify observability endpoints in one initial
 * fetch, then hands off to SyncLogsHubClient which polls every 30s.
 *
 *   GET /api/dashboard/health      — channel matrix + queue depth +
 *                                    24h sync rollup + recent errors
 *   GET /api/dashboard/cron-runs   — latest run per cron + recent
 *                                    failures + stale-RUNNING flags
 *   GET /api/audit-log/search      — recent mutations across the
 *                                    platform with facets
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so the old server-side fetches 401'd
 * and everyone saw an empty hub until the first 30s poll tick. The initial
 * load MUST run client-side where the patched window.fetch adds credentials.
 */

import { useEffect, useState } from 'react'
import PageHeader from '@/components/layout/PageHeader'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import SyncLogsHubClient, {
  type HealthRollup,
  type CronRunsRollup,
  type AuditRollup,
  type ApiCallsRollup,
  type ErrorGroupsRollup,
  type AlertsRollup,
} from './SyncLogsHubClient'

interface InitialPayload {
  health: HealthRollup | null
  crons: CronRunsRollup | null
  audit: AuditRollup | null
  apiCalls: ApiCallsRollup | null
  errorGroups: ErrorGroupsRollup | null
  alerts: AlertsRollup | null
}

async function fetchInitial(): Promise<InitialPayload> {
  const backend = getBackendUrl()
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const [
    healthRes,
    cronsRes,
    auditRes,
    apiCallsRes,
    errorGroupsRes,
    alertsRes,
  ] = await Promise.all([
      fetch(`${backend}/api/dashboard/health`, { cache: 'no-store' }).catch(
        () => null,
      ),
      fetch(`${backend}/api/dashboard/cron-runs`, { cache: 'no-store' }).catch(
        () => null,
      ),
      fetch(
        `${backend}/api/audit-log/search?limit=15&since=${encodeURIComponent(since)}`,
        { cache: 'no-store' },
      ).catch(() => null),
      fetch(
        `${backend}/api/sync-logs/api-calls?since=${encodeURIComponent(since)}`,
        { cache: 'no-store' },
      ).catch(() => null),
      // L.13.1 — surface active error-group count on the KPI strip.
      // limit=1 because we only want the totals, not the rows.
      fetch(
        `${backend}/api/sync-logs/error-groups?status=ACTIVE&limit=1`,
        { cache: 'no-store' },
      ).catch(() => null),
      // L.16.2 — active alert events for the firing banner.
      fetch(
        `${backend}/api/sync-logs/alerts/events?status=TRIGGERED&limit=10`,
        { cache: 'no-store' },
      ).catch(() => null),
    ])

  const health =
    healthRes && healthRes.ok ? ((await healthRes.json()) as HealthRollup) : null
  const crons =
    cronsRes && cronsRes.ok ? ((await cronsRes.json()) as CronRunsRollup) : null
  const audit =
    auditRes && auditRes.ok ? ((await auditRes.json()) as AuditRollup) : null
  const apiCalls =
    apiCallsRes && apiCallsRes.ok
      ? ((await apiCallsRes.json()) as ApiCallsRollup)
      : null
  const errorGroups =
    errorGroupsRes && errorGroupsRes.ok
      ? ((await errorGroupsRes.json()) as ErrorGroupsRollup)
      : null
  const alerts =
    alertsRes && alertsRes.ok
      ? ((await alertsRes.json()) as AlertsRollup)
      : null

  return { health, crons, audit, apiCalls, errorGroups, alerts }
}

export default function SyncLogsHubPage() {
  const { t } = useTranslations()
  const [initial, setInitial] = useState<InitialPayload | null>(null)

  useEffect(() => {
    let alive = true
    fetchInitial().then((payload) => {
      if (alive) setInitial(payload)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div>
      <PageHeader
        title={t('syncLogs.hub.title')}
        subtitle={t('syncLogs.hub.subtitle')}
        breadcrumbs={[
          { label: t('syncLogs.breadcrumb.monitoring') },
          { label: t('syncLogs.hub.title') },
        ]}
      />
      {initial ? (
        <SyncLogsHubClient initial={initial} />
      ) : (
        <div className="space-y-5" aria-busy="true">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-20 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse"
              />
            ))}
          </div>
          <div className="h-56 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
          <div className="h-56 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
        </div>
      )}
    </div>
  )
}
