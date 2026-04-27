import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'
import AccountSettingsClient from './AccountSettingsClient'

export const dynamic = 'force-dynamic'

export default async function AccountSettingsPage() {
  const settings = await (prisma as any).accountSettings.findFirst()

  return (
    <div>
      <PageHeader
        title="Account Settings"
        subtitle="Manage your business information and preferences"
        breadcrumbs={[
          { label: 'Settings', href: '/settings/account' },
          { label: 'Account' },
        ]}
      />

      <AccountSettingsClient
        settings={settings ? {
          businessName: settings.businessName,
          addressLine1: settings.addressLine1,
          addressLine2: settings.addressLine2,
          city: settings.city,
          state: settings.state,
          postalCode: settings.postalCode,
          country: settings.country,
          timezone: settings.timezone,
          currency: settings.currency,
        } : null}
      />
    </div>
  )
}
