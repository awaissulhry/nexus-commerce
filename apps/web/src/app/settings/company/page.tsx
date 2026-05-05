import PageHeader from '@/components/layout/PageHeader'
import CompanySettingsClient from './CompanySettingsClient'

export const dynamic = 'force-dynamic'

export default function CompanySettingsPage() {
  return (
    <div>
      <PageHeader
        title="Company / Brand Settings"
        subtitle="Letterhead identity used on factory POs, packing slips, and brand documents."
        breadcrumbs={[
          { label: 'Settings', href: '/settings/account' },
          { label: 'Company' },
        ]}
      />
      <CompanySettingsClient />
    </div>
  )
}
