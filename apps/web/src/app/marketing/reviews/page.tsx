import { Star } from 'lucide-react'
import ComingSoonPage from '@/components/layout/ComingSoonPage'

export const dynamic = 'force-dynamic'

export default function ReviewsPage() {
  return (
    <ComingSoonPage
      title="Reviews"
      description="Cross-channel review monitoring and response"
      icon={Star}
      emptyDescription="Read and respond to reviews from Amazon, eBay, Shopify, Etsy, and WooCommerce in one feed. Sentiment scoring and auto-flagging ship in Phase 5."
    />
  )
}
