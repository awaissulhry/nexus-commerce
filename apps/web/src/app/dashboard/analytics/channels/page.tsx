import PageHeader from '@/components/layout/PageHeader'
import ChannelAnalyticsClient from './ChannelAnalyticsClient'
import { getChannelAnalytics } from './actions'

export const dynamic = 'force-dynamic'

export default async function ChannelAnalyticsPage() {
  const result = await getChannelAnalytics()

  const initialData = result.success && result.data
    ? result.data
    : {
        channels: [],
        totals: { totalRevenue: 0, totalListings: 0, totalOrders: 0, channelCount: 0 },
      }

  return (
    <div>
      <PageHeader
        title="Channel Performance"
        subtitle="Compare performance metrics across all connected sales channels"
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Analytics', href: '/dashboard/analytics' },
          { label: 'Channels' },
        ]}
      />
      <ChannelAnalyticsClient initialData={initialData} />
    </div>
  )
}
