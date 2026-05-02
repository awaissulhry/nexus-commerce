import { Boxes } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { ListingsTable, type Listing } from '@/components/listings/ListingsTable'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

async function loadListings(): Promise<Listing[]> {
  const res = await fetch(`${getBackendUrl()}/api/listings/all`, {
    cache: 'no-store',
  })
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data.listings) ? data.listings : []
}

export default async function AllListingsPage() {
  const listings = await loadListings()

  return (
    <div className="space-y-5">
      <PageHeader
        title="All Listings"
        description="Every published listing across all channels and marketplaces"
      />

      {listings.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No listings yet"
          description="Publish products to channels to see listings appear here. Open a product and use the channel tabs to create one."
          action={{ label: 'View Catalog', href: '/products' }}
        />
      ) : (
        <ListingsTable listings={listings} />
      )}
    </div>
  )
}
