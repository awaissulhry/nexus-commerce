import PageHeader from '@/components/layout/PageHeader'
import RecycleBinClient from './RecycleBinClient'

export const dynamic = 'force-dynamic'

export default function RecycleBinPage() {
  return (
    <div>
      <PageHeader
        title="Recycle bin housekeeping"
        subtitle="Counts, oldest item age, and manual purge per entity"
        breadcrumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Recycle bin' },
        ]}
      />
      <div className="p-6">
        <RecycleBinClient />
      </div>
    </div>
  )
}
