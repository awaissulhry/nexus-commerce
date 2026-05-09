import PageHeader from '@/components/layout/PageHeader'
import SchedulesClient from './SchedulesClient'

export const dynamic = 'force-dynamic'

export default function BulkOperationsSchedulesPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Scheduled bulk actions"
        description="One-time + recurring schedules · pause / resume / cancel · click a row to drill into the linked job"
        breadcrumbs={[
          { label: 'Bulk Operations', href: '/bulk-operations' },
          { label: 'Schedules' },
        ]}
      />
      <SchedulesClient />
    </div>
  )
}
