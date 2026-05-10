import PageHeader from '@/components/layout/PageHeader'
import ImportsTabs from './ImportsTabs'

export const dynamic = 'force-dynamic'

export default function BulkOperationsImportsPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Imports"
        description="One-shot CSV / XLSX / JSON wizard + recurring URL-pull schedules. Tabs below."
        breadcrumbs={[
          { label: 'Bulk Operations', href: '/bulk-operations' },
          { label: 'Imports' },
        ]}
      />
      <ImportsTabs />
    </div>
  )
}
