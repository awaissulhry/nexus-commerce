import PageHeader from '@/components/layout/PageHeader'
import HistoryClient from './HistoryClient'

export const dynamic = 'force-dynamic'

export default function BulkOperationsHistoryPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Job History"
        description="Past bulk operations · click any job to drill into per-item results"
        breadcrumbs={[
          { label: 'Bulk Operations', href: '/bulk-operations' },
          { label: 'History' },
        ]}
      />
      <HistoryClient />
    </div>
  )
}
