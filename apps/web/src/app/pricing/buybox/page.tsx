import PageHeader from '@/components/layout/PageHeader'
import BuyBoxClient from './BuyBoxClient'

export const dynamic = 'force-dynamic'

export default function PricingBuyBoxPage() {
  return (
    <div>
      <PageHeader
        title="Buy Box"
        subtitle="Per-marketplace win rate + top competitors. Powered by BuyBoxHistory rows written on every SP-API getItemOffersBatch refresh."
        breadcrumbs={[{ label: 'Pricing', href: '/pricing' }, { label: 'Buy Box' }]}
      />
      <BuyBoxClient />
    </div>
  )
}
