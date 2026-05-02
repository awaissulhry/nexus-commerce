import { ShoppingBag } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'

export const dynamic = 'force-dynamic'

export default function WooCommerceListingsPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="WooCommerce"
        description="Manage your WooCommerce store listings"
        breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'WooCommerce' }]}
      />
      <EmptyState
        icon={ShoppingBag}
        title="WooCommerce not connected"
        description="Connect your WooCommerce store to start managing listings here."
        action={{ label: 'Connect WooCommerce', href: '/settings/channels' }}
      />
    </div>
  )
}
