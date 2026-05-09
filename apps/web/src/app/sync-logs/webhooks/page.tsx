/**
 * L.9.1 — /sync-logs/webhooks browser.
 *
 * Read-only inspection surface for inbound WebhookEvent rows
 * (currently Shopify, WooCommerce, Etsy receivers write here;
 * Sendcloud + signature-verification visibility ship later).
 * Replay capability is a follow-up commit.
 */

import PageHeader from '@/components/layout/PageHeader'
import { getServerT } from '@/lib/i18n/server'
import WebhooksClient from './WebhooksClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function WebhooksPage() {
  const t = await getServerT()
  return (
    <div>
      <PageHeader
        title={t('syncLogs.webhooks.title')}
        subtitle={t('syncLogs.webhooks.subtitle')}
        breadcrumbs={[
          { label: t('syncLogs.breadcrumb.monitoring') },
          { label: t('syncLogs.hub.title'), href: '/sync-logs' },
          { label: t('syncLogs.breadcrumb.webhooks') },
        ]}
      />
      <WebhooksClient />
    </div>
  )
}
