/**
 * L.16.1 — /sync-logs/alerts (rules + events).
 *
 * Two-column layout: rules on the left (list + create), events on
 * the right (history with acknowledge/resolve actions).
 *
 * Backed by /api/sync-logs/alerts/{rules,events} (L.16.0).
 */

import PageHeader from '@/components/layout/PageHeader'
import { getServerT } from '@/lib/i18n/server'
import AlertsClient from './AlertsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AlertsPage() {
  const t = await getServerT()
  return (
    <div>
      <PageHeader
        title={t('syncLogs.alerts.title')}
        subtitle={t('syncLogs.alerts.subtitle')}
        breadcrumbs={[
          { label: t('syncLogs.breadcrumb.monitoring') },
          { label: t('syncLogs.hub.title'), href: '/sync-logs' },
          { label: t('syncLogs.breadcrumb.alerts') },
        ]}
      />
      <AlertsClient />
    </div>
  )
}
