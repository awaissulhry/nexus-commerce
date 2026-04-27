import PageHeader from '@/components/layout/PageHeader'
import InventoryAnalyticsClient from './InventoryAnalyticsClient'
import { getInventoryAnalytics } from './actions'

export const dynamic = 'force-dynamic'

export default async function InventoryAnalyticsPage() {
  const result = await getInventoryAnalytics()

  const initialData = result.success && result.data
    ? result.data
    : {
        totalProducts: 0,
        totalUnits: 0,
        totalStockValue: 0,
        stockDistribution: { outOfStock: 0, lowStock: 0, healthyStock: 0, overStock: 0 },
        topStocked: [],
        lowStockProducts: [],
        outOfStockProducts: [],
        priceTiers: [],
      }

  return (
    <div>
      <PageHeader
        title="Inventory Analytics"
        subtitle="Stock distribution, value analysis, and inventory health metrics"
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Analytics', href: '/dashboard/analytics' },
          { label: 'Inventory' },
        ]}
      />
      <InventoryAnalyticsClient initialData={initialData} />
    </div>
  )
}
