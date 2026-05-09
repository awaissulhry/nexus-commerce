/**
 * L.8.1 — /sync-logs/errors error-grouping drill-down.
 *
 * Sentry-tier rolled-up view of SyncLogErrorGroup. Each row is
 * "this error class happened N times since first seen" with
 * resolution actions (Resolve / Mute / Ignore / Reopen).
 *
 * Backed by GET /api/sync-logs/error-groups.
 */

import PageHeader from '@/components/layout/PageHeader'
import { getServerT } from '@/lib/i18n/server'
import ErrorGroupsClient from './ErrorGroupsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function ErrorsPage() {
  const t = await getServerT()
  return (
    <div>
      <PageHeader
        title={t('syncLogs.errors.title')}
        subtitle={t('syncLogs.errors.subtitle')}
        breadcrumbs={[
          { label: t('syncLogs.breadcrumb.monitoring') },
          { label: t('syncLogs.hub.title'), href: '/sync-logs' },
          { label: t('syncLogs.breadcrumb.errors') },
        ]}
      />
      <ErrorGroupsClient />
    </div>
  )
}
