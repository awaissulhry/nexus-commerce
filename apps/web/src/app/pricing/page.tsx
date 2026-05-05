import PageHeader from '@/components/layout/PageHeader'
import PricingMatrixClient from './PricingMatrixClient'

export const dynamic = 'force-dynamic'

export default function PricingPage() {
  return (
    <div>
      <PageHeader
        title="Pricing"
        subtitle="Per-marketplace prices resolved by the engine. Click any cell to edit, click a row for full breakdown + history."
        breadcrumbs={[{ label: 'Pricing' }]}
      />
      <PricingMatrixClient />
    </div>
  )
}
