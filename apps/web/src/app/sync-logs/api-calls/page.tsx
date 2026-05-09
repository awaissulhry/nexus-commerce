/**
 * L.5.0 — /sync-logs/api-calls drill-down page.
 *
 * Dedicated surface for the OutboundApiCallLog stream with:
 *   - Time-range chips (1h / 24h / 7d / 30d)
 *   - Filter chips for channel, errorType, success
 *   - Cursor-paginated table with status / latency / error
 *   - Per-row click opens a detail panel with full payload
 *
 * Backed by GET /api/sync-logs/api-calls/recent with server-side
 * filtering. The hub's compact panel shows the last 25; this page
 * is the deep-dive.
 */

import PageHeader from '@/components/layout/PageHeader'
import { getServerT } from '@/lib/i18n/server'
import ApiCallsClient from './ApiCallsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function ApiCallsPage() {
  const t = await getServerT()
  return (
    <div>
      <PageHeader
        title={t('syncLogs.apiCalls.title')}
        subtitle={t('syncLogs.apiCalls.subtitle')}
        breadcrumbs={[
          { label: t('syncLogs.breadcrumb.monitoring') },
          { label: t('syncLogs.hub.title'), href: '/sync-logs' },
          { label: t('syncLogs.breadcrumb.apiCalls') },
        ]}
      />
      <ApiCallsClient />
    </div>
  )
}
