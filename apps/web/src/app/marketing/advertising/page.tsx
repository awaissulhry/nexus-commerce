import { Target } from 'lucide-react'
import ComingSoonPage from '@/components/layout/ComingSoonPage'

export const dynamic = 'force-dynamic'

export default function AdvertisingPage() {
  return (
    <ComingSoonPage
      title="Advertising"
      description="Sponsored Products, Brands, and Display campaigns"
      icon={Target}
      emptyDescription="Manage Amazon Sponsored Products, eBay Promoted Listings, and Shopify ads. Bid optimization and ROAS tracking ship in Phase 5."
    />
  )
}
