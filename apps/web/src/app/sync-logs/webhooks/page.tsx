/**
 * L.9.1 — /sync-logs/webhooks browser.
 *
 * Read-only inspection surface for inbound WebhookEvent rows
 * (currently Shopify, WooCommerce, Etsy receivers write here;
 * Sendcloud + signature-verification visibility ship later).
 * Replay capability is a follow-up commit.
 */

import PageHeader from '@/components/layout/PageHeader'
import WebhooksClient from './WebhooksClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function WebhooksPage() {
  return (
    <div>
      <PageHeader
        title="Inbound Webhooks"
        subtitle="Every webhook received from Shopify / WooCommerce / Etsy with payload + processing state"
        breadcrumbs={[
          { label: 'Monitoring' },
          { label: 'Sync Logs', href: '/sync-logs' },
          { label: 'Webhooks' },
        ]}
      />
      <WebhooksClient />
    </div>
  )
}
