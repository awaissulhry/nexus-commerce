import PageHeader from '@/components/layout/PageHeader'
import ExportsTabs from './ExportsTabs'

export const dynamic = 'force-dynamic'

export default function BulkOperationsExportsPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Exports"
        description="One-shot CSV / XLSX / JSON / PDF wizard + recurring exports with email / webhook delivery. Tabs below."
        breadcrumbs={[
          { label: 'Bulk Operations', href: '/bulk-operations' },
          { label: 'Exports' },
        ]}
      />
      <ExportsTabs />
    </div>
  )
}
