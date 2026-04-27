import PageHeader from '@/components/layout/PageHeader'
import AnalyticsClient from './AnalyticsClient'
import { getAnalyticsData } from './actions'

export const dynamic = 'force-dynamic'

export default async function AnalyticsPage() {
  const result = await getAnalyticsData('30d')

  const initialData = result.success && result.data
    ? result.data
    : {
        ordersByStatus: [],
        totalRevenue: 0,
        totalOrders: 0,
        revenueByDay: [],
        topProducts: [],
      }

  return (
    <div>
      <PageHeader
        title="Analytics Overview"
        subtitle="Key metrics and trends across your commerce operations"
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Analytics' },
        ]}
      />
      <AnalyticsClient initialData={initialData} />
    </div>
  )
}
