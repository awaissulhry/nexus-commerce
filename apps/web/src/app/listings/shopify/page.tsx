import { ShoppingBag } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'

export const dynamic = 'force-dynamic'

export default function ShopifyListingsPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Shopify"
        description="Manage your Shopify store listings"
        breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'Shopify' }]}
      />
      <EmptyState
        icon={ShoppingBag}
        title="Shopify not connected"
        description="Connect your Shopify store to start managing listings here."
        action={{ label: 'Connect Shopify', href: '/settings/channels' }}
      />
    </div>
  )
}
