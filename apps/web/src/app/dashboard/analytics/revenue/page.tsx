import PageHeader from '@/components/layout/PageHeader'
import RevenueClient from './RevenueClient'
import { getRevenueAnalytics } from './actions'

export const dynamic = 'force-dynamic'

export default async function RevenueAnalyticsPage() {
  const result = await getRevenueAnalytics('30d')

  const initialData = result.success && result.data
    ? result.data
    : {
        totalRevenue: 0,
        previousRevenue: 0,
        revenueChange: 0,
        totalOrders: 0,
        previousOrders: 0,
        ordersChange: 0,
        avgOrderValue: 0,
        revenueByDay: [],
        revenueByStatus: [],
        topRevenueProducts: [],
      }

  return (
    <div>
      <PageHeader
        title="Revenue Analytics"
        subtitle="Track revenue trends, compare periods, and identify top-performing products"
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Analytics', href: '/dashboard/analytics' },
          { label: 'Revenue' },
        ]}
      />
      <RevenueClient initialData={initialData} />
    </div>
  )
}
