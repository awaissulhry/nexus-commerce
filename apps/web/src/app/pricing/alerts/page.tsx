import PageHeader from '@/components/layout/PageHeader'
import PricingAlertsClient from './PricingAlertsClient'

export const dynamic = 'force-dynamic'

export default function PricingAlertsPage() {
  return (
    <div>
      <PageHeader
        title="Pricing alerts"
        subtitle="SKUs the engine flagged: clamped to a floor, missing inputs, no resolution path."
        breadcrumbs={[
          { label: 'Pricing', href: '/pricing' },
          { label: 'Alerts' },
        ]}
      />
      <PricingAlertsClient />
    </div>
  )
}
