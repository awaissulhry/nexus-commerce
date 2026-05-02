import { Megaphone } from 'lucide-react'
import ComingSoonPage from '@/components/layout/ComingSoonPage'

export const dynamic = 'force-dynamic'

export default function PromotionsPage() {
  return (
    <ComingSoonPage
      title="Promotions"
      description="Discounts, coupons, lightning deals across channels"
      icon={Megaphone}
      emptyDescription="Schedule and sync promotions across Amazon, eBay, Shopify, and WooCommerce from one place. Ships in Phase 5."
    />
  )
}
