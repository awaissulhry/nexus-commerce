/**
 * L.2.0 — Unified observability hub.
 *
 * Replaces the prior page (a 245-line static table that read 50 rows
 * from the SyncLog table — Amazon-only labelling, zero filters, zero
 * client interactivity, and 0 rows in the DB so it always rendered
 * the empty state).
 *
 * The hub aggregates four already-mounted Fastify endpoints in one
 * server fetch so first paint is fully populated, then hands off to
 * the client component which polls every 30s.
 *
 *   GET /api/dashboard/health      — channel matrix + queue depth +
 *                                    24h sync rollup + recent errors
 *   GET /api/dashboard/cron-runs   — latest run per cron + recent
 *                                    failures + stale-RUNNING flags
 *   GET /api/audit-log/search      — recent mutations across the
 *                                    platform with facets
 *
 * Future Phase L2 commits will add sub-routes (/sync-logs/cron,
 * /sync-logs/activity, /sync-logs/outbound, /sync-logs/webhooks,
 * /sync-logs/errors) backed by the same endpoints + new typed Fastify
 * routes for webhook delivery and outbound API call streams.
 */

import PageHeader from '@/components/layout/PageHeader'
import { getBackendUrl } from '@/lib/backend-url'
import { getServerT } from '@/lib/i18n/server'
import SyncLogsHubClient, {
  type HealthRollup,
  type CronRunsRollup,
  type AuditRollup,
  type ApiCallsRollup,
  type ErrorGroupsRollup,
  type AlertsRollup,
} from './SyncLogsHubClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

async function fetchInitial(): Promise<{
  health: HealthRollup | null
  crons: CronRunsRollup | null
  audit: AuditRollup | null
  apiCalls: ApiCallsRollup | null
  errorGroups: ErrorGroupsRollup | null
  alerts: AlertsRollup | null
}> {
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

export default async function SyncLogsHubPage() {
  const [initial, t] = await Promise.all([fetchInitial(), getServerT()])
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
      <SyncLogsHubClient initial={initial} />
    </div>
  )
}
