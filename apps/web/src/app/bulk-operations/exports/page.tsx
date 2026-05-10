import PageHeader from '@/components/layout/PageHeader'
import ExportsClient from './ExportsClient'

export const dynamic = 'force-dynamic'

export default function BulkOperationsExportsPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Export wizard"
        description="CSV / XLSX / JSON / PDF · column picker · filter scope · per-export download links"
        breadcrumbs={[
          { label: 'Bulk Operations', href: '/bulk-operations' },
          { label: 'Exports' },
        ]}
      />
      <ExportsClient />
    </div>
  )
}
