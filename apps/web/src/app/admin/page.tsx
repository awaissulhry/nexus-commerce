import PageHeader from '@/components/layout/PageHeader'
import AdminDashboardClient from './AdminDashboardClient'
import { getHealthStatus, getValidationReport } from './actions'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  // Fetch initial data
  const [health, validation] = await Promise.all([
    getHealthStatus(),
    getValidationReport(),
  ])

  return (
    <div>
      <PageHeader
        title="Admin Dashboard"
        subtitle="Data Validation & Repair Operations"
        breadcrumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Dashboard' },
        ]}
      />

      <div className="p-6">
        <AdminDashboardClient initialHealth={health} initialValidation={validation} />
      </div>
    </div>
  )
}
