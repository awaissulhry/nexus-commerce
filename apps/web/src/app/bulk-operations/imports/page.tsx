import PageHeader from '@/components/layout/PageHeader'
import ImportsClient from './ImportsClient'

export const dynamic = 'force-dynamic'

export default function BulkOperationsImportsPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Import wizard"
        description="CSV / XLSX / JSON · column mapping · preview before apply · per-row results · retry-failed + rollback"
        breadcrumbs={[
          { label: 'Bulk Operations', href: '/bulk-operations' },
          { label: 'Imports' },
        ]}
      />
      <ImportsClient />
    </div>
  )
}
