import PageHeader from '@/components/layout/PageHeader'
import PromotionsClient from './PromotionsClient'

export const dynamic = 'force-dynamic'

export default function PricingPromotionsPage() {
  return (
    <div>
      <PageHeader
        title="Promotions"
        subtitle="Scheduled retail events + price actions. Hourly cron materializes ChannelListing.salePrice for active windows; engine reads as SCHEDULED_SALE source."
        breadcrumbs={[{ label: 'Pricing', href: '/pricing' }, { label: 'Promotions' }]}
      />
      <PromotionsClient />
    </div>
  )
}
