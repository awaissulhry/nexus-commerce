import PageHeader from '@/components/layout/PageHeader'
import ReportsClient from './ReportsClient'
import { getReports } from './actions'

export const dynamic = 'force-dynamic'

export default async function ReportsHubPage() {
  const result = await getReports()
  const reports = result.success && result.data ? result.data : []

  return (
    <div>
      <PageHeader
        title="Reports Hub"
        subtitle="Generate and view detailed reports across all aspects of your business"
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Reports' },
        ]}
      />
      <ReportsClient reports={reports} />
    </div>
  )
}
